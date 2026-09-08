import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "./logger.js";

const DB_DIR = join(homedir(), ".local", "share", "opencode-telegram");
const DB_PATH = join(DB_DIR, "state.db");
const OPENCODE_DB_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db");

interface Db {
  exec(sql: string): void;
  run(sql: string, ...params: unknown[]): void;
  get(sql: string, ...params: unknown[]): any;
  all(sql: string, ...params: unknown[]): any[];
  close(): void;
}

function openSqlite(path: string): Db {
  const req = createRequire(import.meta.url);
  try {
    const { Database } = req("bun:sqlite");
    const raw = new Database(path);
    return {
      exec: raw.exec.bind(raw),
      close: raw.close.bind(raw),
      run: (sql, ...p) => raw.query(sql).run(...p),
      get: (sql, ...p) => raw.query(sql).get(...p),
      all: (sql, ...p) => raw.query(sql).all(...p),
    };
  } catch {}
  const { DatabaseSync } = req("node:sqlite");
  const raw = new DatabaseSync(path);
  return {
    exec: raw.exec.bind(raw),
    close: raw.close.bind(raw),
    run: (sql, ...p) => raw.prepare(sql).run(...p),
    get: (sql, ...p) => raw.prepare(sql).get(...p),
    all: (sql, ...p) => raw.prepare(sql).all(...p),
  };
}

let db: Db | null = null;

export function openDb(): void {
  if (db) return;
  mkdirSync(DB_DIR, { recursive: true });
  const d = openSqlite(DB_PATH);
  d.exec("PRAGMA journal_mode=WAL");
  d.exec("PRAGMA busy_timeout=2000");
  d.exec(`
    CREATE TABLE IF NOT EXISTS pending_questions (
      request_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      questions_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS pending_permissions (
      permission_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS question_answers (
      request_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      answers_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS permission_results (
      permission_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      response TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS button_tokens (
      token TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      question_index INTEGER NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS pending_custom (
      request_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS forwarded_texts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_instance_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS instance_sessions (
      instance_id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      session_id TEXT,
      session_slug TEXT,
      session_title TEXT,
      project_name TEXT,
      directory TEXT,
      time_updated TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS session_topics (
      session_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      thread_id INTEGER NOT NULL,
      title TEXT,
      project_name TEXT,
      closed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_session_topics_thread ON session_topics(thread_id);
  `);
  db = d;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

export function cleanupExpired(): void {
  if (!db) return;
  try {
    db.exec("DELETE FROM pending_questions WHERE created_at < datetime('now', '-10 minutes')");
    db.exec("DELETE FROM pending_permissions WHERE created_at < datetime('now', '-10 minutes')");
    db.exec("DELETE FROM question_answers WHERE created_at < datetime('now', '-10 minutes')");
    db.exec("DELETE FROM permission_results WHERE created_at < datetime('now', '-10 minutes')");
    db.exec("DELETE FROM button_tokens WHERE created_at < datetime('now', '-10 minutes')");
    db.exec("DELETE FROM pending_custom WHERE created_at < datetime('now', '-10 minutes')");
    db.exec("DELETE FROM forwarded_texts WHERE created_at < datetime('now', '-10 minutes')");
    db.exec("DELETE FROM instance_sessions WHERE time_updated < datetime('now', '-10 minutes')");
  } catch {}
}

function d(): Db {
  if (!db) throw new Error("state db not open");
  return db;
}

// --- session topics ---

export function upsertSessionTopic(
  sessionId: string,
  instanceId: string,
  threadId: number,
  title: string | null,
  projectName: string | null,
): void {
  try {
    d().run(
      "INSERT OR REPLACE INTO session_topics (session_id, instance_id, thread_id, title, project_name, closed) VALUES (?, ?, ?, ?, ?, COALESCE((SELECT closed FROM session_topics WHERE session_id = ?), 0))",
      sessionId,
      instanceId,
      threadId,
      title,
      projectName,
      sessionId,
    );
  } catch (error) {
    log.error("Failed to upsert session topic", { error: String(error), sessionId });
  }
}

export function getTopicBySession(sessionId: string) {
  try {
    return (
      d().get(
        "SELECT session_id, instance_id, thread_id, title, project_name, closed FROM session_topics WHERE session_id = ?",
        sessionId,
      ) ?? null
    );
  } catch {
    return null;
  }
}

export function getSessionByThreadId(threadId: number) {
  try {
    return (
      d().get(
        "SELECT session_id, instance_id, thread_id, title, project_name, closed FROM session_topics WHERE thread_id = ?",
        threadId,
      ) ?? null
    );
  } catch {
    return null;
  }
}

export function setTopicClosed(sessionId: string, closed: boolean): void {
  try {
    d().run("UPDATE session_topics SET closed = ? WHERE session_id = ?", closed ? 1 : 0, sessionId);
  } catch {}
}

export function setTopicTitle(sessionId: string, title: string): void {
  try {
    d().run("UPDATE session_topics SET title = ? WHERE session_id = ?", title, sessionId);
  } catch {}
}

// --- cross-instance relay ---

export function insertPendingQuestion(
  instanceId: string,
  requestID: string,
  sessionId: string,
  questions: unknown,
): void {
  try {
    d().run(
      "INSERT OR REPLACE INTO pending_questions (request_id, instance_id, session_id, questions_json) VALUES (?, ?, ?, ?)",
      requestID,
      instanceId,
      sessionId,
      JSON.stringify(questions),
    );
  } catch (error) {
    log.error("Failed to insert pending question", { error: String(error) });
  }
}

export function getSharedQuestionBySession(sessionId: string) {
  try {
    const row = d().get(
      "SELECT request_id, instance_id FROM pending_questions WHERE session_id = ? LIMIT 1",
      sessionId,
    );
    return row ? { requestID: row.request_id as string, instanceId: row.instance_id as string } : null;
  } catch {
    return null;
  }
}

export function deletePendingQuestion(requestID: string): void {
  try {
    d().run("DELETE FROM pending_questions WHERE request_id = ?", requestID);
  } catch {}
}

export function insertQuestionAnswer(instanceId: string, requestID: string, answers: unknown): void {
  try {
    d().run(
      "INSERT OR REPLACE INTO question_answers (request_id, instance_id, answers_json) VALUES (?, ?, ?)",
      requestID,
      instanceId,
      JSON.stringify(answers),
    );
  } catch (error) {
    log.error("Failed to insert question answer", { error: String(error) });
  }
}

export function pollQuestionAnswers(instanceId: string) {
  try {
    const rows = d().all(
      "SELECT request_id, answers_json FROM question_answers WHERE instance_id = ?",
      instanceId,
    );
    const out = rows.map((row) => ({
      requestID: row.request_id as string,
      answers: JSON.parse(row.answers_json) as string[][],
    }));
    for (const row of rows) d().run("DELETE FROM question_answers WHERE request_id = ?", row.request_id);
    return out;
  } catch {
    return [];
  }
}

export function insertPendingCustom(instanceId: string, requestID: string): void {
  try {
    d().run("INSERT OR REPLACE INTO pending_custom (request_id, instance_id) VALUES (?, ?)", requestID, instanceId);
  } catch {}
}

export function pollPendingCustom(instanceId: string) {
  try {
    const rows = d().all("SELECT request_id FROM pending_custom WHERE instance_id = ?", instanceId);
    for (const row of rows) d().run("DELETE FROM pending_custom WHERE request_id = ?", row.request_id);
    return rows.map((row) => row.request_id as string);
  } catch {
    return [];
  }
}

export function insertPendingPermission(instanceId: string, permissionId: string, sessionId: string): void {
  try {
    d().run(
      "INSERT OR REPLACE INTO pending_permissions (permission_id, instance_id, session_id) VALUES (?, ?, ?)",
      permissionId,
      instanceId,
      sessionId,
    );
  } catch (error) {
    log.error("Failed to insert pending permission", { error: String(error) });
  }
}

export function getSharedPermission(permissionId: string) {
  try {
    const row = d().get(
      "SELECT instance_id, session_id FROM pending_permissions WHERE permission_id = ?",
      permissionId,
    );
    return row ? { instanceId: row.instance_id as string, sessionId: row.session_id as string } : null;
  } catch {
    return null;
  }
}

export function deletePendingPermission(permissionId: string): void {
  try {
    d().run("DELETE FROM pending_permissions WHERE permission_id = ?", permissionId);
  } catch {}
}

export function insertPermissionResult(instanceId: string, permissionId: string, response: string): void {
  try {
    d().run(
      "INSERT OR REPLACE INTO permission_results (permission_id, instance_id, response) VALUES (?, ?, ?)",
      permissionId,
      instanceId,
      response,
    );
  } catch (error) {
    log.error("Failed to insert permission result", { error: String(error) });
  }
}

export function pollPermissionResults(instanceId: string) {
  try {
    const rows = d().all(
      "SELECT permission_id, response FROM permission_results WHERE instance_id = ?",
      instanceId,
    );
    const out = rows.map((row) => ({
      permissionId: row.permission_id as string,
      response: row.response as string,
    }));
    for (const row of rows)
      d().run("DELETE FROM permission_results WHERE permission_id = ?", row.permission_id);
    return out;
  } catch {
    return [];
  }
}

export function storeButtonToken(
  instanceId: string,
  token: string,
  requestID: string,
  questionIndex: number,
  label: string,
): void {
  try {
    d().run(
      "INSERT OR REPLACE INTO button_tokens (token, instance_id, request_id, question_index, label) VALUES (?, ?, ?, ?, ?)",
      token,
      instanceId,
      requestID,
      questionIndex,
      label,
    );
  } catch {}
}

export function resolveSharedButtonToken(token: string) {
  try {
    const row = d().get(
      "SELECT instance_id, request_id, question_index, label FROM button_tokens WHERE token = ?",
      token,
    );
    if (!row) return null;
    d().run("DELETE FROM button_tokens WHERE token = ?", token);
    return {
      instanceId: row.instance_id as string,
      requestID: row.request_id as string,
      questionIndex: row.question_index as number,
      label: row.label as string,
    };
  } catch {
    return null;
  }
}

export function insertForwardedText(targetInstanceId: string, sessionId: string, text: string): void {
  try {
    d().run(
      "INSERT INTO forwarded_texts (target_instance_id, session_id, text) VALUES (?, ?, ?)",
      targetInstanceId,
      sessionId,
      text,
    );
  } catch {}
}

export function pollForwardedTexts(instanceId: string) {
  try {
    const rows = d().all(
      "SELECT id, session_id, text FROM forwarded_texts WHERE target_instance_id = ? ORDER BY id",
      instanceId,
    );
    const out = rows.map((row) => ({ sessionId: row.session_id as string, text: row.text as string }));
    for (const row of rows) d().run("DELETE FROM forwarded_texts WHERE id = ?", row.id);
    return out;
  } catch {
    return [];
  }
}

// --- instance tracking ---

export function upsertInstanceSession(
  instanceId: string,
  sessionId: string | null,
  slug: string | null,
  title: string | null,
  projectName: string | null,
  directory: string | null,
): void {
  try {
    d().run(
      `INSERT OR REPLACE INTO instance_sessions (instance_id, pid, session_id, session_slug, session_title, project_name, directory, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      instanceId,
      process.pid,
      sessionId,
      slug,
      title,
      projectName,
      directory,
    );
  } catch {}
}

export function removeInstanceSession(instanceId: string): void {
  try {
    d().run("DELETE FROM instance_sessions WHERE instance_id = ?", instanceId);
  } catch {}
}

export function getInstanceSessions() {
  try {
    return d().all(
      "SELECT instance_id, pid, session_id, session_slug, session_title, project_name, directory, time_updated FROM instance_sessions ORDER BY time_updated DESC",
    );
  } catch {
    return [];
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function cleanupDeadInstances(): void {
  try {
    for (const row of getInstanceSessions()) {
      if (!isPidAlive(row.pid)) removeInstanceSession(row.instance_id);
    }
  } catch {}
}

// --- reads from opencode.db (commands) ---

const SESSION_COLS =
  "id, slug, title, directory, project_id, agent, model, summary_additions, summary_deletions, summary_files, time_created, time_updated, time_archived, workspace_id";

function withOpencodeDb<T>(fn: (o: Db) => T, fallback: T): T {
  let o: Db;
  try {
    o = openSqlite(OPENCODE_DB_PATH);
  } catch {
    return fallback;
  }
  try {
    return fn(o);
  } catch (error) {
    log.error("opencode.db query failed", { error: String(error) });
    return fallback;
  } finally {
    o.close();
  }
}

export function listSessions(opts: { limit?: number; projectName?: string } = {}) {
  return withOpencodeDb((o) => {
    let sql = `SELECT ${SESSION_COLS} FROM session WHERE time_archived IS NULL`;
    const params: unknown[] = [];
    if (opts.projectName) {
      sql += " AND project_id IN (SELECT id FROM project WHERE name LIKE ? OR worktree LIKE ?)";
      params.push(`%${opts.projectName}%`, `%${opts.projectName}%`);
    }
    sql += " ORDER BY time_updated DESC LIMIT ?";
    params.push(opts.limit ?? 10);
    return o.all(sql, ...params);
  }, []);
}

export function getSessionBySlug(slug: string) {
  return withOpencodeDb(
    (o) => o.get(`SELECT ${SESSION_COLS} FROM session WHERE slug = ?`, slug) ?? null,
    null,
  );
}

export function getSessionById(id: string) {
  return withOpencodeDb(
    (o) => o.get(`SELECT ${SESSION_COLS} FROM session WHERE id = ?`, id) ?? null,
    null,
  );
}

export function listArchivedSessions(limit = 20) {
  return withOpencodeDb(
    (o) =>
      o.all(
        `SELECT ${SESSION_COLS} FROM session WHERE time_archived IS NOT NULL ORDER BY time_archived DESC LIMIT ?`,
        limit,
      ),
    [],
  );
}

export function listTodos(opts: { statuses?: string[]; sessionId?: string; filter?: string; limit?: number } = {}) {
  const statuses = opts.statuses ?? ["pending", "in_progress"];
  return withOpencodeDb((o) => {
    const placeholders = statuses.map(() => "?").join(",");
    let sql = `SELECT t.session_id, s.slug AS session_slug, s.title AS session_title,
      COALESCE(p.name, s.directory) AS project_name, t.content, t.status, t.priority, t.position
      FROM todo t JOIN session s ON t.session_id = s.id LEFT JOIN project p ON s.project_id = p.id
      WHERE t.status IN (${placeholders})`;
    const params: unknown[] = [...statuses];
    if (opts.sessionId) {
      sql += " AND t.session_id = ?";
      params.push(opts.sessionId);
    }
    if (opts.filter) {
      sql += " AND t.content LIKE ?";
      params.push(`%${opts.filter}%`);
    }
    sql += " ORDER BY s.time_updated DESC, t.position ASC LIMIT ?";
    params.push(opts.limit ?? 30);
    return o.all(sql, ...params);
  }, []);
}

export function getTodoCounts() {
  return withOpencodeDb((o) => {
    const result = { total: 0, pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
    const counts: Record<string, number> = result;
    for (const row of o.all("SELECT status, COUNT(*) AS cnt FROM todo GROUP BY status")) {
      result.total += row.cnt;
      if (row.status in counts) counts[row.status] = row.cnt;
    }
    return result;
  }, { total: 0, pending: 0, in_progress: 0, completed: 0, cancelled: 0 });
}

export function countMessages(sessionId: string) {
  return withOpencodeDb((o) => o.get("SELECT COUNT(*) AS cnt FROM message WHERE session_id = ?", sessionId)?.cnt ?? 0, 0);
}

export interface SessionActivity {
  thoughts: string | null;
  tool: { name: string; status: string; input: string; output: string } | null;
  text: string | null;
  lastActivityAt: number;
}

export function getLatestActivity(sessionId: string): SessionActivity | null {
  return withOpencodeDb((o) => {
    const msgs = o.all(
      "SELECT id FROM message WHERE session_id = ? AND json_extract(data,'$.role')='assistant' ORDER BY time_created DESC LIMIT 3",
      sessionId,
    );
    for (const msg of msgs) {
      const rows = o.all(
        "SELECT data, time_updated FROM part WHERE message_id = ? ORDER BY time_created, rowid",
        msg.id,
      );
      if (rows.length === 0) continue;
      let thoughts: string | null = null;
      let tool: SessionActivity["tool"] = null;
      let text: string | null = null;
      let lastActivityAt = 0;
      for (const row of rows) {
        let p: any;
        try {
          p = JSON.parse(row.data);
        } catch {
          continue;
        }
        lastActivityAt = Math.max(lastActivityAt, Number(row.time_updated) || 0);
        if (p.type === "reasoning" && p.text) thoughts = String(p.text);
        else if (p.type === "tool" && p.tool) {
          const input = p.state?.input;
          const output = p.state?.output ?? p.state?.metadata?.output;
          tool = {
            name: String(p.tool),
            status: String(p.state?.status ?? "unknown"),
            input:
              typeof input === "string" ? input : input ? JSON.stringify(input, null, 2) : "",
            output: typeof output === "string" ? output : "",
          };
        } else if (p.type === "text" && p.text) text = String(p.text);
      }
      if (thoughts || tool || text) return { thoughts, tool, text, lastActivityAt };
    }
    return null;
  }, null);
}

export function archiveSession(slug: string) {
  return withOpencodeDb((o) => {
    o.run("UPDATE session SET time_archived = ? WHERE slug = ? AND time_archived IS NULL", Date.now(), slug);
    return true;
  }, false);
}

export function resumeSession(slug: string) {
  return withOpencodeDb((o) => {
    o.run("UPDATE session SET time_archived = NULL WHERE slug = ?", slug);
    return true;
  }, false);
}

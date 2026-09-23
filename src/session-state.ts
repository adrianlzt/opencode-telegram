export interface PendingQuestion {
  requestID: string;
  sessionId: string;
  questions: Array<{
    header?: string;
    question: string;
    options: Array<{ label: string; description?: string }>;
    multiple?: boolean;
    custom?: boolean;
  }>;
  answers: string[][];
  currentIndex: number;
  awaitingCustom: boolean;
  isMultiSelect: boolean;
  context?: string;
}

export class SessionState {
  private sessionTitles = new Map<string, string>();
  private pendingPermissions = new Map<string, { sessionId: string }>();
  private pendingQuestions = new Map<string, PendingQuestion>();
  private currentQuestionRequestID: string | null = null;
  private activeSessionId: string | null = null;
  private buttonTokens = new Map<string, { requestID: string; questionIndex: number; label: string }>();
  private tokenCounter = 0;
  private paused: boolean;

  constructor(enabled: boolean) {
    this.paused = !enabled;
  }

  setSessionTitle(id: string, title: string): void {
    this.sessionTitles.set(id, title);
  }

  getSessionTitle(id: string): string | null {
    return this.sessionTitles.get(id) ?? null;
  }

  addPendingPermission(permissionId: string, sessionId: string): void {
    this.pendingPermissions.set(permissionId, { sessionId });
  }

  consumePendingPermission(permissionId: string): { sessionId: string } | null {
    const entry = this.pendingPermissions.get(permissionId);
    if (entry) {
      this.pendingPermissions.delete(permissionId);
      return entry;
    }
    return null;
  }

  addPendingQuestion(
    requestID: string,
    sessionId: string,
    questions: PendingQuestion["questions"],
    context?: string,
  ): void {
    this.pendingQuestions.set(requestID, {
      requestID,
      sessionId,
      questions,
      answers: questions.map(() => []),
      currentIndex: 0,
      awaitingCustom: false,
      isMultiSelect: false,
      context,
    });
    this.currentQuestionRequestID = requestID;
  }

  getPendingQuestion(requestID?: string): PendingQuestion | null {
    if (requestID) return this.pendingQuestions.get(requestID) ?? null;
    if (this.currentQuestionRequestID)
      return this.pendingQuestions.get(this.currentQuestionRequestID) ?? null;
    if (this.pendingQuestions.size === 1) return this.pendingQuestions.values().next().value ?? null;
    return null;
  }

  getPendingQuestionBySession(sessionId: string): PendingQuestion | null {
    for (const pq of this.pendingQuestions.values()) {
      if (pq.sessionId === sessionId) return pq;
    }
    return null;
  }

  setAwaitingCustom(value: boolean, requestID?: string): void {
    const pq = this.getPendingQuestion(requestID);
    if (pq) pq.awaitingCustom = value;
  }

  setIsMultiSelect(value: boolean, requestID?: string): void {
    const pq = this.getPendingQuestion(requestID);
    if (pq) pq.isMultiSelect = value;
  }

  recordAnswer(answer: string[], requestID?: string): void {
    const pq = this.getPendingQuestion(requestID);
    if (pq) pq.answers[pq.currentIndex] = answer;
  }

  advanceQuestion(requestID?: string): boolean {
    const pq = this.getPendingQuestion(requestID);
    if (!pq) return false;
    pq.currentIndex++;
    pq.awaitingCustom = false;
    pq.isMultiSelect = false;
    return pq.currentIndex < pq.questions.length;
  }

  consumePendingQuestion(requestID?: string): PendingQuestion | null {
    const id = requestID ?? this.currentQuestionRequestID;
    if (!id) return null;
    const pq = this.pendingQuestions.get(id);
    if (!pq) return null;
    this.pendingQuestions.delete(id);
    if (this.currentQuestionRequestID === id) this.currentQuestionRequestID = null;
    return pq;
  }

  setActiveSession(sessionId: string | null): void {
    this.activeSessionId = sessionId;
  }

  getActiveSession(): string | null {
    return this.activeSessionId;
  }

  registerButtonToken(requestID: string, questionIndex: number, label: string): string {
    const token = (++this.tokenCounter).toString(36);
    this.buttonTokens.set(token, { requestID, questionIndex, label });
    return token;
  }

  resolveButtonToken(token: string): { requestID: string; questionIndex: number; label: string } | null {
    const data = this.buttonTokens.get(token);
    if (!data) return null;
    this.buttonTokens.delete(token);
    return data;
  }

  pause(): boolean {
    const wasPaused = this.paused;
    this.paused = true;
    return !wasPaused;
  }

  resume(): boolean {
    const wasPaused = this.paused;
    this.paused = false;
    return wasPaused;
  }

  isPaused(): boolean {
    return this.paused;
  }
}

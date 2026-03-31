export class SessionState {
  private sessionTitles = new Map<string, string>();
  private pendingPermissions = new Map<string, { sessionId: string }>();
  private activeSessionId: string | null = null;
  private paused = false;

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

  consumePendingPermission(
    permissionId: string,
  ): { sessionId: string } | null {
    const entry = this.pendingPermissions.get(permissionId);
    if (entry) {
      this.pendingPermissions.delete(permissionId);
      return entry;
    }
    return null;
  }

  setActiveSession(sessionId: string | null): void {
    this.activeSessionId = sessionId;
  }

  getActiveSession(): string | null {
    return this.activeSessionId;
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

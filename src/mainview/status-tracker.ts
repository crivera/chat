export type ThreadStatus = "idle" | "working" | "done";

export interface StatusTrackerOptions {
  now?: () => number;
  setTimeout?: (cb: () => void, ms: number) => number;
  clearTimeout?: (id: number) => void;
  onStatusChange: (id: string, status: ThreadStatus) => void;
}

export class StatusTracker {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private idleTimers = new Map<string, any>();
  private deactivatedAt = new Map<string, number>();
  private statuses = new Map<string, ThreadStatus>();
  private titled = new Set<string>();
  private agentRunning = new Set<string>();

  private now: () => number;
  private _setTimeout: (cb: () => void, ms: number) => number;
  private _clearTimeout: (id: number) => void;
  private onStatusChange: (id: string, status: ThreadStatus) => void;

  constructor(opts: StatusTrackerOptions) {
    this.now = opts.now ?? Date.now;
    this._setTimeout =
      opts.setTimeout ??
      ((cb, ms) => globalThis.setTimeout(cb, ms) as unknown as number);
    this._clearTimeout =
      opts.clearTimeout ??
      ((id) =>
        globalThis.clearTimeout(
          id as unknown as ReturnType<typeof globalThis.setTimeout>,
        ));
    this.onStatusChange = opts.onStatusChange;
  }

  trackThread(id: string, isTitled: boolean) {
    this.statuses.set(id, "idle");
    if (isTitled) this.titled.add(id);
  }

  setTitled(id: string, isTitled: boolean) {
    if (isTitled) this.titled.add(id);
    else this.titled.delete(id);
  }

  getStatus(id: string): ThreadStatus | undefined {
    return this.statuses.get(id);
  }

  markActive(id: string, activeId: string | null) {
    if (id === activeId) return;
    if (!this.titled.has(id)) return;

    const status = this.statuses.get(id);
    if (!status) return;

    // New output on a "done" thread → reset to idle so working/done can recycle
    if (status === "done") {
      this.setStatus(id, "idle");
      return;
    }

    // Ignore residual output right after switching away
    const deactivated = this.deactivatedAt.get(id);
    if (deactivated !== undefined) {
      if (this.now() - deactivated < 1500) return;
      this.deactivatedAt.delete(id);
    }

    if (status !== "working") {
      this.setStatus(id, "working");
    }

    // Don't schedule a "done" timer while an agent is still running
    if (this.agentRunning.has(id)) {
      this.clearTimers(id);
      return;
    }

    const existing = this.idleTimers.get(id);
    if (existing) this._clearTimeout(existing);

    this.idleTimers.set(
      id,
      this._setTimeout(() => {
        this.idleTimers.delete(id);
        if (this.agentRunning.has(id)) return;
        this.setStatus(id, "done");
      }, 2000),
    );
  }

  setAgentRunning(id: string, running: boolean, activeId: string | null) {
    const was = this.agentRunning.has(id);
    if (running === was) return;

    if (running) this.agentRunning.add(id);
    else this.agentRunning.delete(id);

    if (id === activeId) return;
    if (!this.titled.has(id)) return;

    if (running) {
      this.clearTimers(id);
      if (this.statuses.get(id) !== "working") {
        this.setStatus(id, "working");
      }
    } else if (this.statuses.get(id) === "working") {
      this.setStatus(id, "done");
    }
  }

  selectThread(newId: string, prevId: string | null) {
    if (prevId && prevId !== newId) {
      this.clearTimers(prevId);
      this.deactivatedAt.set(prevId, this.now());
      if (this.agentRunning.has(prevId)) {
        if (this.statuses.get(prevId) !== "working") {
          this.setStatus(prevId, "working");
        }
      } else if (this.statuses.get(prevId) === "working") {
        this.setStatus(prevId, "idle");
      }
    }

    this.clearTimers(newId);
    if (this.statuses.get(newId) !== "idle") {
      this.setStatus(newId, "idle");
    }
  }

  removeThread(id: string) {
    this.clearTimers(id);
    this.deactivatedAt.delete(id);
    this.statuses.delete(id);
    this.titled.delete(id);
    this.agentRunning.delete(id);
  }

  private setStatus(id: string, status: ThreadStatus) {
    this.statuses.set(id, status);
    this.onStatusChange(id, status);
  }

  private clearTimers(id: string) {
    const timer = this.idleTimers.get(id);
    if (timer) {
      this._clearTimeout(timer);
      this.idleTimers.delete(id);
    }
  }
}

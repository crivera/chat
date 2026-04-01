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
  private outputAccumulators = new Map<string, number>();
  private deactivatedAt = new Map<string, number>();
  private lastBgOutputAt = new Map<string, number>();
  private statuses = new Map<string, ThreadStatus>();
  private titled = new Set<string>();

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

  markActive(id: string, dataLen: number, activeId: string | null) {
    if (id === activeId) return;
    if (!this.titled.has(id)) return;

    const status = this.statuses.get(id);
    if (!status || status === "done") return;

    // Ignore residual output right after switching away
    const deactivated = this.deactivatedAt.get(id);
    if (deactivated !== undefined) {
      if (this.now() - deactivated < 1500) return;
      this.deactivatedAt.delete(id);
    }

    // Reset accumulator when there's a gap between output events (>1s).
    // Prevents slow periodic noise from gradually accumulating to threshold.
    const currentTime = this.now();
    const lastTime = this.lastBgOutputAt.get(id);
    this.lastBgOutputAt.set(id, currentTime);
    if (lastTime !== undefined && currentTime - lastTime > 1000) {
      this.outputAccumulators.delete(id);
    }

    const accumulated = (this.outputAccumulators.get(id) || 0) + dataLen;
    this.outputAccumulators.set(id, accumulated);

    const existing = this.idleTimers.get(id);
    if (existing) this._clearTimeout(existing);

    if (accumulated >= 200 && status !== "working") {
      this.setStatus(id, "working");
    }

    this.idleTimers.set(
      id,
      this._setTimeout(() => {
        this.idleTimers.delete(id);
        const total = this.outputAccumulators.get(id) || 0;
        this.outputAccumulators.delete(id);
        if (total < 200) return;
        this.setStatus(id, "done");
      }, 2000),
    );
  }

  selectThread(newId: string, prevId: string | null) {
    // Clean up thread we're leaving
    if (prevId && prevId !== newId) {
      this.clearTimers(prevId);
      this.outputAccumulators.delete(prevId);
      this.lastBgOutputAt.delete(prevId);
      this.deactivatedAt.set(prevId, this.now());
      if (this.statuses.get(prevId) === "working") {
        this.setStatus(prevId, "idle");
      }
    }

    // Clean up thread we're switching to
    this.clearTimers(newId);
    this.outputAccumulators.delete(newId);
    this.lastBgOutputAt.delete(newId);
    if (this.statuses.get(newId) !== "idle") {
      this.setStatus(newId, "idle");
    }
  }

  removeThread(id: string) {
    this.clearTimers(id);
    this.outputAccumulators.delete(id);
    this.deactivatedAt.delete(id);
    this.lastBgOutputAt.delete(id);
    this.statuses.delete(id);
    this.titled.delete(id);
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

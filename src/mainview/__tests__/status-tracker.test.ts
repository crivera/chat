import { describe, test, expect } from "bun:test";
import { StatusTracker, type ThreadStatus } from "../status-tracker";

function setup() {
  let currentTime = 0;
  const timers = new Map<number, { cb: () => void; fireAt: number }>();
  let nextTimerId = 1;
  const statusChanges: { id: string; status: ThreadStatus }[] = [];

  const tracker = new StatusTracker({
    now: () => currentTime,
    setTimeout: (cb, ms) => {
      const id = nextTimerId++;
      timers.set(id, { cb, fireAt: currentTime + ms });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    onStatusChange: (id, status) => {
      statusChanges.push({ id, status });
    },
  });

  function advance(ms: number) {
    currentTime += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.fireAt <= currentTime) {
        timers.delete(id);
        timer.cb();
      }
    }
  }

  return { tracker, advance, statusChanges };
}

describe("StatusTracker", () => {
  test("background output triggers working, then done after 2s", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("bg", true);

    tracker.markActive("bg", "other");
    expect(statusChanges).toEqual([{ id: "bg", status: "working" }]);

    advance(2000);
    expect(statusChanges).toEqual([
      { id: "bg", status: "working" },
      { id: "bg", status: "done" },
    ]);
  });

  test("deactivatedAt guard blocks output for first 1500ms", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("a", true);
    tracker.trackThread("b", true);

    tracker.selectThread("a", "b");

    advance(500);
    tracker.markActive("b", "a");
    advance(500);
    tracker.markActive("b", "a");
    expect(statusChanges).toEqual([]);

    advance(600); // now 1600ms past selectThread
    tracker.markActive("b", "a");
    expect(statusChanges).toEqual([{ id: "b", status: "working" }]);
  });

  test("done thread resets to idle on new output, then can cycle again", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("bg", true);

    tracker.markActive("bg", "other");
    advance(2000);
    expect(statusChanges).toEqual([
      { id: "bg", status: "working" },
      { id: "bg", status: "done" },
    ]);

    statusChanges.length = 0;
    tracker.markActive("bg", "other");
    expect(statusChanges).toEqual([{ id: "bg", status: "idle" }]);

    statusChanges.length = 0;
    tracker.markActive("bg", "other");
    advance(2000);
    expect(statusChanges).toEqual([
      { id: "bg", status: "working" },
      { id: "bg", status: "done" },
    ]);
  });

  test("selectThread cleans up both previous and new thread", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("a", true);
    tracker.trackThread("b", true);

    tracker.markActive("b", "a");
    expect(statusChanges).toEqual([{ id: "b", status: "working" }]);
    statusChanges.length = 0;

    tracker.selectThread("b", "a");
    expect(statusChanges).toEqual([{ id: "b", status: "idle" }]);
    statusChanges.length = 0;

    tracker.markActive("a", "b");
    expect(statusChanges).toEqual([]);

    advance(2000);
    expect(statusChanges).toEqual([]);
  });

  test("untitled threads are ignored", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("bg", false);

    tracker.markActive("bg", "other");
    advance(2000);
    expect(statusChanges).toEqual([]);

    tracker.setTitled("bg", true);
    tracker.markActive("bg", "other");
    expect(statusChanges).toEqual([{ id: "bg", status: "working" }]);
  });

  test("active thread output is ignored", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("a", true);

    tracker.markActive("a", "a");
    advance(2000);
    expect(statusChanges).toEqual([]);
  });

  test("rapid A→B→A switch does not leave stale state", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("a", true);
    tracker.trackThread("b", true);

    tracker.selectThread("b", "a");
    advance(100);
    tracker.selectThread("a", "b");

    advance(5000);
    expect(statusChanges).toEqual([]);

    statusChanges.length = 0;
    advance(2000);
    tracker.markActive("b", "a");
    expect(statusChanges).toEqual([{ id: "b", status: "working" }]);
  });

  test("removeThread while working cancels pending done timer", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("bg", true);

    tracker.markActive("bg", "other");
    expect(statusChanges).toEqual([{ id: "bg", status: "working" }]);
    statusChanges.length = 0;

    tracker.removeThread("bg");
    advance(3000);
    expect(statusChanges).toEqual([]);
  });

  test("continuous output keeps thread in working state", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("bg", true);

    tracker.markActive("bg", "other");
    expect(statusChanges).toEqual([{ id: "bg", status: "working" }]);
    statusChanges.length = 0;

    for (let i = 0; i < 20; i++) {
      advance(500);
      tracker.markActive("bg", "other");
    }
    expect(statusChanges).toEqual([]);

    advance(2000);
    expect(statusChanges).toEqual([{ id: "bg", status: "done" }]);
  });

  test("selectThread with null prevId does not crash", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("a", true);

    tracker.selectThread("a", null);
    advance(3000);
    expect(statusChanges).toEqual([]);
  });

  test("selectThread to same thread is a no-op", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("a", true);

    tracker.selectThread("a", "a");
    advance(3000);
    expect(statusChanges).toEqual([]);
  });

  test("setAgentRunning pins working state and suppresses done timer", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("bg", true);

    tracker.setAgentRunning("bg", true, "other");
    expect(statusChanges).toEqual([{ id: "bg", status: "working" }]);

    // 2s passes — no done transition while agent still running
    advance(2000);
    expect(statusChanges).toEqual([{ id: "bg", status: "working" }]);

    // Further output does not schedule a done timer either
    tracker.markActive("bg", "other");
    advance(5000);
    expect(statusChanges).toEqual([{ id: "bg", status: "working" }]);
  });

  test("setAgentRunning(false) fires done if was working", () => {
    const { tracker, statusChanges } = setup();
    tracker.trackThread("bg", true);

    tracker.setAgentRunning("bg", true, "other");
    tracker.setAgentRunning("bg", false, "other");

    expect(statusChanges).toEqual([
      { id: "bg", status: "working" },
      { id: "bg", status: "done" },
    ]);
  });

  test("switching to a thread with agent running still resets to idle", () => {
    const { tracker, statusChanges } = setup();
    tracker.trackThread("a", true);
    tracker.trackThread("bg", true);

    tracker.setAgentRunning("bg", true, "a");
    expect(statusChanges).toEqual([{ id: "bg", status: "working" }]);
    statusChanges.length = 0;

    // User views the bg thread — status goes idle even though agent runs
    tracker.selectThread("bg", "a");
    expect(statusChanges).toEqual([{ id: "bg", status: "idle" }]);
  });

  test("switching away from a thread with agent running shows working", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("a", true);
    tracker.trackThread("bg", true);

    // bg is active, agent starts there (no status change — it's active)
    tracker.setAgentRunning("bg", true, "bg");
    expect(statusChanges).toEqual([]);

    // Switch away to "a" — bg should immediately show working
    tracker.selectThread("a", "bg");
    expect(statusChanges).toEqual([{ id: "bg", status: "working" }]);

    // Done timer stays suppressed while agent runs
    advance(5000);
    expect(statusChanges).toEqual([{ id: "bg", status: "working" }]);
  });

  test("setAgentRunning on active thread records state silently", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("a", true);

    tracker.setAgentRunning("a", true, "a");
    advance(5000);
    expect(statusChanges).toEqual([]);

    tracker.setAgentRunning("a", false, "a");
    expect(statusChanges).toEqual([]);
  });

  test("setAgentRunning is idempotent", () => {
    const { tracker, statusChanges } = setup();
    tracker.trackThread("bg", true);

    tracker.setAgentRunning("bg", true, "other");
    tracker.setAgentRunning("bg", true, "other");
    tracker.setAgentRunning("bg", true, "other");
    expect(statusChanges).toEqual([{ id: "bg", status: "working" }]);

    tracker.setAgentRunning("bg", false, "other");
    tracker.setAgentRunning("bg", false, "other");
    expect(statusChanges).toEqual([
      { id: "bg", status: "working" },
      { id: "bg", status: "done" },
    ]);
  });
});

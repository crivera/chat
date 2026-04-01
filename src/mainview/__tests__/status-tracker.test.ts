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
  test("periodic noise after thread switch does not trigger working/done", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("a", true);
    tracker.trackThread("b", true);

    // "a" is active, switch away from "b"
    tracker.selectThread("a", "b");

    // Wait for deactivatedAt guard to expire
    advance(2000);

    // Simulate periodic noise: 80 bytes every 1.5s (gap > 1s resets accumulator)
    for (let i = 0; i < 10; i++) {
      tracker.markActive("b", 80, "a");
      advance(1500);
    }

    // No status changes for "b" — accumulator reset each time
    expect(statusChanges).toEqual([]);
  });

  test("rapid background output triggers working then done", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("bg", true);

    // Rapid output: 50 bytes every 100ms, 6 events = 300 bytes
    for (let i = 0; i < 6; i++) {
      tracker.markActive("bg", 50, "other");
      advance(100);
    }

    expect(statusChanges).toEqual([{ id: "bg", status: "working" }]);

    // 2s idle → done
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

    // Output within 1500ms is ignored
    advance(500);
    tracker.markActive("b", 500, "a");
    advance(500);
    tracker.markActive("b", 500, "a");

    expect(statusChanges).toEqual([]);

    // After 1500ms, output is processed
    advance(600); // now at 1600ms total
    tracker.markActive("b", 300, "a");

    expect(statusChanges).toEqual([{ id: "b", status: "working" }]);
  });

  test("gap >1s between output events resets accumulator", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("bg", true);

    // 150 bytes
    tracker.markActive("bg", 150, "other");
    // Gap of 1.1s
    advance(1100);
    // 100 bytes — would be 250 total without reset, but gap resets to 100
    tracker.markActive("bg", 100, "other");
    // Wait for idle timer
    advance(2000);

    // No working or done — accumulated never reached 200 in a single burst
    expect(statusChanges).toEqual([]);
  });

  test("output under 200 bytes total does not trigger done", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("bg", true);

    // Send 150 bytes in rapid succession
    tracker.markActive("bg", 50, "other");
    advance(100);
    tracker.markActive("bg", 50, "other");
    advance(100);
    tracker.markActive("bg", 50, "other");

    // Wait for idle timer
    advance(2000);

    // No status changes — total < 200
    expect(statusChanges).toEqual([]);
  });

  test("thread already done ignores further output", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("bg", true);

    // Trigger working → done
    tracker.markActive("bg", 300, "other");
    advance(2000);
    expect(statusChanges).toEqual([
      { id: "bg", status: "working" },
      { id: "bg", status: "done" },
    ]);

    // More output after done — should be ignored
    statusChanges.length = 0;
    tracker.markActive("bg", 500, "other");
    advance(2000);

    expect(statusChanges).toEqual([]);
  });

  test("selectThread cleans up both previous and new thread", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("a", true);
    tracker.trackThread("b", true);

    // Get "b" into working state
    tracker.markActive("b", 300, "a");
    expect(statusChanges).toEqual([{ id: "b", status: "working" }]);
    statusChanges.length = 0;

    // Switch to "b" — should reset "b" to idle, deactivate "a"
    tracker.selectThread("b", "a");

    expect(statusChanges).toEqual([{ id: "b", status: "idle" }]);
    statusChanges.length = 0;

    // Immediate output to "a" should be blocked (deactivatedAt guard)
    tracker.markActive("a", 500, "b");
    expect(statusChanges).toEqual([]);

    // "b"'s idle timer should have been cleared (no "done" fires)
    advance(2000);
    expect(statusChanges).toEqual([]);
  });

  test("untitled threads are ignored", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("bg", false);

    tracker.markActive("bg", 500, "other");
    advance(2000);

    expect(statusChanges).toEqual([]);

    // After setting titled, output is processed
    tracker.setTitled("bg", true);
    tracker.markActive("bg", 300, "other");
    expect(statusChanges).toEqual([{ id: "bg", status: "working" }]);
  });

  test("active thread output is ignored", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("a", true);

    // Output for the active thread
    tracker.markActive("a", 500, "a");
    advance(2000);

    expect(statusChanges).toEqual([]);
  });

  test("rapid A→B→A switch does not leave stale state", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("a", true);
    tracker.trackThread("b", true);

    // Switch A→B, then immediately back B→A
    tracker.selectThread("b", "a");
    advance(100);
    tracker.selectThread("a", "b");

    // Both threads got deactivated then reactivated — no lingering timers
    advance(5000);
    expect(statusChanges).toEqual([]);

    // "b" should still be trackable after the rapid switch
    statusChanges.length = 0;
    advance(2000); // ensure deactivatedAt guard expires
    tracker.markActive("b", 300, "a");
    expect(statusChanges).toEqual([{ id: "b", status: "working" }]);
  });

  test("removeThread while working cancels pending done timer", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("bg", true);

    // Get into working state
    tracker.markActive("bg", 300, "other");
    expect(statusChanges).toEqual([{ id: "bg", status: "working" }]);
    statusChanges.length = 0;

    // Remove thread before idle timer fires
    tracker.removeThread("bg");
    advance(3000);

    // No "done" transition — timer was cancelled
    expect(statusChanges).toEqual([]);
  });

  test("done thread can cycle back to working after re-selection", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("a", true);
    tracker.trackThread("bg", true);

    // bg goes working → done
    tracker.markActive("bg", 300, "a");
    advance(2000);
    expect(statusChanges).toEqual([
      { id: "bg", status: "working" },
      { id: "bg", status: "done" },
    ]);
    statusChanges.length = 0;

    // User views bg (resets to idle), then switches back to a
    tracker.selectThread("bg", "a");
    expect(statusChanges).toEqual([{ id: "bg", status: "idle" }]);
    statusChanges.length = 0;

    tracker.selectThread("a", "bg");
    advance(2000); // wait out deactivatedAt guard

    // bg can now trigger working → done again
    tracker.markActive("bg", 400, "a");
    advance(2000);
    expect(statusChanges).toEqual([
      { id: "bg", status: "working" },
      { id: "bg", status: "done" },
    ]);
  });

  test("multiple background threads track independently", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("active", true);
    tracker.trackThread("bg1", true);
    tracker.trackThread("bg2", true);

    // bg1 gets heavy output, bg2 gets noise
    tracker.markActive("bg1", 300, "active");
    tracker.markActive("bg2", 50, "active");
    advance(1500);
    tracker.markActive("bg2", 50, "active"); // gap > 1s, resets

    // Only bg1 should be working
    expect(statusChanges).toEqual([{ id: "bg1", status: "working" }]);
    statusChanges.length = 0;

    // bg1 goes done, bg2 still nothing
    advance(2000);
    expect(statusChanges).toEqual([{ id: "bg1", status: "done" }]);
  });

  test("continuous output keeps thread in working state", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("bg", true);

    // Initial burst triggers working
    tracker.markActive("bg", 300, "other");
    expect(statusChanges).toEqual([{ id: "bg", status: "working" }]);
    statusChanges.length = 0;

    // Output keeps arriving every 500ms for 10 seconds — timer keeps resetting
    for (let i = 0; i < 20; i++) {
      advance(500);
      tracker.markActive("bg", 100, "other");
    }

    // Still only "working", no premature "done"
    expect(statusChanges).toEqual([]);

    // Now stop — done fires after 2s
    advance(2000);
    expect(statusChanges).toEqual([{ id: "bg", status: "done" }]);
  });

  test("exactly 200 bytes triggers working", () => {
    const { tracker, statusChanges } = setup();
    tracker.trackThread("bg", true);

    tracker.markActive("bg", 199, "other");
    expect(statusChanges).toEqual([]);

    tracker.markActive("bg", 1, "other");
    expect(statusChanges).toEqual([{ id: "bg", status: "working" }]);
  });

  test("selectThread with null prevId (first selection)", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("a", true);

    // First selection — no previous thread
    tracker.selectThread("a", null);
    advance(3000);

    // No crashes, no status changes
    expect(statusChanges).toEqual([]);
  });

  test("selectThread to same thread is a no-op", () => {
    const { tracker, advance, statusChanges } = setup();
    tracker.trackThread("a", true);

    tracker.selectThread("a", "a");
    advance(3000);

    expect(statusChanges).toEqual([]);
  });
});

import { describe, test, expect } from "bun:test";

/**
 * Tests for auto-update behavior.
 *
 * The fix: when an update is ready and terminals are open, don't auto-apply.
 * Instead, notify the frontend and let the user decide when to restart.
 * If no terminals are open, apply immediately.
 */

interface MockUpdater {
  updateAvailable: boolean;
  updateReady: boolean;
  applied: boolean;
  checkForUpdate(): Promise<{ updateAvailable: boolean }>;
  downloadUpdate(): Promise<void>;
  updateInfo(): { updateReady: boolean };
  applyUpdate(): Promise<void>;
}

function createMockUpdater(opts?: {
  available?: boolean;
  ready?: boolean;
}): MockUpdater {
  return {
    updateAvailable: opts?.available ?? true,
    updateReady: opts?.ready ?? true,
    applied: false,
    async checkForUpdate() {
      return { updateAvailable: this.updateAvailable };
    },
    async downloadUpdate() {},
    updateInfo() {
      return { updateReady: this.updateReady };
    },
    async applyUpdate() {
      this.applied = true;
    },
  };
}

/**
 * Mirrors the fixed checkForUpdates logic from src/bun/index.ts.
 */
function createUpdateManager(updater: MockUpdater) {
  const terminals = new Map<string, unknown>();
  const messages: string[] = [];
  let updatePending = false;

  async function checkForUpdates() {
    if (updatePending) return;
    const result = await updater.checkForUpdate();
    if (result.updateAvailable) {
      messages.push("downloading");
      await updater.downloadUpdate();
      const info = updater.updateInfo();
      if (info.updateReady) {
        if (terminals.size === 0) {
          messages.push("applying");
          await updater.applyUpdate();
        } else {
          updatePending = true;
          messages.push("updateReady");
        }
      }
    }
  }

  return {
    terminals,
    messages,
    checkForUpdates,
    getUpdatePending: () => updatePending,
  };
}

describe("Auto-update", () => {
  test("applies immediately when no terminals are open", async () => {
    const updater = createMockUpdater();
    const mgr = createUpdateManager(updater);

    await mgr.checkForUpdates();

    expect(mgr.messages).toEqual(["downloading", "applying"]);
    expect(updater.applied).toBe(true);
  });

  test("defers update when terminals are open", async () => {
    const updater = createMockUpdater();
    const mgr = createUpdateManager(updater);
    mgr.terminals.set("1", {});

    await mgr.checkForUpdates();

    expect(mgr.messages).toEqual(["downloading", "updateReady"]);
    expect(updater.applied).toBe(false);
  });

  test("skips check when update is already pending", async () => {
    const updater = createMockUpdater();
    const mgr = createUpdateManager(updater);
    mgr.terminals.set("1", {});

    await mgr.checkForUpdates();
    expect(mgr.messages).toEqual(["downloading", "updateReady"]);

    // Second check should be skipped entirely
    mgr.messages.length = 0;
    await mgr.checkForUpdates();
    expect(mgr.messages).toEqual([]);
  });

  test("does nothing when no update is available", async () => {
    const updater = createMockUpdater({ available: false });
    const mgr = createUpdateManager(updater);

    await mgr.checkForUpdates();

    expect(mgr.messages).toEqual([]);
    expect(updater.applied).toBe(false);
  });

  test("does not apply when download succeeds but update is not ready", async () => {
    const updater = createMockUpdater({ available: true, ready: false });
    const mgr = createUpdateManager(updater);

    await mgr.checkForUpdates();

    expect(mgr.messages).toEqual(["downloading"]);
    expect(updater.applied).toBe(false);
  });
});

import { describe, test, expect } from "bun:test";

/**
 * Tests for PTY terminal lifecycle race conditions.
 *
 * The crash (EXC_BREAKPOINT on Worker thread) was caused by:
 * 1. closeTerminal calling pty.kill() while terminal was still in the map,
 *    allowing concurrent write/resize to hit a dying PTY
 * 2. No try/catch around pty.write() and pty.resize()
 * 3. onExit double-cleaning up after closeTerminal already handled it
 *
 * These tests exercise the coordination logic using a mock PTY.
 */

interface MockPty {
  killed: boolean;
  written: string[];
  resizes: { cols: number; rows: number }[];
  onDataCb: ((data: string) => void) | null;
  onExitCb: (() => void) | null;
  killError: boolean;
  writeError: boolean;
  resizeError: boolean;
  kill(): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: () => void): void;
}

function createMockPty(opts?: {
  killError?: boolean;
  writeError?: boolean;
  resizeError?: boolean;
}): MockPty {
  const pty: MockPty = {
    killed: false,
    written: [],
    resizes: [],
    onDataCb: null,
    onExitCb: null,
    killError: opts?.killError ?? false,
    writeError: opts?.writeError ?? false,
    resizeError: opts?.resizeError ?? false,
    kill() {
      if (this.killError) throw new Error("PTY already dead");
      this.killed = true;
    },
    write(data: string) {
      if (this.writeError) throw new Error("PTY write failed");
      this.written.push(data);
    },
    resize(cols: number, rows: number) {
      if (this.resizeError) throw new Error("PTY resize failed");
      this.resizes.push({ cols, rows });
    },
    onData(cb) {
      this.onDataCb = cb;
    },
    onExit(cb) {
      this.onExitCb = cb;
    },
  };
  return pty;
}

interface Terminal {
  id: string;
  pty: MockPty;
}

/**
 * Simulates the terminal management logic from src/bun/index.ts.
 * Mirrors the fixed code: map-remove-first ordering, try/catch guards,
 * and onExit deduplication.
 */
function createTerminalManager() {
  const terminals = new Map<string, Terminal>();
  const exits: string[] = [];

  function addTerminal(id: string, pty: MockPty): void {
    terminals.set(id, { id, pty });
    pty.onExit(() => {
      // Guard: closeTerminal may have already cleaned up
      if (terminals.has(id)) {
        terminals.delete(id);
      }
      exits.push(id);
    });
  }

  function closeTerminal(id: string): void {
    const terminal = terminals.get(id);
    if (terminal) {
      // Remove from map first to prevent write/resize calls during teardown
      terminals.delete(id);
      try {
        terminal.pty.kill();
      } catch {
        // PTY may already be dead
      }
    }
  }

  function terminalInput(id: string, data: string): void {
    const terminal = terminals.get(id);
    if (terminal) {
      try {
        terminal.pty.write(data);
      } catch {
        // PTY may have exited between the check and the write
      }
    }
  }

  function terminalResize(id: string, cols: number, rows: number): void {
    const terminal = terminals.get(id);
    if (terminal) {
      try {
        terminal.pty.resize(cols, rows);
      } catch {
        // PTY may have exited between the check and the resize
      }
    }
  }

  return {
    terminals,
    exits,
    addTerminal,
    closeTerminal,
    terminalInput,
    terminalResize,
  };
}

describe("Terminal lifecycle", () => {
  test("closeTerminal removes from map before killing PTY", () => {
    const mgr = createTerminalManager();
    let wasInMapDuringKill = true;
    const pty = createMockPty();

    // Override kill to check map state at kill time
    const origKill = pty.kill.bind(pty);
    pty.kill = () => {
      wasInMapDuringKill = mgr.terminals.has("1");
      origKill();
    };

    mgr.addTerminal("1", pty);
    mgr.closeTerminal("1");

    expect(wasInMapDuringKill).toBe(false);
    expect(pty.killed).toBe(true);
    expect(mgr.terminals.has("1")).toBe(false);
  });

  test("closeTerminal catches error when PTY is already dead", () => {
    const mgr = createTerminalManager();
    const pty = createMockPty({ killError: true });
    mgr.addTerminal("1", pty);

    // Should not throw
    expect(() => mgr.closeTerminal("1")).not.toThrow();
    expect(mgr.terminals.has("1")).toBe(false);
  });

  test("terminalInput catches error when PTY write fails", () => {
    const mgr = createTerminalManager();
    const pty = createMockPty({ writeError: true });
    mgr.addTerminal("1", pty);

    // Should not throw
    expect(() => mgr.terminalInput("1", "hello")).not.toThrow();
  });

  test("terminalResize catches error when PTY resize fails", () => {
    const mgr = createTerminalManager();
    const pty = createMockPty({ resizeError: true });
    mgr.addTerminal("1", pty);

    // Should not throw
    expect(() => mgr.terminalResize("1", 80, 24)).not.toThrow();
  });

  test("terminalInput is no-op for unknown terminal", () => {
    const mgr = createTerminalManager();

    expect(() => mgr.terminalInput("nonexistent", "data")).not.toThrow();
  });

  test("terminalResize is no-op for unknown terminal", () => {
    const mgr = createTerminalManager();

    expect(() => mgr.terminalResize("nonexistent", 80, 24)).not.toThrow();
  });

  test("onExit skips cleanup when closeTerminal already handled it", () => {
    const mgr = createTerminalManager();
    const pty = createMockPty();
    mgr.addTerminal("1", pty);

    // closeTerminal removes from map and kills
    mgr.closeTerminal("1");
    expect(mgr.terminals.has("1")).toBe(false);

    // Simulate onExit firing after closeTerminal
    pty.onExitCb!();

    // Should still record the exit event (for frontend notification)
    expect(mgr.exits).toEqual(["1"]);
    // But should not crash or error
  });

  test("onExit cleans up when terminal exits naturally (no closeTerminal)", () => {
    const mgr = createTerminalManager();
    const pty = createMockPty();
    mgr.addTerminal("1", pty);

    expect(mgr.terminals.has("1")).toBe(true);

    // Simulate natural PTY exit
    pty.onExitCb!();

    expect(mgr.terminals.has("1")).toBe(false);
    expect(mgr.exits).toEqual(["1"]);
  });

  test("write after closeTerminal is a no-op (race window)", () => {
    const mgr = createTerminalManager();
    const pty = createMockPty();
    mgr.addTerminal("1", pty);

    mgr.closeTerminal("1");

    // Simulate a write arriving after close but before the frontend knows
    mgr.terminalInput("1", "late data");

    expect(pty.written).toEqual([]);
  });

  test("resize after closeTerminal is a no-op (race window)", () => {
    const mgr = createTerminalManager();
    const pty = createMockPty();
    mgr.addTerminal("1", pty);

    mgr.closeTerminal("1");

    mgr.terminalResize("1", 120, 40);

    expect(pty.resizes).toEqual([]);
  });

  test("closeTerminal on already-closed terminal is a no-op", () => {
    const mgr = createTerminalManager();
    const pty = createMockPty();
    mgr.addTerminal("1", pty);

    mgr.closeTerminal("1");
    // Double close should not throw
    expect(() => mgr.closeTerminal("1")).not.toThrow();
  });
});

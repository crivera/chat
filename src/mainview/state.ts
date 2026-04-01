import { signal, computed } from "@preact/signals";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

// --- Types ---

export interface ThreadData {
  id: string;
  name: string;
  folderPath: string;
  title: string;
  titled: boolean;
  status: "idle" | "working" | "done";
  inputBuffer: string;
}

export interface DetectedPrompt {
  id: string;
  threadTitle: string;
  folderName: string;
  question: string;
  options: { label: string; keystroke: string }[];
}

export interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
}

export interface FolderGroupData {
  folderPath: string;
  name: string;
  threads: ThreadData[];
}

// --- Imperative stores ---

export const terminalInstances = new Map<string, TerminalInstance>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const outputAccumulators = new Map<string, number>();
const deactivatedAt = new Map<string, number>();
const notifiedDone = new Set<string>();
let lastNotifiedThreadId: string | null = null;
let lastNotifiedAt = 0;

// When the window regains focus after a notification, switch to that thread
window.addEventListener("focus", () => {
  if (lastNotifiedThreadId && Date.now() - lastNotifiedAt < 30000) {
    const id = lastNotifiedThreadId;
    lastNotifiedThreadId = null;
    lastNotifiedAt = 0;
    if (threads.value.has(id)) {
      selectThread(id);
    }
  } else {
    lastNotifiedThreadId = null;
    lastNotifiedAt = 0;
  }
});
const promptCheckTimers = new Map<string, ReturnType<typeof setTimeout>>();
const promptCooldowns = new Map<string, number>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let rpc: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function initRpc(r: any) {
  rpc = r;
}

// --- Signals ---

export const threads = signal<Map<string, ThreadData>>(new Map());
export const activeId = signal<string | null>(null);
export const settingsOpen = signal(false);
export const browserUrl = signal<string | null>(null);
export const collapsedFolders = signal<Set<string>>(new Set());
export const activePrompts = signal<Map<string, DetectedPrompt>>(new Map());

// --- Computed ---

export const folderGroups = computed<FolderGroupData[]>(() => {
  const groups = new Map<string, FolderGroupData>();
  for (const thread of threads.value.values()) {
    let group = groups.get(thread.folderPath);
    if (!group) {
      group = { folderPath: thread.folderPath, name: thread.name, threads: [] };
      groups.set(thread.folderPath, group);
    }
    group.threads.push(thread);
  }
  return [...groups.values()];
});

// --- Internal helpers ---

function updateThread(id: string, updates: Partial<ThreadData>) {
  const map = new Map(threads.value);
  const thread = map.get(id);
  if (!thread) return;
  map.set(id, { ...thread, ...updates });
  threads.value = map;
}

// --- Thread navigation ---

export function getAllThreadsOrdered(): ThreadData[] {
  const result: ThreadData[] = [];
  for (const group of folderGroups.value) {
    result.push(...group.threads);
  }
  return result;
}

export function cycleThread(direction: 1 | -1) {
  const all = getAllThreadsOrdered();
  if (all.length <= 1) return;
  const currentIdx = all.findIndex((t) => t.id === activeId.value);
  const nextIdx = (currentIdx + direction + all.length) % all.length;
  selectThread(all[nextIdx].id);
}

export function selectThreadByIndex(index: number) {
  const all = getAllThreadsOrdered();
  if (index < all.length) {
    selectThread(all[index].id);
  }
}

// --- Thread actions ---

export function addThread(
  id: string,
  name: string,
  folderPath: string,
  title?: string,
  isLast?: boolean,
) {
  const map = new Map(threads.value);
  map.set(id, {
    id,
    name,
    folderPath,
    title: title || "New thread",
    titled: !!title,
    status: "idle",
    inputBuffer: "",
  });
  threads.value = map;

  // Suppress the first "done" notification for restored threads
  if (title) notifiedDone.add(id);

  const collapsed = new Set(collapsedFolders.value);
  if (isLast === false) {
    // Restored non-active thread: start collapsed
    collapsed.add(folderPath);
  } else {
    // New thread or last-active restored thread: expand
    collapsed.delete(folderPath);
  }
  collapsedFolders.value = collapsed;
}

export function removeThread(id: string) {
  const map = new Map(threads.value);
  map.delete(id);
  threads.value = map;

  const instance = terminalInstances.get(id);
  if (instance) {
    instance.terminal.dispose();
    instance.container.remove();
    terminalInstances.delete(id);
  }

  const timer = idleTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    idleTimers.delete(id);
  }
  outputAccumulators.delete(id);
  deactivatedAt.delete(id);
  notifiedDone.delete(id);

  const checkTimer = promptCheckTimers.get(id);
  if (checkTimer) {
    clearTimeout(checkTimer);
    promptCheckTimers.delete(id);
  }
  promptCooldowns.delete(id);
  dismissPrompt(id);

  if (activeId.value === id) {
    if (browserUrl.value) closeBrowser();
    const remaining = [...map.keys()];
    if (remaining.length > 0) {
      selectThread(remaining[0]);
    } else {
      activeId.value = null;
    }
  }
}

export function markActive(id: string, dataLen: number) {
  const thread = threads.value.get(id);
  if (!thread || id === activeId.value || !thread.titled) return;

  // Already done — don't re-trigger the working→done cycle from noise
  if (thread.status === "done") return;

  // Ignore residual output right after switching away from this thread
  const deactivated = deactivatedAt.get(id);
  if (deactivated) {
    if (Date.now() - deactivated < 1500) return;
    deactivatedAt.delete(id);
  }

  // Accumulate output volume to distinguish real work from terminal noise
  const accumulated = (outputAccumulators.get(id) || 0) + dataLen;
  outputAccumulators.set(id, accumulated);

  const existing = idleTimers.get(id);
  if (existing) clearTimeout(existing);

  // Only show "working" once enough output has accumulated to indicate real activity
  if (accumulated >= 200 && thread.status !== "working") {
    updateThread(id, { status: "working" });
  }

  idleTimers.set(
    id,
    setTimeout(() => {
      idleTimers.delete(id);
      const total = outputAccumulators.get(id) || 0;
      outputAccumulators.delete(id);

      // Trivial output (cursor moves, spinner, title sequences) — stay idle
      if (total < 200) {
        return;
      }

      updateThread(id, { status: "done" });
      if (!document.hasFocus() && !notifiedDone.has(id)) {
        const thread = threads.value.get(id);
        if (thread) {
          notifiedDone.add(id);
          lastNotifiedThreadId = id;
          lastNotifiedAt = Date.now();
          rpc.send.requestAttention({
            title: `Chat — ${thread.name}`,
            body: `${thread.title || "Thread"} is ready`,
          });
        }
      }
    }, 2000),
  );
}

export function selectThread(id: string) {
  if (browserUrl.value) closeBrowser();
  dismissPrompt(id);

  // Reset tracking for the thread we're leaving so residual output
  // doesn't trigger a false working→done cycle
  const prevId = activeId.value;
  if (prevId && prevId !== id) {
    const prevTimer = idleTimers.get(prevId);
    if (prevTimer) {
      clearTimeout(prevTimer);
      idleTimers.delete(prevId);
    }
    outputAccumulators.delete(prevId);
    deactivatedAt.set(prevId, Date.now());
    const prevThread = threads.value.get(prevId);
    if (prevThread && prevThread.status === "working") {
      updateThread(prevId, { status: "idle" });
    }
  }

  activeId.value = id;
  rpc.send.setActiveThread({ id });

  const timer = idleTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    idleTimers.delete(id);
  }
  outputAccumulators.delete(id);
  notifiedDone.delete(id);
  lastNotifiedThreadId = null;
  const thread = threads.value.get(id);
  if (thread && thread.status !== "idle") {
    updateThread(id, { status: "idle" });
  }

  for (const [entryId, instance] of terminalInstances) {
    instance.container.classList.toggle("active", entryId === id);
  }

  const instance = terminalInstances.get(id);
  if (instance) {
    requestAnimationFrame(() => {
      instance.fitAddon.fit();
      instance.terminal.focus();
    });
  }
}

export function handleTerminalInput(id: string, data: string) {
  const thread = threads.value.get(id);
  if (!thread || thread.titled) return;

  if (data === "\r" || data === "\n") {
    const title = thread.inputBuffer.trim();
    if (title.length > 0) {
      const displayTitle =
        title.length > 40 ? title.slice(0, 40) + "\u2026" : title;
      updateThread(id, {
        titled: true,
        title: displayTitle,
        inputBuffer: "",
      });
      rpc.send.setThreadTitle({ id, title: displayTitle });
    } else {
      updateThread(id, { inputBuffer: "" });
    }
  } else if (data === "\x7f") {
    updateThread(id, { inputBuffer: thread.inputBuffer.slice(0, -1) });
  } else if (data.length === 1 && data >= " ") {
    updateThread(id, { inputBuffer: thread.inputBuffer + data });
  } else if (data.length > 1 && !data.includes("\x1b")) {
    updateThread(id, { inputBuffer: thread.inputBuffer + data });
  }
}

export function toggleFolderCollapsed(folderPath: string) {
  const next = new Set(collapsedFolders.value);
  if (next.has(folderPath)) next.delete(folderPath);
  else next.add(folderPath);
  collapsedFolders.value = next;
}

// --- RPC wrappers ---

export async function openFolderDialog() {
  const folderPath = await rpc.request.openFolderDialog({});
  if (folderPath) rpc.send.openTerminal({ folderPath });
}

export function openNewTerminal(folderPath: string) {
  rpc.send.openTerminal({ folderPath });
}

export function closeTerminal(id: string) {
  rpc.send.closeTerminal({ id });
  removeThread(id);
}

export function sendTerminalInput(id: string, data: string) {
  rpc.send.terminalInput({ id, data });
}

export function sendTerminalResize(id: string, cols: number, rows: number) {
  rpc.send.terminalResize({ id, cols, rows });
}

export function shellAction(action: string) {
  if (activeId.value) {
    rpc.send.shellAction({ id: activeId.value, action });
  }
}

export async function showBrowser(url: string) {
  const frameable = await rpc.request.checkFrameable({ url });
  if (!frameable) {
    openExternal(url);
    return;
  }
  if (browserUrl.value) {
    browserUrl.value = url;
    return;
  }
  browserUrl.value = url;
  for (const instance of terminalInstances.values()) {
    instance.container.style.display = "none";
  }
}

export function closeBrowser() {
  if (!browserUrl.value) return;
  browserUrl.value = null;
  for (const instance of terminalInstances.values()) {
    instance.container.style.display = "";
  }
  if (activeId.value) {
    const instance = terminalInstances.get(activeId.value);
    if (instance) {
      instance.container.classList.add("active");
      requestAnimationFrame(() => {
        instance.fitAddon.fit();
        instance.terminal.focus();
      });
    }
  }
  rpc.send.closeBrowser({});
}

export function openExternal(url: string) {
  closeBrowser();
  rpc.send.openExternal({ url });
}

export async function getAppInfo() {
  return rpc.request.getAppInfo({});
}

export async function getSettings() {
  return rpc.request.getSettings({});
}

export async function setSettings(s: { useWorktree: boolean }) {
  return rpc.request.setSettings(s);
}

export function refitAllTerminals() {
  for (const instance of terminalInstances.values()) {
    instance.fitAddon.fit();
  }
}

export function refitActiveTerminal() {
  if (activeId.value) {
    const instance = terminalInstances.get(activeId.value);
    if (instance) instance.fitAddon.fit();
  }
}

// --- Prompt detection ---

export function schedulePromptCheck(id: string) {
  const existing = promptCheckTimers.get(id);
  if (existing) clearTimeout(existing);

  promptCheckTimers.set(
    id,
    setTimeout(() => {
      promptCheckTimers.delete(id);
      const cooldown = promptCooldowns.get(id);
      if (cooldown && Date.now() < cooldown) return;
      runPromptCheck(id);
    }, 300),
  );
}

function runPromptCheck(id: string) {
  const thread = threads.value.get(id);
  if (!thread) return;

  // Only show popups for background terminals
  if (id === activeId.value) {
    // Dismiss if it was previously showing (user switched to this terminal)
    if (activePrompts.value.has(id)) dismissPrompt(id);
    return;
  }

  const instance = terminalInstances.get(id);
  if (!instance) return;

  const buffer = instance.terminal.buffer.active;
  const lines: string[] = [];
  const cursorRow = buffer.baseY + buffer.cursorY;
  const startRow = Math.max(0, cursorRow - 24);

  for (let i = startRow; i <= cursorRow; i++) {
    const line = buffer.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }

  const detected = detectPromptPattern(lines);
  const map = new Map(activePrompts.value);

  if (detected) {
    const isNew = !activePrompts.value.has(id);
    map.set(id, {
      id,
      threadTitle: thread.title,
      folderName: thread.name,
      question: detected.question,
      options: detected.options,
    });
    if (isNew && !document.hasFocus()) {
      lastNotifiedThreadId = id;
      lastNotifiedAt = Date.now();
      rpc.send.requestAttention({
        title: `Chat — ${thread.name}`,
        body: detected.question,
      });
    }
  } else {
    if (!map.has(id)) return;
    map.delete(id);
  }

  activePrompts.value = map;
}

function detectPromptPattern(lines: string[]): {
  question: string;
  options: { label: string; keystroke: string }[];
} | null {
  const recentText = lines.join("\n");

  // --- Pattern: Numbered selection list ---
  // "Enter to select · ↑/↓ to navigate · Esc to cancel"
  if (/Enter to select/.test(recentText)) {
    const numbered: { num: number; label: string }[] = [];
    for (const line of lines) {
      const m = line.match(/^\s*(?:[❯›>]\s+)?(\d+)\.\s+(.+)$/);
      if (m) numbered.push({ num: parseInt(m[1]), label: m[2].trim() });
    }

    if (numbered.length > 0) {
      const DOWN = "\x1b[B";

      // Cursor starts at item 1; send (num-1) downs then Enter
      // Options requiring text input navigate to the terminal instead
      const textInputLabels = /^(type something|chat about this)\.?$/i;
      const options = numbered.map((opt) => ({
        label: opt.label,
        keystroke: textInputLabels.test(opt.label)
          ? "goto:" + DOWN.repeat(opt.num - 1) + "\r"
          : DOWN.repeat(opt.num - 1) + "\r",
      }));
      options.push({ label: "Cancel", keystroke: "\x1b" });

      let question = "Select an option";
      for (const line of lines) {
        const t = line.trim();
        if (t.endsWith("?") && t.length > 10 && !/^\d+\./.test(t)) {
          question = t;
          break;
        }
      }

      return { question, options };
    }
  }

  // --- Pattern: Yes/No permission prompts ---
  const recentLines = lines.slice(-10);
  const recentBottom = recentLines.join("\n");

  const hasOptionLine = recentLines.some((line) => {
    const t = line.trim();
    return /\bYes\b/.test(t) && /\bNo\b/.test(t);
  });

  const hasBracketYN = /[\[(][Yy]\/[Nn](?:\/[Aa])?[\])]/.test(recentBottom);

  if (!hasOptionLine && !hasBracketYN) return null;

  const hasAlways = /\bAlways\b/i.test(recentBottom);

  const options: { label: string; keystroke: string }[] = [
    { label: "Yes", keystroke: "y" },
    { label: "No", keystroke: "n" },
  ];
  if (hasAlways) {
    options.push({ label: "Always", keystroke: "a" });
  }

  // Try to extract the question — "Allow <tool> <path>?"
  const allowMatch = recentBottom.match(
    /(?:⎿\s*)?(?:Allow|Approve)\s+(.+?)(?:\?|$)/m,
  );
  if (allowMatch) {
    const q = allowMatch[1].trim().replace(/\?$/, "");
    return { question: `Allow ${q}?`, options };
  }

  // Line ending with "?"
  for (
    let i = recentLines.length - 1;
    i >= Math.max(0, recentLines.length - 6);
    i--
  ) {
    const line = recentLines[i].trim();
    if (line.endsWith("?") && line.length > 3) {
      return { question: line, options };
    }
  }

  // Bracket pattern: "something [Y/n]"
  if (hasBracketYN) {
    const match = recentBottom.match(
      /(.{3,80}?)\s*[\[(][Yy]\/[Nn](?:\/[Aa])?[\])]/,
    );
    if (match) {
      return { question: match[1].trim(), options };
    }
  }

  return { question: "Action required", options };
}

export function respondToPrompt(id: string, keystroke: string) {
  dismissPrompt(id);
  promptCooldowns.set(id, Date.now() + 2000);

  // Options prefixed with "goto:" select the option then switch to terminal
  const isGoto = keystroke.startsWith("goto:");
  if (isGoto) keystroke = keystroke.slice(5);

  // Split into individual escape sequences/characters and stagger sends
  // so ink processes each keypress separately
  const parts: string[] = [];
  let i = 0;
  while (i < keystroke.length) {
    if (keystroke[i] === "\x1b" && i + 2 < keystroke.length) {
      parts.push(keystroke.slice(i, i + 3));
      i += 3;
    } else {
      parts.push(keystroke[i]);
      i++;
    }
  }

  parts.forEach((part, idx) => {
    if (idx === 0) sendTerminalInput(id, part);
    else setTimeout(() => sendTerminalInput(id, part), idx * 30);
  });

  if (isGoto) {
    // Switch to terminal after keystrokes are sent
    setTimeout(() => selectThread(id), parts.length * 30 + 50);
  }
}

export function dismissPrompt(id: string) {
  const map = new Map(activePrompts.value);
  if (!map.has(id)) return;
  map.delete(id);
  activePrompts.value = map;
}

export function dismissPromptOnInput(id: string) {
  if (activePrompts.value.has(id)) {
    dismissPrompt(id);
    promptCooldowns.set(id, Date.now() + 2000);
  }
}

// --- Toast (vanilla DOM) ---

export function showToast(title: string, body: string, ok: boolean) {
  const toast = document.createElement("div");
  toast.className = `toast ${ok ? "toast-ok" : "toast-err"}`;
  toast.innerHTML = `<strong>${title}</strong><pre>${body}</pre>`;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("toast-visible"));
  setTimeout(() => {
    toast.classList.remove("toast-visible");
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

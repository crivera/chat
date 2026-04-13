import { signal, computed } from "@preact/signals";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { StatusTracker } from "./status-tracker";

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
const notifiedDone = new Set<string>();
let lastNotifiedThreadId: string | null = null;
let lastNotifiedAt = 0;

const statusTracker = new StatusTracker({
  onStatusChange(id, status) {
    updateThread(id, { status });
    if (status === "done" && !document.hasFocus() && !notifiedDone.has(id)) {
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
  },
});

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
export const restoring = signal(false);
export const updateReady = signal(false);
export const branchChange = signal<{ id: string; branch: string } | null>(null);
export const branchReload = signal(0);

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
  statusTracker.trackThread(id, !!title);

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

  statusTracker.removeThread(id);
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

export function markActive(id: string) {
  statusTracker.markActive(id, activeId.value);
}

export function selectThread(id: string) {
  if (browserUrl.value) closeBrowser();
  dismissPrompt(id);

  statusTracker.selectThread(id, activeId.value);

  activeId.value = id;
  rpc.send.setActiveThread({ id });

  notifiedDone.delete(id);
  lastNotifiedThreadId = null;

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
      statusTracker.setTitled(id, true);
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

export async function getBranches(): Promise<{
  current: string;
  branches: string[];
}> {
  if (!activeId.value) return { current: "", branches: [] };
  return rpc.request.getBranches({ id: activeId.value });
}

export async function checkoutBranch(
  branch: string,
): Promise<{ ok: boolean; output: string }> {
  if (!activeId.value) return { ok: false, output: "No active terminal" };
  return rpc.request.checkoutBranch({ id: activeId.value, branch });
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

export async function getCustomCommand(
  folderPath: string,
): Promise<{ label: string; command: string } | null> {
  return rpc.request.getCustomCommand({ folderPath });
}

export async function setCustomCommand(
  folderPath: string,
  label: string,
  command: string,
) {
  return rpc.request.setCustomCommand({ folderPath, label, command });
}

export async function clearCustomCommand(folderPath: string) {
  return rpc.request.clearCustomCommand({ folderPath });
}

export function runCustomCommand(command: string) {
  if (!activeId.value) return;
  sendTerminalInput(activeId.value, command + "\n");
}

export function setUpdateReady() {
  updateReady.value = true;
}

export function applyUpdate() {
  rpc.send.applyUpdate({});
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

  // Local-agent detection: pin "working" while background agents run
  const agentRunning = /\b\d+\s+local agents?\b/i.test(lines.join("\n"));
  statusTracker.setAgentRunning(id, agentRunning, activeId.value);

  // Prompt popups are only for background terminals
  if (id === activeId.value) {
    if (activePrompts.value.has(id)) dismissPrompt(id);
    return;
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

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

// --- Thread actions ---

export function addThread(id: string, name: string, folderPath: string) {
  const map = new Map(threads.value);
  map.set(id, {
    id,
    name,
    folderPath,
    title: "New thread",
    titled: false,
    status: "idle",
    inputBuffer: "",
  });
  threads.value = map;

  // Auto-expand folder
  const collapsed = new Set(collapsedFolders.value);
  collapsed.delete(folderPath);
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
  const thread = threads.value.get(id);
  if (!thread || id === activeId.value || !thread.titled) return;

  const existing = idleTimers.get(id);
  if (existing) clearTimeout(existing);

  updateThread(id, { status: "working" });

  idleTimers.set(
    id,
    setTimeout(() => {
      updateThread(id, { status: "done" });
      idleTimers.delete(id);
    }, 2000),
  );
}

export function selectThread(id: string) {
  if (browserUrl.value) closeBrowser();

  activeId.value = id;

  const timer = idleTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    idleTimers.delete(id);
  }
  updateThread(id, { status: "idle" });

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
      updateThread(id, {
        titled: true,
        title: title.length > 40 ? title.slice(0, 40) + "\u2026" : title,
        inputBuffer: "",
      });
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

export function showBrowser(url: string) {
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

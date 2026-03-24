import { Electroview, type RPCSchema } from "electrobun/view";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";

type Schema = {
  bun: RPCSchema<{
    requests: {
      openFolderDialog: {
        params: Record<string, never>;
        response: string | null;
      };
      getAppInfo: {
        params: Record<string, never>;
        response: { version: string };
      };
      getSettings: {
        params: Record<string, never>;
        response: { useWorktree: boolean };
      };
      setSettings: {
        params: { useWorktree: boolean };
        response: void;
      };
    };
    messages: {
      minimizeWindow: Record<string, never>;
      maximizeWindow: Record<string, never>;
      closeWindow: Record<string, never>;
      openTerminal: { folderPath: string };
      closeTerminal: { id: string };
      terminalInput: { id: string; data: string };
      terminalResize: { id: string; cols: number; rows: number };
      shellAction: { id: string; action: string };
      closeBrowser: Record<string, never>;
      openExternal: { url: string };
    };
  }>;
  webview: RPCSchema<{
    requests: {
      confirmAction: {
        params: { message: string };
        response: boolean;
      };
    };
    messages: {
      terminalReady: { id: string; name: string; folderPath: string };
      terminalOutput: { id: string; data: string };
      terminalExit: { id: string };
      actionResult: {
        id: string;
        action: string;
        output: string;
        ok: boolean;
      };
      updateToast: { message: string };
      refitTerminals: Record<string, never>;
      browserOpen: { url: string };
    };
  }>;
};

const rpc = Electroview.defineRPC<Schema>({
  maxRequestTime: 120000,
  handlers: {
    requests: {
      confirmAction: ({ message }: { message: string }) => {
        return confirm(message);
      },
    },
    messages: {
      terminalReady: ({
        id,
        name,
        folderPath,
      }: {
        id: string;
        name: string;
        folderPath: string;
      }) => {
        setupTerminalUI(id, name, folderPath);
      },
      terminalOutput: ({ id, data }: { id: string; data: string }) => {
        const entry = terminals.get(id);
        if (entry) {
          entry.terminal.write(data);
          markActive(id);
        }
      },
      terminalExit: ({ id }: { id: string }) => {
        removeProject(id);
      },
      actionResult: ({
        action,
        output,
        ok,
      }: {
        id: string;
        action: string;
        output: string;
        ok: boolean;
      }) => {
        showToast(`git ${action}`, output, ok);
      },
      updateToast: ({ message }: { message: string }) => {
        showToast("Update", message, true);
      },
      refitTerminals: () => {
        for (const entry of terminals.values()) {
          entry.fitAddon.fit();
        }
      },
      browserOpen: ({ url }: { url: string }) => {
        showBrowserOverlay(url);
      },
    },
  },
});

new Electroview({ rpc });

interface TerminalEntry {
  id: string;
  name: string;
  folderPath: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  threadItem: HTMLDivElement;
  idleTimer: ReturnType<typeof setTimeout> | null;
  createdAt: number;
  inputBuffer: string;
  titled: boolean;
}

interface FolderGroup {
  folderPath: string;
  name: string;
  element: HTMLDivElement;
  threadList: HTMLDivElement;
  collapsed: boolean;
  threadIds: string[];
}

const terminals = new Map<string, TerminalEntry>();
const folderGroups = new Map<string, FolderGroup>();
let activeId: string | null = null;
let browserOverlay: HTMLDivElement | null = null;

function getRelativeTime(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const projectList = document.getElementById("project-list")!;
const terminalArea = document.getElementById("terminal-area")!;
const emptyState = document.getElementById("empty-state")!;
const addBtn = document.getElementById("add-project-btn")!;
const toolbar = document.getElementById("toolbar")!;
const settingsPanel = document.getElementById("settings-panel")!;
const settingsBtn = document.getElementById("settings-btn")!;
const settingsBack = document.getElementById("settings-back")!;

const worktreeToggle = document.getElementById(
  "settings-worktree",
)! as HTMLInputElement;

worktreeToggle.addEventListener("change", () => {
  rpc.request.setSettings({ useWorktree: worktreeToggle.checked });
});

async function showSettings() {
  settingsPanel.classList.add("open");
  settingsPanel.querySelector<HTMLSpanElement>(
    "#settings-project-count",
  )!.textContent = String(terminals.size);
  const [info, settings] = await Promise.all([
    rpc.request.getAppInfo({}),
    rpc.request.getSettings({}),
  ]);
  settingsPanel.querySelector<HTMLSpanElement>(
    "#settings-version",
  )!.textContent = info.version;
  worktreeToggle.checked = settings.useWorktree;
}

function hideSettings() {
  settingsPanel.classList.remove("open");
}

settingsBtn.addEventListener("click", showSettings);
settingsBack.addEventListener("click", hideSettings);

document
  .getElementById("settings-clear-data")!
  .addEventListener("click", () => {
    if (
      confirm(
        "Clear all saved project data? Open sessions will not be affected.",
      )
    ) {
      localStorage.clear();
      showToast("Settings", "Local data cleared", true);
    }
  });

document.getElementById("settings-close-all")!.addEventListener("click", () => {
  if (terminals.size === 0) return;
  if (confirm(`Close all ${terminals.size} open projects?`)) {
    for (const id of [...terminals.keys()]) {
      rpc.send.closeTerminal({ id });
      removeProject(id);
    }
    showToast("Settings", "All projects closed", true);
    hideSettings();
  }
});

function ensureFolderGroup(folderPath: string, name: string): FolderGroup {
  let group = folderGroups.get(folderPath);
  if (group) return group;

  const element = document.createElement("div");
  element.className = "folder-group";
  element.dataset.folderPath = folderPath;

  const header = document.createElement("div");
  header.className = "folder-header";
  header.innerHTML = `
    <span class="folder-chevron">&#x276F;</span>
    <span class="folder-icon">&#x1F4C1;</span>
    <span class="folder-name">${name}</span>
    <button class="folder-add-thread" title="New thread">+</button>
  `;

  const threadList = document.createElement("div");
  threadList.className = "folder-threads";

  element.appendChild(header);
  element.appendChild(threadList);
  projectList.appendChild(element);

  group = {
    folderPath,
    name,
    element,
    threadList,
    collapsed: false,
    threadIds: [],
  };

  // Toggle collapse on header click
  header.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".folder-add-thread")) return;
    group!.collapsed = !group!.collapsed;
    element.classList.toggle("collapsed", group!.collapsed);
  });

  // Add thread button
  header.querySelector(".folder-add-thread")!.addEventListener("click", (e) => {
    e.stopPropagation();
    rpc.send.openTerminal({ folderPath });
  });

  folderGroups.set(folderPath, group);
  return group;
}

function createThreadItem(id: string, createdAt: number): HTMLDivElement {
  const item = document.createElement("div");
  item.className = "thread-item";
  item.dataset.id = id;

  item.innerHTML = `
    <span class="thread-label">New thread</span>
    <span class="thread-time">${getRelativeTime(createdAt)}</span>
    <button class="thread-close" title="Close">&#x2715;</button>
  `;

  item.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".thread-close")) {
      selectProject(id);
    }
  });

  item.querySelector(".thread-close")!.addEventListener("click", (e) => {
    e.stopPropagation();
    rpc.send.closeTerminal({ id });
    removeProject(id);
  });

  return item;
}

function setupTerminalUI(id: string, name: string, folderPath: string) {
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily:
      "'Cascadia Code', 'Consolas', 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
    letterSpacing: 0,
    lineHeight: 1,
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
    theme: {
      background: "#000000",
      foreground: "#cccccc",
      cursor: "#ffffff",
      selectionBackground: "#ffffff40",
    },
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  try {
    const unicode11Addon = new Unicode11Addon();
    term.loadAddon(unicode11Addon);
    term.unicode.activeVersion = "11";
  } catch {
    // Unicode 11 addon not available, continue with default
  }

  const container = document.createElement("div");
  container.className = "terminal-container";
  container.dataset.id = id;
  terminalArea.appendChild(container);

  term.open(container);

  try {
    term.loadAddon(new WebglAddon());
  } catch {
    // WebGL not available, fall back to default canvas renderer
  }

  try {
    term.loadAddon(
      new WebLinksAddon((_event, url) => {
        showBrowserOverlay(url);
      }),
    );
  } catch {
    // Web links addon not available, continue without clickable links
  }

  requestAnimationFrame(() => {
    fitAddon.fit();
    term.focus();
  });

  term.onData((data) => {
    rpc.send.terminalInput({ id, data });
    // Capture first user message as thread title
    const entry = terminals.get(id);
    if (entry && !entry.titled) {
      if (data === "\r" || data === "\n") {
        const title = entry.inputBuffer.trim();
        if (title.length > 0) {
          entry.titled = true;
          const label = entry.threadItem.querySelector(".thread-label");
          if (label) {
            label.textContent =
              title.length > 40 ? title.slice(0, 40) + "\u2026" : title;
          }
        }
        entry.inputBuffer = "";
      } else if (data === "\x7f") {
        // Backspace
        entry.inputBuffer = entry.inputBuffer.slice(0, -1);
      } else if (data.length === 1 && data >= " ") {
        // Printable character
        entry.inputBuffer += data;
      } else if (data.length > 1 && !data.includes("\x1b")) {
        // Pasted text (multi-char, no escape sequences)
        entry.inputBuffer += data;
      }
    }
  });

  term.onResize(({ cols, rows }) => {
    rpc.send.terminalResize({ id, cols, rows });
  });

  const createdAt = Date.now();

  // Create entry first so createThreadItem can access it
  const entry: TerminalEntry = {
    id,
    name,
    folderPath,
    terminal: term,
    fitAddon,
    container,
    threadItem: null as unknown as HTMLDivElement, // set below
    idleTimer: null,
    createdAt,
    inputBuffer: "",
    titled: false,
  };
  terminals.set(id, entry);

  // Ensure folder group exists and add thread
  const group = ensureFolderGroup(folderPath, name);
  group.threadIds.push(id);

  const threadItem = createThreadItem(id, createdAt);
  entry.threadItem = threadItem;
  group.threadList.appendChild(threadItem);

  // Expand the folder if collapsed
  if (group.collapsed) {
    group.collapsed = false;
    group.element.classList.remove("collapsed");
  }

  selectProject(id);
}

function markActive(id: string) {
  const entry = terminals.get(id);
  if (!entry) return;
  if (id === activeId) return;
  entry.threadItem.classList.remove("done");
  entry.threadItem.classList.add("working");
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    entry.threadItem.classList.remove("working");
    entry.threadItem.classList.add("done");
    entry.idleTimer = null;
  }, 2000);
}

async function openNewFolder() {
  try {
    const folderPath = await rpc.request.openFolderDialog({});
    if (folderPath) {
      rpc.send.openTerminal({ folderPath });
    }
  } catch (err) {
    emptyState.innerHTML = `<p style="color:red">${err}</p>`;
  }
}

addBtn.addEventListener("click", openNewFolder);

// Cmd+O to open a new folder
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "o") {
    e.preventDefault();
    openNewFolder();
  }
});

// Toolbar actions
document.getElementById("btn-open-vscode")!.addEventListener("click", () => {
  if (activeId) rpc.send.shellAction({ id: activeId, action: "vscode" });
});
document.getElementById("btn-open-finder")!.addEventListener("click", () => {
  if (activeId) rpc.send.shellAction({ id: activeId, action: "finder" });
});
document.getElementById("btn-git-status")!.addEventListener("click", () => {
  if (activeId) rpc.send.shellAction({ id: activeId, action: "git-status" });
});
document.getElementById("btn-git-pull")!.addEventListener("click", () => {
  if (activeId) rpc.send.shellAction({ id: activeId, action: "git-pull" });
});
document.getElementById("btn-git-commit")!.addEventListener("click", () => {
  if (activeId) rpc.send.shellAction({ id: activeId, action: "git-commit" });
});
document.getElementById("btn-git-reset")!.addEventListener("click", () => {
  if (activeId) rpc.send.shellAction({ id: activeId, action: "git-reset" });
});

function selectProject(id: string) {
  if (browserOverlay) closeBrowserOverlay();

  activeId = id;

  for (const [entryId, entry] of terminals) {
    const isActive = entryId === id;
    entry.container.classList.toggle("active", isActive);
    entry.threadItem.classList.toggle("active", isActive);
    if (isActive) {
      entry.threadItem.classList.remove("done", "working");
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
      requestAnimationFrame(() => {
        entry.fitAddon.fit();
        entry.terminal.focus();
      });
    }
  }

  emptyState.style.display = "none";
  toolbar.style.display = "flex";
}

function removeProject(id: string) {
  const entry = terminals.get(id);
  if (!entry) return;

  if (activeId === id && browserOverlay) closeBrowserOverlay();

  entry.terminal.dispose();
  entry.container.remove();
  entry.threadItem.remove();
  terminals.delete(id);

  // Remove from folder group
  const group = folderGroups.get(entry.folderPath);
  if (group) {
    group.threadIds = group.threadIds.filter((tid) => tid !== id);
    // Remove the folder group if no threads remain
    if (group.threadIds.length === 0) {
      group.element.remove();
      folderGroups.delete(entry.folderPath);
    }
  }

  if (activeId === id) {
    activeId = null;
    const first = terminals.keys().next().value;
    if (first) {
      selectProject(first);
    } else {
      emptyState.style.display = "flex";
      toolbar.style.display = "none";
    }
  }
}

window.addEventListener("resize", () => {
  if (activeId) {
    const entry = terminals.get(activeId);
    if (entry) {
      entry.fitAddon.fit();
    }
  }
});

// Browser overlay: shows a URL in an iframe replacing the terminal
function showBrowserOverlay(url: string) {
  if (browserOverlay) {
    const iframe = browserOverlay.querySelector("iframe");
    if (iframe) iframe.src = url;
    return;
  }

  browserOverlay = document.createElement("div");
  browserOverlay.id = "browser-overlay";
  browserOverlay.innerHTML = `
    <div class="browser-toolbar">
      <span class="browser-url">${url}</span>
      <button class="browser-close-btn" title="Close browser">&#x2715; Close</button>
    </div>
    <iframe src="${url}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
  `;

  const iframe = browserOverlay.querySelector("iframe")!;
  iframe.addEventListener("load", () => {
    // If the site blocks framing (X-Frame-Options / CSP), the iframe loads
    // but the content is blank and contentDocument is inaccessible.
    try {
      const doc = iframe.contentDocument;
      // If we can access the doc and it has no body content, it was blocked
      if (doc && doc.body && doc.body.innerHTML === "") {
        openExternalFallback(url);
      }
    } catch {
      // Cross-origin access denied — page loaded successfully in the iframe
    }
  });

  browserOverlay
    .querySelector(".browser-close-btn")!
    .addEventListener("click", () => {
      closeBrowserOverlay();
    });

  // Hide all terminal containers
  for (const entry of terminals.values()) {
    entry.container.style.display = "none";
  }

  terminalArea.appendChild(browserOverlay);
}

function openExternalFallback(url: string) {
  closeBrowserOverlay();
  rpc.send.openExternal({ url });
}

function closeBrowserOverlay() {
  if (!browserOverlay) return;
  browserOverlay.remove();
  browserOverlay = null;

  // Restore the active terminal container
  for (const entry of terminals.values()) {
    entry.container.style.display = "";
  }
  if (activeId) {
    const entry = terminals.get(activeId);
    if (entry) {
      entry.container.classList.add("active");
      requestAnimationFrame(() => {
        entry.fitAddon.fit();
        entry.terminal.focus();
      });
    }
  }

  rpc.send.closeBrowser({});
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && browserOverlay) {
    closeBrowserOverlay();
  }
});

function showToast(title: string, body: string, ok: boolean) {
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

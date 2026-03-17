import { Electroview, type RPCSchema } from "electrobun/view";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";

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
  listItem: HTMLDivElement;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const terminals = new Map<string, TerminalEntry>();
let activeId: string | null = null;

const projectList = document.getElementById("project-list")!;
const terminalArea = document.getElementById("terminal-area")!;
const emptyState = document.getElementById("empty-state")!;
const addBtn = document.getElementById("add-project-btn")!;
const toolbar = document.getElementById("toolbar")!;
const settingsPanel = document.getElementById("settings-panel")!;
const settingsBtn = document.getElementById("settings-btn")!;
const settingsBack = document.getElementById("settings-back")!;

async function showSettings() {
  settingsPanel.classList.add("open");
  settingsPanel.querySelector<HTMLSpanElement>(
    "#settings-project-count",
  )!.textContent = String(terminals.size);
  const info = await rpc.request.getAppInfo({});
  settingsPanel.querySelector<HTMLSpanElement>(
    "#settings-version",
  )!.textContent = info.version;
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

  const unicode11Addon = new Unicode11Addon();
  term.loadAddon(unicode11Addon);
  term.unicode.activeVersion = "11";

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

  requestAnimationFrame(() => {
    fitAddon.fit();
    term.focus();
  });

  term.onData((data) => {
    rpc.send.terminalInput({ id, data });
  });

  term.onResize(({ cols, rows }) => {
    rpc.send.terminalResize({ id, cols, rows });
  });

  const listItem = createProjectListItem(id, name);
  projectList.appendChild(listItem);

  const entry: TerminalEntry = {
    id,
    name,
    folderPath,
    terminal: term,
    fitAddon,
    container,
    listItem,
    idleTimer: null,
  };

  terminals.set(id, entry);
  selectProject(id);
}

function markActive(id: string) {
  const entry = terminals.get(id);
  if (!entry) return;
  if (id === activeId) return;
  entry.listItem.classList.add("working");
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    entry.listItem.classList.remove("working");
    entry.listItem.classList.add("done");
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

function createProjectListItem(id: string, name: string): HTMLDivElement {
  const item = document.createElement("div");
  item.className = "project-item";
  item.dataset.id = id;

  item.innerHTML = `
    <span class="project-chevron">&#x25BE;</span>
    <span class="project-icon">&#x1F4C1;</span>
    <span class="project-name">${name}</span>
    <button class="project-close" title="Close">&#x2715;</button>
  `;

  item.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".project-close")) {
      selectProject(id);
    }
  });

  item.querySelector(".project-close")!.addEventListener("click", () => {
    rpc.send.closeTerminal({ id });
    removeProject(id);
  });

  return item;
}

function selectProject(id: string) {
  activeId = id;

  for (const [entryId, entry] of terminals) {
    const isActive = entryId === id;
    entry.container.classList.toggle("active", isActive);
    entry.listItem.classList.toggle("active", isActive);
    if (isActive) {
      entry.listItem.classList.remove("done", "working");
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

  entry.terminal.dispose();
  entry.container.remove();
  entry.listItem.remove();
  terminals.delete(id);

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

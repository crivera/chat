/** @jsxImportSource preact */
import { render } from "preact";
import { Electroview, type RPCSchema } from "electrobun/view";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import {
  initRpc,
  terminalInstances,
  addThread,
  removeThread,
  markActive,
  selectThread,
  handleTerminalInput,
  sendTerminalInput,
  sendTerminalResize,
  showBrowser,
  showToast,
  refitAllTerminals,
  schedulePromptCheck,
  dismissPromptOnInput,
  branchChange,
  setUpdateReady,
} from "./state";
import { App } from "./components/App";

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
      checkFrameable: {
        params: { url: string };
        response: boolean;
      };
      getBranches: {
        params: { id: string };
        response: { current: string; branches: string[] };
      };
      checkoutBranch: {
        params: { id: string; branch: string };
        response: { ok: boolean; output: string };
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
      setThreadTitle: { id: string; title: string };
      setActiveThread: { id: string };
      closeBrowser: Record<string, never>;
      openExternal: { url: string };
      requestAttention: { title: string; body: string };
      applyUpdate: Record<string, never>;
    };
  }>;
  webview: RPCSchema<{
    requests: Record<string, never>;
    messages: {
      terminalReady: {
        id: string;
        name: string;
        folderPath: string;
        title?: string;
        isLast?: boolean;
      };
      terminalOutput: { id: string; data: string };
      terminalExit: { id: string };
      branchChanged: { id: string; branch: string };
      actionResult: {
        id: string;
        action: string;
        output: string;
        ok: boolean;
      };
      updateToast: { message: string };
      updateReady: Record<string, never>;
      refitTerminals: Record<string, never>;
      browserOpen: { url: string };
    };
  }>;
};

const rpc = Electroview.defineRPC<Schema>({
  maxRequestTime: 120000,
  handlers: {
    requests: {},
    messages: {
      terminalReady: ({
        id,
        name,
        folderPath,
        title,
        isLast,
      }: {
        id: string;
        name: string;
        folderPath: string;
        title?: string;
        isLast?: boolean;
      }) => {
        setupTerminal(id, name, folderPath, title, isLast);
      },
      terminalOutput: ({ id, data }: { id: string; data: string }) => {
        const instance = terminalInstances.get(id);
        if (instance) {
          instance.terminal.write(data);
          // Strip ANSI escape sequences and control chars so animations
          // (buddy, status line redraws) don't trigger working/done indicators.

          const visible = data
            .replace(/\x1b(?:\[[^@-~]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|.)/g, "")
            .replace(/[\x00-\x1f\x7f]/g, "").length;
          markActive(id, visible);
          schedulePromptCheck(id);
        }
      },
      terminalExit: ({ id }: { id: string }) => {
        removeThread(id);
      },
      branchChanged: ({ id, branch }: { id: string; branch: string }) => {
        branchChange.value = { id, branch };
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
      updateReady: () => {
        setUpdateReady();
      },
      refitTerminals: () => {
        refitAllTerminals();
      },
      browserOpen: ({ url }: { url: string }) => {
        showBrowser(url);
      },
    },
  },
});

new Electroview({ rpc });
initRpc(rpc);

function setupTerminal(
  id: string,
  name: string,
  folderPath: string,
  title?: string,
  isLast?: boolean,
) {
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
    // Unicode 11 addon not available
  }

  const container = document.createElement("div");
  container.className = "terminal-container";
  container.dataset.id = id;
  document.getElementById("terminal-area")?.appendChild(container);

  term.open(container);

  try {
    term.loadAddon(new WebglAddon());
  } catch {
    // WebGL not available
  }

  try {
    term.loadAddon(
      new WebLinksAddon((_event, url) => {
        showBrowser(url);
      }),
    );
  } catch {
    // Web links addon not available
  }

  terminalInstances.set(id, { terminal: term, fitAddon, container });

  term.onData((data) => {
    sendTerminalInput(id, data);
    handleTerminalInput(id, data);
    dismissPromptOnInput(id);
  });

  term.onResize(({ cols, rows }) => {
    sendTerminalResize(id, cols, rows);
  });

  addThread(id, name, folderPath, title, isLast);
  // For restored threads, only select the last-active one.
  // For new threads (isLast is undefined), always select.
  if (isLast !== false) selectThread(id);

  requestAnimationFrame(() => {
    fitAddon.fit();
    term.focus();
  });
}

render(<App />, document.getElementById("app")!);

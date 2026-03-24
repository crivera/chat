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
        setupTerminal(id, name, folderPath);
      },
      terminalOutput: ({ id, data }: { id: string; data: string }) => {
        const instance = terminalInstances.get(id);
        if (instance) {
          instance.terminal.write(data);
          markActive(id);
        }
      },
      terminalExit: ({ id }: { id: string }) => {
        removeThread(id);
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

function setupTerminal(id: string, name: string, folderPath: string) {
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
  });

  term.onResize(({ cols, rows }) => {
    sendTerminalResize(id, cols, rows);
  });

  addThread(id, name, folderPath);
  selectThread(id);

  requestAnimationFrame(() => {
    fitAddon.fit();
    term.focus();
  });
}

render(<App />, document.getElementById("app")!);

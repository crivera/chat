import {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  Utils,
  type RPCSchema,
} from "electrobun/bun";
import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import pkg from "../../package.json";

// Persistence
const configDir = join(homedir(), ".config", "chat-app");
const configFile = join(configDir, "projects.json");

interface SavedProject {
  folderPath: string;
  hasWorktree: boolean;
}

function loadSavedProjects(): SavedProject[] {
  try {
    if (existsSync(configFile)) {
      const data = JSON.parse(readFileSync(configFile, "utf-8"));
      // Handle old format (string[])
      if (
        Array.isArray(data) &&
        data.length > 0 &&
        typeof data[0] === "string"
      ) {
        return data.map((f: string) => ({ folderPath: f, hasWorktree: true }));
      }
      return data;
    }
  } catch {
    // Corrupt file, ignore
  }
  return [];
}

function saveProjects(projects: SavedProject[]) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configFile, JSON.stringify(projects, null, 2));
}

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
      openTerminal: { folderPath: string };
      closeTerminal: { id: string };
      terminalInput: { id: string; data: string };
      shellAction: { id: string; action: string };
    };
  }>;
  webview: RPCSchema<{
    requests: Record<string, never>;
    messages: {
      terminalReady: { id: string; name: string; folderPath: string };
      terminalOutput: { id: string; data: string };
      terminalExit: { id: string };
      actionResult: { id: string; action: string; output: string; ok: boolean };
    };
  }>;
};

interface TerminalProcess {
  id: string;
  name: string;
  folderPath: string;
  hasWorktree: boolean;
  proc: ReturnType<typeof Bun.spawn>;
}

const terminals = new Map<string, TerminalProcess>();
let nextId = 1;

function spawnTerminal(folderPath: string, isRestore = false) {
  const id = String(nextId++);
  const name = folderPath.split("/").pop() || folderPath;

  // First open: use --worktree to create a new worktree
  // Restore: worktree already exists, just run claude
  const claudeCmd = isRestore ? "claude" : "claude --worktree";
  const escaped = folderPath.replace(/"/g, '\\"');

  const proc = Bun.spawn(
    [
      "python3",
      "-c",
      `import pty,os;os.chdir("${escaped}");pty.spawn(["/bin/zsh","-l","-c","${claudeCmd}; exec /bin/zsh -l"])`,
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TERM: "xterm-256color" },
    },
  );

  terminals.set(id, { id, name, folderPath, hasWorktree: true, proc });

  rpc.send.terminalReady({ id, name, folderPath });

  const readStream = async (
    stream: ReadableStream<Uint8Array>,
    termId: string,
  ) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rpc.send.terminalOutput({ id: termId, data: decoder.decode(value) });
      }
    } catch {
      // Stream ended
    }
  };

  readStream(proc.stdout as ReadableStream<Uint8Array>, id);
  readStream(proc.stderr as ReadableStream<Uint8Array>, id);

  proc.exited.then(() => {
    terminals.delete(id);
    rpc.send.terminalExit({ id });
  });
}

function persistCurrentProjects() {
  const projects = [...terminals.values()].map((t) => ({
    folderPath: t.folderPath,
    hasWorktree: t.hasWorktree,
  }));
  saveProjects(projects);
}

const rpc = BrowserView.defineRPC<Schema>({
  maxRequestTime: 120000,
  handlers: {
    requests: {
      openFolderDialog: () => {
        return new Promise<string | null>((resolve) => {
          setTimeout(async () => {
            try {
              const result = await Utils.openFileDialog({
                startingFolder: homedir(),
                canChooseFiles: false,
                canChooseDirectory: true,
                allowsMultipleSelection: false,
              });
              if (result && result.length > 0 && result[0] !== "") {
                resolve(result[0]);
              } else {
                resolve(null);
              }
            } catch {
              resolve(null);
            }
          }, 0);
        });
      },
      getAppInfo: () => {
        return { version: pkg.version };
      },
    },
    messages: {
      openTerminal: ({ folderPath }: { folderPath: string }) => {
        spawnTerminal(folderPath);
        persistCurrentProjects();
      },
      closeTerminal: ({ id }: { id: string }) => {
        const terminal = terminals.get(id);
        if (terminal) {
          terminal.proc.kill();
          terminals.delete(id);
          persistCurrentProjects();
        }
      },
      terminalInput: ({ id, data }: { id: string; data: string }) => {
        const terminal = terminals.get(id);
        if (terminal) {
          terminal.proc.stdin.write(new TextEncoder().encode(data));
          terminal.proc.stdin.flush();
        }
      },
      shellAction: async ({ id, action }: { id: string; action: string }) => {
        const terminal = terminals.get(id);
        if (!terminal) return;
        const folder = terminal.folderPath;

        const runGit = async (args: string[]) => {
          const proc = Bun.spawn(["git", ...args], {
            cwd: folder,
            stdout: "pipe",
            stderr: "pipe",
          });
          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          const code = await proc.exited;
          return {
            output: (stdout + stderr).trim(),
            ok: code === 0,
          };
        };

        switch (action) {
          case "vscode":
            Bun.spawn(["code", folder], {
              stdout: "ignore",
              stderr: "ignore",
            });
            break;
          case "finder":
            Bun.spawn(["open", folder], {
              stdout: "ignore",
              stderr: "ignore",
            });
            break;
          case "git-status": {
            const r = await runGit(["status", "--short"]);
            rpc.send.actionResult({
              id,
              action: "status",
              output: r.output || "Working tree clean",
              ok: r.ok,
            });
            break;
          }
          case "git-pull": {
            const r = await runGit(["pull"]);
            rpc.send.actionResult({
              id,
              action: "pull",
              output: r.output,
              ok: r.ok,
            });
            break;
          }
          case "git-commit": {
            const status = await runGit(["status", "--porcelain"]);
            if (!status.output) {
              rpc.send.actionResult({
                id,
                action: "commit",
                output: "Nothing to commit",
                ok: true,
              });
              break;
            }
            await runGit(["add", "-A"]);
            const r = await runGit(["commit", "-m", "wip"]);
            rpc.send.actionResult({
              id,
              action: "commit",
              output: r.output,
              ok: r.ok,
            });
            break;
          }
        }
      },
    },
  },
});

ApplicationMenu.setApplicationMenu([
  {
    label: "Chat",
    submenu: [
      { role: "about" },
      { type: "divider" },
      { role: "hide", accelerator: "CmdOrCtrl+H" },
      { role: "hideOthers", accelerator: "CmdOrCtrl+Alt+H" },
      { role: "showAll" },
      { type: "divider" },
      { role: "quit", accelerator: "CmdOrCtrl+Q" },
    ],
  },
  {
    label: "File",
    submenu: [{ role: "close", accelerator: "CmdOrCtrl+W" }],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo", accelerator: "CmdOrCtrl+Z" },
      { role: "redo", accelerator: "CmdOrCtrl+Shift+Z" },
      { type: "divider" },
      { role: "cut", accelerator: "CmdOrCtrl+X" },
      { role: "copy", accelerator: "CmdOrCtrl+C" },
      { role: "paste", accelerator: "CmdOrCtrl+V" },
      { role: "selectAll", accelerator: "CmdOrCtrl+A" },
    ],
  },
  {
    label: "Window",
    submenu: [
      { role: "minimize", accelerator: "CmdOrCtrl+M" },
      { role: "zoom" },
      { type: "divider" },
      { role: "bringAllToFront" },
    ],
  },
]);

const win = new BrowserWindow({
  title: "Chat",
  frame: {
    x: 0,
    y: 0,
    width: 1100,
    height: 750,
  },
  url: "views://mainview/index.html",
  rpc,
});

// Restore saved projects after webview is ready
win.webview.on("dom-ready", () => {
  const saved = loadSavedProjects();
  if (saved.length > 0) {
    setTimeout(() => {
      for (const project of saved) {
        if (existsSync(project.folderPath)) {
          spawnTerminal(project.folderPath, project.hasWorktree);
        }
      }
    }, 1500);
  }
});

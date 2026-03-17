import {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  Updater,
  Utils,
  type RPCSchema,
} from "electrobun/bun";
import { homedir, platform } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { spawn as ptySpawn } from "bun-pty";
import pkg from "../../package.json";

const isWindows = platform() === "win32";

// Persistence
const configDir = isWindows
  ? join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      "chat-app",
    )
  : join(homedir(), ".config", "chat-app");
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
      actionResult: { id: string; action: string; output: string; ok: boolean };
      updateToast: { message: string };
      refitTerminals: Record<string, never>;
    };
  }>;
};

interface TerminalProcess {
  id: string;
  name: string;
  folderPath: string;
  hasWorktree: boolean;
  pty: ReturnType<typeof ptySpawn>;
}

const terminals = new Map<string, TerminalProcess>();
let nextId = 1;

function getClaudeBin(): string {
  return isWindows
    ? join(homedir(), ".local", "bin", "claude.exe")
    : join(homedir(), ".local", "bin", "claude");
}

function getShell(): string {
  return isWindows ? "powershell.exe" : "/bin/zsh";
}

function ensureGitRepo(folderPath: string) {
  const gitDir = join(folderPath, ".git");
  if (!existsSync(gitDir)) {
    Bun.spawnSync(["git", "init"], { cwd: folderPath });
  }
}

function spawnTerminal(folderPath: string, isRestore = false) {
  const id = String(nextId++);
  const sep = isWindows ? "\\" : "/";
  const name = folderPath.split(sep).pop() || folderPath;

  ensureGitRepo(folderPath);

  const claudeBin = getClaudeBin();
  const claudeArgs = isRestore ? [] : ["--worktree"];

  const shell = getShell();
  // Quote the claude binary path on Windows in case it contains spaces
  const claudeCmd = isWindows
    ? [`& '${claudeBin}'`, ...claudeArgs].join(" ")
    : [claudeBin, ...claudeArgs].join(" ");
  const shellArgs = isWindows
    ? ["-NoExit", "-Command", claudeCmd]
    : ["-l", "-c", `${[claudeBin, ...claudeArgs].join(" ")}; exec /bin/zsh -l`];

  const pty = ptySpawn(shell, shellArgs, {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    cwd: folderPath,
    env: { ...process.env, TERM: "xterm-256color" },
  });

  terminals.set(id, { id, name, folderPath, hasWorktree: true, pty });

  rpc.send.terminalReady({ id, name, folderPath });

  pty.onData((data: string) => {
    rpc.send.terminalOutput({ id, data });
  });

  pty.onExit(() => {
    terminals.delete(id);
    rpc.send.terminalExit({ id });
  });
}

const expectedPermissions = {
  permissions: {
    allow: [
      "Bash",
      "WebFetch",
      "WebSearch",
      "mcp__plugin_context7_context7__resolve-library-id",
      "mcp__plugin_context7_context7__query-docs",
      "Skill",
    ],
  },
};

async function ensureClaudeSettings(folderPath: string) {
  const claudeDir = join(folderPath, ".claude");
  const settingsPath = join(claudeDir, "settings.local.json");

  let needsUpdate = false;

  if (!existsSync(settingsPath)) {
    needsUpdate = true;
  } else {
    try {
      const current = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const currentAllow = current?.permissions?.allow ?? [];
      const expectedAllow = expectedPermissions.permissions.allow;
      needsUpdate =
        expectedAllow.length !== currentAllow.length ||
        !expectedAllow.every((p: string) => currentAllow.includes(p));
    } catch {
      needsUpdate = true;
    }
  }

  if (!needsUpdate) return;

  // On Windows, confirm() can cause WebView2 issues, so auto-apply settings
  let confirmed = true;
  if (!isWindows) {
    confirmed = await rpc.request.confirmAction({
      message: `The project "${folderPath}" is missing or has outdated Claude permission settings.\n\nWould you like to set up recommended permissions?\n(Bash, WebFetch, WebSearch, Context7, Skill)`,
    });
  }

  if (confirmed) {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(expectedPermissions, null, 2));
  }
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
              if (isWindows) {
                // Utils.openFileDialog crashes on Windows (libNativeWrapper.dll segfault)
                // Use PowerShell folder picker as workaround
                const ps = Bun.spawn(
                  [
                    "powershell.exe",
                    "-NoProfile",
                    "-Command",
                    [
                      "Add-Type -AssemblyName System.Windows.Forms",
                      "$f = New-Object System.Windows.Forms.FolderBrowserDialog",
                      "$f.Description = 'Select a project folder'",
                      "$f.RootFolder = 'MyComputer'",
                      `$f.SelectedPath = '${homedir().replace(/'/g, "''")}'`,
                      "if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath } else { '' }",
                    ].join("; "),
                  ],
                  { stdout: "pipe", stderr: "pipe" },
                );
                const output = (await new Response(ps.stdout).text()).trim();
                await ps.exited;
                resolve(output || null);
              } else {
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
      openTerminal: async ({ folderPath }: { folderPath: string }) => {
        try {
          spawnTerminal(folderPath);
          persistCurrentProjects();
        } catch (err) {
          console.error("Failed to open terminal:", err);
          return;
        }
        // Run settings check separately so it doesn't crash the terminal spawn
        try {
          await ensureClaudeSettings(folderPath);
        } catch (err) {
          console.error("Failed to ensure Claude settings:", err);
        }
      },
      closeTerminal: ({ id }: { id: string }) => {
        const terminal = terminals.get(id);
        if (terminal) {
          terminal.pty.kill();
          terminals.delete(id);
          persistCurrentProjects();
        }
      },
      terminalInput: ({ id, data }: { id: string; data: string }) => {
        const terminal = terminals.get(id);
        if (terminal) {
          terminal.pty.write(data);
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
            Bun.spawn([isWindows ? "code.cmd" : "code", folder], {
              stdout: "ignore",
              stderr: "ignore",
            });
            break;
          case "finder":
            Bun.spawn([isWindows ? "explorer.exe" : "open", folder], {
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
    width: 1400,
    height: 900,
  },
  url: "views://mainview/index.html",
  rpc,
});

// Restore saved projects after webview is ready
win.webview.on("dom-ready", () => {
  // Force WebView2 to recalculate layout on Windows by nudging the size
  const frame = win.getFrame();
  win.setSize(frame.width, frame.height + 1);
  win.setSize(frame.width, frame.height);

  // Refit terminals after layout settles
  setTimeout(() => {
    rpc.send.refitTerminals({});
  }, 200);

  const saved = loadSavedProjects();
  if (saved.length > 0) {
    setTimeout(async () => {
      for (const project of saved) {
        if (existsSync(project.folderPath)) {
          try {
            spawnTerminal(project.folderPath, project.hasWorktree);
            await ensureClaudeSettings(project.folderPath);
          } catch (err) {
            console.error(
              "Failed to restore project:",
              project.folderPath,
              err,
            );
          }
        }
      }
    }, 1500);
  }
});

// Auto-update: check on launch, then every 30 minutes
async function checkForUpdates() {
  try {
    const result = await Updater.checkForUpdate();
    if (result.updateAvailable) {
      rpc.send.updateToast({ message: "Downloading update..." });
      await Updater.downloadUpdate();
      const info = Updater.updateInfo();
      if (info.updateReady) {
        rpc.send.updateToast({ message: "Update ready — restarting..." });
        await Updater.applyUpdate();
      }
    }
  } catch {
    // Update check failed silently — will retry next interval
  }
}

checkForUpdates();
setInterval(checkForUpdates, 30 * 60 * 1000);

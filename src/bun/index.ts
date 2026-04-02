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
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  chmodSync,
  watch,
} from "fs";
import { spawn as ptySpawn } from "bun-pty";
import pkg from "../../package.json";

const isWindows = platform() === "win32";

/**
 * On macOS, GUI apps don't inherit the user's shell environment.
 * Spawn a login shell at startup to capture the full env (PATH, etc.).
 */
function resolveUserEnv(): Record<string, string> {
  if (isWindows) return { ...process.env } as Record<string, string>;
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const result = Bun.spawnSync([shell, "-li", "-c", "env -0"], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = result.stdout.toString();
    if (!output) return { ...process.env } as Record<string, string>;
    const env: Record<string, string> = {};
    for (const entry of output.split("\0")) {
      const idx = entry.indexOf("=");
      if (idx > 0) env[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
    return env;
  } catch {
    return { ...process.env } as Record<string, string>;
  }
}

const userEnv = resolveUserEnv();

// Persistence
const configDir = isWindows
  ? join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      "chat-app",
    )
  : join(homedir(), ".config", "chat-app");
const configFile = join(configDir, "projects.json");
const settingsFile = join(configDir, "settings.json");

interface AppSettings {
  useWorktree: boolean;
}

const defaultSettings: AppSettings = { useWorktree: true };

function loadSettings(): AppSettings {
  try {
    if (existsSync(settingsFile)) {
      return {
        ...defaultSettings,
        ...JSON.parse(readFileSync(settingsFile, "utf-8")),
      };
    }
  } catch {
    // Corrupt file, use defaults
  }
  return { ...defaultSettings };
}

function saveSettings(settings: AppSettings) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

let appSettings = loadSettings();

interface SavedProject {
  folderPath: string;
  hasWorktree: boolean;
  title?: string;
  active?: boolean;
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

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0"
  );
}

// Check if a URL can be embedded in an iframe by inspecting response headers
async function canEmbed(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    const isLocal = isLocalHostname(parsed.hostname);
    if (isLocal) return true;
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(3000),
    });
    const xfo = res.headers.get("x-frame-options")?.toUpperCase();
    if (xfo === "DENY" || xfo === "SAMEORIGIN") return false;
    const csp = res.headers.get("content-security-policy");
    if (csp) {
      const match = csp.match(/frame-ancestors\s+([^;]+)/i);
      if (match && !match[1].includes("*")) return false;
    }
    return true;
  } catch {
    // Network error or timeout — local URLs should still open in-app
    try {
      return isLocalHostname(new URL(url).hostname);
    } catch {
      return false;
    }
  }
}

// Browser bridge: write a shell script that routes browser opens back to the app
function ensureBridgeScript(): string {
  mkdirSync(configDir, { recursive: true });
  const scriptPath = join(configDir, "open-in-chat.sh");
  const script = [
    "#!/bin/sh",
    "curl -s \"http://127.0.0.1:${CHAT_BROWSER_PORT}/open?url=$(printf '%s' \"$1\" | sed 's/ /%20/g;s/?/%3F/g;s/&/%26/g;s/=/%3D/g;s/#/%23/g')\" > /dev/null 2>&1",
    "",
  ].join("\n");
  try {
    if (readFileSync(scriptPath, "utf-8") === script) return scriptPath;
  } catch {
    // File doesn't exist yet
  }
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

const bridgeScriptPath = ensureBridgeScript();

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
        response: AppSettings;
      };
      setSettings: {
        params: AppSettings;
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
      actionResult: { id: string; action: string; output: string; ok: boolean };
      branchChanged: { id: string; branch: string };
      updateToast: { message: string };
      updateReady: Record<string, never>;
      refitTerminals: Record<string, never>;
      browserOpen: { url: string };
    };
  }>;
};

interface TerminalProcess {
  id: string;
  name: string;
  folderPath: string;
  hasWorktree: boolean;
  title?: string;
  pty: ReturnType<typeof ptySpawn>;
}

const terminals = new Map<string, TerminalProcess>();
const branchWatchers = new Map<string, ReturnType<typeof watch>>();
let nextId = 1;
let activeTerminalId: string | null = null;

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

function findDefaultBranch(branchListOutput: string): string | null {
  const branches = branchListOutput
    .split("\n")
    .map((b) => b.replace("*", "").trim())
    .filter(Boolean);
  return (
    branches.find((b) => b === "main") ||
    branches.find((b) => b === "develop") ||
    branches.find((b) => b === "master") ||
    null
  );
}

/** If the current branch's remote tracking branch is gone, switch to the default branch and pull. */
function ensureBranchExists(folderPath: string) {
  const git = (args: string[]) =>
    Bun.spawnSync(["git", ...args], {
      cwd: folderPath,
      env: userEnv,
      stdout: "pipe",
      stderr: "pipe",
    });

  // Get the current branch name
  const branchResult = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const currentBranch = branchResult.stdout.toString().trim();
  if (!currentBranch || currentBranch === "HEAD") return;

  // Check if this branch has a remote tracking ref
  const trackingResult = git([
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  if (trackingResult.exitCode !== 0) return; // no tracking branch, nothing to check

  // Fetch and prune stale remote refs
  git(["fetch", "--prune"]);

  // Check again if the tracking ref still exists after prune
  const recheckResult = git([
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  if (recheckResult.exitCode === 0) return; // remote branch still exists, all good

  // Remote branch is gone — find the default branch
  const branchList = git(["branch", "--list"]);
  const defaultBranch = findDefaultBranch(branchList.stdout.toString());
  if (!defaultBranch) return;

  git(["checkout", defaultBranch]);
  git(["pull"]);
  console.log(
    `Branch "${currentBranch}" remote was deleted — switched to ${defaultBranch}`,
  );
}

function spawnTerminal(
  folderPath: string,
  isRestore = false,
  title?: string,
  isLast?: boolean,
) {
  const id = String(nextId++);
  const sep = isWindows ? "\\" : "/";
  const name = folderPath.split(sep).pop() || folderPath;

  ensureGitRepo(folderPath);
  ensureBranchExists(folderPath);

  const claudeBin = getClaudeBin();
  const useWorktree = !isRestore && appSettings.useWorktree;
  const claudeArgs = useWorktree ? ["--worktree"] : [];

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
    env: {
      ...userEnv,
      TERM: "xterm-256color",
      // Ensure ~/.local/bin is on PATH even if the user's profile doesn't add it
      PATH: [join(homedir(), ".local", "bin"), userEnv.PATH || process.env.PATH]
        .filter(Boolean)
        .join(isWindows ? ";" : ":"),
      CLAUDE_CODE_NO_FLICKER: "1",
      CHAT_BROWSER_PORT: String(browserBridgePort),
      BROWSER: bridgeScriptPath,
    },
  });

  terminals.set(id, { id, name, folderPath, hasWorktree: true, title, pty });

  rpc.send.terminalReady({ id, name, folderPath, title, isLast });

  // Watch .git/HEAD for branch changes
  const gitHeadPath = join(folderPath, ".git", "HEAD");
  try {
    const watcher = watch(gitHeadPath, () => {
      try {
        const head = readFileSync(gitHeadPath, "utf-8").trim();
        const match = head.match(/^ref: refs\/heads\/(.+)$/);
        if (match) {
          rpc.send.branchChanged({ id, branch: match[1] });
        }
      } catch {
        // ignore read errors (e.g. mid-write)
      }
    });
    branchWatchers.set(id, watcher);
  } catch {
    // .git/HEAD may not exist yet for fresh repos
  }

  pty.onData((data: string) => {
    rpc.send.terminalOutput({ id, data });
  });

  pty.onExit(() => {
    // Guard: closeTerminal may have already cleaned up
    if (terminals.has(id)) {
      terminals.delete(id);
      branchWatchers.get(id)?.close();
      branchWatchers.delete(id);
    }
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
      "Edit",
    ],
  },
};

function ensureClaudeSettings(folderPath: string) {
  const claudeDir = join(folderPath, ".claude");
  const settingsPath = join(claudeDir, "settings.local.json");

  const expectedAllow = expectedPermissions.permissions.allow;
  let existing: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const currentAllow: string[] =
        (existing as { permissions?: { allow?: string[] } })?.permissions
          ?.allow ?? [];
      const allPresent = expectedAllow.every((p: string) =>
        currentAllow.includes(p),
      );
      if (allPresent) return;
    } catch {
      // File corrupt or unreadable — rebuild it
    }
  }

  // Merge expected permissions into existing settings
  const permissions =
    (existing as { permissions?: Record<string, unknown> })?.permissions ?? {};
  const currentAllow: string[] = Array.isArray(permissions.allow)
    ? (permissions.allow as string[])
    : [];
  const merged = Array.from(new Set([...currentAllow, ...expectedAllow]));

  const updated = {
    ...existing,
    permissions: { ...permissions, allow: merged },
  };

  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(updated, null, 2));
}

function getActiveWorktreePath(folderPath: string): string | null {
  const worktreesDir = join(folderPath, ".claude", "worktrees");
  if (!existsSync(worktreesDir)) return null;
  try {
    const entries = readdirSync(worktreesDir)
      .map((name) => {
        const full = join(worktreesDir, name);
        try {
          const stat = statSync(full);
          if (!stat.isDirectory()) return null;
          return { path: full, mtime: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((e): e is { path: string; mtime: number } => e !== null);
    if (entries.length === 0) return null;
    entries.sort((a, b) => b.mtime - a.mtime);
    return entries[0].path;
  } catch {
    return null;
  }
}

function persistCurrentProjects() {
  const projects = [...terminals.values()].map((t) => ({
    folderPath: t.folderPath,
    hasWorktree: t.hasWorktree,
    title: t.title,
    active: t.id === activeTerminalId || undefined,
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
                      "$f.RootFolder = 'Desktop'",
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
      getSettings: () => {
        return { ...appSettings };
      },
      setSettings: (settings: AppSettings) => {
        appSettings = { ...appSettings, ...settings };
        saveSettings(appSettings);
      },
      checkFrameable: ({ url }: { url: string }) => canEmbed(url),
      getBranches: async ({ id }: { id: string }) => {
        const terminal = terminals.get(id);
        if (!terminal) return { current: "", branches: [] };
        const folder = terminal.folderPath;
        const run = (args: string[]) =>
          Bun.spawn(["git", ...args], {
            cwd: folder,
            env: userEnv,
            stdout: "pipe",
            stderr: "pipe",
          });
        const currentProc = run(["rev-parse", "--abbrev-ref", "HEAD"]);
        const branchProc = run([
          "branch",
          "--sort=-committerdate",
          "--format=%(refname:short)",
        ]);
        const current = (await new Response(currentProc.stdout).text()).trim();
        const branchOutput = (
          await new Response(branchProc.stdout).text()
        ).trim();
        const branches = branchOutput
          ? branchOutput.split("\n").filter((b) => b !== current)
          : [];
        return { current, branches: [current, ...branches] };
      },
      checkoutBranch: async ({
        id,
        branch,
      }: {
        id: string;
        branch: string;
      }) => {
        const terminal = terminals.get(id);
        if (!terminal) return { ok: false, output: "Terminal not found" };
        const proc = Bun.spawn(["git", "checkout", branch], {
          cwd: terminal.folderPath,
          env: userEnv,
          stdout: "pipe",
          stderr: "pipe",
        });
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const code = await proc.exited;
        return { ok: code === 0, output: (stdout + stderr).trim() };
      },
    },
    messages: {
      minimizeWindow: () => {
        win.minimize();
      },
      maximizeWindow: () => {
        if (win.isMaximized()) {
          win.unmaximize();
        } else {
          win.maximize();
        }
      },
      closeWindow: () => {
        win.close();
      },
      openTerminal: ({ folderPath }: { folderPath: string }) => {
        try {
          ensureClaudeSettings(folderPath);
        } catch (err) {
          console.error("Failed to ensure Claude settings:", err);
        }
        try {
          spawnTerminal(folderPath);
          persistCurrentProjects();
        } catch (err) {
          console.error("Failed to open terminal:", err);
        }
      },
      closeTerminal: ({ id }: { id: string }) => {
        const terminal = terminals.get(id);
        if (terminal) {
          // Remove from map first to prevent write/resize calls during teardown
          terminals.delete(id);
          branchWatchers.get(id)?.close();
          branchWatchers.delete(id);
          try {
            terminal.pty.kill();
          } catch {
            // PTY may already be dead
          }
          persistCurrentProjects();
        }
      },
      terminalInput: ({ id, data }: { id: string; data: string }) => {
        const terminal = terminals.get(id);
        if (terminal) {
          try {
            terminal.pty.write(data);
          } catch {
            // PTY may have exited between the check and the write
          }
        }
      },
      setThreadTitle: ({ id, title }: { id: string; title: string }) => {
        const terminal = terminals.get(id);
        if (terminal) {
          terminal.title = title;
          persistCurrentProjects();
        }
      },
      setActiveThread: ({ id }: { id: string }) => {
        activeTerminalId = id;
        persistCurrentProjects();
      },
      terminalResize: ({
        id,
        cols,
        rows,
      }: {
        id: string;
        cols: number;
        rows: number;
      }) => {
        const terminal = terminals.get(id);
        if (terminal) {
          try {
            terminal.pty.resize(cols, rows);
          } catch {
            // PTY may have exited between the check and the resize
          }
        }
      },
      closeBrowser: () => {
        // No backend action needed; frontend handles UI toggle
      },
      openExternal: ({ url }: { url: string }) => {
        Bun.spawn([isWindows ? "explorer.exe" : "open", url], {
          stdout: "ignore",
          stderr: "ignore",
        });
      },
      requestAttention: ({ title, body }: { title: string; body: string }) => {
        Utils.showNotification({ title, body });
      },
      applyUpdate: async () => {
        try {
          await Updater.applyUpdate();
        } catch {
          // Update apply failed — user can try again
        }
      },
      shellAction: async ({ id, action }: { id: string; action: string }) => {
        const terminal = terminals.get(id);
        if (!terminal) return;
        const folder = terminal.folderPath;

        const runGit = async (args: string[]) => {
          const proc = Bun.spawn(["git", ...args], {
            cwd: folder,
            env: userEnv,
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
          case "vscode": {
            const worktree = terminal.hasWorktree
              ? getActiveWorktreePath(folder)
              : null;
            const target = worktree || folder;
            if (isWindows) {
              Bun.spawn(["code.cmd", target], {
                stdout: "ignore",
                stderr: "ignore",
              });
            } else {
              // Use `open -a` on macOS — the `code` CLI may not be in PATH for GUI apps
              Bun.spawn(["open", "-a", "Visual Studio Code", target], {
                stdout: "ignore",
                stderr: "ignore",
              });
            }
            break;
          }
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
          case "git-reset": {
            const branches = await runGit(["branch", "--list"]);
            const defaultBranch = findDefaultBranch(branches.output);
            if (!defaultBranch) {
              rpc.send.actionResult({
                id,
                action: "reset",
                output: "No main, develop, or master branch found",
                ok: false,
              });
              break;
            }
            const checkout = await runGit(["checkout", defaultBranch]);
            if (!checkout.ok) {
              rpc.send.actionResult({
                id,
                action: "reset",
                output: checkout.output,
                ok: false,
              });
              break;
            }
            const pull = await runGit(["pull"]);
            rpc.send.actionResult({
              id,
              action: "reset",
              output: `Switched to ${defaultBranch}\n${pull.output}`,
              ok: pull.ok,
            });
            break;
          }
        }
      },
    },
  },
});

// HTTP bridge server: receives browser-open requests from the bridge script
const browserBridge = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const reqUrl = new URL(req.url);
    if (reqUrl.pathname === "/open") {
      const targetUrl = reqUrl.searchParams.get("url");
      if (targetUrl) {
        const embeddable = await canEmbed(targetUrl);
        if (embeddable) {
          rpc.send.browserOpen({ url: targetUrl });
        } else {
          Bun.spawn([isWindows ? "explorer.exe" : "open", targetUrl], {
            stdout: "ignore",
            stderr: "ignore",
          });
        }
      }
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  },
});
const browserBridgePort = browserBridge.port;

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
    submenu: [{ role: "close" }],
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
  titleBarStyle: "default",
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
    setTimeout(() => {
      for (const project of saved) {
        if (existsSync(project.folderPath)) {
          try {
            ensureClaudeSettings(project.folderPath);
          } catch (err) {
            console.error(
              "Failed to ensure Claude settings:",
              project.folderPath,
              err,
            );
          }
          try {
            spawnTerminal(
              project.folderPath,
              project.hasWorktree,
              project.title,
              !!project.active,
            );
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
let updatePending = false;

async function checkForUpdates() {
  if (updatePending) return;
  try {
    const result = await Updater.checkForUpdate();
    if (result.updateAvailable) {
      rpc.send.updateToast({ message: "Downloading update..." });
      await Updater.downloadUpdate();
      const info = Updater.updateInfo();
      if (info.updateReady) {
        if (terminals.size === 0) {
          rpc.send.updateToast({ message: "Update ready — restarting..." });
          await Updater.applyUpdate();
        } else {
          updatePending = true;
          rpc.send.updateReady({});
        }
      }
    }
  } catch {
    // Update check failed silently — will retry next interval
  }
}

checkForUpdates();
setInterval(checkForUpdates, 30 * 60 * 1000);

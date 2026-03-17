import { platform } from "os";
import { join, dirname } from "path";
import { existsSync, readdirSync } from "fs";

if (platform() !== "win32") {
  process.exit(0);
}

const projectRoot = dirname(import.meta.dir);
const icoPath = join(projectRoot, "icon.ico");

if (!existsSync(icoPath)) {
  console.log("[post-build] icon.ico not found, skipping icon patch");
  process.exit(0);
}

// Look for rcedit in node_modules first, then fall back to global install
const localRcedit = join(
  projectRoot,
  "node_modules",
  "rcedit",
  "bin",
  "rcedit-x64.exe",
);
const globalRcedit = join(
  process.env.APPDATA || "",
  "npm",
  "node_modules",
  "rcedit",
  "bin",
  "rcedit-x64.exe",
);

const rcedit = existsSync(localRcedit) ? localRcedit : globalRcedit;

if (!existsSync(rcedit)) {
  console.log("[post-build] rcedit not found. Install with: bun add -d rcedit");
  process.exit(1);
}

// Find the bin directory in any build variant
const buildRoot = join(projectRoot, "build");
if (!existsSync(buildRoot)) {
  console.log("[post-build] No build directory found");
  process.exit(0);
}

const targets = ["launcher.exe", "bun.exe"];

for (const buildDir of readdirSync(buildRoot)) {
  const binDir = join(buildRoot, buildDir);
  // Look for bin/ inside any subdirectory (e.g. Chat-dev/)
  const entries = existsSync(binDir) ? readdirSync(binDir) : [];
  for (const entry of entries) {
    const candidateBin = join(binDir, entry, "bin");
    if (existsSync(candidateBin)) {
      for (const exe of targets) {
        const exePath = join(candidateBin, exe);
        if (existsSync(exePath)) {
          console.log(`[post-build] Patching icon into ${exe}`);
          const result = Bun.spawnSync([
            rcedit,
            exePath,
            "--set-icon",
            icoPath,
          ]);
          if (result.exitCode !== 0) {
            console.error(
              `[post-build] rcedit failed for ${exe}:`,
              result.stderr.toString(),
            );
          } else {
            console.log(`[post-build] ${exe} icon patched successfully`);
          }
        }
      }
    }
  }
}

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { DATA_DIR } from "@/lib/dataDir.js";
import { findHeadroomBinary, findPython310, HEADROOM_COMPRESSION_EXTRAS, EXTRA_MARKERS, getInstalledHeadroomExtras } from "./detect.js";

const HEADROOM_DIR = path.join(DATA_DIR, "headroom");
const PID_FILE = path.join(HEADROOM_DIR, "proxy.pid");
const LOG_FILE = path.join(HEADROOM_DIR, "proxy.log");
const INSTALL_LOG_FILE = path.join(HEADROOM_DIR, "install.log");
const DISABLED_FILE = path.join(HEADROOM_DIR, "supervisor.disabled");
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const STARTUP_TIMEOUT_MS = 8000;

// Render/free-tier runtime installs only `headroom-ai[proxy]`. Proxy-only mode
// keeps managed starts on the lightweight local profile and prevents optional
// `[code]`/`[ml]` extras from changing the managed command line.
export function isHeadroomProxyOnly() {
  return process.env.HEADROOM_PROXY_ONLY === "true";
}

export function getHeadroomDisabledFile() {
  return DISABLED_FILE;
}

function numberEnv(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function headroomSpawnEnv() {
  return {
    ...process.env,
    HEADROOM_STATELESS: process.env.HEADROOM_STATELESS || "true",
    HEADROOM_TELEMETRY: process.env.HEADROOM_TELEMETRY || "off",
    HEADROOM_NO_SUBSCRIPTION_TRACKING: process.env.HEADROOM_NO_SUBSCRIPTION_TRACKING || "1",
  };
}

function noteManualStop() {
  try {
    ensureDir();
    fs.writeFileSync(DISABLED_FILE, `stopped at ${new Date().toISOString()}\n`);
  } catch { /* stopping must still succeed if the sentinel cannot be written */ }
}

function clearManualStop() {
  try { if (fs.existsSync(DISABLED_FILE)) fs.unlinkSync(DISABLED_FILE); } catch { /* ignore */ }
}

function ensureDir() {
  if (!fs.existsSync(HEADROOM_DIR)) fs.mkdirSync(HEADROOM_DIR, { recursive: true });
}

function readPid() {
  try {
    if (fs.existsSync(PID_FILE)) return parseInt(fs.readFileSync(PID_FILE, "utf8"), 10);
  } catch { /* ignore */ }
  return null;
}

function writePid(pid) {
  ensureDir();
  fs.writeFileSync(PID_FILE, String(pid));
}

function clearPid() {
  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

// process.kill throws if pid is dead — use this to probe.
export function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function pidMatchesHeadroom(pid) {
  // Guard against stale PID files: on Linux, avoid treating an unrelated
  // recycled PID as the managed proxy. Other platforms keep the liveness probe.
  if (process.platform !== "linux") return true;
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.toLowerCase().includes("headroom");
  } catch {
    return false;
  }
}

export function getManagedPid() {
  const pid = readPid();
  if (!pid || !isPidAlive(pid)) return null;
  if (!pidMatchesHeadroom(pid)) {
    clearPid();
    return null;
  }
  return pid;
}

// Build proxy CLI flags for the active compression extras. `[code]` (AST
// compression) is off by default in headroom → pass --code-aware to turn it on;
// `[ml]` (Kompress) is on by default → pass --disable-kompress to turn it off.
// Proxy-only mode always disables both optional compression paths so the
// managed daemon stays on the lightweight `[proxy]` core.
function extrasProxyArgs({ codeAware, kompress } = {}) {
  if (isHeadroomProxyOnly()) return ["--disable-kompress", "--disable-kompress-fallback"];
  const args = [];
  if (codeAware) args.push("--code-aware");
  if (kompress === false) args.push("--disable-kompress");
  return args;
}

export function buildHeadroomProxyArgs({ port = DEFAULT_PORT, codeAware = false, kompress = true } = {}) {
  const safePort = Number(port) > 0 && Number(port) < 65536 ? Number(port) : DEFAULT_PORT;
  return [
    "proxy",
    "--host", DEFAULT_HOST,
    "--port", String(safePort),
    "--no-telemetry",
    "--stateless",
    "--no-ccr",
    "--no-cache",
    "--no-rate-limit",
    "--no-subscription-tracking",
    ...extrasProxyArgs({ codeAware, kompress }),
    "--workers", "1",
    "--limit-concurrency", String(numberEnv("HEADROOM_LIMIT_CONCURRENCY", 8, 1, 64)),
    "--max-connections", String(numberEnv("HEADROOM_MAX_CONNECTIONS", 16, 1, 128)),
    "--max-keepalive", String(numberEnv("HEADROOM_MAX_KEEPALIVE", 4, 0, 64)),
    "--keepalive-expiry", String(numberEnv("HEADROOM_KEEPALIVE_EXPIRY", 10, 0, 300)),
    "--compression-max-workers", String(numberEnv("HEADROOM_COMPRESSION_MAX_WORKERS", 1, 1, 8)),
    "--anthropic-pre-upstream-concurrency", String(numberEnv("HEADROOM_ANTHROPIC_PRE_UPSTREAM_CONCURRENCY", 2, 1, 16)),
  ];
}

export async function startHeadroomProxy({ port = DEFAULT_PORT, codeAware = false, kompress = true } = {}) {
  const binary = findHeadroomBinary();
  if (!binary) {
    const err = new Error("Headroom CLI not installed");
    err.code = "NOT_INSTALLED";
    throw err;
  }

  const existing = getManagedPid();
  if (existing) return { pid: existing, alreadyRunning: true };

  ensureDir();
  clearManualStop();
  if (process.env.HEADROOM_SUPERVISED === "1") {
    // The container entrypoint owns the daemon lifecycle. Ask it to start by
    // clearing a manual stop, then wait for the supervisor to publish the PID.
    const deadline = Date.now() + 15000;
    let supervisedPid = getManagedPid();
    while (!supervisedPid && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      supervisedPid = getManagedPid();
    }
    if (!supervisedPid) {
      const err = new Error("headroom supervisor did not start the proxy — see proxy.log");
      err.code = "SUPERVISOR_FAILED";
      throw err;
    }
    return { pid: supervisedPid, alreadyRunning: true };
  }
  // spawn stdio requires fd numbers, not WriteStream objects.
  const outFd = fs.openSync(LOG_FILE, "a");

  const args = buildHeadroomProxyArgs({ port, codeAware, kompress });
  const child = spawn(binary, args, {
    stdio: ["ignore", outFd, outFd],
    detached: true,
    windowsHide: true,
    env: headroomSpawnEnv(),
  });

  if (!child.pid) {
    fs.closeSync(outFd);
    const err = new Error("Failed to spawn headroom proxy");
    err.code = "SPAWN_FAILED";
    throw err;
  }

  child.unref();
  writePid(child.pid);

  // Wait until the process either stays alive briefly (success) or exits fast (failure).
  await new Promise((resolve, reject) => {
    const startupTimer = setTimeout(() => {
      if (isPidAlive(child.pid)) resolve();
      else reject(new Error("headroom proxy exited during startup — see proxy.log"));
    }, STARTUP_TIMEOUT_MS);

    child.once("exit", (code) => {
      clearTimeout(startupTimer);
      clearPid();
      fs.closeSync(outFd);
      const e = new Error(`headroom proxy exited early (code=${code}) — see proxy.log`);
      e.code = "EARLY_EXIT";
      reject(e);
    });
  });

  // Close parent's copy of the fd; child retains its own after unref.
  fs.closeSync(outFd);

  return { pid: child.pid, alreadyRunning: false };
}

export function stopHeadroomProxy() {
  const pid = getManagedPid();
  if (!pid) {
    noteManualStop();
    return { stopped: false, reason: "not_running" };
  }
  try {
    noteManualStop();
    process.kill(pid, "SIGTERM");
    // Give it a moment, then force if still alive.
    setTimeout(() => {
      if (isPidAlive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }, 2000);
    clearPid();
    return { stopped: true, pid };
  } catch (e) {
    clearPid();
    const err = new Error(`Failed to stop headroom proxy: ${e.message}`);
    err.code = "STOP_FAILED";
    throw err;
  }
}

// Stop the managed proxy (if any), wait for the pid to die, then start again
// with the given flags. Used when toggling active extras that require a restart.
export async function restartHeadroomProxy(opts = {}) {
  const pid = getManagedPid();
  if (pid) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    // Wait up to ~3s for graceful exit, force-kill if still alive.
    for (let i = 0; i < 30 && isPidAlive(pid); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (isPidAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    clearPid();
  }
  return startHeadroomProxy(opts);
}

export function getHeadroomLogTail(maxLines = 200) {
  try {
    if (!fs.existsSync(LOG_FILE)) return "";
    const content = fs.readFileSync(LOG_FILE, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines).join("\n");
  } catch { return ""; }
}

// Install (or upgrade) headroom-ai with the requested compression extras.
// `extras` is a whitelist from HEADROOM_COMPRESSION_EXTRAS — anything else
// is rejected to keep the install surface predictable. Always installs the
// `proxy` base + whatever extras the user picked, regardless of what is
// already present.
export async function installHeadroomExtras(extras = []) {
  const requested = Array.isArray(extras) ? extras.filter((e) => HEADROOM_COMPRESSION_EXTRAS.includes(e)) : [];
  const py = findPython310();
  if (!py) {
    const err = new Error("Python >= 3.10 not found");
    err.code = "NO_PYTHON";
    throw err;
  }
  if (!findHeadroomBinary()) {
    const err = new Error("headroom-ai not installed (run `pip install headroom-ai[proxy]` first)");
    err.code = "NOT_INSTALLED";
    throw err;
  }
  // pip install string is built from a closed set (HEADROOM_COMPRESSION_EXTRAS),
  // so it cannot be poisoned by caller input — the comma-list is a fixed
  // ['proxy', ...requested]. No shell interpolation.
  const extrasList = ["proxy", ...requested].join(",");
  const spec = `headroom-ai[${extrasList}]`;
  const args = ["-m", "pip", "install", "--upgrade", spec];

  ensureDir();
  // Truncate ("w") so the log reflects only the current install for live progress.
  const outFd = fs.openSync(INSTALL_LOG_FILE, "w");
  const child = spawn(py, args, {
    stdio: ["ignore", outFd, outFd],
    windowsHide: true,
    env: { ...process.env },
  });

  return new Promise((resolve, reject) => {
    child.once("error", (e) => { fs.closeSync(outFd); reject(e); });
    child.once("exit", (code) => {
      fs.closeSync(outFd);
      if (code === 0) {
        const status = getInstalledHeadroomExtras(py);
        resolve({ success: true, code, spec, extras: requested, ...status });
      } else {
        const err = new Error(`pip install exited with code=${code} — see headroom/install.log`);
        err.code = "INSTALL_FAILED";
        reject(err);
      }
    });
  });
}

// Uninstall the marker packages that back a single extra (e.g. `ml` → torch,
// huggingface-hub). `headroom-ai` base and the `proxy` extra are never removed.
export async function uninstallHeadroomExtras(extras = []) {
  const requested = Array.isArray(extras) ? extras.filter((e) => HEADROOM_COMPRESSION_EXTRAS.includes(e)) : [];
  const py = findPython310();
  if (!py) {
    const err = new Error("Python >= 3.10 not found");
    err.code = "NO_PYTHON";
    throw err;
  }
  const pkgs = [...new Set(requested.flatMap((e) => EXTRA_MARKERS[e] || []))];
  if (pkgs.length === 0) {
    const err = new Error("No valid extras to remove");
    err.code = "INVALID_EXTRAS";
    throw err;
  }
  const args = ["-m", "pip", "uninstall", "-y", ...pkgs];

  ensureDir();
  const outFd = fs.openSync(INSTALL_LOG_FILE, "w");
  const child = spawn(py, args, {
    stdio: ["ignore", outFd, outFd],
    windowsHide: true,
    env: { ...process.env },
  });

  return new Promise((resolve, reject) => {
    child.once("error", (e) => { fs.closeSync(outFd); reject(e); });
    child.once("exit", (code) => {
      fs.closeSync(outFd);
      if (code === 0) {
        const status = getInstalledHeadroomExtras(py);
        resolve({ success: true, code, removed: pkgs, extras: requested, ...status });
      } else {
        const err = new Error(`pip uninstall exited with code=${code} — see headroom/install.log`);
        err.code = "UNINSTALL_FAILED";
        reject(err);
      }
    });
  });
}

// Read the tail of the install/uninstall log for live progress in the UI.
export function getInstallLogTail(maxLines = 15) {
  try {
    if (!fs.existsSync(INSTALL_LOG_FILE)) return "";
    const lines = fs.readFileSync(INSTALL_LOG_FILE, "utf8").split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines).join("\n");
  } catch { return ""; }
}

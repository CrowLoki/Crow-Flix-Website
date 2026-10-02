import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMP_PREFIX = "crowflix-acceptance-";
const TERMINATION_UNCONFIRMED = "CROWFLIX_TERMINATION_UNCONFIRMED";

const hasExited = (child) => child.exitCode !== null || child.signalCode !== null;
const terminationFailure = (message, cause) => Object.assign(new Error(message, { cause }), { code: TERMINATION_UNCONFIRMED });
const isTerminationUnconfirmed = (error) => error?.code === TERMINATION_UNCONFIRMED
  || (error instanceof AggregateError && error.errors.some(isTerminationUnconfirmed));

function throwFailures(errors, message) {
  if (errors.length === 1) throw errors[0];
  // The CLI prints .message, so retain every failure there as well as in .errors.
  if (errors.length) throw new AggregateError(errors, `${message}\n${errors.map((error) => error.message || String(error)).join("\n")}`, { cause: errors[0] });
}

async function waitForExit(child, milliseconds) {
  if (hasExited(child)) return;
  let listener;
  let timer;
  try {
    await Promise.race([
      new Promise((resolve) => { listener = resolve; child.once("exit", listener); }),
      new Promise((resolve) => { timer = setTimeout(resolve, milliseconds); }),
    ]);
  } finally {
    if (listener) child.removeListener("exit", listener);
    clearTimeout(timer);
  }
}

/** Only terminate the child/process group created by this runner. */
export async function stopOwnedProcess(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (hasExited(child)) return;
    // Killing node first would orphan Chrome. Terminate the owned tree together.
    const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    let lastFailure;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore", windowsHide: true,
      });
      let spawnFailure;
      killer.on("error", (error) => { spawnFailure = error; });
      await waitForExit(killer, 20_000);
      if (!hasExited(killer)) {
        killer.kill();
        await waitForExit(killer, 2_000);
      }
      await waitForExit(child, 5_000);
      if (killer.exitCode === 0 && hasExited(child)) return;
      lastFailure = spawnFailure || new Error(`Owned-tree termination attempt ${attempt + 1} did not confirm success (taskkill ${killer.exitCode ?? killer.signalCode ?? "still running"}).`);
      // Once the parent has exited, its PID is not a safe retry target. A failed
      // taskkill can still have left descendants alive, so retain their profile.
      if (hasExited(child)) break;
      if (attempt === 0) await delay(250);
    }
    throw terminationFailure("The isolated browser process tree could not be confirmed stopped.", lastFailure);
  }
  // Each child is a new POSIX process group, including its browser descendants.
  const killGroup = (signal) => {
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  killGroup("SIGTERM");
  await waitForExit(child, 5_000);
  killGroup("SIGKILL");
  await waitForExit(child, 5_000);
  if (!hasExited(child)) throw terminationFailure("The isolated browser process group did not stop.");
}

export async function runOwnedNode(args, {
  cwd = repositoryRoot,
  env = process.env,
  timeoutMs = 3 * 60_000,
  signal,
  stdio = "inherit",
  stopChild = stopOwnedProcess,
} = {}) {
  signal?.throwIfAborted();
  const child = spawn(process.execPath, args, {
    cwd, env, stdio, windowsHide: true, detached: process.platform !== "win32",
  });
  let timer;
  let abort;
  const failures = [];
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Isolated browser check exceeded ${timeoutMs} ms.`)), timeoutMs);
      abort = () => reject(signal.reason || new Error("Browser acceptance interrupted"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.once("error", reject);
      child.once("exit", (code, exitSignal) => {
        if (code === 0) resolve();
        else reject(new Error(`Browser check failed (${exitSignal || `exit ${code}`}): ${path.basename(args[0] || "node")}`));
      });
    });
  } catch (error) {
    failures.push(error);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    try { await stopChild(child); }
    catch (error) {
      failures.push(isTerminationUnconfirmed(error) ? error
        : terminationFailure(`Owned-process shutdown failed: ${error.message || error}`, error));
    }
  }
  throwFailures(failures, "Browser check and owned-process shutdown failed:");
}

export async function removeAcceptanceRoot(directory, parent = tmpdir()) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(parent) || !path.basename(resolved).startsWith(TEMP_PREFIX)) {
    throw new Error("Refusing to remove anything except the runner's isolated temporary directory.");
  }
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { await rm(resolved, { recursive: true, force: true }); return; }
    catch (error) {
      if (attempt === 79) throw error;
      await delay(250);
    }
  }
}

async function startLocalPreview(dist) {
  if (!(await stat(path.join(dist, "index.html"))).isFile()) throw new Error("Build the site before running browser acceptance.");
  const { preview } = await import("vite");
  // Avoid loading unrelated dev plugins or a fixed user port. Port zero belongs
  // only to this server; no pre-existing preview can accidentally satisfy CI.
  const server = await preview({
    configFile: false, root: repositoryRoot, logLevel: "warn",
    build: { outDir: dist },
    preview: { host: "127.0.0.1", port: 0, strictPort: true, open: false },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.httpServer.close(resolve));
    throw new Error("Local preview did not bind an isolated loopback port.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    async close() {
      server.httpServer.closeAllConnections();
      await new Promise((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export async function runBrowserChecks({
  dist = path.join(repositoryRoot, "dist"),
  signal,
  runChild = runOwnedNode,
  startPreview = startLocalPreview,
  removeRoot = removeAcceptanceRoot,
  log = console.log,
} = {}) {
  const temporaryParent = path.resolve(tmpdir());
  const temporaryRoot = await mkdtemp(path.join(temporaryParent, TEMP_PREFIX));
  const env = { ...process.env, CROWFLIX_ACCEPTANCE_TEMP_ROOT: temporaryRoot };
  let preview;
  const failures = [];
  try {
    signal?.throwIfAborted();
    preview = await startPreview(path.resolve(dist));
    log("Running isolated local application regressions; provider traffic is blocked.");
    await runChild(["scripts/headless-review-regressions.mjs", preview.url], { env, signal });
    await preview.close();
    preview = null;
    signal?.throwIfAborted();
    log("Running local decoded-media acceptance with owned fixtures.");
    await runChild(["scripts/headless-playback-acceptance.mjs", "--dist", path.resolve(dist)], { env, signal, timeoutMs: 230_000 });
    log("Local browser acceptance passed: application regressions and decoded playback.");
  } catch (error) {
    failures.push(error);
  } finally {
    try { await preview?.close(); }
    catch (error) { failures.push(error); }
    if (failures.some(isTerminationUnconfirmed)) {
      failures.push(new Error(`Retained isolated browser files because process termination is unconfirmed: ${temporaryRoot}`));
    } else {
      try { await removeRoot(temporaryRoot, temporaryParent); }
      catch (error) { failures.push(error); }
    }
  }
  throwFailures(failures, "Browser acceptance failed, including cleanup:");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--dist")) {
    throw new Error("Usage: node scripts/run-browser-checks.mjs [--dist <built directory>]");
  }
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Browser acceptance interrupted"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try { await runBrowserChecks({ ...(args[1] ? { dist: args[1] } : {}), signal: controller.signal }); }
  finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

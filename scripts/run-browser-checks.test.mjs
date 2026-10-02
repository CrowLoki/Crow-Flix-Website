import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { removeAcceptanceRoot, runBrowserChecks, runOwnedNode } from "./run-browser-checks.mjs";

describe("owned browser acceptance runner", () => {
  it("runs suites sequentially, stops preview before playback and removes its unique temporary root", async () => {
    const calls = [];
    let temporaryRoot;
    const close = vi.fn(async () => { calls.push("close preview"); });
    const runChild = vi.fn(async (args, options) => {
      temporaryRoot = options.env.CROWFLIX_ACCEPTANCE_TEMP_ROOT;
      expect((await stat(temporaryRoot)).isDirectory()).toBe(true);
      expect(path.dirname(temporaryRoot)).toBe(path.resolve(tmpdir()));
      calls.push(path.basename(args[0]));
    });
    await runBrowserChecks({
      dist: "dist", log: vi.fn(), runChild,
      startPreview: vi.fn(async () => ({ url: "http://127.0.0.1:32123/", close })),
    });
    expect(calls).toEqual(["headless-review-regressions.mjs", "close preview", "headless-playback-acceptance.mjs"]);
    expect(runChild.mock.calls[0][0][1]).toBe("http://127.0.0.1:32123/");
    expect(runChild.mock.calls[1][0].slice(1)).toEqual(["--dist", path.resolve("dist")]);
    expect(runChild.mock.calls[1][1].timeoutMs).toBe(230_000);
    await expect(stat(temporaryRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops on the first failure and cleans preview and temporary files", async () => {
    let temporaryRoot;
    const close = vi.fn(async () => {});
    const runChild = vi.fn(async (_args, options) => {
      temporaryRoot = options.env.CROWFLIX_ACCEPTANCE_TEMP_ROOT;
      throw new Error("deliberate failure");
    });
    await expect(runBrowserChecks({
      runChild, log: vi.fn(), startPreview: async () => ({ url: "http://127.0.0.1:32123/", close }),
    })).rejects.toThrow("deliberate failure");
    expect(runChild).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    await expect(stat(temporaryRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not remove a broad or unrelated directory", async () => {
    await expect(removeAcceptanceRoot(tmpdir())).rejects.toThrow(/Refusing/);
    await expect(removeAcceptanceRoot(path.join(tmpdir(), "unrelated-directory"))).rejects.toThrow(/Refusing/);
    await expect(removeAcceptanceRoot(process.cwd())).rejects.toThrow(/Refusing/);
  });

  it("preserves the original failure when preview and directory cleanup also fail", async () => {
    const original = new Error("original suite failure");
    const previewFailure = new Error("preview close failed");
    const directoryFailure = new Error("directory cleanup failed");
    let temporaryRoot;
    try {
      const result = await runBrowserChecks({
        log: vi.fn(),
        runChild: async (_args, options) => {
          temporaryRoot = options.env.CROWFLIX_ACCEPTANCE_TEMP_ROOT;
          throw original;
        },
        startPreview: async () => ({ url: "http://127.0.0.1:32123/", close: async () => { throw previewFailure; } }),
        removeRoot: async () => { throw directoryFailure; },
      }).catch((error) => error);
      expect(result).toBeInstanceOf(AggregateError);
      expect(result.errors).toEqual([original, previewFailure, directoryFailure]);
      expect(result.cause).toBe(original);
      for (const failure of [original, previewFailure, directoryFailure]) expect(result.message).toContain(failure.message);
    } finally {
      if (temporaryRoot) await removeAcceptanceRoot(temporaryRoot);
    }
  });

  it("retains the profile root when owned-process termination cannot be confirmed", async () => {
    const original = new Error("suite timeout");
    const termination = Object.assign(new Error("owned process still alive"), { code: "CROWFLIX_TERMINATION_UNCONFIRMED" });
    const removeRoot = vi.fn();
    const close = vi.fn(async () => {});
    let temporaryRoot;
    try {
      const result = await runBrowserChecks({
        log: vi.fn(), removeRoot,
        runChild: async (_args, options) => {
          temporaryRoot = options.env.CROWFLIX_ACCEPTANCE_TEMP_ROOT;
          throw new AggregateError([original, termination], "suite and termination failed", { cause: original });
        },
        startPreview: async () => ({ url: "http://127.0.0.1:32123/", close }),
      }).catch((error) => error);
      expect(result.message).toContain("Retained isolated browser files");
      expect(result.message).toContain(temporaryRoot);
      expect(removeRoot).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      expect((await stat(temporaryRoot)).isDirectory()).toBe(true);
    } finally {
      if (temporaryRoot) await removeAcceptanceRoot(temporaryRoot);
    }
  });

  it("preserves a child failure alongside a shutdown failure", async () => {
    const cleanup = new Error("injected shutdown failure");
    const result = await runOwnedNode(["-e", "process.exit(7)"], {
      stdio: "ignore", timeoutMs: 5_000, stopChild: async () => { throw cleanup; },
    }).catch((error) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect(result.errors[0].message).toContain("exit 7");
    expect(result.errors[1]).toMatchObject({ code: "CROWFLIX_TERMINATION_UNCONFIRMED", cause: cleanup });
    expect(result.cause).toBe(result.errors[0]);
  });

  it("propagates an actual child failure", async () => {
    await expect(runOwnedNode(["-e", "process.exit(7)"], { stdio: "ignore", timeoutMs: 5_000 }))
      .rejects.toThrow(/exit 7/);
  });

  it("bounds and terminates an actual hung child without starting a browser", async () => {
    // Even a failing shutdown implementation must not leak this leaf fixture.
    await expect(runOwnedNode(["-e", "setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000)"], { stdio: "ignore", timeoutMs: 300 }))
      .rejects.toThrow(/exceeded 300 ms/);
  }, 70_000);

  it("terminates a real owned parent and its descendant on timeout", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "crowflix-runner-test-"));
    const marker = path.join(directory, "owned-processes.json");
    let owned = [];
    const alive = (pid) => {
      try { process.kill(pid, 0); return true; }
      catch (error) { if (error.code === "ESRCH") return false; throw error; }
    };
    const program = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
      descendant.once('spawn', () => writeFileSync(process.argv[1], JSON.stringify([process.pid, descendant.pid])));
      descendant.once('exit', () => process.exit(0));
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `;
    try {
      await expect(runOwnedNode(["-e", program, marker], { stdio: "ignore", timeoutMs: 5_000 }))
        .rejects.toThrow(/exceeded 5000 ms/);
      owned = JSON.parse(await readFile(marker, "utf8"));
      expect(owned).toHaveLength(2);
      for (let attempt = 0; attempt < 20 && owned.some(alive); attempt += 1) await delay(100);
      expect(owned.filter(alive)).toEqual([]);
    } finally {
      if (!owned.length) owned = JSON.parse(await readFile(marker, "utf8").catch(() => "[]"));
      for (const pid of owned) if (alive(pid)) process.kill(pid, "SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  }, 70_000);
});

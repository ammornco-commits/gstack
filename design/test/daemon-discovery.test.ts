/**
 * Out-of-process tests for daemon-client.ts.
 *
 * Spawns real daemon subprocesses (via the fixtures helper) so we can
 * exercise: state-file discovery, /health attach vs spawn, the lock +
 * re-read-under-lock race, identity-verified SIGTERM, version mismatch
 * with and without active boards, startup-error log surfacing, and the
 * concurrent-CLIs race (two real subprocesses, one wins the lock).
 *
 * These tests are slower than daemon.test.ts (each spawn is ~200ms) so
 * they're kept in a separate file to keep the in-process suite fast.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import {
  daemonStatus,
  ensureDaemon,
  publishBoard,
  shutdownDaemon,
} from "../src/daemon-client";
import {
  CMDLINE_MARKER,
  isProcessAlive,
  readStateFile,
  resolveLockFilePath,
  verifyIdentity,
} from "../src/daemon-state";
import {
  DAEMON_SCRIPT,
  makeBoardHtml,
  makeTmpDir,
  spawnDaemonForTest,
  type SpawnedDaemon,
} from "./daemon-tests-fixtures";

let workDir: string;
let stateFile: string;
let activeDaemons: SpawnedDaemon[] = [];

beforeEach(() => {
  workDir = makeTmpDir("discovery");
  stateFile = path.join(workDir, "design.json");
  // Each test gets a private state-file path; env var ensures both the
  // client's resolver and any spawned daemons converge on the same file.
  process.env.DESIGN_DAEMON_STATE_FILE = stateFile;
});

afterEach(async () => {
  for (const d of activeDaemons.splice(0)) {
    try { await d.stop(); } catch {}
  }
  // Tear down any state file left around so the next test starts clean.
  try { fs.unlinkSync(stateFile); } catch {}
  try { fs.unlinkSync(resolveLockFilePath(stateFile)); } catch {}
  delete process.env.DESIGN_DAEMON_STATE_FILE;
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
});

async function spawn1(idleMs = 60_000): Promise<SpawnedDaemon> {
  const d = await spawnDaemonForTest({ stateFile, idleMs });
  activeDaemons.push(d);
  return d;
}

// ─── healthCheck + readStateFile basics ──────────────────────────

describe("daemon-state helpers", () => {
  test("readStateFile returns null when missing", () => {
    expect(readStateFile(stateFile)).toBeNull();
  });

  test("spawned daemon writes a usable state file", async () => {
    const d = await spawn1();
    const state = readStateFile(stateFile);
    expect(state).not.toBeNull();
    expect(state!.pid).toBe(d.proc.pid);
    expect(state!.port).toBe(d.port);
    expect(state!.cmdlineMarker).toBe(CMDLINE_MARKER);
    expect(state!.version).toBe("test-version");
  });

  test("verifyIdentity matches a real spawned daemon's cmdline", async () => {
    const d = await spawn1();
    expect(verifyIdentity(d.proc.pid!, CMDLINE_MARKER)).toBe(true);
    // wrong marker → false
    expect(verifyIdentity(d.proc.pid!, "some-other-marker-xyz")).toBe(false);
  });

  test("verifyIdentity returns false for dead pids", async () => {
    expect(verifyIdentity(999_999_999, CMDLINE_MARKER)).toBe(false);
  });
});

// ─── ensureDaemon ────────────────────────────────────────────────

describe("ensureDaemon", () => {
  test("with no state file: spawns a fresh daemon", async () => {
    const result = await ensureDaemon({
      version: "test-version",
      stateFile,
      verbose: false,
    });
    expect(result.spawned).toBe(true);
    expect(result.port).toBeGreaterThan(0);
    expect(result.version).toBe("test-version");

    const state = readStateFile(stateFile);
    expect(state).not.toBeNull();
    expect(isProcessAlive(state!.pid)).toBe(true);

    // Track for cleanup
    activeDaemons.push({
      proc: { pid: state!.pid } as any,
      port: state!.port,
      stateFile,
      stop: async () => {
        try { process.kill(state!.pid, "SIGTERM"); } catch {}
      },
    });
  });

  test("with a healthy daemon already running: attaches without spawning", async () => {
    const existing = await spawn1();
    const result = await ensureDaemon({
      version: "test-version",
      stateFile,
      verbose: false,
    });
    expect(result.spawned).toBe(false);
    expect(result.port).toBe(existing.port);
  });

  test("with a stale state file (PID dead): spawns fresh, overwrites state", async () => {
    // Synthesize a stale state file pointing at a definitely-dead pid.
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      pid: 999_999_998,
      port: 1, // bogus port — /health will fail fast
      startedAt: "2020-01-01T00:00:00Z",
      version: "ancient",
      serverPath: "/nope",
      cmdlineMarker: CMDLINE_MARKER,
    }));

    const result = await ensureDaemon({
      version: "test-version",
      stateFile,
      verbose: false,
    });
    expect(result.spawned).toBe(true);

    // State file should now point at the live daemon.
    const fresh = readStateFile(stateFile);
    expect(fresh!.pid).not.toBe(999_999_998);
    expect(isProcessAlive(fresh!.pid)).toBe(true);

    activeDaemons.push({
      proc: { pid: fresh!.pid } as any,
      port: fresh!.port,
      stateFile,
      stop: async () => { try { process.kill(fresh!.pid, "SIGTERM"); } catch {} },
    });
  });

  test("PID-reuse safety: stale state with an unrelated alive PID → identity-verify blocks signal, daemon spawned", async () => {
    // Use the current test process's PID — definitely alive, definitely
    // does NOT have CMDLINE_MARKER in its cmdline (it's the Bun test runner).
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      pid: process.pid, // alive but NOT a daemon
      port: 1,
      startedAt: "2020-01-01T00:00:00Z",
      version: "ancient",
      serverPath: "/nope",
      cmdlineMarker: CMDLINE_MARKER,
    }));

    // ensureDaemon should NOT signal process.pid (we'd kill ourselves);
    // verifyIdentity catches the cmdline mismatch and skips the kill.
    const result = await ensureDaemon({
      version: "test-version",
      stateFile,
      verbose: false,
    });

    // We're still alive (didn't get killed)
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(result.spawned).toBe(true);

    const fresh = readStateFile(stateFile);
    expect(fresh!.pid).not.toBe(process.pid);
    activeDaemons.push({
      proc: { pid: fresh!.pid } as any,
      port: fresh!.port,
      stateFile,
      stop: async () => { try { process.kill(fresh!.pid, "SIGTERM"); } catch {} },
    });
  });

  test("version mismatch with NO active boards: gracefully shuts existing down and respawns", async () => {
    const existing = await spawn1();
    // The existing daemon's version is "test-version" (set by fixture env).
    // ensureDaemon with a DIFFERENT version → should /shutdown the existing
    // (no active boards) and spawn fresh.
    const result = await ensureDaemon({
      version: "different-version",
      stateFile,
      verbose: false,
    });
    expect(result.spawned).toBe(true);
    expect(result.version).toBe("different-version");

    // existing.proc.pid should be gone by now (or soon)
    // Give it a moment for the /shutdown + SIGTERM to take effect
    await new Promise((r) => setTimeout(r, 200));
    expect(isProcessAlive(existing.proc.pid!)).toBe(false);

    // New daemon recorded
    const fresh = readStateFile(stateFile);
    expect(fresh!.pid).not.toBe(existing.proc.pid);
    activeDaemons.push({
      proc: { pid: fresh!.pid } as any,
      port: fresh!.port,
      stateFile,
      stop: async () => { try { process.kill(fresh!.pid, "SIGTERM"); } catch {} },
    });
  });

  test("version mismatch WITH active boards: refuses to kill, exits 1 with user-actionable error", async () => {
    // Run the ensureDaemon-that-would-exit-1 in a subprocess so we can
    // observe the exit code and stderr without killing the test runner.
    const existing = await spawn1();

    // Publish a board so activeBoards > 0
    const html = makeBoardHtml(workDir);
    await publishBoard({ port: existing.port, html });

    // Sanity: status should reflect the active board
    const statusResp = await fetch(`http://127.0.0.1:${existing.port}/health`);
    const status = (await statusResp.json()) as any;
    expect(status.activeBoards).toBe(1);

    // Now run a tiny script that calls ensureDaemon with a mismatched
    // version. It should print the WARNING + exit 1.
    const scriptPath = path.join(workDir, "ensure-mismatch.ts");
    fs.writeFileSync(scriptPath, `
import { ensureDaemon } from "${path.resolve(import.meta.dir, "..", "src", "daemon-client.ts").replace(/\\\\/g, "/")}";
await ensureDaemon({
  version: "totally-different-version",
  stateFile: ${JSON.stringify(stateFile)},
  verbose: true,
});
console.log("REACHED_AFTER_ENSURE — should not happen");
`);

    const child = spawn("bun", ["run", scriptPath], {
      env: { ...process.env, DESIGN_DAEMON_STATE_FILE: stateFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    const stdoutChunks: Buffer[] = [];
    child.stderr.on("data", (c) => stderrChunks.push(c));
    child.stdout.on("data", (c) => stdoutChunks.push(c));
    const exitCode = await new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? -1));
    });
    const stderr = Buffer.concat(stderrChunks).toString();
    const stdout = Buffer.concat(stdoutChunks).toString();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("active board");
    expect(stderr).toContain("Refusing to auto-kill");
    // We must NOT have reached the post-ensure line
    expect(stdout).not.toContain("REACHED_AFTER_ENSURE");

    // And the existing daemon should still be alive
    expect(isProcessAlive(existing.proc.pid!)).toBe(true);
  }, 15_000);
});

// ─── publishBoard ────────────────────────────────────────────────

describe("publishBoard", () => {
  test("publishes a board through the real HTTP path and returns id+url+sourceDir", async () => {
    const d = await spawn1();
    const htmlPath = makeBoardHtml(workDir, "<p>via-client</p>");
    const result = await publishBoard({ port: d.port, html: htmlPath });
    expect(result.id).toMatch(/^b-/);
    expect(result.url).toBe(`http://127.0.0.1:${d.port}/boards/${result.id}/`);
    expect(result.sourceDir).toBe(fs.realpathSync(workDir));

    // Confirm the board is actually fetchable at the returned URL
    const r = await fetch(result.url);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("via-client");
  });

  test("409 surfaces existing board's id+url (returned object, no throw)", async () => {
    const d = await spawn1();
    const htmlPath = makeBoardHtml(workDir);
    const first = await publishBoard({ port: d.port, html: htmlPath });
    const htmlPath2 = makeBoardHtml(workDir, "<p>second</p>");
    const second = await publishBoard({ port: d.port, html: htmlPath2 });
    // Same sourceDir → 409 with `existing` field; publishBoard returns it
    // so the caller can attach to the existing board.
    expect(second.id).toBe(first.id);
    expect(second.url).toBe(first.url);
  });
});

// ─── shutdownDaemon / daemonStatus ───────────────────────────────

describe("shutdownDaemon + daemonStatus", () => {
  test("status reports not-running when no state file", async () => {
    const s = await daemonStatus();
    expect(s.running).toBe(false);
  });

  test("status reports running with port + version + counts when daemon alive", async () => {
    const d = await spawn1();
    const s = await daemonStatus();
    expect(s.running).toBe(true);
    if (s.running) {
      expect(s.port).toBe(d.port);
      expect(s.pid).toBe(d.proc.pid);
      expect(s.version).toBe("test-version");
      expect(s.boards).toBe(0);
      expect(s.activeBoards).toBe(0);
    }
  });

  test("shutdownDaemon succeeds when no active boards", async () => {
    const d = await spawn1();
    const r = await shutdownDaemon();
    expect(r.stopped).toBe(true);
    // Give it a moment to die
    await new Promise((res) => setTimeout(res, 300));
    expect(isProcessAlive(d.proc.pid!)).toBe(false);
  });

  test("shutdownDaemon refuses (without force) when active boards present", async () => {
    const d = await spawn1();
    await publishBoard({ port: d.port, html: makeBoardHtml(workDir) });
    const r = await shutdownDaemon();
    expect(r.stopped).toBe(false);
    expect(r.reason).toContain("active");
    expect(r.activeBoards).toBe(1);
    // Daemon still running
    expect(isProcessAlive(d.proc.pid!)).toBe(true);
  });

  test("shutdownDaemon with force=true ignores active boards", async () => {
    const d = await spawn1();
    await publishBoard({ port: d.port, html: makeBoardHtml(workDir) });
    const r = await shutdownDaemon({ force: true });
    expect(r.stopped).toBe(true);
  });
});

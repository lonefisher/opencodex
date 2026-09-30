import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexInputUnlockSnapshot,
  launchCodexInputUnlock,
  resetCodexInputUnlockForTests,
  syncCodexInputUnlock,
  type CodexInputUnlockIo,
} from "../../src/codex/input-unlock/coordinator";
import type { DesktopAppAdapter, DesktopAppInstall, DesktopProcess } from "../../src/codex/desktop-app/types";
import { setTrustedWindowsElevationExecutablesForTests } from "../../src/lib/windows-elevation";
import type { OcxConfig } from "../../src/types";

/**
 * Coordinator state-machine coverage: the seams are injected so no PowerShell,
 * no real endpoint, and no process enumeration ever runs. The armed test-home
 * guard is what makes "the caller forgot to inject exec" a safe default.
 */

const INSTALL: DesktopAppInstall = { id: "pkg", root: "/fake/root", relaunch: "Pkg!App" };
const PROC: DesktopProcess = { pid: 4242, parentPid: 1, createdAt: "T0", executable: "/fake/root/ChatGPT.exe" };

function adapterWith(processes: DesktopProcess[] | null): DesktopAppAdapter {
  return {
    discover: () => INSTALL,
    listProcesses: () => processes,
    isShell: () => true,
    ancestryPids: () => [9999],
    requestQuit: () => {},
    forceStop: () => {},
    captureRelaunchContext: () => ({}),
    relaunch: () => {},
  };
}

function enabledConfig(): OcxConfig {
  return { codexInputUnlock: { enabled: true } } as unknown as OcxConfig;
}
const disabledConfig = () => ({}) as unknown as OcxConfig;

let stateDir: string;

function io(over: Partial<CodexInputUnlockIo> = {}): CodexInputUnlockIo {
  stateDir = mkdtempSync(join(tmpdir(), "ocx-input-unlock-"));
  return {
    platform: "win32",
    execFile: () => "",
    adapter: adapterWith([]),
    statePath: join(stateDir, "state.json"),
    tickMs: 10_000_000, // effectively "manual": the loop is driven via sync()
    ...over,
  };
}

afterEach(async () => {
  await resetCodexInputUnlockForTests();
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

describe("syncCodexInputUnlock", () => {
  test("disabled config means no enumeration and a disabled snapshot", async () => {
    let enumerated = false;
    const snap = await syncCodexInputUnlock(disabledConfig(), io({
      adapter: { ...adapterWith([]), listProcesses: () => { enumerated = true; return []; } },
    }));
    expect(snap).toMatchObject({ enabled: false, state: "disabled" });
    expect(enumerated).toBe(false);
  });

  test("non-Windows reports unsupported and still runs nothing", async () => {
    const snap = await syncCodexInputUnlock(enabledConfig(), io({ platform: "darwin" }));
    expect(snap.state).toBe("unsupported");
  });

  test("enabled with no client and no launch record waits", async () => {
    const snap = await syncCodexInputUnlock(enabledConfig(), io());
    expect(snap.state).toBe("waiting");
  });

  test("enabled with an ordinary instance running reports restart_required", async () => {
    const snap = await syncCodexInputUnlock(enabledConfig(), io({ adapter: adapterWith([PROC]) }));
    expect(snap.state).toBe("restart_required");
  });

  test("an injected adapter without an injected exec is still refused by the guard", async () => {
    // Under the armed test-home guard the coordinator must not launder a fake
    // adapter into a real exec: exec stays undefined, so the guard fires.
    const snap = await syncCodexInputUnlock(enabledConfig(), io({ execFile: undefined }));
    expect(snap.state).toBe("waiting");
    expect(snap.detail).toContain("environment");
  });

  test("a live recorded endpoint reattaches the supervisor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-input-unlock-"));
    stateDir = dir;
    const statePath = join(dir, "state.json");
    // Pre-seed a launch record, then answer /json with an app page target.
    const { writeCodexInputUnlockState } = await import("../../src/codex/input-unlock/state");
    writeCodexInputUnlockState(
      { version: 1, debugPort: 9555, appPid: 4242, aumid: "Pkg!App", launchedAt: new Date().toISOString() },
      { statePath },
    );
    let supervisedPort: number | null = null;
    const snap = await syncCodexInputUnlock(enabledConfig(), io({
      statePath,
      cdp: {
        fetchImpl: (async () => new Response(JSON.stringify([
          { id: "p", type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9555/devtools/page/p" },
        ]), { status: 200 })) as typeof fetch,
      },
      runSupervisorImpl: async options => {
        supervisedPort = options.port;
        return { mountedAtLeastOnce: false, endpointGone: true };
      },
    }));
    expect(supervisedPort).toBe(9555);
    // The supervisor resolves instantly, so the phase it last reported stands.
    expect(["attaching", "waiting", "failed"]).toContain(snap.state);
  });
});

describe("launchCodexInputUnlock", () => {
  test("refuses under the test guard when no exec is injected", async () => {
    const result = await launchCodexInputUnlock(enabledConfig(), {}, io({ execFile: undefined }));
    expect(result).toMatchObject({ launched: false, reason: "test_environment" });
  });

  test("a running ordinary instance reports needsRestart rather than being replaced", async () => {
    const result = await launchCodexInputUnlock(enabledConfig(), {}, io({ adapter: adapterWith([PROC]) }));
    expect(result).toMatchObject({ launched: false, needsRestart: true });
    expect(result.snapshot.state).toBe("restart_required");
  });

  test("no client: allocates a port, COM-activates, records state, supervises", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-input-unlock-"));
    stateDir = dir;
    const statePath = join(dir, "state.json");
    let supervisorPort: number | null = null;
    const result = await launchCodexInputUnlock(enabledConfig(), {}, io({
      statePath,
      allocatePortImpl: async () => 48879,
      launchImpl: async () => ({ debugPort: 48879, appPid: 7777 }),
      runSupervisorImpl: async options => {
        supervisorPort = options.port;
        options.onPhase("mounted", { targetUrl: "app://-/index.html" });
        return { mountedAtLeastOnce: true, endpointGone: false };
      },
    }));
    expect(result.launched).toBe(true);
    const record = JSON.parse(readFileSync(statePath, "utf8")) as { debugPort: number; appPid: number };
    expect(record).toMatchObject({ debugPort: 48879, appPid: 7777 });
    expect(supervisorPort).toBe(48879);
    expect(codexInputUnlockSnapshot(enabledConfig()).state).toBe("mounted");
  });

  test("--restart goes through the injected restart ladder, not a silent kill", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-input-unlock-"));
    stateDir = dir;
    const calls: Array<{ file: string; args: string[] }> = [];
    let restartedWith: { adapter?: unknown } | null = null;
    setTrustedWindowsElevationExecutablesForTests({ powershell: "powershell.exe" });
    try {
      const result = await launchCodexInputUnlock(enabledConfig(), { restart: true }, io({
        statePath: join(dir, "state.json"),
        adapter: adapterWith([PROC]),
        execFile: (file, args) => {
          calls.push({ file, args: [...args] });
          return "8888";
        },
        allocatePortImpl: async () => 49001,
        restartAppImpl: restartIo => {
          restartedWith = restartIo;
          // Drive the wrapper relaunch the way the real ladder would — with the
          // caller's exec verbatim, so the armed-guard semantics survive.
          restartIo.adapter?.relaunch(restartIo.execFile!, INSTALL, {});
          return { attempted: true, stopped: [PROC.pid], surviving: [], relaunch: "started" };
        },
        runSupervisorImpl: async () => ({ mountedAtLeastOnce: false, endpointGone: true }),
      }));
      expect(result.launched).toBe(true);
      expect(result.restarted).toBe(true);
      expect(restartedWith).not.toBeNull();
    } finally {
      setTrustedWindowsElevationExecutablesForTests(null);
    }
    // The wrapper's relaunch is the COM activation: an EncodedCommand whose
    // decoded script carries the discovered AUMID and the debug port.
    const activation = calls.find(c => c.args.includes("-EncodedCommand"))!;
    const decoded = Buffer.from(activation.args.at(-1)!, "base64").toString("utf16le");
    expect(decoded).toContain("Pkg!App");
    expect(decoded).toContain("--remote-debugging-port=49001");
    expect(decoded).toContain("--remote-debugging-address=127.0.0.1");
    const record = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { appPid: number; debugPort: number };
    expect(record).toMatchObject({ debugPort: 49001, appPid: 8888 });
  });
});

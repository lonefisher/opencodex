import { describe, expect, test } from "bun:test";
import {
  activateCodexDesktopApp,
  allocateLoopbackPort,
  codexDesktopLaunchArguments,
  encodePowerShellCommand,
  inputUnlockRealOsGuard,
  inputUnlockRestartAdapter,
} from "../../src/codex/input-unlock/windows";
import { setTrustedWindowsElevationExecutablesForTests } from "../../src/lib/windows-elevation";
import type { DesktopAppAdapter, DesktopAppInstall } from "../../src/codex/desktop-app/types";

/**
 * Windows launch-adapter coverage. The COM activation never leaves the machine
 * in these tests: the exec seam captures the encoded command so the payload can
 * be decoded and asserted instead of trusted.
 */

const INSTALL: DesktopAppInstall = { id: "pkg", root: "C:\\pkg", relaunch: "OpenAI.Codex_x!App" };

function withTrustedPowerShell<T>(run: () => T): T {
  setTrustedWindowsElevationExecutablesForTests({ powershell: "powershell.exe" });
  try {
    return run();
  } finally {
    setTrustedWindowsElevationExecutablesForTests(null);
  }
}

describe("codexDesktopLaunchArguments", () => {
  test("carries a loopback-only debugging triple", () => {
    expect(codexDesktopLaunchArguments(5111)).toEqual([
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=5111",
      "--remote-allow-origins=http://127.0.0.1:5111",
    ]);
  });
});

describe("allocateLoopbackPort", () => {
  test("returns a real ephemeral port", async () => {
    const port = await allocateLoopbackPort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });
});

describe("activateCodexDesktopApp", () => {
  test("invokes the trusted PowerShell with an EncodedCommand and parses the pid", () => {
    const calls: Array<{ file: string; args: string[]; timeout?: number }> = [];
    const pid = withTrustedPowerShell(() => activateCodexDesktopApp(
      (file, args, options) => {
        calls.push({ file, args: [...args], timeout: options?.timeout });
        return "noise\r\n4242\r\n";
      },
      INSTALL,
      codexDesktopLaunchArguments(5111),
    ));
    expect(pid).toBe(4242);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("powershell.exe");
    expect(calls[0]!.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(calls[0]!.timeout).toBeGreaterThan(0);
  });

  test("the encoded script carries the aumid and the debug arguments", () => {
    let encoded = "";
    withTrustedPowerShell(() => activateCodexDesktopApp(
      (_file, args) => {
        encoded = args.at(-1)!;
        return "1";
      },
      INSTALL,
      codexDesktopLaunchArguments(64001),
    ));
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toContain("ActivateApplication");
    expect(script).toContain("'OpenAI.Codex_x!App'");
    expect(script).toContain("--remote-debugging-port=64001");
  });

  test("single quotes in the aumid or arguments are PowerShell-escaped", () => {
    let encoded = "";
    withTrustedPowerShell(() => activateCodexDesktopApp(
      (_file, args) => {
        encoded = args.at(-1)!;
        return "1";
      },
      { ...INSTALL, relaunch: "Pkg.O'Codex!App" },
      ["--flag", "--value=it's"],
    ));
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toContain("'Pkg.O''Codex!App'");
    expect(script).toContain("it''s");
  });

  test("a shell that reports no pid fails instead of returning garbage", () => {
    expect(() => withTrustedPowerShell(() => activateCodexDesktopApp(
      () => "not a pid",
      INSTALL,
      codexDesktopLaunchArguments(5111),
    ))).toThrow();
  });
});

describe("inputUnlockRestartAdapter", () => {
  test("keeps the base adapter's members and swaps only relaunch", () => {
    const base: DesktopAppAdapter = {
      discover: () => INSTALL,
      listProcesses: () => [],
      isShell: () => true,
      ancestryPids: () => [1],
      requestQuit: () => {},
      forceStop: () => {},
      captureRelaunchContext: () => ({}),
      relaunch: () => { throw new Error("base relaunch must not run"); },
    };
    let encoded = "";
    const { adapter, launchedPid } = inputUnlockRestartAdapter(6001, base);
    withTrustedPowerShell(() => adapter.relaunch((_f, args) => { encoded = args.at(-1)!; return "777"; }, INSTALL, {}));
    expect(launchedPid()).toBe(777);
    expect(adapter.discover).toBe(base.discover);
    expect(adapter.listProcesses).toBe(base.listProcesses);
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toContain("--remote-debugging-port=6001");
  });
});

describe("inputUnlockRealOsGuard", () => {
  test("an armed test environment refuses a real exec; an injected exec disarms it", () => {
    // tests/preload arms the guard; an explicit exec proves the caller owns the seam.
    expect(inputUnlockRealOsGuard(undefined)).toBe(true);
    expect(inputUnlockRealOsGuard(() => "")).toBe(false);
  });
});

/**
 * Windows launch adapter for the Codex desktop input unlock.
 *
 * The official MSIX app accepts Chromium switches through COM activation —
 * `IApplicationActivationManager::ActivateApplication` passes them as the
 * command line, which is how the upstream patch's PowerShell script launched
 * the client with a loopback debug port. This file keeps the same contract
 * (GUIDs, `--remote-debugging-*` arguments) but runs inside the proxy: the
 * PowerShell invocation is one bounded `exec` call that activates the app and
 * prints the new pid, rather than an installed controller script.
 *
 * Port allocation keeps the upstream approach — bind port 0 on loopback, read
 * the port the OS picked, release it — via `node:net`, which Bun provides.
 * The released port can be claimed by another process before the app binds it;
 * the coordinator tolerates that because the supervisor only attaches to an
 * endpoint that actually answers `app://` page targets.
 */
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { resolveTrustedWindowsPowerShellExe } from "../../lib/windows-elevation";
import { isTestHomeGuardArmed } from "../../lib/test-home-guard";
import {
  parseWindowsDiscover,
  parseWindowsProcessList,
  WINDOWS_POWERSHELL_PROBE_OPTIONS,
  windowsDesktopAppAdapter,
  windowsDefaultExec,
  windowsDiscoverScript,
  windowsListProcessesScript,
} from "../desktop-app/windows";
import type {
  DesktopAppAdapter,
  DesktopAppInstall,
  DesktopExec,
  DesktopProcess,
} from "../desktop-app/types";

const POWERSHELL_TIMEOUT_MS = 30_000;

/** Chromium arguments carried by the activation command line. */
export function codexDesktopLaunchArguments(debugPort: number): string[] {
  return [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${debugPort}`,
    `--remote-allow-origins=http://127.0.0.1:${debugPort}`,
  ];
}

/** Pick an ephemeral loopback TCP port, release it, and return it. */
export async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string" || !address.port) {
      throw new Error("no ephemeral port was assigned");
    }
    return address.port;
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

/**
 * The COM activation shim. `Add-Type` compiles the interop declaration in the
 * fresh PowerShell process (the `interface`/`class` pair is upstream's
 * verbatim), then `ActivateApplication` starts the MSIX app with our argument
 * string and reports the pid on stdout.
 */
function activationScript(aumid: string, argumentString: string): string {
  const escape = (value: string) => value.replace(/'/g, "''");
  return `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace CodexInputUnlock {
  [Flags]
  public enum ActivateOptions : uint {
    None = 0
  }

  [ComImport]
  [Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IApplicationActivationManager {
    int ActivateApplication(
      [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
      [MarshalAs(UnmanagedType.LPWStr)] string arguments,
      ActivateOptions options,
      out uint processId);
    int ActivateForFile(string appUserModelId, IntPtr itemArray, string verb, out uint processId);
    int ActivateForProtocol(string appUserModelId, IntPtr itemArray, out uint processId);
  }

  [ComImport]
  [Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
  class ApplicationActivationManager {}

  public static class ApplicationActivator {
    public static uint Activate(string appUserModelId, string arguments) {
      var manager = (IApplicationActivationManager)new ApplicationActivationManager();
      uint processId;
      int result = manager.ActivateApplication(appUserModelId, arguments, ActivateOptions.None, out processId);
      Marshal.ThrowExceptionForHR(result);
      return processId;
    }
  }
}
'@
$ocxPid = [CodexInputUnlock.ApplicationActivator]::Activate('${escape(aumid)}', '${escape(argumentString)}')
Write-Output $ocxPid`;
}

/** `-EncodedCommand` is UTF-16LE base64; embedding it avoids all argv quoting. */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function quoteWindowsArgument(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * COM-activate the discovered package with `arguments` on its command line.
 * Returns the pid the shell reported. Throws on probe or activation failure.
 */
export function activateCodexDesktopApp(
  exec: DesktopExec,
  install: Pick<DesktopAppInstall, "relaunch">,
  launchArguments: readonly string[],
): number {
  const argumentString = launchArguments.map(quoteWindowsArgument).join(" ");
  const encoded = encodePowerShellCommand(activationScript(install.relaunch, argumentString));
  const stdout = exec(resolveTrustedWindowsPowerShellExe(), [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded,
  ], { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true });
  const pid = Number(stdout.trim().split(/\r?\n/).pop());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`COM activation did not report a pid (stdout: ${stdout.trim().slice(0, 200)})`);
  }
  return pid;
}

/**
 * The discovered install plus the launch arguments for one run, wrapped as a
 * `DesktopAppAdapter` whose `relaunch` COM-activates with the debug port. The
 * restart ladder then keeps its identity checks, lock, and fail-closed stops;
 * only the "start the app again" step differs.
 */
export function inputUnlockRestartAdapter(
  debugPort: number,
  base: DesktopAppAdapter = windowsDesktopAppAdapter,
): { adapter: DesktopAppAdapter; launchedPid: () => number | null } {
  let pid: number | null = null;
  const adapter: DesktopAppAdapter = {
    ...base,
    relaunch(exec, install) {
      pid = activateCodexDesktopApp(exec, install, codexDesktopLaunchArguments(debugPort));
    },
  };
  return { adapter, launchedPid: () => pid };
}

/**
 * Everything the coordinator needs to launch a fresh client with the debug
 * port: allocate a port, COM-activate, report pid + port.
 */
export async function launchCodexDesktopWithDebugPort(
  exec: DesktopExec | undefined,
  install: Pick<DesktopAppInstall, "relaunch">,
): Promise<{ debugPort: number; appPid: number }> {
  const debugPort = await allocateLoopbackPort();
  const appPid = activateCodexDesktopApp(
    exec ?? windowsDefaultExec,
    install,
    codexDesktopLaunchArguments(debugPort),
  );
  return { debugPort, appPid };
}

/**
 * Armed test-home guard shared by the coordinator's launch paths, matching the
 * restart ladder's `test_environment` refusal: a test process that forgot to
 * inject `exec` must never reach the real activation path.
 */
export function inputUnlockRealOsGuard(exec: DesktopExec | undefined): boolean {
  return exec === undefined && isTestHomeGuardArmed();
}

export type CodexDesktopProbeResult =
  | { processes: DesktopProcess[] }
  | { error: "discovery" | "probe" };

/**
 * Async twin of the adapter's `execFileSync` probe contract. The sync exec is
 * fine for the one-shot restart ladder, but the coordinator's tick cannot run
 * it on the proxy event loop — each spawn can take seconds, so the loop would
 * stall every interval. `execFile` carries the same timeout bound and leaves
 * the loop free between spawns.
 */
async function execPowerShellProbe(script: string): Promise<string | null> {
  try {
    return await new Promise<string>((resolve, reject) => {
      execFile(
        resolveTrustedWindowsPowerShellExe(),
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { ...WINDOWS_POWERSHELL_PROBE_OPTIONS, encoding: "utf-8" },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
  } catch {
    return null;
  }
}

/**
 * Discover the package and list its processes without blocking the event loop.
 * The error tags mirror the adapter contract: `discovery` means the package
 * was not found, `probe` means the listing command itself could not run — the
 * same fail-closed distinction the restart ladder relies on.
 */
export async function probeCodexDesktopProcessesAsync(): Promise<CodexDesktopProbeResult> {
  const discoverOut = await execPowerShellProbe(windowsDiscoverScript());
  const install = discoverOut === null ? null : parseWindowsDiscover(discoverOut);
  if (!install) return { error: "discovery" };
  const listOut = await execPowerShellProbe(windowsListProcessesScript(install.root));
  if (listOut === null) return { error: "probe" };
  return { processes: parseWindowsProcessList(listOut, install.root) };
}

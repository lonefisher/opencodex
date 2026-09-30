/**
 * Windows adapter for the Codex desktop-app restart.
 *
 * Moved from `desktop-app-restart.ts`. Behaviour is the Appx/CIM/taskkill path
 * that already shipped: runtime package discovery, current-user GetOwner
 * scoping, CloseMainWindow then taskkill /T /F, relaunch through the discovered
 * AUMID. The shape is DesktopAppAdapter so the ladder, not this file, owns
 * PID-reuse re-verification and the fail-closed sequencing.
 *
 * Measured (devlog/_plan/260913_cross_platform_desktop_app_restart/001_platform_topology.md §3):
 * OpenAI.Codex MSIX, ChatGPT.exe, InstallLocation under WindowsApps.
 */
import { execFileSync } from "node:child_process";
import { sep, win32 } from "node:path";
import { resolveTrustedWindowsPowerShellExe, resolveTrustedWindowsTaskkillExe } from "../../lib/windows-elevation";
import {
  isUnderRoot,
  type DesktopAppAdapter,
  type DesktopAppInstall,
  type DesktopExec,
  type DesktopProcess,
} from "./types";

/** Every probe is bounded; on machines with slow CIM the per-process GetOwner loop — not the spawn — is what eats the budget. */
const PROBE_TIMEOUT_MS = 30_000;
const MAX_ANCESTRY_HOPS = 16;
const SHELL_BASENAME = "chatgpt.exe";

/**
 * The probe options the synchronous adapter passes to `execFileSync`, exported
 * so async callers (the input-unlock coordinator, which must not block the
 * proxy event loop on a PowerShell spawn) share the same bound.
 */
export const WINDOWS_POWERSHELL_PROBE_OPTIONS = { timeout: PROBE_TIMEOUT_MS, windowsHide: true } as const;
const POWERSHELL_PROBE_OPTIONS = WINDOWS_POWERSHELL_PROBE_OPTIONS;

/**
 * isUnderRoot checks a lexical path boundary and is case-sensitive. Windows
 * membership is case-insensitive, and this file is executed by Unix CI against
 * mixed slash paths, so both slash forms are folded onto the host separator first.
 * The boundary itself — sibling `OpenAI.Codex-evil` must not match root
 * `OpenAI.Codex` — is still isUnderRoot's, which is why the PowerShell
 * StartsWith is only a cheap pre-filter.
 */
function toHostMembershipPath(windowsPath: string): string {
  const lowered = windowsPath.toLowerCase();
  return lowered.replace(/[\\/]/g, sep);
}

function isMemberExecutable(executable: string, root: string): boolean {
  return isUnderRoot(toHostMembershipPath(executable), toHostMembershipPath(root));
}

/**
 * Runtime discovery, never a hardcoded identifier. The beta MSIX package family
 * changes between builds, so a literal AUMID would silently stop matching and
 * then either do nothing or — worse — match a package we did not mean.
 */
/**
 * The package-discovery probe, exported as a script string so the async
 * input-unlock enumeration path runs the identical command without going
 * through the synchronous `execFileSync` contract.
 */
export function windowsDiscoverScript(): string {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    "Import-Module Appx -ErrorAction SilentlyContinue",
    "$p = Get-AppxPackage -Name OpenAI.Codex",
    "if (-not $p) { $p = Get-AppxPackage -Name OpenAI.CodexBeta }",
    "if (-not $p -or -not $p.InstallLocation) { 'MISS' } else {",
    "  $p.PackageFamilyName; $p.InstallLocation; \"$($p.PackageFamilyName)!App\"",
    "}",
  ].join("; ");
}

/** Parse {@link windowsDiscoverScript} stdout; null means "not installed" or unparseable. */
export function parseWindowsDiscover(stdout: string): DesktopAppInstall | null {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
  if (lines.length < 3 || lines[0] === "MISS") return null;
  const [family, installLocation, aumid] = lines;
  if (!family || !installLocation || !aumid) return null;
  return { id: family, root: installLocation, relaunch: aumid };
}

function discoverPackage(exec: DesktopExec): DesktopAppInstall | null {
  let stdout: string;
  try {
    stdout = exec(resolveTrustedWindowsPowerShellExe(), ["-NoProfile", "-NonInteractive", "-Command", windowsDiscoverScript()], POWERSHELL_PROBE_OPTIONS);
  } catch {
    return null;
  }
  return parseWindowsDiscover(stdout);
}

/**
 * The process-listing probe, exported like {@link windowsDiscoverScript} for
 * the same async caller.
 *
 * Lists only `ChatGPT.exe` processes whose image lives under the discovered install
 * location AND owned by the current user. The install location alone is not
 * enough: an MSIX package under `WindowsApps` is shared, so on a multi-user
 * machine another account's Codex desktop matches the same path. The app-server
 * collector already pays for `GetOwner` for exactly this reason.
 *
 * `CreationDate` is captured so a PID can be re-verified before it is signalled;
 * a graceful-close window is long enough for Windows to recycle a PID.
 *
 * ExecutablePath is included so membership can be decided by {@link isUnderRoot}
 * rather than by PowerShell's `StartsWith`, which is a prefix test and would
 * admit a sibling `OpenAI.Codex-evil` directory.
 */
export function windowsListProcessesScript(root: string): string {
  const literal = root.replace(/'/g, "''");
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$root = '${literal}'.Replace('/', '\\')`,
    "$me = ([Security.Principal.WindowsIdentity]::GetCurrent()).Name",
    "Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe'\" |",
    "  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.Replace('/', '\\').StartsWith($root, 'OrdinalIgnoreCase') } |",
    "  ForEach-Object {",
    "    $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner",
    "    if ($o -and $o.ReturnValue -eq 0 -and $o.User) {",
    "      $owner = if ($o.Domain) { \"$($o.Domain)\\$($o.User)\" } else { $o.User }",
    "      if ($owner -ieq $me) {",
    "        \"$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToString('o')) $($_.ExecutablePath)\"",
    "      }",
    "    }",
    "  }",
  // Statements must be newline-separated. Joining with a space concatenates
  // `$ErrorActionPreference='SilentlyContinue' $root = '...'` into one malformed statement,
  // which PowerShell rejects — so the probe threw and every caller read "not running" (#2557).
  ].join("\n");
}

/** Parse all of {@link windowsListProcessesScript}'s stdout into member processes. */
export function parseWindowsProcessList(stdout: string, root: string): DesktopProcess[] {
  const processes: DesktopProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const parsed = parseWindowsProcessLine(line, root);
    if (parsed) processes.push(parsed);
  }
  return processes;
}

function listPackageProcesses(exec: DesktopExec, install: DesktopAppInstall): DesktopProcess[] | null {
  let stdout: string;
  try {
    stdout = exec(resolveTrustedWindowsPowerShellExe(), ["-NoProfile", "-NonInteractive", "-Command", windowsListProcessesScript(install.root)], POWERSHELL_PROBE_OPTIONS);
  } catch {
    // A probe that could not run is NOT proof the app is absent. Returning [] here made a
    // failed enumeration indistinguishable from "no targets", so the CLI reported the app as
    // not running and skipped a restart the user had explicitly asked for.
    return null;
  }
  return parseWindowsProcessList(stdout, install.root);
}

/** Parse one stdout line of {@link windowsListProcessesScript}; null when not a member process. */
export function parseWindowsProcessLine(line: string, root: string): DesktopProcess | null {
  const match = /^\s*(\d+)\s+(\d+)\s+(\S+)(?:\s+(.+))?$/.exec(line);
  if (!match) return null;
  const pid = Number(match[1]);
  const parentPid = Number(match[2]);
  const createdAt = match[3] ?? "";
  const listed = (match[4] ?? "").trim();
  // The live probe emits ExecutablePath. Historical listings, and the tests that
  // script them, were three tokens because the PowerShell filter is already
  // Name='ChatGPT.exe' under root. Synthesize that image so executable is
  // populated without treating a missing path as a different process.
  const executable = listed.length > 0 ? listed : `${root.replace(/[\\/]+$/, "")}\\ChatGPT.exe`;
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid) || !createdAt || !executable) {
    return null;
  }
  // Authoritative membership. PowerShell StartsWith already cheap-filtered, but
  // that test is a string prefix and is how a sibling install would sneak in.
  if (!isMemberExecutable(executable, root)) return null;
  return { pid, parentPid, createdAt, executable };
}

/**
 * Full Windows parent chain for this process, innermost first.
 *
 * `process.ppid` is one level, which is not enough: a terminal hosted inside the
 * desktop app sits several hops below `ChatGPT.exe`, so a one-level check would
 * miss the exact case the guard exists for and we would terminate our own host.
 * The chain therefore comes from CIM, with a bound so a corrupted parent cycle
 * cannot spin.
 */
function windowsAncestryPids(exec: DesktopExec): number[] {
  const chain: number[] = [process.pid];
  let current = process.pid;
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS; hop++) {
    let stdout: string;
    try {
      stdout = exec(resolveTrustedWindowsPowerShellExe(), [
        "-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference='SilentlyContinue'; (Get-CimInstance Win32_Process -Filter "ProcessId=${current}").ParentProcessId`,
      ], POWERSHELL_PROBE_OPTIONS);
    } catch {
      // An unreadable chain must not be read as "not our ancestor".
      return [];
    }
    const trimmed = stdout.trim();
    // Empty output means the pid has no live CIM entry: a CLEAN end of chain, not
    // a read failure. Windows never reparents orphans, so the detached handoff
    // helper always has a dead parent link once its caller exits. Reading that as
    // unreadable would make the helper refuse forever and the feature would never
    // work on Windows.
    if (trimmed === "") return chain;
    const parent = Number(trimmed);
    if (!Number.isSafeInteger(parent) || parent <= 0) return chain;
    if (chain.includes(parent)) return chain;
    chain.push(parent);
    current = parent;
  }
  // Bound reached without finding the top. A truncated chain silently defeats the
  // self-ancestry intersection, so this reports "could not establish" instead.
  return [];
}

export const windowsDesktopAppAdapter: DesktopAppAdapter = {
  discover(exec): DesktopAppInstall | null {
    return discoverPackage(exec);
  },

  listProcesses(exec, install): DesktopProcess[] | null {
    return listPackageProcesses(exec, install);
  },

  isShell(entry): boolean {
    return win32.basename(entry.executable).toLowerCase() === SHELL_BASENAME;
  },

  ancestryPids(exec): number[] {
    return windowsAncestryPids(exec);
  },

  requestQuit(exec, _install, root): void {
    exec(resolveTrustedWindowsPowerShellExe(), [
      "-NoProfile", "-NonInteractive", "-Command",
      `$p = Get-Process -Id ${root.pid} -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow() }`,
    ], POWERSHELL_PROBE_OPTIONS);
  },

  forceStop(exec, root): void {
    exec(resolveTrustedWindowsTaskkillExe(), ["/PID", String(root.pid), "/T", "/F"], POWERSHELL_PROBE_OPTIONS);
  },

  captureRelaunchContext(): Record<string, string> {
    // The session is supplied by the shell:AppsFolder launch, so nothing needs
    // carrying forward.
    return {};
  },

  relaunch(exec, install): void {
    // Throws on failure so the ladder reports relaunch_failed. The old code
    // returned targets_survived here, which was dishonest: everything HAD died
    // and it was the relaunch that failed.
    exec(resolveTrustedWindowsPowerShellExe(), [
      "-NoProfile", "-NonInteractive", "-Command",
      `Start-Process 'shell:AppsFolder\\${install.relaunch}'`,
    ], POWERSHELL_PROBE_OPTIONS);
  },
};

export const windowsDefaultExec: DesktopExec = (file, args, options) => execFileSync(file, [...args], {
  encoding: "utf-8",
  timeout: options?.timeout ?? PROBE_TIMEOUT_MS,
  windowsHide: options?.windowsHide ?? true,
});

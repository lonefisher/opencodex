/**
 * Process-local coordinator for the Codex desktop input unlock.
 *
 * Owns the lifecycle the upstream patch split between a PowerShell controller
 * and a detached Node supervisor: when `codexInputUnlock.enabled` is on, find
 * the debug endpoint of a client OpenCodex launched (or notice that a plain
 * instance is running and needs a restart), attach {@link runSupervisor}, and
 * reflect its phases. When the flag is off — the default — there is no timer,
 * no endpoint probing, and no process enumeration at all.
 *
 * The persisted launch record (`codex-input-unlock.json` in the config dir) is
 * a hint, never proof: a restarted proxy reattaches only when the stored port
 * still answers `/json` with `app://` page targets, or when the stored app pid
 * is still among the running package processes (the endpoint is simply not up
 * yet). The desktop app's own process tree is reached exclusively through the
 * existing `DesktopAppAdapter` contract, so discovery, owner scoping, identity
 * checks and the restart lock stay in `src/codex/desktop-app*`.
 */
import type { OcxConfig } from "../../types";
import type { DesktopAppAdapter, DesktopExec, DesktopProcess } from "../desktop-app/types";
import {
  restartCodexDesktopApp,
  type DesktopAppRestartIo,
  type DesktopAppRestartResult,
} from "../desktop-app-restart";
import { windowsDesktopAppAdapter, windowsDefaultExec } from "../desktop-app/windows";
import {
  type CdpIo,
  type CodexInputUnlockPhase,
  discoverTargets,
  runSupervisor,
} from "./cdp";
import { quotaGateApi, quotaGatePageSource } from "./quota-gate";
import {
  clearCodexInputUnlockState,
  readCodexInputUnlockState,
  writeCodexInputUnlockState,
} from "./state";
import {
  allocateLoopbackPort,
  inputUnlockRealOsGuard,
  inputUnlockRestartAdapter,
  launchCodexDesktopWithDebugPort,
  probeCodexDesktopProcessesAsync,
} from "./windows";

export type CodexInputUnlockState =
  /** `codexInputUnlock.enabled` is unset or false; nothing runs. */
  | "disabled"
  /** The flag is on but this platform has no desktop unlock support (v1: Windows only). */
  | "unsupported"
  /** Enabled; no Codex desktop instance is running. */
  | "waiting"
  /** Enabled; a desktop instance is running WITHOUT the debug port, so the unlock cannot attach. */
  | "restart_required"
  /** The debug endpoint answered; breakpoint installation is in flight. */
  | "attaching"
  /** The conditional breakpoint is armed in at least one renderer. */
  | "mounted"
  /** A desktop build whose bundle the locator cannot uniquely match. */
  | "incompatible"
  /** Startup deadline or an unrecoverable supervisor error. */
  | "failed";

export interface CodexInputUnlockSnapshot {
  enabled: boolean;
  state: CodexInputUnlockState;
  detail?: string;
  port?: number;
  appPid?: number;
  targetUrl?: string;
  updatedAt: string;
}

export interface CodexInputUnlockLaunchResult {
  launched: boolean;
  restarted?: boolean;
  needsRestart?: boolean;
  reason?: string;
  snapshot: CodexInputUnlockSnapshot;
}

export interface CodexInputUnlockIo {
  platform?: NodeJS.Platform;
  /**
   * Exec seam shared with the desktop-app adapters. When unset the real
   * Windows exec is used — and the armed test-home guard refuses instead.
   */
  execFile?: DesktopExec;
  /** Discovery/enumeration adapter; the relaunch step is overridden per launch. */
  adapter?: DesktopAppAdapter;
  statePath?: string;
  cdp?: CdpIo;
  runSupervisorImpl?: typeof runSupervisor;
  restartAppImpl?: (io: DesktopAppRestartIo) => DesktopAppRestartResult;
  launchImpl?: typeof launchCodexDesktopWithDebugPort;
  allocatePortImpl?: () => Promise<number>;
  tickMs?: number;
}

interface CoordinatorRuntime {
  generation: number;
  controller: AbortController | null;
  task: Promise<unknown> | null;
  tickTimer: ReturnType<typeof setInterval> | null;
  io: CodexInputUnlockIo;
  state: CodexInputUnlockState;
  detail?: string;
  port?: number;
  appPid?: number;
  targetUrl?: string;
  updatedAt: string;
}

// The classification tick spawns two PowerShell probes; 15s keeps status fresh
// without keeping a PowerShell child alive around the clock on slow machines.
const DEFAULT_TICK_MS = 15_000;

const runtime: CoordinatorRuntime = {
  generation: 0,
  controller: null,
  task: null,
  tickTimer: null,
  io: {},
  state: "disabled",
  updatedAt: new Date(0).toISOString(),
};

let launchFlight: Promise<CodexInputUnlockLaunchResult> | null = null;
let reconcileFlight: Promise<void> | null = null;

function codexInputUnlockEnabled(config: Pick<OcxConfig, "codexInputUnlock">): boolean {
  return config.codexInputUnlock?.enabled === true;
}

function mark(
  state: CodexInputUnlockState,
  patch: Partial<Pick<CoordinatorRuntime, "detail" | "port" | "appPid" | "targetUrl">> = {},
): void {
  runtime.state = state;
  runtime.detail = patch.detail;
  if ("port" in patch) runtime.port = patch.port;
  if ("appPid" in patch) runtime.appPid = patch.appPid;
  if ("targetUrl" in patch) runtime.targetUrl = patch.targetUrl;
  runtime.updatedAt = new Date().toISOString();
}

function snapshot(config: Pick<OcxConfig, "codexInputUnlock">): CodexInputUnlockSnapshot {
  const out: CodexInputUnlockSnapshot = {
    enabled: codexInputUnlockEnabled(config),
    state: runtime.state,
    updatedAt: runtime.updatedAt,
  };
  if (runtime.detail !== undefined) out.detail = runtime.detail;
  if (runtime.port !== undefined) out.port = runtime.port;
  if (runtime.appPid !== undefined) out.appPid = runtime.appPid;
  if (runtime.targetUrl !== undefined) out.targetUrl = runtime.targetUrl;
  return out;
}

/** Merge per-call seams over the runtime defaults; tests reset via the test seam. */
function resolveIo(io?: CodexInputUnlockIo): CodexInputUnlockIo {
  if (io) runtime.io = { ...runtime.io, ...io };
  return runtime.io;
}

function platform(io: CodexInputUnlockIo): NodeJS.Platform {
  return io.platform ?? process.platform;
}

type Enumeration = { processes: DesktopProcess[] } | { error: "discovery" | "probe" | "test_environment" };

function enumerateApp(io: CodexInputUnlockIo): Enumeration {
  // Same rule the restart ladder enforces internally: under the armed
  // test-home guard a call without an injected exec must never reach the real
  // OS — the caller's fake adapter is not a licence to spawn PowerShell either.
  if (inputUnlockRealOsGuard(io.execFile)) return { error: "test_environment" };
  const adapter = io.adapter ?? windowsDesktopAppAdapter;
  const exec = io.execFile ?? windowsDefaultExec;
  const install = adapter.discover(exec);
  if (!install) return { error: "discovery" };
  const processes = adapter.listProcesses(exec, install);
  if (processes === null) return { error: "probe" };
  return { processes };
}

function mapSupervisorPhase(phase: CodexInputUnlockPhase, detail?: Record<string, unknown>): void {
  // The supervisor reports how many renderers are armed on every phase: a
  // second window's attach or retry must not downgrade a mount that is alive.
  const mountedCount = typeof detail?.mountedCount === "number" ? detail.mountedCount : 0;
  switch (phase) {
    case "waiting":
    case "injecting":
      if (mountedCount > 0) break;
      mark("attaching", { detail: (detail?.lastError as string | undefined) ?? runtime.detail });
      break;
    case "mounted":
      mark("mounted", { targetUrl: detail?.targetUrl as string | undefined, detail: undefined });
      break;
    case "retrying":
      if (mountedCount > 0) break;
      mark("attaching", { detail: detail?.error as string | undefined });
      break;
    case "incompatible":
      if (mountedCount > 0) break;
      mark("incompatible", { detail: "quota gate did not uniquely locate the client bundle" });
      break;
    case "failed":
      mark("failed", { detail: detail?.error as string | undefined });
      break;
  }
}

function startSupervisor(port: number, appPid: number | undefined, io: CodexInputUnlockIo): void {
  const controller = new AbortController();
  const generation = ++runtime.generation;
  runtime.controller?.abort();
  runtime.controller = controller;
  runtime.port = port;
  runtime.appPid = appPid;
  mark("attaching", { port, appPid });
  const supervise = io.runSupervisorImpl ?? runSupervisor;
  runtime.task = supervise({
    port,
    gateSource: quotaGatePageSource(),
    gateApi: quotaGateApi(),
    signal: controller.signal,
    ...(io.cdp ?? {}),
    onPhase: (phase, detail) => {
      if (runtime.generation !== generation) return;
      mapSupervisorPhase(phase, detail);
    },
  }).then(result => result, error => {
    if (runtime.generation === generation) {
      mark("failed", { detail: (error as Error)?.message ?? String(error) });
    }
    return { mountedAtLeastOnce: false, endpointGone: true };
  }).finally(() => {
    if (runtime.generation !== generation) return;
    runtime.task = null;
    runtime.controller = null;
  });
}

async function stopSupervisorTask(): Promise<void> {
  const controller = runtime.controller;
  const task = runtime.task;
  runtime.controller = null;
  runtime.task = null;
  runtime.generation += 1;
  controller?.abort();
  if (task) {
    try {
      await Promise.race([task, new Promise<void>(resolve => setTimeout(resolve, 5000))]);
    } catch { /* teardown is best-effort */ }
  }
}

/** One reconcile in flight at a time: a tick while a probe runs must not pile up PowerShell children. */
function queueReconcile(): Promise<void> {
  if (!reconcileFlight) {
    reconcileFlight = reconcileOnce().finally(() => { reconcileFlight = null; });
  }
  return reconcileFlight;
}

function ensureTick(io: CodexInputUnlockIo): void {
  if (runtime.tickTimer) return;
  const timer = setInterval(() => {
    void queueReconcile().catch(() => { /* the supervisor's own onPhase reports failures */ });
  }, io.tickMs ?? DEFAULT_TICK_MS);
  // The tick is a UI/update convenience, never a reason to keep the process alive.
  timer.unref?.();
  runtime.tickTimer = timer;
}

function stopTick(): void {
  if (runtime.tickTimer) clearInterval(runtime.tickTimer);
  runtime.tickTimer = null;
}

async function enumerateAndMark(io: CodexInputUnlockIo): Promise<{ processes: DesktopProcess[] } | null> {
  // Off the event loop unless a test injected its own seams: the real
  // discover/list pair is a PowerShell spawn whose seconds-long runtime would
  // otherwise freeze every request this proxy is serving on each tick.
  const generation = runtime.generation;
  const enumerated: Enumeration = io.execFile || io.adapter
    ? enumerateApp(io)
    : inputUnlockRealOsGuard(io.execFile)
      ? { error: "test_environment" }
      : await probeCodexDesktopProcessesAsync();
  if (generation !== runtime.generation) return null;
  if ("error" in enumerated) {
    if (enumerated.error === "discovery") {
      mark("failed", { detail: "Codex desktop package could not be discovered" });
      return null;
    }
    if (enumerated.error === "test_environment") {
      mark("waiting", { detail: "process enumeration unavailable in this environment" });
      return null;
    }
    // A probe that could not run is not evidence either way: keep the current
    // phase and let the next tick look again (same fail-closed rule as the
    // restart ladder).
    mark(runtime.state === "disabled" || runtime.state === "unsupported" ? "waiting" : runtime.state, {
      detail: "process enumeration probe failed",
    });
    return null;
  }
  return { processes: enumerated.processes };
}

async function reconcileOnce(): Promise<void> {
  const io = runtime.io;
  if (runtime.task) return; // the live supervisor reports its own phase

  // A launch record exists: the port belongs to a client we started. Reattach
  // only when the endpoint really answers with app pages — a recycled port
  // owned by another process, or a dead endpoint with a dead pid, drops the
  // record instead of trusting it.
  const record = readCodexInputUnlockState({ statePath: io.statePath });
  if (record) {
    let endpointLive = false;
    try {
      endpointLive = (await discoverTargets(record.debugPort, io.cdp ?? {})).length > 0;
    } catch {
      endpointLive = false;
    }
    if (endpointLive) {
      startSupervisor(record.debugPort, record.appPid, io);
      return;
    }
    const enumerated = await enumerateAndMark(io);
    if (!enumerated) return;
    if (enumerated.processes.some(entry => entry.pid === record.appPid)) {
      // Our instance is alive; the debug endpoint is just not bound yet.
      startSupervisor(record.debugPort, record.appPid, io);
      return;
    }
    clearCodexInputUnlockState({ statePath: io.statePath });
    mark(enumerated.processes.length > 0 ? "restart_required" : "waiting", { detail: undefined });
    return;
  }

  const enumerated = await enumerateAndMark(io);
  if (!enumerated) return;
  mark(enumerated.processes.length > 0 ? "restart_required" : "waiting", { detail: undefined });
}

/**
 * Bring the runtime in line with `config`: start supervising when enabled and a
 * managed endpoint exists, report waiting / restart-required otherwise, and
 * tear everything down when disabled. Called by the management route after a
 * config write and by the dormant startup hook; idempotent.
 */
export async function syncCodexInputUnlock(
  config: OcxConfig,
  io?: CodexInputUnlockIo,
): Promise<CodexInputUnlockSnapshot> {
  const resolved = resolveIo(io);
  if (!codexInputUnlockEnabled(config)) {
    await stopSupervisorTask();
    stopTick();
    clearCodexInputUnlockState({ statePath: resolved.statePath });
    mark("disabled", { detail: undefined, port: undefined, appPid: undefined, targetUrl: undefined });
    return snapshot(config);
  }
  if (platform(resolved) !== "win32") {
    await stopSupervisorTask();
    stopTick();
    mark("unsupported", { detail: "input unlock currently supports Windows only" });
    return snapshot(config);
  }
  ensureTick(resolved);
  await queueReconcile();
  return snapshot(config);
}

/**
 * Launch (or, with `restart`, relaunch) the desktop client carrying the
 * loopback debug port, then attach the supervisor. A running ordinary instance
 * is never silently replaced: it reports `needsRestart` until the caller asks
 * for a restart, which goes through the shared fail-closed restart ladder.
 */
export function launchCodexInputUnlock(
  config: OcxConfig,
  options: { restart?: boolean } = {},
  io?: CodexInputUnlockIo,
): Promise<CodexInputUnlockLaunchResult> {
  if (!launchFlight) {
    launchFlight = launchInner(config, options, resolveIo(io))
      .finally(() => { launchFlight = null; });
  }
  return launchFlight;
}

async function launchInner(
  config: OcxConfig,
  options: { restart?: boolean },
  io: CodexInputUnlockIo,
): Promise<CodexInputUnlockLaunchResult> {
  const denied = (reason: string): CodexInputUnlockLaunchResult =>
    ({ launched: false, reason, snapshot: snapshot(config) });

  // Guard the launch path itself — the restart ladder has its own copy of this
  // rule, keyed on `io.execFile`, so passing a resolved default would defeat it.
  if (inputUnlockRealOsGuard(io.execFile)) return denied("test_environment");
  const adapter = io.adapter ?? windowsDesktopAppAdapter;
  const exec = io.execFile ?? windowsDefaultExec;
  const install = adapter.discover(exec);
  if (!install) return denied("package_discovery_failed");
  const processes = adapter.listProcesses(exec, install);
  if (processes === null) return denied("process_probe_failed");

  if (processes.length > 0 && options.restart !== true) {
    mark("restart_required", { detail: "a running Codex desktop instance needs an explicit restart" });
    return { launched: false, needsRestart: true, snapshot: snapshot(config) };
  }

  let debugPort: number;
  let appPid: number | null;
  let restarted = false;
  if (processes.length > 0) {
    debugPort = await (io.allocatePortImpl ?? allocateLoopbackPort)();
    // The wrapper keeps the injected/production adapter's discovery, listing and
    // stop steps; only "start the app again" is swapped for COM activation with
    // the debug arguments.
    const wrapper = inputUnlockRestartAdapter(debugPort, adapter);
    const restart = (io.restartAppImpl ?? restartCodexDesktopApp)({
      platform: platform(io),
      // Verbatim, not the resolved default: the ladder's own armed-guard reads
      // `io.execFile === undefined`, and this module must not launder the seam.
      execFile: io.execFile,
      adapter: wrapper.adapter,
      allowHandoff: false,
    });
    if (restart.relaunch !== "started") {
      mark("failed", { detail: `restart did not complete: ${restart.reason ?? "unknown"}` });
      return denied(restart.reason ?? "restart_failed");
    }
    restarted = true;
    appPid = wrapper.launchedPid();
  } else {
    const launch = io.launchImpl ?? launchCodexDesktopWithDebugPort;
    const outcome = await launch(io.execFile, install);
    debugPort = outcome.debugPort;
    appPid = outcome.appPid;
  }

  writeCodexInputUnlockState(
    {
      version: 1,
      debugPort,
      appPid: appPid ?? -1,
      aumid: install.relaunch,
      launchedAt: new Date().toISOString(),
    },
    { statePath: io.statePath },
  );
  ensureTick(io);
  startSupervisor(debugPort, appPid ?? undefined, io);
  return { launched: true, restarted, snapshot: snapshot(config) };
}

/** Read-only view for GET — never starts timers, probes, or supervisors. */
export function codexInputUnlockSnapshot(config: Pick<OcxConfig, "codexInputUnlock">): CodexInputUnlockSnapshot {
  return snapshot(config);
}

/**
 * Server-start hook from `startProcessLoops`: reconcile only when the flag is
 * on, so a default install runs nothing here at all — no timer, no probe.
 */
export function codexInputUnlockStartupReconcile(config: OcxConfig): void {
  if (!codexInputUnlockEnabled(config)) return;
  void syncCodexInputUnlock(config).catch(() => { /* surfaced through status */ });
}

/** Test seam: stop the supervisor, the tick, and clear in-memory state. */
export async function resetCodexInputUnlockForTests(): Promise<void> {
  await stopSupervisorTask();
  stopTick();
  runtime.io = {};
  runtime.state = "disabled";
  runtime.detail = undefined;
  runtime.port = undefined;
  runtime.appPid = undefined;
  runtime.targetUrl = undefined;
  runtime.updatedAt = new Date(0).toISOString();
  reconcileFlight = null;
  launchFlight = null;
}

/**
 * CDP supervision for the Codex desktop input unlock.
 *
 * Ported from codex-input-unlock's `cdp-supervisor.mjs` and adapted so the loop
 * lives inside the proxy process instead of a detached Node child: state moves
 * through the `onPhase` callback, cancellation through `signal`, and every
 * transport is injectable so tests run a fake endpoint instead of a real
 * desktop app.
 *
 * Behaviour kept from the original: loopback-only endpoint validation, ranked
 * `app://` page-target discovery, `Debugger.scriptParsed` gating on candidate
 * bundle URLs, `getPossibleBreakpoints` before `setBreakpoint`, a bootstrap
 * script re-evaluated into every new document, reload detection via
 * `Runtime.executionContextsCleared`, and breakpoint + script cleanup when a
 * session is torn down. Multi-window support goes through one session per
 * `page` target, rediscovered on a poll while any session stays attached.
 */
import type { QuotaGateLocation } from "./quota-gate";

export type CodexInputUnlockPhase =
  /** No page target answered the debug endpoint yet (or endpoint is down). */
  | "waiting"
  /** A page target was found; breakpoint installation is in flight. */
  | "injecting"
  /** At least one renderer carries the armed conditional breakpoint. */
  | "mounted"
  /** A transient failure; the loop retries inside its startup budget. */
  | "retrying"
  /** Candidate bundles parsed but the locator matched none of them. */
  | "incompatible"
  /** The startup deadline expired before the first mount. */
  | "failed";

export interface CodexTargetDescriptor {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "error" | "message" | "close",
    listener: (event: { data?: unknown }) => void,
    options?: { once?: boolean },
  ): void;
}

type WebSocketCtor = new (url: string) => WebSocketLike;

export interface CdpIo {
  fetchImpl?: typeof fetch;
  /** Injectable for tests; production uses the platform WebSocket. */
  webSocketImpl?: WebSocketCtor;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Bound on waiting for a candidate bundle inside one session; tests shrink it. */
  quotaScriptWaitMs?: number;
}

export function validateCdpPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`invalid CDP port: ${value}`);
  }
  return value;
}

/** The debug endpoint may only ever reach loopback; anything else is refused. */
export function validateWebSocketUrl(value: string, expectedPort: number): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`unexpected websocket scheme: ${parsed.protocol}`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error(`CDP websocket is not loopback-only: ${parsed.hostname}`);
  }
  if (Number(parsed.port) !== expectedPort) {
    throw new Error(`CDP websocket port mismatch: ${parsed.port}`);
  }
  return parsed.toString();
}

async function fetchJson(url: string, io: CdpIo, timeoutMs = 3000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (io.fetchImpl ?? fetch)(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function targetRank(target: { type?: string; url?: string }): number {
  if (target?.type !== "page") return -1;
  const url = String(target.url || "");
  if (url === "app://-/index.html") return 100;
  if (url.startsWith("app://")) return 80;
  return -1;
}

/**
 * Every attachable page target on the endpoint, best first.
 *
 * Upstream picked only the highest-ranked target; the OpenCodex port supervises
 * all of them so a second app window is covered without a rediscovery cycle.
 */
export async function discoverTargets(port: number, io: CdpIo = {}): Promise<CodexTargetDescriptor[]> {
  let targets: unknown;
  try {
    targets = await fetchJson(`http://127.0.0.1:${port}/json`, io);
  } catch (firstError) {
    try {
      targets = await fetchJson(`http://[::1]:${port}/json`, io);
    } catch {
      throw firstError;
    }
  }
  if (!Array.isArray(targets)) throw new Error("CDP target list is not an array");
  return targets
    .map(target => ({ target, rank: targetRank(target as { type?: string; url?: string }) }))
    .filter(entry => entry.rank >= 0 && (entry.target as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl)
    .sort((left, right) => right.rank - left.rank)
    .map(entry => ({
      ...(entry.target as CodexTargetDescriptor),
      webSocketDebuggerUrl: validateWebSocketUrl(
        (entry.target as CodexTargetDescriptor).webSocketDebuggerUrl,
        port,
      ),
    }));
}

interface PendingCommand {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type EventHandler = (params: Record<string, unknown>) => void;

export class CdpSession {
  private socket: WebSocketLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly eventHandlers = new Map<string, Set<EventHandler>>();

  constructor(private readonly url: string, private readonly io: CdpIo = {}) {}

  async connect(timeoutMs = 5000): Promise<void> {
    const Ctor = this.io.webSocketImpl ?? (WebSocket as unknown as WebSocketCtor);
    const socket = new Ctor(this.url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (finish: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finish();
      };
      const timer = setTimeout(() => {
        try { socket.close(); } catch { /* best effort */ }
        done(() => reject(new Error("CDP websocket open timed out")));
      }, timeoutMs);
      socket.addEventListener("open", () => done(resolve), { once: true });
      socket.addEventListener("error", () => {
        try { socket.close(); } catch { /* best effort */ }
        done(() => reject(new Error("CDP websocket failed to open")));
      }, { once: true });
    });
    socket.addEventListener("message", event => void this.onMessage(event.data));
    socket.addEventListener("close", () => this.rejectPending(new Error("CDP websocket closed")));
  }

  private async onMessage(data: unknown): Promise<void> {
    let text: string | undefined;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString("utf8");
    else if (ArrayBuffer.isView(data)) {
      text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
    } else if (typeof (data as { text?: () => Promise<string> })?.text === "function") {
      text = await (data as { text: () => Promise<string> }).text();
    } else return;

    let message: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: { message?: string };
    };
    try { message = JSON.parse(text); } catch { return; }
    if (!message.id) {
      if (message.method) {
        for (const handler of this.eventHandlers.get(message.method) || []) {
          try { handler(message.params || {}); } catch { /* listener faults must not break the session */ }
        }
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else pending.resolve(message.result || {});
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 7000): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      return Promise.reject(new Error("CDP websocket is not open"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, handler: EventHandler): () => void {
    if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, new Set());
    this.eventHandlers.get(method)!.add(handler);
    return () => this.eventHandlers.get(method)?.delete(handler);
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error("renderer evaluation failed");
    return (result.result as { value?: unknown } | undefined)?.value;
  }

  close(): void {
    try { this.socket?.close(); } catch { /* best effort */ }
  }
}

const GATE_READY_EXPRESSION =
  "Boolean(globalThis.__codexExternalQuotaGate && (globalThis.__codexInputUnlockState?.breakpoint || globalThis.__codexExternalPatchState?.breakpoint))";

function buildBootstrap(location: QuotaGateLocation & { condition: string }, bundleUrl: string): string {
  const serializedLocation = JSON.stringify({ ...location, condition: location.condition });
  const serializedBundleUrl = JSON.stringify(bundleUrl);
  return `(() => {
    globalThis.__codexInputUnlockState = {
      status: "located",
      bundleUrl: ${serializedBundleUrl},
      breakpoint: ${serializedLocation},
    };
    globalThis.__codexExternalPatchState = globalThis.__codexInputUnlockState;
  })();`;
}

async function installScripts(session: CdpSession, combinedSource: string): Promise<string | null> {
  await session.send("Runtime.enable");
  await session.send("Page.enable");
  let installed: Record<string, unknown>;
  try {
    installed = await session.send("Page.addScriptToEvaluateOnNewDocument", { source: combinedSource, runImmediately: true });
  } catch {
    installed = await session.send("Page.addScriptToEvaluateOnNewDocument", { source: combinedSource });
  }
  await session.evaluate(combinedSource);
  const verified = await session.evaluate(GATE_READY_EXPRESSION);
  if (verified !== true) throw new Error("renderer runtime injection did not verify");
  return (installed.identifier as string | undefined) ?? null;
}

export function isCandidateScriptUrl(value: unknown): boolean {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === "app:" && parsed.pathname.endsWith(".js");
  } catch {
    return false;
  }
}

export interface LocatedQuotaScript {
  scriptId: string;
  url: string;
  location: QuotaGateLocation;
  condition: string;
}

type GateApi = {
  locate(source: string, sourceUrl: string): QuotaGateLocation | null;
  condition(location: QuotaGateLocation | null): string | null;
};

export interface QuotaScriptWait {
  script: LocatedQuotaScript | null;
  /**
   * True when at least one candidate bundle was fetched and failed the
   * locator. Distinguishes "a new bundle shipped that this locator cannot
   * read" (incompatible) from "the renderer has not parsed its bundle yet"
   * (retry), so the caller can report an honest phase instead of timing out
   * identically in both cases.
   */
  sawCandidate: boolean;
}

async function waitForQuotaScript(session: CdpSession, gateApi: GateApi, timeoutMs = 20000): Promise<QuotaScriptWait> {
  // Holder object rather than a bare `let`: the unsubscribe is assigned inside a
  // nested closure, which TS does not narrow against.
  const handlerRef: { remove?: () => void } = {};
  let settled = false;
  let sawCandidate = false;
  try {
    const scriptPromise = new Promise<LocatedQuotaScript | null>(resolve => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, timeoutMs);
      handlerRef.remove = session.on("Debugger.scriptParsed", params => {
        const scriptId = params.scriptId as string | undefined;
        if (settled || !scriptId || !isCandidateScriptUrl(params.url)) return;
        void (async () => {
          try {
            const sourceResult = await session.send("Debugger.getScriptSource", { scriptId }, 15000);
            const source = sourceResult.scriptSource;
            if (typeof source !== "string" || source.length === 0) return;
            sawCandidate = true;
            const location = gateApi.locate(source, String(params.url));
            const condition = gateApi.condition(location);
            if (!location || !condition || settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ scriptId, url: String(params.url), location, condition });
          } catch { /* a script that cannot be read is not the match */ }
        })();
      });
    });
    await session.send("Debugger.enable", {}, timeoutMs);
    const script = await scriptPromise;
    return { script, sawCandidate };
  } finally {
    handlerRef.remove?.();
  }
}

interface BreakpointLocation {
  scriptId: string;
  lineNumber: number;
  columnNumber: number;
}

async function resolveBreakpointLocation(
  session: CdpSession,
  scriptId: string,
  desired: QuotaGateLocation,
): Promise<BreakpointLocation> {
  if (Number.isInteger(desired.endLineNumber) && Number.isInteger(desired.endColumnNumber)) {
    const start: BreakpointLocation = {
      scriptId,
      lineNumber: desired.lineNumber,
      columnNumber: desired.columnNumber,
    };
    const end: BreakpointLocation = {
      scriptId,
      lineNumber: desired.endLineNumber!,
      columnNumber: desired.endColumnNumber!,
    };
    const result = await session.send("Debugger.getPossibleBreakpoints", { start, end, restrictToFunction: true });
    const candidates = ((result.locations || []) as BreakpointLocation[])
      .filter(item => {
        if (item.scriptId !== scriptId) return false;
        if (item.lineNumber < start.lineNumber || item.lineNumber > end.lineNumber) return false;
        if (item.lineNumber === start.lineNumber && item.columnNumber < start.columnNumber) return false;
        if (item.lineNumber === end.lineNumber && item.columnNumber > end.columnNumber) return false;
        return true;
      })
      .sort((left, right) => left.lineNumber - right.lineNumber || left.columnNumber - right.columnNumber);
    if (candidates.length > 0) return candidates[0]!;
    throw new Error(
      `no executable breakpoint inside quota expression ${start.lineNumber}:${start.columnNumber}-${end.lineNumber}:${end.columnNumber}`,
    );
  }
  for (const radius of [300, 2000]) {
    const start: BreakpointLocation = {
      scriptId,
      lineNumber: desired.lineNumber,
      columnNumber: Math.max(0, desired.columnNumber - 100),
    };
    const end: BreakpointLocation = {
      scriptId,
      lineNumber: desired.lineNumber,
      columnNumber: desired.columnNumber + radius,
    };
    const result = await session.send("Debugger.getPossibleBreakpoints", { start, end, restrictToFunction: true });
    const candidates = ((result.locations || []) as BreakpointLocation[])
      .filter(item => item.scriptId === scriptId && item.lineNumber === desired.lineNumber && item.columnNumber >= desired.columnNumber)
      .sort((left, right) => left.columnNumber - right.columnNumber);
    if (candidates.length > 0) return candidates[0]!;
  }
  throw new Error(`no executable breakpoint location at or after ${desired.lineNumber}:${desired.columnNumber}`);
}

export interface MountedTarget {
  targetId: string;
  targetUrl: string;
  bundleUrl: string;
  breakpointId: string;
  actualLocation: BreakpointLocation;
}

export interface TargetSessionOutcome {
  mounted: boolean;
  /** The renderer signalled a document reload or dropped the gate state. */
  reloaded: boolean;
  /** Candidate bundles were parsed but none located — a new app build. */
  sawCandidate: boolean;
}

/**
 * Attach to one page target, arm the breakpoint, then hold the session until
 * the renderer reloads, the breakpoint stops verifying, or the socket drops.
 */
export async function superviseTarget(
  target: CodexTargetDescriptor,
  gateSource: string,
  gateApi: GateApi,
  io: CdpIo,
  signal: AbortSignal,
  onMounted: (mounted: MountedTarget) => void,
): Promise<TargetSessionOutcome> {
  const session = new CdpSession(target.webSocketDebuggerUrl, io);
  let breakpointId: string | null = null;
  let documentScriptId: string | null = null;
  let removeReloadHandler: (() => void) | null = null;
  let sawCandidate = false;
  const sleep = io.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const abortListener = () => session.close();
  signal.addEventListener("abort", abortListener, { once: true });
  try {
    await session.connect();
    const found = await waitForQuotaScript(session, gateApi, io.quotaScriptWaitMs ?? 20000);
    sawCandidate = found.sawCandidate;
    if (signal.aborted || !found.script) return { mounted: false, reloaded: false, sawCandidate };
    const breakpoint = { ...found.script.location, condition: found.script.condition };
    const bootstrap = buildBootstrap(breakpoint, found.script.url);
    documentScriptId = await installScripts(session, `${gateSource}\n${bootstrap}`);
    const actualLocation = await resolveBreakpointLocation(session, found.script.scriptId, breakpoint);
    const armed = await session.send("Debugger.setBreakpoint", {
      location: actualLocation,
      condition: breakpoint.condition,
    });
    breakpointId = (armed.breakpointId as string | undefined) ?? null;
    if (!breakpointId || !armed.actualLocation) {
      throw new Error("Debugger.setBreakpoint did not resolve an actual location");
    }
    onMounted({
      targetId: target.id,
      targetUrl: target.url,
      bundleUrl: found.script.url,
      breakpointId,
      actualLocation: armed.actualLocation as BreakpointLocation,
    });

    let reloadDetected = false;
    removeReloadHandler = session.on("Runtime.executionContextsCleared", () => { reloadDetected = true; });
    for (;;) {
      await sleep(2000);
      if (signal.aborted) return { mounted: true, reloaded: reloadDetected, sawCandidate };
      if (reloadDetected) return { mounted: true, reloaded: true, sawCandidate };
      const alive = await session.evaluate(GATE_READY_EXPRESSION);
      if (alive !== true) return { mounted: true, reloaded: true, sawCandidate };
    }
  } finally {
    signal.removeEventListener("abort", abortListener);
    removeReloadHandler?.();
    if (breakpointId) {
      try { await session.send("Debugger.removeBreakpoint", { breakpointId }, 2000); } catch { /* closing anyway */ }
    }
    if (documentScriptId) {
      try {
        await session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: documentScriptId }, 2000);
      } catch { /* closing anyway */ }
    }
    session.close();
  }
}

export interface SupervisorOptions extends CdpIo {
  port: number;
  gateSource: string;
  gateApi: GateApi;
  signal: AbortSignal;
  /** Milliseconds the loop will keep trying before the first mount. */
  startupTimeoutMs?: number;
  onPhase: (phase: CodexInputUnlockPhase, detail?: Record<string, unknown>) => void;
}

export interface SupervisorResult {
  mountedAtLeastOnce: boolean;
  /** Endpoint stayed silent after a mounted session dropped (app likely quit). */
  endpointGone: boolean;
}

const STARTUP_TIMEOUT_MS = 60_000;
const DISCOVERY_RETRY_MS = 500;
const TARGET_POLL_MS = 3_000;
const ENDPOINT_GONE_GRACE_MS = 20_000;
/**
 * A target that finished a full script wait without locating the gate (auxiliary
 * windows like the avatar overlay host a different entry bundle) backs off
 * instead of immediately re-handshaking and re-fetching every bundle source.
 */
const TARGET_FAIL_COOLDOWN_MS = 60_000;

/**
 * The supervisor loop: discover page targets, supervise each, re-discover on
 * reload or new windows, until cancelled or the endpoint goes quiet after a
 * successful mount. Runs no polling of its own once stopped — the caller owns
 * the outer lifecycle.
 */
export async function runSupervisor(options: SupervisorOptions): Promise<SupervisorResult> {
  const { port, gateSource, gateApi, signal, onPhase } = options;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  const deadline = now() + startupTimeoutMs;
  let everReady = false;
  let missingSince: number | null = null;
  let lastError: string | null = null;
  const active = new Map<string, Promise<TargetSessionOutcome>>();
  const mounted = new Map<string, MountedTarget>();
  const retryAfter = new Map<string, number>();
  /** Every phase report carries how many renderers are armed, so listeners can keep "mounted" while a second window is still attaching. */
  const phaseDetail = (extra?: Record<string, unknown>): Record<string, unknown> => ({
    port,
    mountedCount: mounted.size,
    ...extra,
  });

  const abortPromise = new Promise<"aborted">(resolve => {
    if (signal.aborted) resolve("aborted");
    else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });

  onPhase("waiting", phaseDetail());
  try {
    for (;;) {
      if (signal.aborted) break;
      let targets: CodexTargetDescriptor[];
      try {
        targets = await discoverTargets(port, options);
        missingSince = null;
      } catch (error) {
        if (active.size > 0) {
          // Sessions still decide their own fate; a transient /json failure is not their end.
          await Promise.race([sleep(DISCOVERY_RETRY_MS), abortPromise]);
          continue;
        }
        missingSince ??= now();
        if (!everReady && now() >= deadline) {
          onPhase("failed", phaseDetail({ error: `Codex CDP startup timed out: ${(error as Error).message}` }));
          return { mountedAtLeastOnce: false, endpointGone: true };
        }
        if (everReady && now() - missingSince > ENDPOINT_GONE_GRACE_MS) {
          return { mountedAtLeastOnce: true, endpointGone: true };
        }
        onPhase(everReady ? "retrying" : "waiting", phaseDetail());
        await Promise.race([sleep(DISCOVERY_RETRY_MS), abortPromise]);
        continue;
      }

      if (targets.length === 0) {
        onPhase(everReady ? "retrying" : "waiting", phaseDetail());
        await Promise.race([sleep(DISCOVERY_RETRY_MS), abortPromise]);
        continue;
      }

      for (const target of targets) {
        if (active.has(target.id)) continue;
        if (now() < (retryAfter.get(target.id) ?? 0)) continue;
        onPhase("injecting", phaseDetail({ targetId: target.id, targetUrl: target.url, lastError }));
        const task = superviseTarget(
          target, gateSource, gateApi, options, signal,
          mount => {
            mounted.set(target.id, mount);
            everReady = true;
            onPhase("mounted", phaseDetail(mount));
          },
        ).then(outcome => {
          if (outcome.mounted) retryAfter.delete(target.id);
          else retryAfter.set(target.id, now() + TARGET_FAIL_COOLDOWN_MS);
          if (!outcome.mounted && outcome.sawCandidate && mounted.size === 0) {
            onPhase("incompatible", phaseDetail({ targetId: target.id, targetUrl: target.url }));
          }
          return outcome;
        }, error => {
          retryAfter.set(target.id, now() + TARGET_FAIL_COOLDOWN_MS);
          lastError = (error as Error)?.stack || String(error);
          onPhase("retrying", phaseDetail({ error: lastError, targetId: target.id }));
          return { mounted: mounted.has(target.id), reloaded: false, sawCandidate: false };
        }).finally(() => {
          active.delete(target.id);
          const wasMounted = mounted.delete(target.id);
          // Losing the last armed renderer is a state change the poll loop
          // would otherwise never report while other sessions keep running.
          if (wasMounted && mounted.size === 0 && !signal.aborted) {
            onPhase("waiting", phaseDetail({ targetId: target.id }));
          }
        });
        active.set(target.id, task);
      }

      // Keep discovering while sessions live so new windows attach, then wait out
      // the poll interval or the first session ending, whichever comes first.
      await Promise.race([
        sleep(TARGET_POLL_MS),
        abortPromise,
        ...[...active.values()].map(task => task.then(() => "session-ended")),
      ]);
    }
    return { mountedAtLeastOnce: everReady, endpointGone: false };
  } finally {
    for (const task of active.values()) {
      try { await task; } catch { /* teardown path */ }
    }
  }
}

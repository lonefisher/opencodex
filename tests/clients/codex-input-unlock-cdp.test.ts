import { describe, expect, test } from "bun:test";
import {
  discoverTargets,
  isCandidateScriptUrl,
  runSupervisor,
  superviseTarget,
  validateCdpPort,
  validateWebSocketUrl,
  type CodexTargetDescriptor,
} from "../../src/codex/input-unlock/cdp";
import { quotaGateApi, quotaGatePageSource, type QuotaGateLocation } from "../../src/codex/input-unlock/quota-gate";

/**
 * CDP lifecycle coverage with a fake endpoint: the WebSocket double answers
 * real protocol frames so the whole mount/reload/cleanup sequence is exercised
 * without a desktop app.
 */

const GATE_READY = "Boolean(globalThis.__codexExternalQuotaGate && (globalThis.__codexInputUnlockState?.breakpoint || globalThis.__codexExternalPatchState?.breakpoint))";

/** A modern dual-quota bundle the real locator accepts. */
const BUNDLE = [
  "var qq=ff(gg,({get:tt})=>{const u=tt.authMethod!==`chatgpt`;return u?tt.rate_limit?.allowed!==!1:!0});",
  "var vv=ww(qq)&&hh;",
  "var out={submitDisabled:vv,rateLimitSendBlocked:cc||vv,rateLimitConversationSendBlocked:cc};",
].join("\n");
const BUNDLE_URL = "app://-/assets/index-abc123.js";

type Listener = (event: { data?: unknown }) => void;

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  readonly url: string;
  readonly sent: Array<{ id?: number; method?: string; params?: Record<string, unknown> }> = [];
  private listeners = new Map<string, Listener[]>();
  /** Set false to make the next GATE_READY evaluate fail (simulates a dead gate). */
  gateAlive = true;
  /** Set true to emit scriptParsed carrying BUNDLE once Debugger.enable lands. */
  serveBundle = true;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
    queueMicrotask(() => this.emit("open"));
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, event: { data?: unknown } = {}): void {
    if (type === "open") this.readyState = 1;
    if (type === "close") this.readyState = 3;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** Deliver a CDP event frame (e.g. Debugger.scriptParsed) to the session. */
  emitEvent(method: string, params: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify({ method, params }) });
  }

  private respond(id: number, result: Record<string, unknown>): void {
    queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id, result }) }));
  }

  send(data: string): void {
    const message = JSON.parse(data) as { id: number; method: string; params?: Record<string, unknown> };
    this.sent.push(message);
    const { id, method } = message;
    switch (method) {
      case "Debugger.enable":
        this.respond(id, {});
        if (this.serveBundle) {
          queueMicrotask(() => queueMicrotask(() =>
            this.emitEvent("Debugger.scriptParsed", { scriptId: "s1", url: BUNDLE_URL })));
        }
        break;
      case "Debugger.getScriptSource":
        this.respond(id, { scriptSource: BUNDLE });
        break;
      case "Page.addScriptToEvaluateOnNewDocument":
        this.respond(id, { identifier: "doc-1" });
        break;
      case "Runtime.evaluate": {
        const expression = String(message.params?.expression ?? "");
        this.respond(id, { result: { value: expression === GATE_READY ? this.gateAlive : undefined } });
        break;
      }
      case "Debugger.getPossibleBreakpoints": {
        const start = message.params?.start as { scriptId: string; lineNumber: number; columnNumber: number };
        const end = message.params?.end as { lineNumber: number; columnNumber: number } | undefined;
        this.respond(id, {
          locations: [{
            scriptId: start.scriptId,
            lineNumber: start.lineNumber,
            // A breakpoint at the end of the queried range always satisfies the
            // "at or after desired" filter for the single-line modes.
            columnNumber: end ? end.columnNumber : start.columnNumber,
          }],
        });
        break;
      }
      case "Debugger.setBreakpoint":
        this.respond(id, {
          breakpointId: "b1",
          actualLocation: message.params?.location,
        });
        break;
      default:
        this.respond(id, {});
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

function fakeIo(extra: Record<string, unknown> = {}) {
  FakeSocket.instances = [];
  return {
    webSocketImpl: FakeSocket,
    sleep: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
    quotaScriptWaitMs: 300,
    ...extra,
  };
}

function target(id: string, url = "app://-/index.html"): CodexTargetDescriptor {
  return { id, type: "page", url, webSocketDebuggerUrl: `ws://127.0.0.1:9333/devtools/page/${id}` };
}

const gate = { gateSource: quotaGatePageSource(), gateApi: quotaGateApi() };

describe("endpoint validation", () => {
  test("only loopback websockets on the requested port are accepted", () => {
    expect(validateWebSocketUrl("ws://127.0.0.1:9222/x", 9222)).toContain("127.0.0.1");
    expect(validateWebSocketUrl("ws://[::1]:9222/x", 9222)).toContain("::1");
    expect(() => validateWebSocketUrl("ws://192.168.1.5:9222/x", 9222)).toThrow();
    expect(() => validateWebSocketUrl("ws://evil.example@127.0.0.1:9222/x", 9222)).not.toThrow();
    expect(() => validateWebSocketUrl("ws://127.0.0.1:9999/x", 9222)).toThrow();
    expect(() => validateWebSocketUrl("http://127.0.0.1:9222/x", 9222)).toThrow();
  });

  test("ports must be valid tcp ports", () => {
    expect(validateCdpPort(1)).toBe(1);
    expect(validateCdpPort(65535)).toBe(65535);
    expect(() => validateCdpPort(0)).toThrow();
    expect(() => validateCdpPort(65536)).toThrow();
    expect(() => validateCdpPort(9.5)).toThrow();
  });

  test("only app:// .js script urls are candidates", () => {
    expect(isCandidateScriptUrl("app://-/assets/x.js")).toBe(true);
    expect(isCandidateScriptUrl("app://-/index.html")).toBe(false);
    expect(isCandidateScriptUrl("https://example.com/x.js")).toBe(false);
    expect(isCandidateScriptUrl("not a url")).toBe(false);
  });
});

describe("discoverTargets", () => {
  function fetchWith(targets: unknown, failV4 = false) {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1") && failV4) throw new Error("v4 down");
      if (!url.endsWith("/json")) return new Response("no", { status: 404 });
      return new Response(JSON.stringify(targets), { status: 200 });
    }) as typeof fetch;
  }

  test("ranks app://-/index.html first and drops non-page targets", async () => {
    const targets = await discoverTargets(9222, {
      fetchImpl: fetchWith([
        { id: "bg", type: "service_worker", url: "app://-/sw.js", webSocketDebuggerUrl: "ws://127.0.0.1:9222/sw" },
        { id: "other", type: "page", url: "app://-/other.html", webSocketDebuggerUrl: "ws://127.0.0.1:9222/other" },
        { id: "main", type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9222/main" },
      ]),
    });
    expect(targets.map(t => t.id)).toEqual(["main", "other"]);
  });

  test("falls back to the IPv6 loopback endpoint", async () => {
    const targets = await discoverTargets(9222, {
      fetchImpl: fetchWith([{ id: "main", type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://[::1]:9222/main" }], true),
    });
    expect(targets).toHaveLength(1);
  });

  test("rejects targets whose websocket is not loopback", async () => {
    await expect(discoverTargets(9222, {
      fetchImpl: fetchWith([{ id: "main", type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://10.0.0.9:9222/main" }]),
    })).rejects.toThrow();
  });
});

describe("superviseTarget", () => {
  test("mounts the conditional breakpoint, then reports a reload and cleans up", async () => {
    const io = fakeIo();
    const mounted: Array<{ breakpointId: string; targetUrl: string }> = [];
    const outcome = await superviseTarget(target("t1"), gate.gateSource, gate.gateApi, io, new AbortController().signal, m => {
      mounted.push(m);
      // After the mount the next keepalive probe finds the gate state gone —
      // what a renderer reload looks like — so the session reports reloaded.
      FakeSocket.instances[0]!.gateAlive = false;
    });

    expect(outcome).toEqual({ mounted: true, reloaded: true, sawCandidate: true });
    expect(mounted).toHaveLength(1);
    expect(mounted[0]!.breakpointId).toBe("b1");

    const socket = FakeSocket.instances[0]!;
    const methods = socket.sent.map(f => f.method);
    expect(methods).toContain("Page.addScriptToEvaluateOnNewDocument");
    expect(methods).toContain("Debugger.setBreakpoint");
    // Teardown removes the breakpoint and the document script before closing.
    expect(methods).toContain("Debugger.removeBreakpoint");
    expect(methods).toContain("Page.removeScriptToEvaluateOnNewDocument");
    expect(socket.closed).toBe(true);
    // The condition sent to the renderer is the located dual-quota clear.
    const setBreakpoint = socket.sent.find(f => f.method === "Debugger.setBreakpoint")!;
    expect(setBreakpoint.params?.condition).toBe("(cc=false,vv=false,false)");
  });

  test("reports incompatible when the bundle parses but does not locate", async () => {
    const io = fakeIo();
    class NoGateSocket extends FakeSocket {
      override send(data: string): void {
        const message = JSON.parse(data) as { method?: string };
        if (message.method === "Debugger.getScriptSource") {
          const id = (JSON.parse(data) as { id: number }).id;
          queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id, result: { scriptSource: "var x=1;" } }) }));
          return;
        }
        super.send(data);
      }
    }
    io.webSocketImpl = NoGateSocket;
    const outcome = await superviseTarget(target("t1"), gate.gateSource, gate.gateApi, io, new AbortController().signal, () => {});
    expect(outcome).toEqual({ mounted: false, reloaded: false, sawCandidate: true });
  });

  test("aborting tears the session down", async () => {
    const io = fakeIo();
    const controller = new AbortController();
    const task = superviseTarget(target("t1"), gate.gateSource, gate.gateApi, io, controller.signal, () => {
      queueMicrotask(() => controller.abort());
    });
    const outcome = await task;
    expect(outcome.mounted).toBe(true);
    expect(FakeSocket.instances[0]!.closed).toBe(true);
  });
});

describe("runSupervisor", () => {
  function supervisorIo(targets: CodexTargetDescriptor[]) {
    return fakeIo({
      fetchImpl: (async (input: RequestInfo | URL) => {
        if (!String(input).endsWith("/json")) return new Response("no", { status: 404 });
        return new Response(JSON.stringify(targets), { status: 200 });
      }) as typeof fetch,
      quotaScriptWaitMs: 300,
    });
  }

  test("waiting -> injecting -> mounted, then abort stops everything", async () => {
    const io = supervisorIo([target("t1")]);
    const phases: string[] = [];
    const controller = new AbortController();
    const task = runSupervisor({
      port: 9333, ...gate, signal: controller.signal, ...io,
      onPhase: phase => {
        phases.push(phase);
        if (phase === "mounted") controller.abort();
      },
    });
    const result = await task;
    expect(result.mountedAtLeastOnce).toBe(true);
    expect(phases[0]).toBe("waiting");
    expect(phases).toContain("injecting");
    expect(phases).toContain("mounted");
  });

  test("two page targets each get a session", async () => {
    const io = supervisorIo([target("t1"), target("t2", "app://-/settings.html")]);
    let mounts = 0;
    const controller = new AbortController();
    const result = await runSupervisor({
      port: 9333, ...gate, signal: controller.signal, ...io,
      onPhase: phase => {
        if (phase === "mounted") {
          mounts += 1;
          if (mounts === 2) controller.abort();
        }
      },
    });
    expect(result.mountedAtLeastOnce).toBe(true);
    expect(mounts).toBe(2);
  });

  test("a silent endpoint past the startup deadline reports failed", async () => {
    let tick = 0;
    const io = fakeIo({
      fetchImpl: (async () => { throw new Error("connection refused"); }) as typeof fetch,
      now: () => (tick += 30_000),
    });
    const phases: string[] = [];
    const result = await runSupervisor({
      port: 9333, ...gate, signal: new AbortController().signal, ...io,
      startupTimeoutMs: 60_000,
      onPhase: phase => phases.push(phase),
    });
    expect(result).toEqual({ mountedAtLeastOnce: false, endpointGone: true });
    expect(phases.at(-1)).toBe("failed");
  });

  test("an endpoint that never yields a locatable bundle reports incompatible", async () => {
    class NoGateSocket extends FakeSocket {
      override send(data: string): void {
        const message = JSON.parse(data) as { id: number; method?: string };
        if (message.method === "Debugger.getScriptSource") {
          queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: message.id, result: { scriptSource: "var x=1;" } }) }));
          return;
        }
        super.send(data);
      }
    }
    const io = supervisorIo([target("t1")]);
    io.webSocketImpl = NoGateSocket;
    const phases: string[] = [];
    const controller = new AbortController();
    const task = runSupervisor({
      port: 9333, ...gate, signal: controller.signal, ...io,
      quotaScriptWaitMs: 60,
      onPhase: phase => {
        phases.push(phase);
        if (phase === "incompatible") controller.abort();
      },
    });
    await task;
    expect(phases).toContain("incompatible");
  });
});

// Re-export check: the supervisor and the locator agree on what "located" means.
test("the fixture bundle is a real locate target", () => {
  const location: QuotaGateLocation | null = quotaGateApi().locate(BUNDLE, BUNDLE_URL);
  expect(location).not.toBeNull();
  expect(location!.mode).toBe("third-party-composer-dual");
});

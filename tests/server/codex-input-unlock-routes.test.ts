import { describe, expect, test } from "bun:test";
import { handleCodexInputUnlockRoutes } from "../../src/server/management/codex-input-unlock-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { CodexInputUnlockRuntime } from "../../src/server/management/codex-input-unlock-routes";
import type { CodexInputUnlockSnapshot } from "../../src/codex/input-unlock/coordinator";
import type { OcxConfig } from "../../src/types";

/**
 * /api/codex/input-unlock route coverage. The coordinator is replaced by an
 * injected runtime seam so the route's contract — body validation, the config
 * write ordering, and the 409/500 shape — is what's under test.
 */

function snap(over: Partial<CodexInputUnlockSnapshot> = {}): CodexInputUnlockSnapshot {
  return { enabled: false, state: "disabled", updatedAt: "2026-09-30T00:00:00Z", ...over };
}

interface Harness {
  config: OcxConfig;
  saves: OcxConfig[];
  synced: number;
  launches: Array<{ restart?: boolean }>;
  ctx: (path: string, method?: string, body?: unknown) => ManagementContext;
}

function harness(extra: Record<string, unknown> = {}, runtime: Partial<CodexInputUnlockRuntime> = {}): Harness {
  const state: Harness = {
    config: { port: 10100, providers: {}, ...extra } as unknown as OcxConfig,
    saves: [],
    synced: 0,
    launches: [],
    ctx: (path, method = "GET", body) => {
      const url = new URL(`http://127.0.0.1:10100${path}`);
      const req = new Request(url, body === undefined
        ? { method }
        : { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
      const rt: CodexInputUnlockRuntime = {
        status: config => snap({ enabled: config.codexInputUnlock?.enabled === true }),
        sync: async config => {
          state.synced += 1;
          return snap({ enabled: config.codexInputUnlock?.enabled === true, state: "waiting" });
        },
        launch: async (_config, options) => {
          state.launches.push(options);
          return { launched: true, snapshot: snap({ enabled: true, state: "attaching" }) };
        },
        ...runtime,
      };
      return {
        req, url, config: state.config, version: "test",
        deps: {
          codexInputUnlock: rt,
          saveConfigPreservingClaudeCode: (config: OcxConfig) => { state.saves.push(structuredClone(config)); },
        },
      } as unknown as ManagementContext;
    },
  };
  return state;
}

describe("/api/codex/input-unlock", () => {
  test("GET returns the runtime snapshot without touching it", async () => {
    const h = harness({}, { status: () => snap({ enabled: true, state: "mounted", port: 5150 }) });
    const res = await handleCodexInputUnlockRoutes(h.ctx("/api/codex/input-unlock"));
    expect(res!.status).toBe(200);
    const body = await res!.json() as { ok: boolean; inputUnlock: CodexInputUnlockSnapshot };
    expect(body.ok).toBe(true);
    expect(body.inputUnlock).toMatchObject({ enabled: true, state: "mounted", port: 5150 });
    expect(h.synced).toBe(0);
  });

  test("PUT enable persists the config, then reconciles", async () => {
    const h = harness();
    const res = await handleCodexInputUnlockRoutes(h.ctx("/api/codex/input-unlock", "PUT", { enabled: true }));
    expect(res!.status).toBe(200);
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0]!.codexInputUnlock).toEqual({ enabled: true });
    expect(h.synced).toBe(1);
    const body = await res!.json() as { inputUnlock: CodexInputUnlockSnapshot };
    expect(body.inputUnlock.enabled).toBe(true);
  });

  test("PUT disable removes the key entirely rather than writing false", async () => {
    const h = harness({ codexInputUnlock: { enabled: true } });
    const res = await handleCodexInputUnlockRoutes(h.ctx("/api/codex/input-unlock", "PUT", { enabled: false }));
    expect(res!.status).toBe(200);
    expect(h.saves[0]!.codexInputUnlock).toBeUndefined();
  });

  test("PUT rejects a non-boolean and unknown fields", async () => {
    const h = harness();
    expect((await handleCodexInputUnlockRoutes(h.ctx("/api/codex/input-unlock", "PUT", { enabled: "yes" })))!.status).toBe(400);
    expect((await handleCodexInputUnlockRoutes(h.ctx("/api/codex/input-unlock", "PUT", { enabled: true, x: 1 })))!.status).toBe(400);
    expect((await handleCodexInputUnlockRoutes(h.ctx("/api/codex/input-unlock", "PUT", "junk")))!.status).toBe(400);
    expect(h.saves).toHaveLength(0);
  });

  test("a failed save rolls the live key back", async () => {
    const h = harness();
    const ctx = h.ctx("/api/codex/input-unlock", "PUT", { enabled: true });
    ctx.deps.saveConfigPreservingClaudeCode = () => { throw new Error("disk full"); };
    await expect(handleCodexInputUnlockRoutes(ctx)).rejects.toThrow("disk full");
    expect(h.config.codexInputUnlock).toBeUndefined();
  });

  test("POST launch refuses when the feature is off", async () => {
    const h = harness();
    const res = await handleCodexInputUnlockRoutes(h.ctx("/api/codex/input-unlock/launch", "POST", {}));
    expect(res!.status).toBe(409);
    expect((await res!.json() as { code: string }).code).toBe("input_unlock_disabled");
    expect(h.launches).toHaveLength(0);
  });

  test("POST launch forwards restart and returns the snapshot", async () => {
    const h = harness({ codexInputUnlock: { enabled: true } });
    const res = await handleCodexInputUnlockRoutes(h.ctx("/api/codex/input-unlock/launch", "POST", { restart: true }));
    expect(res!.status).toBe(200);
    expect(h.launches).toEqual([{ restart: true }]);
    expect((await res!.json() as { launched: boolean }).launched).toBe(true);
  });

  test("a needsRestart refusal is a 409, not a 500", async () => {
    const h = harness({ codexInputUnlock: { enabled: true } }, {
      launch: async () => ({ launched: false, needsRestart: true, snapshot: snap({ enabled: true, state: "restart_required" }) }),
    });
    const res = await handleCodexInputUnlockRoutes(h.ctx("/api/codex/input-unlock/launch", "POST", {}));
    expect(res!.status).toBe(409);
    expect((await res!.json() as { code: string }).code).toBe("restart_required");
  });

  test("other launch failures come back as 500 with the reason as code", async () => {
    const h = harness({ codexInputUnlock: { enabled: true } }, {
      launch: async () => ({ launched: false, reason: "package_discovery_failed", snapshot: snap({ enabled: true, state: "failed" }) }),
    });
    const res = await handleCodexInputUnlockRoutes(h.ctx("/api/codex/input-unlock/launch", "POST", {}));
    expect(res!.status).toBe(500);
    expect((await res!.json() as { code: string }).code).toBe("package_discovery_failed");
  });

  test("unknown paths fall through to the next handler", async () => {
    const h = harness();
    expect(await handleCodexInputUnlockRoutes(h.ctx("/api/codex/other"))).toBeNull();
    expect(await handleCodexInputUnlockRoutes(h.ctx("/api/codex/input-unlock", "DELETE"))).toBeNull();
  });
});

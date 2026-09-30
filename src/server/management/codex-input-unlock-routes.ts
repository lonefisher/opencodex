/**
 * Codex desktop input-unlock routes.
 *
 * Thin adapter over `src/codex/input-unlock/coordinator.ts`: the runtime seam
 * (`deps.codexInputUnlock`) lets route tests drive every phase without ever
 * touching a real client, PowerShell, or CDP endpoint — the same reason the
 * codexRestartService seam exists. The module itself is lazy-mounted from
 * `management-api.ts`, and the coordinator is reached through a dynamic import
 * (the `import type` below carries no runtime edge).
 *
 * `PUT` is a config write: it follows the settings precedent (mutate the live
 * config, persist through `saveConfigPreservingClaudeCode`, roll the in-memory
 * key back on failure) and only then reconciles the runtime.
 */
import { saveConfigPreservingClaudeCode } from "../../config";
import { deleteConfigTopLevelKey } from "../../config/rebase-provenance";
import type { OcxConfig } from "../../types";
import type {
  CodexInputUnlockLaunchResult,
  CodexInputUnlockSnapshot,
} from "../../codex/input-unlock/coordinator";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import { isPlainRecord } from "./shared";
import type { ManagementContext } from "./context";

export type CodexInputUnlockRuntime = {
  status: (config: OcxConfig) => CodexInputUnlockSnapshot;
  sync: (config: OcxConfig) => Promise<CodexInputUnlockSnapshot>;
  launch: (config: OcxConfig, options: { restart?: boolean }) => Promise<CodexInputUnlockLaunchResult>;
};

function runtimeFor(ctx: ManagementContext): Promise<CodexInputUnlockRuntime> {
  if (ctx.deps.codexInputUnlock) return Promise.resolve(ctx.deps.codexInputUnlock);
  return import("../../codex/input-unlock/coordinator").then(coordinator => ({
    status: (config: OcxConfig) => coordinator.codexInputUnlockSnapshot(config),
    sync: (config: OcxConfig) => coordinator.syncCodexInputUnlock(config),
    launch: (config: OcxConfig, options: { restart?: boolean }) =>
      coordinator.launchCodexInputUnlock(config, options),
  }));
}

function parseEnabledBody(raw: unknown): { enabled: boolean } | string {
  if (!isPlainRecord(raw)) return "JSON body must be an object";
  for (const key of Object.keys(raw)) if (key !== "enabled") return `unknown field: ${key}`;
  if (typeof raw.enabled !== "boolean") return "enabled must be a boolean";
  return { enabled: raw.enabled };
}

function parseLaunchBody(raw: unknown): { restart: boolean } | string {
  if (raw === null || raw === undefined) return { restart: false };
  if (!isPlainRecord(raw)) return "JSON body must be an object";
  for (const key of Object.keys(raw)) if (key !== "restart") return `unknown field: ${key}`;
  if (raw.restart !== undefined && typeof raw.restart !== "boolean") return "restart must be a boolean";
  return { restart: raw.restart === true };
}

export async function handleCodexInputUnlockRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;

  if (url.pathname === "/api/codex/input-unlock" && req.method === "GET") {
    const runtime = await runtimeFor(ctx);
    return jsonResponse({ ok: true, inputUnlock: runtime.status(config) });
  }

  if (url.pathname === "/api/codex/input-unlock" && req.method === "PUT") {
    let raw: unknown;
    try {
      raw = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    const body = parseEnabledBody(raw);
    if (typeof body === "string") return jsonResponse({ error: body }, 400);

    const hadKey = Object.hasOwn(config, "codexInputUnlock");
    const previous = config.codexInputUnlock;
    try {
      if (body.enabled) config.codexInputUnlock = { enabled: true };
      else deleteConfigTopLevelKey(config, "codexInputUnlock");
      (ctx.deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode)(config);
    } catch (error) {
      if (hadKey && previous !== undefined) config.codexInputUnlock = previous;
      else deleteConfigTopLevelKey(config, "codexInputUnlock");
      throw error;
    }
    const runtime = await runtimeFor(ctx);
    const inputUnlock = await runtime.sync(config);
    return jsonResponse({ ok: true, inputUnlock });
  }

  if (url.pathname === "/api/codex/input-unlock/launch" && req.method === "POST") {
    let raw: unknown;
    try {
      raw = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    const body = parseLaunchBody(raw);
    if (typeof body === "string") return jsonResponse({ error: body }, 400);
    if (config.codexInputUnlock?.enabled !== true) {
      return jsonResponse({
        ok: false,
        code: "input_unlock_disabled",
        error: "Codex input unlock is not enabled. Enable it first (PUT /api/codex/input-unlock).",
      }, 409);
    }
    const runtime = await runtimeFor(ctx);
    const result = await runtime.launch(config, { restart: body.restart });
    if (result.launched) {
      return jsonResponse({ ok: true, launched: true, restarted: result.restarted === true, inputUnlock: result.snapshot });
    }
    if (result.needsRestart) {
      return jsonResponse({
        ok: false,
        code: "restart_required",
        error: "A running Codex desktop instance was not started with the debug port. Restart it to attach the unlock.",
        inputUnlock: result.snapshot,
      }, 409);
    }
    return jsonResponse({
      ok: false,
      code: result.reason ?? "launch_failed",
      error: `Codex desktop launch failed (${result.reason ?? "unknown"}).`,
      inputUnlock: result.snapshot,
    }, 500);
  }

  return null;
}

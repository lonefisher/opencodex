/**
 * `ocx codex-input-unlock` — operator surface for the Windows-only Codex
 * desktop input unlock. Every verb goes through the management API
 * (`runtimeRequest`), so a running proxy is required and the same validation,
 * config write, and runtime reconciliation serve CLI and GUI alike.
 */
import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  type RuntimeApiDeps,
} from "./runtime-api";

const USAGE = `Usage:
  ocx codex-input-unlock status [--json]
  ocx codex-input-unlock enable [--json]
  ocx codex-input-unlock disable [--json]
  ocx codex-input-unlock launch [--restart] [--json]

Manages the opt-in Codex desktop input unlock (Windows only): when enabled,
OpenCodex launches the official client with a loopback CDP port and clears the
composer's local quota gate for third-party providers. \`launch\` without
--restart refuses while an ordinary (non-debug) instance is running; --restart
explicitly quits and relaunches it, which may discard unsaved composer drafts.`;

interface InputUnlockSnapshot {
  enabled?: boolean;
  state?: string;
  detail?: string;
  port?: number;
  appPid?: number;
  targetUrl?: string;
  updatedAt?: string;
}

interface InputUnlockEnvelope {
  ok?: boolean;
  inputUnlock?: InputUnlockSnapshot;
  launched?: boolean;
  restarted?: boolean;
  code?: string;
  error?: string;
}

function stateLines(snapshot: InputUnlockSnapshot | undefined): string[] {
  if (!snapshot) return ["Codex input unlock: unknown"];
  const lines = [`Codex input unlock: ${snapshot.enabled === true ? "enabled" : "disabled"}, state ${snapshot.state ?? "unknown"}`];
  if (snapshot.detail) lines.push(`  detail: ${snapshot.detail}`);
  if (snapshot.port !== undefined) lines.push(`  debug port: ${snapshot.port}`);
  if (snapshot.appPid !== undefined) lines.push(`  app pid: ${snapshot.appPid}`);
  return lines;
}

export async function handleCodexInputUnlockCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  const [sub = "status", ...rest] = argv;
  return runCliAction(async () => {
    const args = [...rest];
    const wantsJson = takeFlag(args, "--json");
    if (sub === "status") {
      rejectArgs(args, USAGE);
      const result = await runtimeRequest<InputUnlockEnvelope>("/api/codex/input-unlock", {}, deps);
      printData(result, wantsJson, stateLines(result.inputUnlock));
      return;
    }
    if (sub === "enable" || sub === "disable") {
      rejectArgs(args, USAGE);
      const result = await runtimeRequest<InputUnlockEnvelope>("/api/codex/input-unlock", {
        method: "PUT",
        body: JSON.stringify({ enabled: sub === "enable" }),
      }, deps);
      printData(result, wantsJson, stateLines(result.inputUnlock));
      return;
    }
    if (sub === "launch") {
      const restart = takeFlag(args, "--restart");
      rejectArgs(args, USAGE);
      const result = await runtimeRequest<InputUnlockEnvelope>("/api/codex/input-unlock/launch", {
        method: "POST",
        body: JSON.stringify({ restart }),
      }, deps);
      printData(result, wantsJson, [
        result.restarted ? "Codex desktop relaunched with the debug port." : "Codex desktop launched with the debug port.",
        ...stateLines(result.inputUnlock).slice(1),
      ]);
      return;
    }
    throw new CliUsageError(`unknown codex-input-unlock command ${sub}`, USAGE);
  });
}

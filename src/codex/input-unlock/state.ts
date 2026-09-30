/**
 * Persisted launch state for the Codex desktop input unlock.
 *
 * The record is what lets a restarted proxy reattach to a client it launched:
 * the debug port survives the proxy (it is bound by the desktop app for the
 * app's whole lifetime), so the coordinator only needs `{debugPort, appPid}` —
 * plus enough to explain itself in status output. Everything is a hint; the
 * live endpoint probe is authoritative and a stale record is discarded rather
 * than trusted.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../../config/atomic-write";
import { getConfigDir } from "../../config/paths";

export interface CodexInputUnlockStateRecord {
  version: 1;
  debugPort: number;
  appPid: number;
  aumid: string;
  launchedAt: string;
}

export interface CodexInputUnlockStateIo {
  statePath?: string;
}

export function codexInputUnlockStatePath(io: CodexInputUnlockStateIo = {}): string {
  return io.statePath ?? join(getConfigDir(), "codex-input-unlock.json");
}

export function readCodexInputUnlockState(io: CodexInputUnlockStateIo = {}): CodexInputUnlockStateRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(codexInputUnlockStatePath(io), "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Partial<CodexInputUnlockStateRecord>;
    if (record.version !== 1) return null;
    if (!Number.isInteger(record.debugPort) || (record.debugPort as number) < 1 || (record.debugPort as number) > 65535) {
      return null;
    }
    // `-1` means the restart ladder's relaunch did not report a pid; the port
    // probe remains the authority, so the record stays usable.
    if (!Number.isInteger(record.appPid) || (record.appPid as number) < -1 || record.appPid === 0) return null;
    if (typeof record.aumid !== "string" || !record.aumid) return null;
    if (typeof record.launchedAt !== "string" || !record.launchedAt) return null;
    return record as CodexInputUnlockStateRecord;
  } catch {
    return null;
  }
}

export function writeCodexInputUnlockState(
  record: CodexInputUnlockStateRecord,
  io: CodexInputUnlockStateIo = {},
): void {
  atomicWriteFile(codexInputUnlockStatePath(io), `${JSON.stringify(record, null, 2)}\n`);
}

export function clearCodexInputUnlockState(io: CodexInputUnlockStateIo = {}): void {
  try {
    rmSync(codexInputUnlockStatePath(io), { force: true });
  } catch {
    /* absent is already cleared */
  }
}

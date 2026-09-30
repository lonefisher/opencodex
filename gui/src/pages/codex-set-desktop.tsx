import { useCallback, useEffect, useState } from "react";
import { useT } from "../i18n/shared";
import { createBoundedFetch } from "../bounded-fetch";
import { startVisibilityPoll } from "../visibility-poll";
import { DataSurfaceSkeleton, DataSurfaceStatus } from "../components/data-surface";
import type { TKey } from "../i18n/en";

/**
 * The Desktop panel of Codex Set: the Windows input-unlock feature.
 *
 * The status it renders is LIVE supervisor state, not just the config flag —
 * "enabled" and "mounted" are different truths and the panel keeps them apart.
 * A 5s visibility-aware poll is the point here: the supervisor can move between
 * waiting/mounted/failed without any click on this page, unlike the Prompt panel
 * where the file only changes when the user changes it.
 */

export type InputUnlockState =
  | "unsupported"
  | "disabled"
  | "waiting"
  | "restart_required"
  | "attaching"
  | "mounted"
  | "incompatible"
  | "failed";

/** Mirrors `CodexInputUnlockSnapshot` in src/codex/input-unlock/coordinator.ts. */
export interface InputUnlockStatusDto {
  enabled: boolean;
  state: InputUnlockState;
  detail?: string;
  port?: number;
  appPid?: number;
  targetUrl?: string;
  updatedAt: string;
}

interface InputUnlockEnvelope {
  ok: boolean;
  code?: string;
  error?: string;
  inputUnlock?: InputUnlockStatusDto;
}

const STATE_KEYS: Record<InputUnlockState, TKey> = {
  unsupported: "codexSet.desktop.state.unsupported",
  disabled: "codexSet.desktop.state.disabled",
  waiting: "codexSet.desktop.state.waiting",
  restart_required: "codexSet.desktop.state.restartRequired",
  attaching: "codexSet.desktop.state.attaching",
  mounted: "codexSet.desktop.state.mounted",
  incompatible: "codexSet.desktop.state.incompatible",
  failed: "codexSet.desktop.state.failed",
};

const POLL_MS = 5000;

export default function CodexSetDesktop({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [status, setStatus] = useState<InputUnlockStatusDto | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const bounded = createBoundedFetch(8000);
    try {
      const res = await fetch(apiBase + "/api/codex/input-unlock", { signal: bounded.signal });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json() as InputUnlockEnvelope;
      if (!body.inputUnlock) throw new Error("no status");
      setStatus(body.inputUnlock);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      bounded.clear();
    }
  }, [apiBase]);

  // The poll's immediate tick is also the initial load: firing the first fetch
  // directly in the effect body is the set-state-in-effect pattern lint rejects.
  useEffect(() => {
    return startVisibilityPoll(() => { void refresh(); }, POLL_MS, { immediate: true });
  }, [refresh]);

  /**
   * One request path for all three writes: every verb returns the refreshed
   * snapshot in `inputUnlock`, and a failure re-reads instead of guessing.
   */
  const act = async (method: "PUT" | "POST", path: string, body: Record<string, unknown>) => {
    setBusy(true);
    setActionError("");
    try {
      const res = await fetch(apiBase + path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const parsed = await res.json() as InputUnlockEnvelope;
      if (parsed.inputUnlock) setStatus(parsed.inputUnlock);
      else void refresh();
      if (!res.ok || !parsed.ok) {
        // restart_required is an expected refusal, not an error banner.
        setActionError(parsed.code === "restart_required" ? "" : (parsed.error ?? t("codexSet.desktop.actionFailed")));
      }
    } catch {
      setActionError(t("codexSet.desktop.actionFailed"));
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const enabled = status?.enabled ?? false;
  const state = status?.state ?? "disabled";
  // A launch only makes sense when the unlock is on, the platform supports it,
  // and no client is already claiming the supervisor's attention.
  const canLaunch = enabled && (state === "waiting" || state === "failed");
  const canRestart = enabled && (state === "restart_required" || state === "mounted");

  return (
    <div className="panel codex-set-desktop">
      <div className="row">
        <strong>{t("codexSet.desktop.title")}</strong>
      </div>
      <p className="card-sub">{t("codexSet.desktop.subtitle")}</p>

      {status === null && !loadFailed && (
        <DataSurfaceSkeleton label={t("common.loading")} rows={2} />
      )}
      {loadFailed && (
        <div className="notice notice-err" role="alert">{t("codexSet.desktop.loadFailed")}</div>
      )}
      {actionError && (
        <div className="notice notice-err" role="alert">{actionError}</div>
      )}

      {status !== null && (
        <>
          <div className="row codex-set-desktop__row">
            <span>{t("codexSet.desktop.enable")}</span>
            <button
              type="button"
              role="switch"
              className={`toggle ${enabled ? "on" : ""}`}
              aria-checked={enabled}
              aria-label={t("codexSet.desktop.enable")}
              disabled={busy}
              onClick={() => { void act("PUT", "/api/codex/input-unlock", { enabled: !enabled }); }}
            >
              <span className="toggle-knob" />
            </button>
          </div>

          <div className="row codex-set-desktop__row">
            <span className="muted">{t("codexSet.desktop.status")}</span>
            <DataSurfaceStatus live busy={false}>
              <strong data-input-unlock-state={state}>{t(STATE_KEYS[state])}</strong>
            </DataSurfaceStatus>
          </div>

          {state === "unsupported" && (
            <p className="muted small">{t("codexSet.desktop.unsupportedHint")}</p>
          )}
          {state === "restart_required" && (
            <p className="muted small">{t("codexSet.desktop.restartHint")}</p>
          )}
          {state === "incompatible" && (
            <p className="muted small">{t("codexSet.desktop.incompatibleHint")}</p>
          )}
          {status.detail && <p className="muted small">{status.detail}</p>}
          {(status.port !== undefined || status.appPid !== undefined) && (
            <p className="muted small">
              {status.port !== undefined && <code>port {status.port}</code>}{" "}
              {status.appPid !== undefined && <code>pid {status.appPid}</code>}
            </p>
          )}

          {(canLaunch || canRestart) && (
            <div className="row codex-set-desktop__actions">
              {canLaunch && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy}
                  onClick={() => { void act("POST", "/api/codex/input-unlock/launch", {}); }}
                >
                  {t("codexSet.desktop.launch")}
                </button>
              )}
              {canRestart && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => { void act("POST", "/api/codex/input-unlock/launch", { restart: true }); }}
                >
                  {t("codexSet.desktop.restart")}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

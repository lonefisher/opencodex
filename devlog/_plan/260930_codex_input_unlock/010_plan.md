# Codex input unlock: execution plan

Status: in progress. Change `codex-input-unlock` (Comet Native: docs/comet/changes/codex-input-unlock).
Baseline: `upstream/dev` fdf4177d. Branch `codex-input-unlock` in worktree `opencodex-input-unlock/`.
Source patch: https://github.com/1zero224/codex-input-unlock (quota-gate.cjs + cdp-supervisor.mjs + codex-input-unlock.ps1).

## Architecture mapping

| Upstream piece | OpenCodex home |
|---|---|
| quota-gate.cjs | `src/codex/input-unlock/quota-gate.ts` (TS; page source generated via `Function.prototype.toString`) |
| cdp-supervisor.mjs | `src/codex/input-unlock/cdp.ts` (CDP session, breakpoint install, reload/multi-window/reconnect) |
| supervisor loop + status | `src/codex/input-unlock/coordinator.ts` (in-proxy state machine; dormant unless enabled) |
| ps1 COM activation | `src/codex/input-unlock/windows.ts` (IApplicationActivationManager via powershell -EncodedCommand) |
| restart/lock/identity | reuse `desktop-app-restart.ts` ladder with a relaunch-overriding adapter |
| persisted launch state | `codex-input-unlock.json` in getConfigDir() via atomic write |
| config | `codexInputUnlock.enabled` (absent = off) |
| routes | `src/server/management/codex-input-unlock-routes.ts`, lazy-mounted in management-api |
| CLI | `ocx codex-input-unlock status|enable|disable|launch` via `runtime-api.ts` |
| GUI | `CodexSet.tsx` third tab "Desktop" + `codex-set-desktop.tsx` + all locales |
| activation seam | `background-lifecycle.ts` `startProcessLoops` (dormant tick pattern like catalog-auto-refresh) |

## Acceptance (from brief)

- Locator: current structure, renamed vars, duplicate candidates, unknown version → incompatible; unrelated send-disabled preserved.
- Lifecycle: refresh, multi-window, timeout, re-enable, proxy restart, disable cleanup.
- Windows: simulated exec only; never touch real client in tests.
- Engineering: typecheck, focused tests, test:changed, structure:check, registries, GUI lint/i18n/build.
- Real-device zero-quota: separately marked if unreproducible.

## Progress log

- wp0: worktree + Comet change + this plan. done.
- wp1–wp6: all modules landed — quota-gate, cdp, state, windows, coordinator, routes,
  CLI, GUI tab/panel, locales, docs guide, regenerated skill surface. done.
- Verification: `tsc --noEmit` clean; structure:check / skill:surface:check /
  privacy:scan pass; docs-site build 553 pages pass; GUI lint+i18n+build pass;
  39 new focused tests + 12 GUI shell + layout/registry/capability suites pass.
- Known limits: `bun run test:changed` exceeded the 900s ceiling (1355/1876 files);
  the 3 catalog-route timeouts it surfaced reproduce identically on a clean
  fdf4177d baseline (environmental).
- Real-machine round (2026-09-30, Windows + Codex Desktop running, official quota
  exhausted): three fixes landed from live behavior —
  1. sync `execFileSync` enumeration on the tick froze the whole proxy event loop
     (~20s per cycle) → coordinator tick now uses an async PowerShell probe
     (`probeCodexDesktopProcessesAsync`) sharing the adapter's script text via
     exported builders in `desktop-app/windows.ts`; injected test seams keep the
     sync path, and the tick carries a reconcile-flight guard;
  2. the shared 10s probe timeout died inside per-process `GetOwner` CIM calls
     on a slow machine → `PROBE_TIMEOUT_MS` raised to 30s (helps the existing
     restart ladder too);
  3. any window's `injecting` phase downgraded a live mount to "attaching", and
     bundle-less auxiliary windows re-handshook every ~20s → supervisor phases
     now carry `mountedCount`, last-mount loss notifies, and unmounted targets
     get a 60s retry cooldown.
  Verified live: enable → restart_required (ordinary instance detected) →
  `launch --restart` (CloseMainWindow → COM relaunch with debug port) → mounted;
  proxy kill+start reattached via the persisted record without touching the app;
  management API stayed responsive throughout (event loop free). Interactive
  composer typing/submission still to be confirmed by the operator.

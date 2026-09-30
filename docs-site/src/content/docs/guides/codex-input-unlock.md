---
title: Codex Desktop Input Unlock
description: Let the official Codex desktop composer keep accepting and submitting turns through a third-party provider when the signed-in account has no quota (Windows).
---

The official Codex desktop app disables its composer when the signed-in OpenAI account's
local quota gate reports no allowance — even when the thread is routed to a third-party
provider with available capacity. The input unlock keeps the composer editable in exactly
that situation by clearing **only the quota variable** inside the running renderer. It does
not restore quota, bypass a provider rejection, or change which provider serves the turn.

This feature is opt-in, Windows-only, and off by default. It modifies no files in the
official installation: the patch lives entirely in the app's runtime memory and is gone the
moment the app exits.

:::note
Server-side rate limits still apply — an unlocked composer does not make a rejected request
succeed. Sign-in, provider configuration, and the quota display are unchanged. For a
queue-based alternative that does not touch the composer at all, see
[Composer Usage-Gate Fallback](/guides/composer-usage-gate-fallback).
:::

## How it works

When enabled, OpenCodex manages the Codex desktop client's launch:

1. The client is activated through Windows COM with a random **loopback-only**
   `--remote-debugging-port` (bound to `127.0.0.1`).
2. OpenCodex connects over the Chrome DevTools Protocol, finds the minified bundle
   dynamically, and installs a **conditional breakpoint** whose expression clears only the
   quota variables before yielding `false`.
3. Refreshing the page, opening a second window, or restarting the proxy reattaches
   automatically; turning the feature off removes the breakpoint and stops the supervisor.

The locator is fail-closed: it requires exactly one quota anchor and one matching composer
shape. A Codex build it cannot identify is reported as *incompatible* and left untouched —
other send-disabled conditions (empty input, pending approvals, and so on) always keep
working.

## Enable

Settings → **Codex** → **Desktop** → **Enable input unlock**, or:

```bash
ocx codex-input-unlock enable
```

Then start the managed client:

```bash
ocx codex-input-unlock launch
```

If Codex is already running without the debug port, the status shows **Restart required**.
Close it yourself, or pass `--restart` (equivalent to the Restart button) — a restart may
discard unsaved composer drafts:

```bash
ocx codex-input-unlock launch --restart
```

`ocx codex-input-unlock status` shows the current state; `--json` emits the raw snapshot.

## Status states

| State | Meaning |
|---|---|
| Off | The feature is disabled; nothing is running or polling. |
| Waiting for the Codex app | Enabled, but no client is up. Use Launch. |
| Restart required | A client started *without* the debug port is running. |
| Attaching | The debug endpoint answered; breakpoint installation is in flight. |
| Active | The quota gate is armed in at least one renderer. |
| Incompatible app build | The bundle could not be identified; nothing was patched. |
| Failed | Startup timed out or the supervisor hit an unrecoverable error. |

## Compatibility baseline

- Windows only, official Codex desktop app (MSIX install).
- The minified bundle is located dynamically rather than by filename, but the locator only
  understands the composer shapes it was built against. An update that restructures the
  quota flow reports *Incompatible* instead of guessing.
- The debug port is a fresh random port per launch, loopback-only.

## Disable and recovery

```bash
ocx codex-input-unlock disable
```

Disabling removes the breakpoint and stops the supervisor immediately. The client's debug
port closes with the app process — quit and relaunch Codex normally (no OpenCodex launch)
to drop it. Nothing persists in the client itself.

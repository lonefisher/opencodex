import type { KeyboardEvent } from "react";

/**
 * Tab state for the Codex Set page, shaped exactly like Logs/Debug: exclusive
 * tabpanels whose choice lives in the hash, not in component state alone. That
 * is what makes the tab survive a refresh, a bookmark, and back/forward — and
 * it is the pattern devlog 004 §A3 identifies as the one the ask actually names.
 */
export type CodexSetTab = "multiauth" | "prompt" | "desktop";

const TAB_ORDER: readonly CodexSetTab[] = ["multiauth", "prompt", "desktop"];

export function readCodexSetTabFromHash(): CodexSetTab {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash === "codex-set/prompt") return "prompt";
  if (hash === "codex-set/desktop") return "desktop";
  return "multiauth";
}

export function selectCodexSetTab(next: CodexSetTab): void {
  window.location.hash = next === "multiauth" ? "codex-set" : `codex-set/${next}`;
}

function focusTab(next: CodexSetTab): void {
  selectCodexSetTab(next);
  document.getElementById(`codex-set-tab-${next}`)?.focus();
}

export function codexSetTabKeyDown(e: KeyboardEvent): void {
  const current = readCodexSetTabFromHash();
  const index = TAB_ORDER.indexOf(current);
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    focusTab(TAB_ORDER[Math.max(0, index - 1)]!);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    focusTab(TAB_ORDER[Math.min(TAB_ORDER.length - 1, index + 1)]!);
  } else if (e.key === "Home") {
    e.preventDefault();
    focusTab(TAB_ORDER[0]!);
  } else if (e.key === "End") {
    e.preventDefault();
    focusTab(TAB_ORDER[TAB_ORDER.length - 1]!);
  }
}

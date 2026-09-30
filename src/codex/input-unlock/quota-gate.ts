/**
 * Runtime quota-gate locator for the Codex desktop composer.
 *
 * Ported from codex-input-unlock's `quota-gate.cjs`
 * (https://github.com/1zero224/codex-input-unlock). The desktop bundle is
 * minified, so quota variables are located dynamically: a single auth atom
 * names the atom variable, then a layout pass resolves the quota variable from
 * the consumer expression. Missing or ambiguous candidates report
 * "incompatible" rather than patching the wrong predicate, and unrelated
 * send-disabled conditions are left untouched because the breakpoint condition
 * clears only the located variable(s).
 *
 * Every helper below is serialized with `Function.prototype.toString` into
 * {@link quotaGatePageSource}, which is injected into the renderer through
 * `Page.addScriptToEvaluateOnNewDocument`. They must therefore stay
 * self-contained plain JavaScript at runtime: no imports, no module-scope
 * values other than `IDENTIFIER` (serialized separately), and no TypeScript
 * syntax in a body position Bun would keep (annotations are stripped). If a
 * helper needs a new dependency, serialize it in PAGE_PARTS too.
 */

/** Matches one minified identifier. Kept as a string so it composes into patterns. */
const IDENTIFIER = "[A-Za-z_$][\\w$]*";

export type QuotaGateMode = "codex-local-quota" | "legacy-local-host" | "third-party-composer-dual";

export interface QuotaGateLocation {
  /** Anchored regex matching the script URL this location was derived from. */
  urlRegex: string;
  lineNumber: number;
  columnNumber: number;
  /** Present only for `codex-local-quota`: end of the range getPossibleBreakpoints may pick from. */
  endLineNumber?: number;
  endColumnNumber?: number;
  /** The minified variable carrying the quota gate; the breakpoint condition clears it. */
  quotaVariable: string;
  /** The `=== "local"` host variable for the local modes, or null. */
  hostVariable: string | null;
  /** Dual quota variable for `third-party-composer-dual`, or null. */
  conversationQuotaVariable: string | null;
  mode: QuotaGateMode;
}

interface QuotaGateApi {
  locate(source: string, sourceUrl: string): QuotaGateLocation | null;
  condition(location: QuotaGateLocation | null): string | null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sourceLocation(
  source: string,
  sourceUrl: string,
  absoluteOffset: number,
  quotaVariable: string,
  hostVariable: string | null,
  mode: QuotaGateMode,
  conversationQuotaVariable: string | null = null,
  endOffset: number | null = null,
): QuotaGateLocation {
  const precedingLines = source.slice(0, absoluteOffset).split("\n");
  const result: QuotaGateLocation = {
    urlRegex: `^${escapeRegex(sourceUrl)}$`,
    lineNumber: precedingLines.length - 1,
    columnNumber: (precedingLines.at(-1) ?? "").length,
    quotaVariable,
    hostVariable: hostVariable || null,
    conversationQuotaVariable: conversationQuotaVariable || null,
    mode,
  };
  if (Number.isInteger(endOffset) && endOffset !== null && endOffset > absoluteOffset) {
    const endLines = source.slice(0, endOffset).split("\n");
    result.endLineNumber = endLines.length - 1;
    result.endColumnNumber = (endLines.at(-1) ?? "").length;
  }
  return result;
}

function locateLegacy(source: string, sourceUrl: string, atomVariable: string): QuotaGateLocation | null {
  const localGatePattern = new RegExp(
    `(${IDENTIFIER})=${IDENTIFIER}\\(${escapeRegex(atomVariable)}\\)&&(${IDENTIFIER})===\\\`local\\\``,
    "g",
  );
  const localGates = [...source.matchAll(localGatePattern)];
  if (localGates.length !== 1) return null;

  const gate = localGates[0]!;
  const tailOffset = gate.index + gate[0].length;
  const tail = source.slice(tailOffset, tailOffset + 18000);
  const assignment = new RegExp(
    `(${IDENTIFIER})=(${IDENTIFIER}(?:\\|\\|${IDENTIFIER})*\\|\\|${escapeRegex(gate[1]!)})(?=[,;])`,
  ).exec(tail);
  if (!assignment || !tail.includes(`submitDisabled:${assignment[1]}`)) return null;
  const absoluteOffset = tailOffset + assignment.index + assignment[1]!.length + 1;
  return sourceLocation(source, sourceUrl, absoluteOffset, gate[1]!, gate[2]!, "legacy-local-host");
}

function locateModern(source: string, sourceUrl: string, atomVariable: string): QuotaGateLocation | null {
  const consumerPattern = new RegExp(
    `(${IDENTIFIER})=${IDENTIFIER}\\(${escapeRegex(atomVariable)}\\)&&(${IDENTIFIER})`,
    "g",
  );
  const candidates: Array<{ match: RegExpMatchArray; props: RegExpExecArray }> = [];
  for (const match of source.matchAll(consumerPattern)) {
    const window = source.slice(match.index, match.index + 60000);
    const quota = match[1]!;
    if (!window.includes("submitDisabled:")) continue;
    if (!window.includes("rateLimitSendBlocked:")) continue;
    const propsPattern = new RegExp(
      `rateLimitSendBlocked:(${IDENTIFIER})\\|\\|${escapeRegex(quota)},rateLimitConversationSendBlocked:\\1(?:[,}])`,
    );
    const props = propsPattern.exec(window);
    if (!props) continue;
    candidates.push({ match, props });
  }
  if (candidates.length !== 1) return null;
  const { match, props } = candidates[0]!;
  return sourceLocation(
    source,
    sourceUrl,
    (match.index ?? 0) + props.index,
    match[1]!,
    null,
    "third-party-composer-dual",
    props[1]!,
  );
}

function locateCodexLocalQuota(source: string, sourceUrl: string, atomVariable: string): QuotaGateLocation | null {
  const consumerPattern = new RegExp(
    `(${IDENTIFIER})=${IDENTIFIER}\\(${escapeRegex(atomVariable)}\\)&&(${IDENTIFIER})===\\\`local\\\``,
    "g",
  );
  const candidates: Array<{ consumer: RegExpMatchArray; absoluteStart: number; absoluteEnd: number }> = [];
  for (const consumer of source.matchAll(consumerPattern)) {
    const quota = consumer[1]!;
    const window = source.slice(consumer.index, consumer.index + 12000);
    const assignmentPattern = new RegExp(
      `let (${IDENTIFIER})=([^,;]{1,900}\\|\\|${escapeRegex(quota)}),(${IDENTIFIER});`,
    );
    const assignment = assignmentPattern.exec(window);
    if (!assignment) continue;
    if (!window.slice(assignment.index, assignment.index + 10000).includes(`submitDisabled:${assignment[1]}`)) continue;
    const absoluteStart = consumer.index + assignment.index;
    const absoluteEnd = absoluteStart + assignment[0].lastIndexOf(`,${assignment[3]};`);
    candidates.push({ consumer, absoluteStart, absoluteEnd });
  }
  if (candidates.length !== 1) return null;
  const candidate = candidates[0]!;
  return sourceLocation(
    source,
    sourceUrl,
    candidate.absoluteStart,
    candidate.consumer[1]!,
    candidate.consumer[2]!,
    "codex-local-quota",
    null,
    candidate.absoluteEnd,
  );
}

/**
 * Locate the quota predicate in one parsed bundle, or null.
 *
 * The entry point is the auth atom — the single expression that reads
 * `authMethod !== "chatgpt"` and `rate_limit?.allowed !== false`. Exactly one
 * atom is required; zero means a different build, two means the anchor is no
 * longer unique, and both fail closed.
 */
function locate(source: string, sourceUrl: string): QuotaGateLocation | null {
  if (typeof source !== "string" || source.length === 0) return null;
  if (typeof sourceUrl !== "string" || sourceUrl.length === 0) return null;

  const atomPattern = new RegExp(
    `(${IDENTIFIER})=${IDENTIFIER}\\(${IDENTIFIER},\\(\\{get:${IDENTIFIER}\\}\\)=>\\{[^}]{0,1400}?\\.authMethod!==\\\`chatgpt\\\`[^}]{0,1400}?\\.rate_limit\\?\\.allowed!==!1`,
    "g",
  );
  const atoms = [...source.matchAll(atomPattern)];
  if (atoms.length !== 1) return null;
  return locateCodexLocalQuota(source, sourceUrl, atoms[0]![1]!)
    || locateLegacy(source, sourceUrl, atoms[0]![1]!)
    || locateModern(source, sourceUrl, atoms[0]![1]!);
}

/**
 * Build the CDP conditional-breakpoint expression for a located gate.
 *
 * The condition runs at the breakpoint and clears ONLY the quota variable(s)
 * before yielding false — every other predicate the composer computed stays in
 * force, which is what keeps unrelated send-disabled conditions effective.
 */
function condition(location: QuotaGateLocation | null): string | null {
  const safeIdentifier = /^[A-Za-z_$][\w$]*$/;
  if (!safeIdentifier.test(location?.quotaVariable || "")) return null;
  const quota = location!.quotaVariable;
  if (location!.mode === "codex-local-quota" || location!.mode === "legacy-local-host") {
    return `(${quota}=false,false)`;
  }
  if (location!.mode === "third-party-composer-dual") {
    if (!safeIdentifier.test(location!.conversationQuotaVariable || "")) return null;
    return `(${location!.conversationQuotaVariable}=false,${quota}=false,false)`;
  }
  return null;
}

/**
 * JavaScript source evaluated inside the renderer (new documents and the live
 * context). Equivalent to upstream's quota-gate.cjs: it publishes
 * `globalThis.__codexExternalQuotaGate` and assigns `module.exports` when a
 * CommonJS-shaped module object happens to exist.
 */
export function quotaGatePageSource(): string {
  const parts = [
    `const IDENTIFIER = ${JSON.stringify(IDENTIFIER)};`,
    escapeRegex.toString(),
    sourceLocation.toString(),
    locateCodexLocalQuota.toString(),
    locateLegacy.toString(),
    locateModern.toString(),
    locate.toString(),
    condition.toString(),
    `const api = { locate, condition };
globalThis.__codexExternalQuotaGate = api;
if (typeof module === "object" && module?.exports) module.exports = api;`,
  ];
  return `(() => {\n${parts.join("\n")}\n})();`;
}

/** Locator entry point for the supervisor's own copy of a fetched bundle. */
export function locateQuotaGate(source: string, sourceUrl: string): QuotaGateLocation | null {
  return locate(source, sourceUrl);
}

/** Conditional-breakpoint expression for a located gate, or null. */
export function quotaGateCondition(location: QuotaGateLocation | null): string | null {
  return condition(location);
}

/** The object the injected page source publishes, for supervisor-side calls. */
export function quotaGateApi(): QuotaGateApi {
  return { locate, condition };
}

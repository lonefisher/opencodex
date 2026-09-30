import { describe, expect, test } from "bun:test";
import {
  locateQuotaGate,
  quotaGateApi,
  quotaGateCondition,
  quotaGatePageSource,
  type QuotaGateLocation,
} from "../../src/codex/input-unlock/quota-gate";

/**
 * Regression coverage for the minified-bundle locator. The three supported
 * shapes mirror codex-input-unlock's quota-gate.cjs; every case fails closed
 * (null) when the anchor or the single-candidate rule does not hold.
 */

const URL = "app://-/assets/index-abc123.js";

/**
 * The auth atom the locator anchors on. The template-literal "chatgpt" and the
 * `!==!1` spelling are what the real bundle contains — do not normalize them.
 */
function atom(a: string, fn: string, arg: string, get: string): string {
  return `var ${a}=${fn}(${arg},({get:${get}})=>{const u=${get}.authMethod!==\`chatgpt\`;return u?${get}.rate_limit?.allowed!==!1:!0});`;
}

/** Modern dual-quota composer: no `local` host gate, two quota variables. */
function modernBundle(names: { atom?: string; fn?: string; arg?: string; get?: string; quota?: string; read?: string; extra?: string; conv?: string } = {}): string {
  const { atom: a = "qq", fn: f = "ff", arg: g = "gg", get: t = "tt", quota: q = "vv", read: r = "ww", extra: e = "hh", conv: c = "cc" } = names;
  return [
    atom(a, f, g, t),
    `var ${q}=${r}(${a})&&${e};`,
    `var out={submitDisabled:${q},rateLimitSendBlocked:${c}||${q},rateLimitConversationSendBlocked:${c}};`,
  ].join("\n");
}

/** Legacy local-host composer: `x===\`local\`` gate and a `||` assignment. */
function legacyBundle(): string {
  return [
    atom("qa", "fb", "ga", "tb"),
    "var vb=wb(qa)&&hb===`local`;",
    "var zb=yb||vb;",
    "var out={submitDisabled:zb};",
  ].join("\n");
}

/** Codex-local quota shape: `let X=<expr>||quota,Y;` feeding submitDisabled. */
function codexLocalBundle(): string {
  return [
    atom("qc", "fc", "gc", "tc"),
    "var vc=wc(qc)&&hc===`local`;",
    "let xc=ac||vc,bc;",
    "var out={submitDisabled:xc};",
  ].join("\n");
}

describe("quota-gate locator", () => {
  test("locates the modern dual-quota composer and names both variables", () => {
    const location = locateQuotaGate(modernBundle(), URL);
    expect(location).not.toBeNull();
    expect(location!.mode).toBe("third-party-composer-dual");
    expect(location!.quotaVariable).toBe("vv");
    expect(location!.conversationQuotaVariable).toBe("cc");
    expect(location!.hostVariable).toBeNull();
    expect(quotaGateCondition(location)).toBe("(cc=false,vv=false,false)");
  });

  test("locates the legacy local-host composer", () => {
    const location = locateQuotaGate(legacyBundle(), URL);
    expect(location!.mode).toBe("legacy-local-host");
    expect(location!.quotaVariable).toBe("vb");
    expect(location!.hostVariable).toBe("hb");
    expect(quotaGateCondition(location)).toBe("(vb=false,false)");
  });

  test("locates the codex-local quota assignment with an end range", () => {
    const source = codexLocalBundle();
    const location = locateQuotaGate(source, URL);
    expect(location!.mode).toBe("codex-local-quota");
    expect(location!.quotaVariable).toBe("vc");
    expect(location!.hostVariable).toBe("hc");
    expect(location!.endLineNumber).toBeTypeOf("number");
    // The breakpoint range must sit inside the `let xc=...,bc;` statement.
    const start = source.split("\n").slice(0, location!.lineNumber).join("\n").length;
    const lineText = source.split("\n")[location!.lineNumber]!;
    expect(lineText.slice(location!.columnNumber)).toMatch(/^let xc=/);
    expect(start).toBeLessThan(source.length);
  });

  test("renamed minified variables still locate (the names are dynamic, not pinned)", () => {
    const location = locateQuotaGate(modernBundle({
      atom: "x9", fn: "y9", arg: "z9", get: "w9", quota: "m1", read: "n1", extra: "k1", conv: "p1",
    }), URL);
    expect(location).not.toBeNull();
    expect(location!.quotaVariable).toBe("m1");
    expect(location!.conversationQuotaVariable).toBe("p1");
    expect(quotaGateCondition(location)).toBe("(p1=false,m1=false,false)");
  });

  test("two auth atoms are ambiguous and fail closed", () => {
    const source = atom("qa", "fa", "ga", "ta") + atom("qb", "fb", "gb", "tb") + "\nvar v=w(qa)&&h;";
    expect(locateQuotaGate(source, URL)).toBeNull();
  });

  test("no auth atom at all is a different build", () => {
    expect(locateQuotaGate("var v=w(q)&&h;submitDisabled:v", URL)).toBeNull();
  });

  test("two modern candidates are ambiguous, not first-wins", () => {
    const source = [
      atom("qa", "fa", "ga", "ta"),
      "var v=w(qa)&&h;",
      "var out={submitDisabled:v,rateLimitSendBlocked:c||v,rateLimitConversationSendBlocked:c};",
      "var v2=w(qa)&&h2;",
      "var out2={submitDisabled:v2,rateLimitSendBlocked:d||v2,rateLimitConversationSendBlocked:d};",
    ].join("\n");
    expect(locateQuotaGate(source, URL)).toBeNull();
  });

  test("an atom with no matching consumer is an unknown version", () => {
    const source = atom("qa", "fa", "ga", "ta") + "\nvar v=w(qa);";
    expect(locateQuotaGate(source, URL)).toBeNull();
  });

  test("non-quota send-disabled terms stay out of the breakpoint condition", () => {
    const source = modernBundle();
    const location = locateQuotaGate(source, URL)!;
    const condition = quotaGateCondition(location)!;
    // Only the two quota variables are assigned; nothing else in the source is
    // referenced — that is what keeps e.g. a typing/validation gate effective.
    expect(condition).toBe("(cc=false,vv=false,false)");
    expect(condition).not.toContain("submitDisabled");
    expect(condition).not.toContain("rateLimit");
  });

  test("a non-identifier quota variable can never become a condition", () => {
    const location = {
      urlRegex: "^app://x$", lineNumber: 0, columnNumber: 0,
      quotaVariable: "x;alert(1)", hostVariable: null,
      conversationQuotaVariable: null, mode: "legacy-local-host",
    } as QuotaGateLocation;
    expect(quotaGateCondition(location)).toBeNull();
  });

  test("empty inputs locate nothing", () => {
    expect(locateQuotaGate("", URL)).toBeNull();
    expect(locateQuotaGate(modernBundle(), "")).toBeNull();
  });
});

describe("the emitted page source", () => {
  test("evaluates standalone and exposes the same locate/condition pair", () => {
    const g = globalThis as Record<string, unknown>;
    delete g.__codexExternalQuotaGate;
    try {
      new Function(quotaGatePageSource())();
      const api = g.__codexExternalQuotaGate as ReturnType<typeof quotaGateApi> | undefined;
      expect(api).toBeDefined();
      const expected = locateQuotaGate(modernBundle(), URL)!;
      const emitted = api!.locate(modernBundle(), URL);
      expect(emitted).toEqual(expected);
      expect(api!.condition(emitted)).toBe(quotaGateCondition(expected));
      expect(api!.locate("var x=1;", URL)).toBeNull();
    } finally {
      delete g.__codexExternalQuotaGate;
    }
  });
});

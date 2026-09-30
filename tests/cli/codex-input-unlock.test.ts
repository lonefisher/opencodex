import { describe, expect, test } from "bun:test";
import { handleCodexInputUnlockCommand } from "../../src/cli/codex-input-unlock";

/**
 * CLI surface coverage: every verb is a management-API call, so the assertions
 * pin the request shape (method, path, body) against a stubbed transport.
 */

interface Call { url: string; method: string; body: unknown }

function stubbed(calls: Call[], responder: (call: Call) => unknown) {
  return {
    baseUrl: "http://127.0.0.1:10100",
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return new Response(JSON.stringify(responder(call)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
    out: [] as string[],
  };
}

const STATUS = { ok: true, inputUnlock: { enabled: true, state: "mounted", port: 5150, updatedAt: "t" } };

async function run(argv: string[], deps: ReturnType<typeof stubbed>): Promise<number> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...a: unknown[]) => { deps.out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { deps.out.push(a.join(" ")); };
  try {
    return await handleCodexInputUnlockCommand(argv, deps);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe("ocx codex-input-unlock", () => {
  test("status GETs the endpoint and prints the state", async () => {
    const calls: Call[] = [];
    const deps = stubbed(calls, () => STATUS);
    const code = await run(["status"], deps);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", url: "http://127.0.0.1:10100/api/codex/input-unlock" });
    expect(deps.out.join("\n")).toContain("mounted");
  });

  test("enable PUTs {enabled:true}; disable PUTs {enabled:false}", async () => {
    const calls: Call[] = [];
    const deps = stubbed(calls, () => STATUS);
    await run(["enable"], deps);
    await run(["disable"], deps);
    expect(calls[0]).toMatchObject({ method: "PUT", body: { enabled: true } });
    expect(calls[1]).toMatchObject({ method: "PUT", body: { enabled: false } });
  });

  test("launch POSTs {restart:false}; --restart flips it", async () => {
    const calls: Call[] = [];
    const deps = stubbed(calls, () => ({ ok: true, launched: true, inputUnlock: STATUS.inputUnlock }));
    await run(["launch"], deps);
    await run(["launch", "--restart"], deps);
    expect(calls[0]).toMatchObject({ method: "POST", body: { restart: false } });
    expect(calls[1]).toMatchObject({ method: "POST", body: { restart: true } });
    expect(calls[0]!.url).toContain("/api/codex/input-unlock/launch");
  });

  test("--json prints the raw envelope", async () => {
    const calls: Call[] = [];
    const deps = stubbed(calls, () => STATUS);
    await run(["status", "--json"], deps);
    const parsed = JSON.parse(deps.out.join("\n")) as typeof STATUS;
    expect(parsed.inputUnlock.state).toBe("mounted");
  });

  test("an unknown verb and stray args are usage errors", async () => {
    const calls: Call[] = [];
    const deps = stubbed(calls, () => STATUS);
    expect(await run(["bogus"], deps)).not.toBe(0);
    expect(await run(["status", "extra"], deps)).not.toBe(0);
    expect(calls).toHaveLength(0);
  });
});

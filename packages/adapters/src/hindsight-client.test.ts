import { describe, expect, it, vi } from "vitest";
import {
  classifyHindsightBaseUrlTrust,
  getHindsightMemory,
  hindsightBaseUrlRequiresPrivateEndpoint,
  hindsightRecall,
  hindsightRetain,
  invalidateHindsightMemory,
  listHindsightBanks,
  normalizeHindsightBaseUrl,
} from "./hindsight-client.js";

/** Loopback needs no DNS pinning, so requests ride the injected fetch directly. */
const LOCAL_BASE = "http://localhost:8888";

function config(overrides: Partial<Parameters<typeof listHindsightBanks>[0]> = {}) {
  return { baseUrl: LOCAL_BASE, ...overrides };
}

function fakeFetch(handler: (url: URL, init?: RequestInit) => Response) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    // The pinned transports hand the fetch a URL object; plain transports a string.
    return handler(new URL(String(input)), init);
  });
}

describe("hindsight base URLs", () => {
  it("rejects credentials, queries, fragments, and non-HTTP schemes", () => {
    expect(() => normalizeHindsightBaseUrl("")).toThrow();
    expect(() => normalizeHindsightBaseUrl("hindsight://x")).toThrow();
    expect(() => normalizeHindsightBaseUrl("http://user:pass@host:8888")).toThrow();
    expect(() => normalizeHindsightBaseUrl("http://host:8888?x=1")).toThrow();
    expect(() => normalizeHindsightBaseUrl("http://host:8888#frag")).toThrow();
    expect(normalizeHindsightBaseUrl("http://localhost:8888/")).toBe("http://localhost:8888");
  });

  it("treats loopback, private literals, and cleartext HTTP as private", () => {
    expect(hindsightBaseUrlRequiresPrivateEndpoint("http://127.0.0.1:8888")).toBe(true);
    expect(hindsightBaseUrlRequiresPrivateEndpoint("http://10.1.2.3:8888")).toBe(true);
    expect(hindsightBaseUrlRequiresPrivateEndpoint("http://192.168.31.31:8888")).toBe(true);
    expect(hindsightBaseUrlRequiresPrivateEndpoint("http://hindsight.lan:8888")).toBe(true);
    expect(hindsightBaseUrlRequiresPrivateEndpoint("https://hindsight.lan:8888")).toBe(false);
    expect(hindsightBaseUrlRequiresPrivateEndpoint("https://8.8.8.8:8888")).toBe(false);
  });

  it("classifies public-looking HTTPS names by their resolved addresses", async () => {
    const resolve = async () => [{ address: "10.8.0.2", family: 4 as const }];
    expect(await classifyHindsightBaseUrlTrust("https://memory.example.com", resolve)).toBe(
      "private",
    );
    const resolvePublic = async () => [{ address: "93.184.216.34", family: 4 as const }];
    expect(await classifyHindsightBaseUrlTrust("https://memory.example.com", resolvePublic)).toBe(
      "public",
    );
  });
});

describe("listHindsightBanks", () => {
  it("probes with GET without sending a token that was never configured", async () => {
    const fetch = fakeFetch((url, init) => {
      expect(url.pathname).toBe("/v1/default/banks");
      expect(url.searchParams.get("limit")).toBe("1");
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("Authorization")).toBeNull();
      return Response.json({ banks: [], total: 0 });
    });
    const result = await listHindsightBanks(config({ fetch }));
    expect(result).toEqual({ ok: true, value: undefined });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends the bearer token and reports rejection", async () => {
    const fetch = fakeFetch((_url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer hs_test_token");
      return new Response("{}", { status: 403 });
    });
    const result = await listHindsightBanks(config({ token: "hs_test_token", fetch }));
    expect(result).toEqual({ ok: false, error: "Hindsight rejected the access token." });
  });
});

describe("hindsightRetain", () => {
  it("writes items into the bank and accepts the auto-create", async () => {
    const fetch = fakeFetch((url, init) => {
      expect(init?.method).toBe("POST");
      expect(url.pathname).toBe("/v1/default/banks/rakazo-bot-bot-1/memories");
      expect(JSON.parse(String(init?.body))).toEqual({
        items: [{ content: "likes tea", context: "rakazo" }],
      });
      return Response.json({ success: true, bank_id: "rakazo-bot-bot-1", items_count: 1 });
    });
    const result = await hindsightRetain(config({ fetch }), "rakazo-bot-bot-1", [
      { content: "likes tea", context: "rakazo" },
    ]);
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it("surfaces the server's failure detail", async () => {
    const fetch = fakeFetch(() =>
      Response.json({ detail: "retain payload too large" }, { status: 413 }),
    );
    const result = await hindsightRetain(config({ fetch }), "b", [{ content: "x" }]);
    expect(result).toEqual({ ok: false, error: "retain payload too large" });
  });
});

describe("hindsightRecall", () => {
  it("parses ranked results with scores and source facts", async () => {
    const fetch = fakeFetch((url, init) => {
      expect(url.pathname).toBe("/v1/default/banks/b1/memories/recall");
      expect(JSON.parse(String(init?.body))).toEqual({ query: "what does she drink?" });
      return Response.json({
        results: [
          {
            id: "mem-1",
            text: "She likes tea.",
            type: "world",
            scores: { final: 0.82 },
            source_fact_ids: [],
          },
          {
            id: "obs-1",
            text: "Prefers tea over coffee.",
            type: "observation",
            source_fact_ids: ["mem-1", "mem-2"],
          },
          { id: "broken" },
        ],
      });
    });
    const result = await hindsightRecall(config({ fetch }), "b1", "what does she drink?");
    expect(result).toEqual({
      ok: true,
      value: [
        { id: "mem-1", text: "She likes tea.", type: "world", score: 0.82, sourceFactIds: [] },
        {
          id: "obs-1",
          text: "Prefers tea over coffee.",
          type: "observation",
          score: 1,
          sourceFactIds: ["mem-1", "mem-2"],
        },
      ],
    });
  });

  it("treats a bank that was never written as empty", async () => {
    const fetch = fakeFetch(() => new Response("not found", { status: 404 }));
    const result = await hindsightRecall(config({ fetch }), "missing-bank", "anything");
    expect(result).toEqual({ ok: true, value: [] });
  });
});

describe("getHindsightMemory", () => {
  it("returns null for an unknown id and parses known units", async () => {
    const missing = fakeFetch(() => new Response("{}", { status: 404 }));
    expect(await getHindsightMemory(config({ fetch: missing }), "b", "mem-1")).toEqual({
      ok: true,
      value: null,
    });

    const fetch = fakeFetch((url) => {
      expect(url.pathname).toBe("/v1/default/banks/b/memories/mem-1");
      return Response.json({
        id: "mem-1",
        text: "She likes tea.",
        type: "observation",
        state: "valid",
        source_fact_ids: ["mem-2"],
      });
    });
    expect(await getHindsightMemory(config({ fetch }), "b", "mem-1")).toEqual({
      ok: true,
      value: {
        id: "mem-1",
        text: "She likes tea.",
        type: "observation",
        state: "valid",
        sourceFactIds: ["mem-2"],
      },
    });
  });

  it("refuses ids that are not safe path segments", async () => {
    const result = await getHindsightMemory(config(), "b", "../../escape");
    expect(result.ok).toBe(false);
  });
});

describe("invalidateHindsightMemory", () => {
  it("invalidates with the reason and keeps the status on failure", async () => {
    const fetch = fakeFetch((url, init) => {
      expect(init?.method).toBe("PATCH");
      expect(url.pathname).toBe("/v1/default/banks/b/memories/mem-1");
      expect(JSON.parse(String(init?.body))).toEqual({
        state: "invalidated",
        reason: "out of date",
      });
      return Response.json({ id: "mem-1", state: "invalidated" });
    });
    expect(await invalidateHindsightMemory(config({ fetch }), "b", "mem-1", "out of date")).toEqual(
      { ok: true, value: undefined },
    );

    const refused = fakeFetch(() =>
      Response.json({ detail: "observations cannot be curated" }, { status: 400 }),
    );
    const result = await invalidateHindsightMemory(config({ fetch: refused }), "b", "obs-1");
    expect(result).toEqual({
      ok: false,
      error: "observations cannot be curated",
      status: 400,
    });
  });
});

describe("transport failures", () => {
  it("reports unreachable servers without leaking transport detail", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await listHindsightBanks(config({ fetch }));
    expect(result).toEqual({
      ok: false,
      error: "Hindsight is unreachable or the request timed out.",
    });
  });

  it("pins public HTTPS names to their validated public addresses", async () => {
    const fetch = fakeFetch(() => Response.json({ banks: [], total: 0 }));
    const resolve = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
    const result = await listHindsightBanks({
      baseUrl: "https://memory.example.com",
      fetch,
      resolveHostname: resolve,
    });
    expect(result).toEqual({ ok: true, value: undefined });
    expect(resolve).toHaveBeenCalledWith("memory.example.com");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("pins owner-authorized private names to their private addresses", async () => {
    const fetch = fakeFetch(() => Response.json({ banks: [], total: 0 }));
    const resolve = vi.fn(async () => [{ address: "10.8.0.2", family: 4 as const }]);
    const result = await listHindsightBanks({
      baseUrl: "https://hindsight.lan",
      endpointTrust: "private",
      fetch,
      resolveHostname: resolve,
    });
    expect(result).toEqual({ ok: true, value: undefined });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

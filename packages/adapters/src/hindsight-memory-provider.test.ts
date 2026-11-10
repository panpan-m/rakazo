import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as HindsightClientModule from "./hindsight-client.js";
import {
  classifyHindsightConnectionSettings,
  createHindsightProvider,
  HindsightMemoryProvider,
  hindsightBankId,
  hindsightRequiresPrivateEndpoint,
  prepareHindsightConnection,
} from "./hindsight-memory-provider.js";
import { MemoryProviderPrivateEndpointRequiredError } from "./serenity-memory-provider.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

vi.mock("./hindsight-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof HindsightClientModule>();
  return {
    ...actual,
    hindsightRecall: vi.fn(),
    hindsightRetain: vi.fn(),
    getHindsightMemory: vi.fn(),
    invalidateHindsightMemory: vi.fn(),
    listHindsightBanks: vi.fn(),
  };
});

import {
  getHindsightMemory,
  hindsightRecall,
  hindsightRetain,
  invalidateHindsightMemory,
  listHindsightBanks,
} from "./hindsight-client.js";

const recallMock = vi.mocked(hindsightRecall);
const retainMock = vi.mocked(hindsightRetain);
const getMemoryMock = vi.mocked(getHindsightMemory);
const invalidateMock = vi.mocked(invalidateHindsightMemory);
const listBanksMock = vi.mocked(listHindsightBanks);

afterEach(() => {
  vi.clearAllMocks();
});

const CONNECTION = { baseUrl: "http://localhost:8888" };

function provider() {
  return new HindsightMemoryProvider(CONNECTION);
}

const recallRequest = (
  overrides: Partial<Parameters<HindsightMemoryProvider["recall"]>[0]> = {},
) => ({
  query: "what does the user drink?",
  scope: "isolated" as const,
  botId: "bot-1",
  limit: 5,
  ...overrides,
});

const saveRequest = (overrides: Partial<Parameters<HindsightMemoryProvider["save"]>[0]> = {}) => ({
  content: "The user drinks tea every morning.",
  scope: "isolated" as const,
  botId: "bot-1",
  source: { kind: "durable" } as const,
  ...overrides,
});

const forgetArgs = (overrides: Partial<Parameters<HindsightMemoryProvider["forget"]>[0]> = {}) => ({
  id: "mem-1",
  scope: "isolated" as const,
  botId: "bot-1",
  ...overrides,
});

describe("hindsightBankId", () => {
  it("gives every bot its own bank and a shared Space one bank", () => {
    expect(hindsightBankId("isolated", "bot-1", "space-1")).toBe("rakazo-bot-bot-1");
    expect(hindsightBankId("isolated", "bot-2", "space-1")).toBe("rakazo-bot-bot-2");
    expect(hindsightBankId("shared", "bot-1", "space-1")).toBe("rakazo-space-1");
  });

  it("sanitizes ids into safe bank ids", () => {
    expect(hindsightBankId("isolated", "bot/with space", "space-1")).toBe(
      "rakazo-bot-bot_with_space",
    );
  });
});

describe("HindsightMemoryProvider.recall", () => {
  it("recalls from the bot's bank and maps cited facts", async () => {
    recallMock.mockResolvedValue({
      ok: true,
      value: [
        { id: "mem-1", text: "The user drinks tea.", score: 0.9, sourceFactIds: [] },
        { id: "mem-2", text: "Tea is brewed at 7am.", score: 0.4, sourceFactIds: [] },
        { id: "mem-3", text: "Extra fact.", score: 0.2, sourceFactIds: [] },
      ],
    });
    const result = await provider().recall(recallRequest({ limit: 2 }), context);
    expect(recallMock).toHaveBeenCalledWith(
      CONNECTION,
      "rakazo-bot-bot-1",
      "what does the user drink?",
      context.signal,
    );
    expect(result).toEqual({
      ok: true,
      value: [
        {
          memory: "The user drinks tea.",
          score: 0.9,
          id: "mem-1",
          provenance: "hindsight",
          entity: "rakazo-bot-bot-1",
        },
        {
          memory: "Tea is brewed at 7am.",
          score: 0.4,
          id: "mem-2",
          provenance: "hindsight",
          entity: "rakazo-bot-bot-1",
        },
      ],
    });
  });

  it("shares one Space bank in shared scope", async () => {
    recallMock.mockResolvedValue({ ok: true, value: [] });
    await provider().recall(recallRequest({ scope: "shared" }), context);
    expect(recallMock).toHaveBeenCalledWith(
      CONNECTION,
      "rakazo-space-1",
      expect.any(String),
      context.signal,
    );
  });

  it("skips the server for an empty query", async () => {
    const result = await provider().recall(recallRequest({ query: "   " }), context);
    expect(result).toEqual({ ok: true, value: [] });
    expect(recallMock).not.toHaveBeenCalled();
  });

  it("truncates queries to the server's token limit", async () => {
    recallMock.mockResolvedValue({ ok: true, value: [] });
    const long = "茶".repeat(2000);
    await provider().recall(recallRequest({ query: long }), context);
    const sent = recallMock.mock.calls[0]?.[2] ?? "";
    expect(Buffer.byteLength(sent, "utf8")).toBeLessThanOrEqual(1500);
  });
});

describe("HindsightMemoryProvider.save", () => {
  it("retains durable facts into the bot's bank", async () => {
    retainMock.mockResolvedValue({ ok: true, value: undefined });
    const result = await provider().save(saveRequest(), context);
    expect(retainMock).toHaveBeenCalledWith(
      CONNECTION,
      "rakazo-bot-bot-1",
      [{ content: "The user drinks tea every morning.", context: "rakazo" }],
      context.signal,
    );
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it("keeps compaction summaries out of Hindsight", async () => {
    const result = await provider().save(
      saveRequest({ source: { kind: "history", generation: 3 } }),
      context,
    );
    expect(result).toEqual({ ok: true, value: undefined });
    expect(retainMock).not.toHaveBeenCalled();
  });

  it("refuses to save empty content", async () => {
    const result = await provider().save(saveRequest({ content: "  " }), context);
    expect(result.ok).toBe(false);
    expect(retainMock).not.toHaveBeenCalled();
  });
});

describe("HindsightMemoryProvider.forget", () => {
  it("refuses ids from another bot or Space", async () => {
    const result = await provider().forget(forgetArgs({ entity: "rakazo-bot-bot-2" }), context);
    expect(result).toEqual({ ok: false, error: "That memory belongs to another bot or Space." });
    expect(getMemoryMock).not.toHaveBeenCalled();
  });

  it("refuses ids that are not safe path segments", async () => {
    const result = await provider().forget(forgetArgs({ id: "../escape" }), context);
    expect(result.ok).toBe(false);
    expect(getMemoryMock).not.toHaveBeenCalled();
  });

  it("reports a missing memory", async () => {
    getMemoryMock.mockResolvedValue({ ok: true, value: null });
    const result = await provider().forget(forgetArgs(), context);
    expect(result).toEqual({
      ok: false,
      error: "No memory with that id was found in this bot's memory.",
    });
  });

  it("invalidates the fact in the bot's bank", async () => {
    getMemoryMock.mockResolvedValue({
      ok: true,
      value: { id: "mem-1", text: "fact", state: "valid", sourceFactIds: [] },
    });
    invalidateMock.mockResolvedValue({ ok: true, value: undefined });
    const result = await provider().forget(forgetArgs({ reason: "wrong" }), context);
    expect(invalidateMock).toHaveBeenCalledWith(
      CONNECTION,
      "rakazo-bot-bot-1",
      "mem-1",
      "wrong",
      context.signal,
    );
    expect(result).toEqual({ ok: true, value: { id: "mem-1", expired: true, reason: "wrong" } });
  });

  it("treats an already-invalidated memory as forgotten", async () => {
    getMemoryMock.mockResolvedValue({
      ok: true,
      value: { id: "mem-1", state: "invalidated", sourceFactIds: [] },
    });
    const result = await provider().forget(forgetArgs(), context);
    expect(result).toEqual({ ok: true, value: { id: "mem-1", expired: true, reason: null } });
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it("retires an observation through its source facts", async () => {
    getMemoryMock.mockResolvedValue({
      ok: true,
      value: {
        id: "obs-1",
        type: "observation",
        state: "valid",
        sourceFactIds: ["mem-1", "mem-2"],
      },
    });
    invalidateMock.mockImplementation(async (_config, _bank, memoryId) =>
      memoryId === "obs-1"
        ? { ok: false, error: "observations cannot be curated", status: 400 }
        : { ok: true, value: undefined },
    );
    const result = await provider().forget(forgetArgs({ id: "obs-1" }), context);
    expect(result).toEqual({ ok: true, value: { id: "obs-1", expired: true, reason: null } });
    expect(invalidateMock).toHaveBeenCalledTimes(3);
  });

  it("propagates failures other than curation rejections", async () => {
    getMemoryMock.mockResolvedValue({
      ok: true,
      value: { id: "mem-1", state: "valid", sourceFactIds: [] },
    });
    invalidateMock.mockResolvedValue({ ok: false, error: "Hindsight is unreachable" });
    const result = await provider().forget(forgetArgs(), context);
    expect(result).toEqual({ ok: false, error: "Hindsight is unreachable" });
  });
});

describe("hindsightRequiresPrivateEndpoint", () => {
  it("requires the deployment owner for loopback and stored private classifications", () => {
    expect(hindsightRequiresPrivateEndpoint({ baseUrl: "http://127.0.0.1:8888" })).toBe(true);
    expect(hindsightRequiresPrivateEndpoint({ baseUrl: "http://192.168.31.31:8888" })).toBe(true);
    expect(hindsightRequiresPrivateEndpoint({ baseUrl: "https://memory.example.com" })).toBe(false);
    expect(
      hindsightRequiresPrivateEndpoint({
        baseUrl: "https://memory.example.com",
        endpointTrust: "private",
      }),
    ).toBe(true);
  });
});

describe("classifyHindsightConnectionSettings", () => {
  it("classifies private LAN DNS without probing", async () => {
    const classified = await classifyHindsightConnectionSettings(
      { baseUrl: "https://hindsight.lan:8888" },
      { resolveHostname: async () => [{ address: "10.8.0.2", family: 4 as const }] },
    );
    expect(classified).toEqual({ baseUrl: "https://hindsight.lan:8888", endpointTrust: "private" });
  });

  it("drops the trust marker for public endpoints", async () => {
    const classified = await classifyHindsightConnectionSettings(
      { baseUrl: "https://memory.example.com", endpointTrust: "private" },
      { resolveHostname: async () => [{ address: "93.184.216.34", family: 4 as const }] },
    );
    expect(classified).toEqual({ baseUrl: "https://memory.example.com" });
  });
});

describe("prepareHindsightConnection", () => {
  it("refuses private endpoints before probing when not allowed", async () => {
    await expect(
      prepareHindsightConnection(
        { baseUrl: "http://127.0.0.1:8888" },
        {},
        { resolveHostname: async () => [{ address: "127.0.0.1", family: 4 as const }] },
        { allowPrivateEndpoint: false },
      ),
    ).rejects.toThrow(MemoryProviderPrivateEndpointRequiredError);
    expect(listBanksMock).not.toHaveBeenCalled();
  });

  it("probes and stores the normalized connection", async () => {
    listBanksMock.mockResolvedValue({ ok: true, value: undefined });
    const prepared = await prepareHindsightConnection(
      { baseUrl: "http://127.0.0.1:8888/" },
      { token: "hs_test_token" },
      undefined,
      { allowPrivateEndpoint: true },
    );
    expect(listBanksMock).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:8888",
      token: "hs_test_token",
      endpointTrust: "private",
    });
    expect(prepared).toEqual({
      settings: { baseUrl: "http://127.0.0.1:8888", endpointTrust: "private" },
      credentials: { token: "hs_test_token" },
    });
  });

  it("keeps a keyless connection keyless", async () => {
    listBanksMock.mockResolvedValue({ ok: true, value: undefined });
    const prepared = await prepareHindsightConnection(
      { baseUrl: "https://memory.example.com" },
      {},
      { resolveHostname: async () => [{ address: "93.184.216.34", family: 4 as const }] },
    );
    expect(prepared).toEqual({
      settings: { baseUrl: "https://memory.example.com" },
      credentials: {},
    });
  });

  it("surfaces probe failures", async () => {
    listBanksMock.mockResolvedValue({ ok: false, error: "Hindsight rejected the access token." });
    await expect(
      prepareHindsightConnection(
        { baseUrl: "https://memory.example.com" },
        { token: "hs_test_token" },
        { resolveHostname: async () => [{ address: "93.184.216.34", family: 4 as const }] },
      ),
    ).rejects.toThrow("Hindsight rejected the access token.");
  });
});

describe("createHindsightProvider", () => {
  it("describes full semantic-memory capabilities", () => {
    expect(createHindsightProvider({ baseUrl: "http://127.0.0.1:8888" }, {}).describe()).toEqual({
      id: "hindsight",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { recall: true, save: true, purgeHistory: true, sharedScope: true },
    });
  });
});

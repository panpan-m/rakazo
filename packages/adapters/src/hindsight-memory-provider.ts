import type {
  AdapterContext,
  DurableMemoryScope,
  SemanticMemoryForgetRequest,
  SemanticMemoryProvider,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import type {
  HindsightConnectionConfig,
  HindsightNetworkDependencies,
} from "./hindsight-client.js";
import {
  classifyHindsightBaseUrlTrust,
  getHindsightMemory,
  hindsightBaseUrlRequiresPrivateEndpoint,
  hindsightRecall,
  hindsightRetain,
  invalidateHindsightMemory,
  isHindsightMemoryId,
  listHindsightBanks,
  MAX_HINDSIGHT_QUERY_BYTES,
  MAX_HINDSIGHT_RETAIN_BYTES,
  normalizeHindsightBaseUrl,
} from "./hindsight-client.js";
import { egressRefused } from "./network-address.js";
import { MemoryProviderPrivateEndpointRequiredError } from "./serenity-memory-provider.js";
import { truncateUtf8 } from "./utf8.js";

export const HINDSIGHT_PROVIDER_ID = "hindsight";

/**
 * An observation that cannot be curated directly is retired by invalidating its
 * source facts; bound the fan-out so one forget stays a bounded set of calls.
 */
const MAX_FORGET_SOURCE_FACTS = 32;

/** Each bot remembers through its own bank; a shared Space uses one Space bank. */
export function hindsightBankId(scope: DurableMemoryScope, botId: string, spaceId: string): string {
  const raw = scope === "shared" ? `rakazo-${spaceId}` : `rakazo-bot-${botId}`;
  return raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
}

/**
 * Fails closed: loopback, private literals, and any cleartext-HTTP host need the
 * deployment owner's authorization before credentials are ever sent there.
 */
export function hindsightRequiresPrivateEndpoint(settings: Record<string, string>): boolean {
  if (settings.endpointTrust === "private") return true;
  const baseUrl = settings.baseUrl?.trim();
  if (!baseUrl) return false;
  try {
    return hindsightBaseUrlRequiresPrivateEndpoint(baseUrl);
  } catch {
    return false;
  }
}

function requiredValue(values: Record<string, string>, key: string): string {
  const value = values[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function parseHindsightConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): HindsightConnectionConfig {
  const baseUrl = normalizeHindsightBaseUrl(requiredValue(settings, "baseUrl"));
  const token = credentials.token?.trim() ?? "";
  if (token && (token.length < 8 || token.length > 4096)) {
    throw new Error("token must contain 8–4096 characters");
  }
  return {
    baseUrl,
    ...(token ? { token } : {}),
    ...(settings.endpointTrust === "private" ? { endpointTrust: "private" as const } : {}),
  };
}

/**
 * DNS/trust classification without probing. Callers must enforce operator
 * authorization on the result before any credentialed Hindsight request.
 */
export async function classifyHindsightConnectionSettings(
  settings: Record<string, string>,
  network?: HindsightNetworkDependencies,
): Promise<Record<string, string>> {
  const baseUrl = normalizeHindsightBaseUrl(requiredValue(settings, "baseUrl"));
  const trust = await classifyHindsightBaseUrlTrust(baseUrl, network?.resolveHostname);
  const classified: Record<string, string> = { ...settings, baseUrl };
  if (trust === "private") classified.endpointTrust = "private";
  else delete classified.endpointTrust;
  return classified;
}

export async function prepareHindsightConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  network?: HindsightNetworkDependencies,
  options?: { allowPrivateEndpoint?: boolean },
): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }> {
  const classified = await classifyHindsightConnectionSettings(settings, network);
  // Reclassification can flip public→private between the API owner check and this probe.
  // Non-owners must fail closed here before any credentialed request.
  if (classified.endpointTrust === "private" && options?.allowPrivateEndpoint === false) {
    throw egressRefused(
      URL.parse(classified.baseUrl ?? "")?.hostname ?? "",
      new MemoryProviderPrivateEndpointRequiredError(),
    );
  }
  const connection: HindsightConnectionConfig = {
    ...parseHindsightConnection(classified, credentials),
    ...(network?.fetch ? { fetch: network.fetch } : {}),
    ...(network?.resolveHostname ? { resolveHostname: network.resolveHostname } : {}),
  };
  const probe = await listHindsightBanks(connection);
  if (!probe.ok) throw new Error(probe.error);
  return {
    settings: {
      baseUrl: connection.baseUrl,
      ...(connection.endpointTrust === "private" ? { endpointTrust: "private" } : {}),
    },
    credentials: connection.token ? { token: connection.token } : {},
  };
}

export function createHindsightProvider(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): SemanticMemoryProvider {
  return new HindsightMemoryProvider(parseHindsightConnection(settings, credentials));
}

export class HindsightMemoryProvider implements SemanticMemoryProvider {
  constructor(private readonly connection: HindsightConnectionConfig) {}

  describe() {
    return {
      id: HINDSIGHT_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        recall: true,
        save: true,
        purgeHistory: true,
        sharedScope: true,
      } as const,
    };
  }

  async recall(
    request: SemanticMemoryRecallRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>> {
    const bankId = hindsightBankId(request.scope, request.botId, context.spaceId);
    const query = truncateUtf8(request.query.trim(), MAX_HINDSIGHT_QUERY_BYTES);
    if (!query) return { ok: true, value: [] };
    const recalled = await hindsightRecall(this.connection, bankId, query, context.signal);
    if (!recalled.ok) return recalled;
    return {
      ok: true,
      value: recalled.value
        .map((item) => ({
          memory: item.text,
          score: item.score,
          id: item.id,
          provenance: "hindsight",
          entity: bankId,
        }))
        .slice(0, request.limit),
    };
  }

  async save(
    request: SemanticMemorySaveRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    if (request.source.kind === "history") {
      // Compaction summaries stay in Rakazo; Hindsight holds durable facts only.
      return { ok: true, value: undefined };
    }
    const content = truncateUtf8(request.content.trim(), MAX_HINDSIGHT_RETAIN_BYTES);
    if (!content) return { ok: false, error: "Hindsight save skipped: memory content is empty." };
    const bankId = hindsightBankId(request.scope, request.botId, context.spaceId);
    return hindsightRetain(
      this.connection,
      bankId,
      [{ content, context: "rakazo" }],
      context.signal,
    );
  }

  async forget(
    request: SemanticMemoryForgetRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<{ id: string; expired: boolean; reason: string | null }>> {
    const id = request.id.trim();
    if (!id || !isHindsightMemoryId(id)) {
      return { ok: false, error: "Invalid Hindsight memory id." };
    }
    const bankId = hindsightBankId(request.scope, request.botId, context.spaceId);
    if (request.entity && request.entity !== bankId) {
      return { ok: false, error: "That memory belongs to another bot or Space." };
    }
    const found = await getHindsightMemory(this.connection, bankId, id, context.signal);
    if (!found.ok) return found;
    const memory = found.value;
    if (!memory) {
      return { ok: false, error: "No memory with that id was found in this bot's memory." };
    }
    const reason = request.reason ?? null;
    if (memory.state !== "invalidated") {
      const invalidated = await invalidateHindsightMemory(
        this.connection,
        bankId,
        id,
        request.reason,
        context.signal,
      );
      if (!invalidated.ok && invalidated.status !== 400) return invalidated;
      if (invalidated.ok) return { ok: true, value: { id, expired: true, reason } };
      // Only raw facts can be curated; an observation is retired through its source facts.
      const sourceIds = memory.sourceFactIds.slice(0, MAX_FORGET_SOURCE_FACTS);
      if (sourceIds.length === 0) return invalidated;
      for (const sourceId of sourceIds) {
        const retired = await invalidateHindsightMemory(
          this.connection,
          bankId,
          sourceId,
          request.reason,
          context.signal,
        );
        if (!retired.ok && retired.status !== 404) return retired;
      }
    }
    return { ok: true, value: { id, expired: true, reason } };
  }

  async purgeHistory(
    _request: { botId: string; generations: number[] },
    _context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    // History generations are never written to Hindsight.
    return { ok: true, value: undefined };
  }
}

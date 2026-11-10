import { lookup } from "node:dns/promises";
import {
  ipVersion,
  isCloudMetadataAddress,
  isLocalhostOrLoopbackIp,
  isNonPublicAddress,
} from "@rakazo/contracts";
import type { ResolveHostname } from "./network-address.js";
import type { SafeRemoteFetch } from "./remote-mcp.js";
import { createPrivateNetworkFetch, createSafeRemoteFetch } from "./remote-mcp.js";
import { isBlockedHostname, readBodyCapped } from "./web-ssrf.js";

const HINDSIGHT_PROBE_TIMEOUT_MS = 15_000;
const HINDSIGHT_RECALL_TIMEOUT_MS = 30_000;
/** Retain runs server-side LLM extraction over every chunk of the content. */
const HINDSIGHT_RETAIN_TIMEOUT_MS = 120_000;
const HINDSIGHT_CURATE_TIMEOUT_MS = 15_000;
const MAX_HINDSIGHT_RESPONSE_BYTES = 1024 * 1024;

/** Hindsight rejects recall queries over 500 tokens; this stays under it in any script. */
export const MAX_HINDSIGHT_QUERY_BYTES = 1500;
/** One retain item's content; Hindsight chunks anything larger server-side. */
export const MAX_HINDSIGHT_RETAIN_BYTES = 64 * 1024;

export interface HindsightConnectionConfig {
  baseUrl: string;
  /** Optional bearer token; self-hosted servers commonly run without one. */
  token?: string;
  /** Set when prepare classified the endpoint as private LAN/DNS. */
  endpointTrust?: "private" | "public";
  /** Test seams. Production uses the runtime fetch and DNS resolver. */
  fetch?: typeof globalThis.fetch;
  resolveHostname?: ResolveHostname;
}

export type HindsightNetworkDependencies = {
  fetch?: typeof globalThis.fetch;
  resolveHostname?: ResolveHostname;
};

export type HindsightResponse<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; status?: number };

export interface HindsightRetainItem {
  content: string;
  context?: string;
}

export interface HindsightRecallItem {
  id: string;
  text: string;
  type?: string;
  score: number;
  sourceFactIds: string[];
}

export interface HindsightMemoryUnit {
  id?: string;
  text?: string;
  type?: string;
  state?: string;
  sourceFactIds: string[];
}

/** Memory ids are opaque path parameters; keep the shape conservative before interpolating. */
export function isHindsightMemoryId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(value);
}

/** Hindsight bank ids allow letters, digits, `_` and `-` only. */
export function sanitizeHindsightBankId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
}

export function parseHindsightBaseUrl(baseUrl: string): URL {
  if (!baseUrl.trim()) throw new Error("baseUrl is required");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Hindsight base URL must be a valid HTTP(S) URL.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#")
  ) {
    throw new Error(
      "Hindsight base URL must use HTTP(S) without credentials, a query, or a fragment.",
    );
  }
  return url;
}

export function normalizeHindsightBaseUrl(baseUrl: string): string {
  return parseHindsightBaseUrl(baseUrl).href.replace(/\/+$/, "");
}

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

const defaultResolveHostname: ResolveHostname = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

/** Loopback, RFC1918/ULA literals, or cleartext HTTP need deployment-owner authorization. */
export function hindsightBaseUrlRequiresPrivateEndpoint(baseUrl: string): boolean {
  const url = parseHindsightBaseUrl(baseUrl);
  const host = hostnameOf(url);
  if (isLocalhostOrLoopbackIp(host) || isBlockedHostname(host)) return true;
  if (ipVersion(host) !== 0) return isNonPublicAddress(host);
  // Unresolved public-looking hostnames may still be LAN DNS over HTTP.
  return url.protocol === "http:";
}

/**
 * Classifies endpoint trust for fetch + owner gating. Public-looking HTTPS names
 * that resolve only to private addresses are treated as private LAN endpoints.
 */
export async function classifyHindsightBaseUrlTrust(
  baseUrl: string,
  resolveHostname?: ResolveHostname,
): Promise<"private" | "public"> {
  const url = parseHindsightBaseUrl(baseUrl);
  if (hindsightBaseUrlRequiresPrivateEndpoint(url.href)) return "private";
  const resolve = resolveHostname ?? defaultResolveHostname;
  const addresses = await resolve(hostnameOf(url));
  if (addresses.length === 0) {
    throw new Error("Hindsight endpoint did not resolve to an address.");
  }
  if (addresses.some((entry) => isCloudMetadataAddress(entry.address))) {
    throw new Error("Hindsight endpoint targets a blocked address.");
  }
  return addresses.some((entry) => isNonPublicAddress(entry.address)) ? "private" : "public";
}

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

interface HindsightTransport {
  fetch: (url: URL, init: RequestInit) => Promise<Response>;
  close: () => Promise<void>;
}

function constantTransport(fetch: typeof globalThis.fetch): HindsightTransport {
  return { fetch: (url, init) => fetch(String(url), init), close: async () => undefined };
}

function pinnedTransport(safe: SafeRemoteFetch): HindsightTransport {
  return {
    fetch: (url, init) => safe(String(url), init),
    close: () => safe.close().catch(() => undefined),
  };
}

/**
 * Public HTTPS names ride the public-only pinned fetch; owner-authorized private
 * names ride the private-only pinned fetch, so a persisted classification cannot
 * rebind the request to the other network. IP literals need no pinning.
 */
function hindsightTransport(config: HindsightConnectionConfig, url: URL): HindsightTransport {
  if (
    config.endpointTrust === "private" ||
    hindsightBaseUrlRequiresPrivateEndpoint(config.baseUrl)
  ) {
    if (ipVersion(hostnameOf(url)) !== 0) return constantTransport(config.fetch ?? fetch);
    return pinnedTransport(
      createPrivateNetworkFetch(config.fetch, config.resolveHostname ?? defaultResolveHostname),
    );
  }
  return pinnedTransport(
    createSafeRemoteFetch(config.fetch, config.resolveHostname ?? defaultResolveHostname),
  );
}

function bankPath(bankId: string, suffix = ""): string {
  return `/v1/default/banks/${encodeURIComponent(bankId)}${suffix}`;
}

function hindsightErrorMessage(json: unknown, fallback: string): string {
  if (json && typeof json === "object") {
    const detail = (json as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.trim()) return detail.trim();
    if (detail && typeof detail === "object") {
      const message = (detail as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
  }
  return fallback;
}

async function hindsightRequest(
  config: HindsightConnectionConfig,
  path: string,
  options: {
    method?: "GET" | "POST" | "PATCH";
    body?: unknown;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<HindsightResponse<{ status: number; json: unknown }>> {
  const url = new URL(`${config.baseUrl.replace(/\/+$/, "")}${path}`);
  const hasBody = options.body !== undefined;
  const init: RequestInit = {
    method: options.method ?? "POST",
    headers: {
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
    signal: requestSignal(options.timeoutMs ?? HINDSIGHT_PROBE_TIMEOUT_MS, options.signal),
  };
  const transport = hindsightTransport(config, url);
  let response: Response;
  try {
    response = await transport.fetch(url, init);
  } catch {
    await transport.close();
    return { ok: false, error: "Hindsight is unreachable or the request timed out." };
  }
  const signal = init.signal as AbortSignal;
  try {
    try {
      const bytes = await readBodyCapped(response, MAX_HINDSIGHT_RESPONSE_BYTES, signal);
      const text = new TextDecoder().decode(bytes);
      if (!text) return { ok: true, value: { status: response.status, json: null } };
      try {
        return { ok: true, value: { status: response.status, json: JSON.parse(text) } };
      } catch {
        return { ok: true, value: { status: response.status, json: null } };
      }
    } catch {
      return { ok: false, error: "Hindsight returned an unreadable response." };
    }
  } finally {
    await transport.close();
  }
}

function tokenRejected<T>(): HindsightResponse<T> {
  return { ok: false, error: "Hindsight rejected the access token." };
}

/** Proves the URL and token without writing anything. */
export async function listHindsightBanks(
  config: HindsightConnectionConfig,
  signal?: AbortSignal,
): Promise<HindsightResponse<void>> {
  const result = await hindsightRequest(config, "/v1/default/banks?limit=1", {
    method: "GET",
    signal,
  });
  if (!result.ok) return result;
  const { status, json } = result.value;
  if (status >= 200 && status < 300) return { ok: true, value: undefined };
  if (status === 401 || status === 403) return tokenRejected();
  return { ok: false, error: hindsightErrorMessage(json, `Hindsight request failed: ${status}`) };
}

/** Banks auto-create on first write, so retain is also the bank's creation. */
export async function hindsightRetain(
  config: HindsightConnectionConfig,
  bankId: string,
  items: HindsightRetainItem[],
  signal?: AbortSignal,
): Promise<HindsightResponse<void>> {
  const result = await hindsightRequest(config, bankPath(bankId, "/memories"), {
    method: "POST",
    body: { items },
    timeoutMs: HINDSIGHT_RETAIN_TIMEOUT_MS,
    signal,
  });
  if (!result.ok) return result;
  const { status, json } = result.value;
  if (status >= 200 && status < 300) return { ok: true, value: undefined };
  if (status === 401 || status === 403) return tokenRejected();
  return { ok: false, error: hindsightErrorMessage(json, `Hindsight retain failed: ${status}`) };
}

function parseRecallResults(json: unknown): HindsightRecallItem[] {
  if (!json || typeof json !== "object") return [];
  const results = (json as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const parsed: HindsightRecallItem[] = [];
  for (const entry of results) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as {
      id?: unknown;
      text?: unknown;
      type?: unknown;
      scores?: { final?: unknown } | null;
      source_fact_ids?: unknown;
    };
    if (typeof row.id !== "string" || typeof row.text !== "string") continue;
    const final = row.scores?.final;
    parsed.push({
      id: row.id,
      text: row.text,
      ...(typeof row.type === "string" ? { type: row.type } : {}),
      score: typeof final === "number" && Number.isFinite(final) ? final : 1,
      sourceFactIds: Array.isArray(row.source_fact_ids)
        ? row.source_fact_ids.filter(isHindsightMemoryId)
        : [],
    });
  }
  return parsed;
}

/** Recall of a bank that was never written returns 404; that is an empty memory, not an error. */
export async function hindsightRecall(
  config: HindsightConnectionConfig,
  bankId: string,
  query: string,
  signal?: AbortSignal,
): Promise<HindsightResponse<HindsightRecallItem[]>> {
  const result = await hindsightRequest(config, bankPath(bankId, "/memories/recall"), {
    method: "POST",
    body: { query },
    timeoutMs: HINDSIGHT_RECALL_TIMEOUT_MS,
    signal,
  });
  if (!result.ok) return result;
  const { status, json } = result.value;
  if (status === 404) return { ok: true, value: [] };
  if (!(status >= 200 && status < 300)) {
    if (status === 401 || status === 403) return tokenRejected();
    return { ok: false, error: hindsightErrorMessage(json, `Hindsight recall failed: ${status}`) };
  }
  return { ok: true, value: parseRecallResults(json) };
}

function parseMemoryUnit(json: unknown): HindsightMemoryUnit {
  if (!json || typeof json !== "object") return { sourceFactIds: [] };
  const row = json as {
    id?: unknown;
    text?: unknown;
    type?: unknown;
    state?: unknown;
    source_fact_ids?: unknown;
  };
  return {
    ...(typeof row.id === "string" ? { id: row.id } : {}),
    ...(typeof row.text === "string" ? { text: row.text } : {}),
    ...(typeof row.type === "string" ? { type: row.type } : {}),
    ...(typeof row.state === "string" ? { state: row.state } : {}),
    sourceFactIds: Array.isArray(row.source_fact_ids)
      ? row.source_fact_ids.filter(isHindsightMemoryId)
      : [],
  };
}

export async function getHindsightMemory(
  config: HindsightConnectionConfig,
  bankId: string,
  memoryId: string,
  signal?: AbortSignal,
): Promise<HindsightResponse<HindsightMemoryUnit | null>> {
  if (!isHindsightMemoryId(memoryId)) {
    return { ok: false, error: "Invalid Hindsight memory id." };
  }
  const result = await hindsightRequest(
    config,
    bankPath(bankId, `/memories/${encodeURIComponent(memoryId)}`),
    { method: "GET", timeoutMs: HINDSIGHT_CURATE_TIMEOUT_MS, signal },
  );
  if (!result.ok) return result;
  const { status, json } = result.value;
  if (status === 404) return { ok: true, value: null };
  if (!(status >= 200 && status < 300)) {
    if (status === 401 || status === 403) return tokenRejected();
    return { ok: false, error: hindsightErrorMessage(json, `Hindsight request failed: ${status}`) };
  }
  return { ok: true, value: parseMemoryUnit(json) };
}

/** Invalidate is Hindsight's reversible forget: the fact leaves recall and consolidation. */
export async function invalidateHindsightMemory(
  config: HindsightConnectionConfig,
  bankId: string,
  memoryId: string,
  reason?: string,
  signal?: AbortSignal,
): Promise<HindsightResponse<void>> {
  if (!isHindsightMemoryId(memoryId)) {
    return { ok: false, error: "Invalid Hindsight memory id." };
  }
  const result = await hindsightRequest(
    config,
    bankPath(bankId, `/memories/${encodeURIComponent(memoryId)}`),
    {
      method: "PATCH",
      body: { state: "invalidated", ...(reason ? { reason } : {}) },
      timeoutMs: HINDSIGHT_CURATE_TIMEOUT_MS,
      signal,
    },
  );
  if (!result.ok) return result;
  const { status, json } = result.value;
  if (status >= 200 && status < 300) return { ok: true, value: undefined };
  if (status === 401 || status === 403) return tokenRejected();
  return {
    ok: false,
    error: hindsightErrorMessage(json, `Hindsight forget failed: ${status}`),
    status,
  };
}

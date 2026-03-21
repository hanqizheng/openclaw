import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from "undici";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const CACHE_NAMESPACE = "grounded-search-cache";
const BUDGET_FILE = "grounded-search-budget.json";
const DEFAULT_SEARCH_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_DAILY_LIMIT = 300;
const DEFAULT_CACHE_TTL_MINUTES = 720;
const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_MAX_CITATIONS = 8;
const MAX_CITATIONS = 10;
const MAX_HISTORY_DAYS = 35;

type GroundedSearchConfig = {
  workspaceDir: string;
  stateDir: string;
  apiKeyEnv: string;
  model: string;
  dailyLimit: number;
  cacheTtlMinutes: number;
  timezone: string;
  proxyUrl?: string;
};

type GroundedCitation = {
  url: string;
  title?: string;
};

type CachedSearchPayload = {
  query: string;
  model: string;
  createdAt: string;
  expiresAt: string;
  content: string;
  citations: GroundedCitation[];
};

type BudgetState = {
  days?: Record<
    string,
    {
      requests?: number;
      lastRequestAt?: string;
    }
  >;
};

type GeminiGroundingResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
    groundingMetadata?: {
      groundingChunks?: Array<{
        web?: {
          uri?: string;
          title?: string;
        };
      }>;
    };
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

export function createGroundedSearchDefaults() {
  return {
    searchApiKeyEnv: "GEMINI_API_KEY",
    searchModel: DEFAULT_SEARCH_MODEL,
    searchDailyLimit: DEFAULT_DAILY_LIMIT,
    searchCacheTtlMinutes: DEFAULT_CACHE_TTL_MINUTES,
    searchTimezone: DEFAULT_TIMEZONE,
    searchProxyUrl: undefined,
  };
}

export async function getGroundedSearchBudgetStatus(
  rawConfig: GroundedSearchConfig,
): Promise<Record<string, unknown>> {
  const config = normalizeGroundedSearchConfig(rawConfig);
  const paths = await ensureSearchPaths(config.workspaceDir, config.stateDir);
  const budgetState = await readBudgetState(paths.budgetFilePath);
  const dayKey = getDayKey(new Date(), config.timezone);
  const used = readUsedRequests(budgetState, dayKey);
  return buildBudgetStatus(config, dayKey, used);
}

export async function runBudgetedGroundedSearch(params: {
  config: GroundedSearchConfig;
  query: string;
  forceRefresh?: boolean;
  maxCitations?: number;
}): Promise<Record<string, unknown>> {
  const query = normalizeQuery(params.query);
  if (!query) {
    throw new Error("query is required");
  }

  const config = normalizeGroundedSearchConfig(params.config);
  const apiKey = readSecretEnv(config.apiKeyEnv);
  if (!apiKey) {
    return {
      ok: false,
      error: "missing_gemini_api_key",
      message: `Missing env var ${config.apiKeyEnv}.`,
      budget: await getGroundedSearchBudgetStatus(config),
    };
  }

  if (usesVariableSearchBilling(config.model)) {
    return {
      ok: false,
      error: "unsupported_search_billing_model",
      message:
        "Budgeted AIAIG search only supports Gemini 2.5 grounding models. Keep searchModel on gemini-2.5-flash or gemini-2.5-flash-lite so each request maps cleanly to one grounded prompt budget slot.",
      budget: await getGroundedSearchBudgetStatus(config),
      model: config.model,
    };
  }

  const paths = await ensureSearchPaths(config.workspaceDir, config.stateDir);
  const cacheKey = buildCacheKey(query, config.model);
  const maxCitations = normalizeMaxCitations(params.maxCitations);
  if (params.forceRefresh !== true) {
    const cached = await readCachedSearch(paths.cacheDir, cacheKey);
    if (cached) {
      return {
        ok: true,
        cached: true,
        query,
        model: config.model,
        budget: await getGroundedSearchBudgetStatus(config),
        content: cached.content,
        citations: cached.citations.slice(0, maxCitations),
        cache: {
          key: cacheKey,
          createdAt: cached.createdAt,
          expiresAt: cached.expiresAt,
          ttlMinutes: config.cacheTtlMinutes,
        },
      };
    }
  }

  const reservation = await reserveBudgetSlot(paths.budgetFilePath, config);
  if (!reservation.ok) {
    return {
      ok: false,
      error: "search_budget_exhausted",
      message:
        "The AIAIG grounded-search daily budget is exhausted. Stop discovery for today or raise searchDailyLimit intentionally.",
      budget: reservation.budget,
      model: config.model,
    };
  }

  try {
    const result = await runGeminiGroundedSearch({
      apiKey,
      query,
      model: config.model,
      proxyUrl: config.proxyUrl,
    });
    const payload: CachedSearchPayload = {
      query,
      model: config.model,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + config.cacheTtlMinutes * 60_000).toISOString(),
      content: result.content,
      citations: result.citations,
    };
    await writeCachedSearch(paths.cacheDir, cacheKey, payload);

    return {
      ok: true,
      cached: false,
      query,
      model: config.model,
      budget: reservation.budget,
      content: payload.content,
      citations: payload.citations.slice(0, maxCitations),
      cache: {
        key: cacheKey,
        createdAt: payload.createdAt,
        expiresAt: payload.expiresAt,
        ttlMinutes: config.cacheTtlMinutes,
      },
    };
  } catch (error) {
    const detail = sanitizeError(error);
    return {
      ok: false,
      error: "gemini_grounded_search_failed",
      message:
        "Gemini grounded search failed after consuming one reserved budget slot. The slot stays consumed to preserve the hard daily cap.",
      detail,
      budget: reservation.budget,
      model: config.model,
    };
  }
}

function normalizeGroundedSearchConfig(config: GroundedSearchConfig): GroundedSearchConfig {
  return {
    workspaceDir: config.workspaceDir,
    stateDir: config.stateDir,
    apiKeyEnv: config.apiKeyEnv.trim() || createGroundedSearchDefaults().searchApiKeyEnv,
    model: config.model.trim() || createGroundedSearchDefaults().searchModel,
    dailyLimit: normalizePositiveInteger(
      config.dailyLimit,
      createGroundedSearchDefaults().searchDailyLimit,
    ),
    cacheTtlMinutes: normalizePositiveInteger(
      config.cacheTtlMinutes,
      createGroundedSearchDefaults().searchCacheTtlMinutes,
    ),
    timezone: normalizeTimeZone(config.timezone),
    proxyUrl: readOptionalString(config.proxyUrl),
  };
}

function normalizeQuery(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeMaxCitations(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_CITATIONS;
  }
  return Math.max(1, Math.min(MAX_CITATIONS, Math.floor(value)));
}

function normalizePositiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeTimeZone(value: string): string {
  const fallback = createGroundedSearchDefaults().searchTimezone;
  const timeZone = value.trim() || fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return fallback;
  }
}

function usesVariableSearchBilling(model: string): boolean {
  return model.toLowerCase().startsWith("gemini-3");
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readSecretEnv(envVar: string): string | undefined {
  const value = process.env[envVar];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

async function ensureSearchPaths(workspaceDir: string, stateDir: string) {
  const rootDir = path.resolve(workspaceDir, stateDir);
  const cacheDir = path.join(rootDir, CACHE_NAMESPACE);
  await fs.mkdir(cacheDir, { recursive: true });
  return {
    rootDir,
    cacheDir,
    budgetFilePath: path.join(rootDir, BUDGET_FILE),
  };
}

function buildCacheKey(query: string, model: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(model);
  hash.update("\n");
  hash.update(query);
  return hash.digest("hex");
}

async function readCachedSearch(
  cacheDir: string,
  cacheKey: string,
): Promise<CachedSearchPayload | undefined> {
  const cachePath = path.join(cacheDir, `${cacheKey}.json`);
  try {
    const raw = JSON.parse(await fs.readFile(cachePath, "utf8")) as CachedSearchPayload;
    if (Date.now() > Date.parse(raw.expiresAt)) {
      await fs.rm(cachePath, { force: true });
      return undefined;
    }
    return raw;
  } catch {
    return undefined;
  }
}

async function writeCachedSearch(
  cacheDir: string,
  cacheKey: string,
  payload: CachedSearchPayload,
): Promise<void> {
  const cachePath = path.join(cacheDir, `${cacheKey}.json`);
  await fs.writeFile(cachePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function readBudgetState(filePath: string): Promise<BudgetState> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as BudgetState;
  } catch {
    return {};
  }
}

function readUsedRequests(state: BudgetState, dayKey: string): number {
  const entry = state.days?.[dayKey];
  return Number.isInteger(entry?.requests) && entry.requests! > 0 ? entry.requests! : 0;
}

async function reserveBudgetSlot(
  filePath: string,
  config: GroundedSearchConfig,
): Promise<
  { ok: true; budget: Record<string, unknown> } | { ok: false; budget: Record<string, unknown> }
> {
  const dayKey = getDayKey(new Date(), config.timezone);
  const state = pruneBudgetState(await readBudgetState(filePath), dayKey);
  const used = readUsedRequests(state, dayKey);
  if (used >= config.dailyLimit) {
    return {
      ok: false,
      budget: buildBudgetStatus(config, dayKey, used),
    };
  }

  const nextUsed = used + 1;
  state.days ??= {};
  state.days[dayKey] = {
    requests: nextUsed,
    lastRequestAt: new Date().toISOString(),
  };
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return {
    ok: true,
    budget: buildBudgetStatus(config, dayKey, nextUsed),
  };
}

function pruneBudgetState(state: BudgetState, currentDayKey: string): BudgetState {
  const days = Object.entries(state.days ?? {}).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  const keepKeys = new Set(
    days
      .map(([dayKey]) => dayKey)
      .filter((dayKey) => dayKey <= currentDayKey)
      .slice(-MAX_HISTORY_DAYS),
  );
  return {
    days: Object.fromEntries(days.filter(([dayKey]) => keepKeys.has(dayKey))),
  };
}

function buildBudgetStatus(
  config: GroundedSearchConfig,
  dayKey: string,
  used: number,
): Record<string, unknown> {
  const remaining = Math.max(0, config.dailyLimit - used);
  return {
    timezone: config.timezone,
    dayKey,
    limit: config.dailyLimit,
    used,
    remaining,
    blocked: remaining === 0,
    resetsAtLocal: `${incrementDayKey(dayKey)} 00:00 ${config.timezone}`,
  };
}

function getDayKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "00";
  const day = parts.find((part) => part.type === "day")?.value ?? "00";
  return `${year}-${month}-${day}`;
}

function incrementDayKey(dayKey: string): string {
  const date = new Date(`${dayKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

async function runGeminiGroundedSearch(params: {
  apiKey: string;
  query: string;
  model: string;
  proxyUrl?: string;
}): Promise<{ content: string; citations: GroundedCitation[] }> {
  const endpoint = `${GEMINI_API_BASE}/models/${params.model}:generateContent`;
  const fetchImpl = resolveHttpFetch(params.proxyUrl);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": params.apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: params.query }] }],
      tools: [{ google_search: {} }],
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Gemini API error (${response.status}): ${sanitizeError(await response.text())}`,
    );
  }

  let data: GeminiGroundingResponse;
  try {
    data = (await response.json()) as GeminiGroundingResponse;
  } catch (error) {
    throw new Error(`Gemini API returned invalid JSON: ${sanitizeError(error)}`, { cause: error });
  }

  if (data.error) {
    throw new Error(
      `Gemini API error (${String(data.error.code ?? "unknown")}): ${sanitizeError(data.error.message ?? data.error.status ?? "unknown")}`,
    );
  }

  const candidate = data.candidates?.[0];
  const content =
    candidate?.content?.parts
      ?.map((part) => part.text)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("\n") ?? "";

  const citations = await resolveCitations(
    candidate?.groundingMetadata?.groundingChunks ?? [],
    params.proxyUrl,
  );
  return {
    content: content || "No grounded answer returned.",
    citations,
  };
}

async function resolveCitations(
  chunks: Array<{
    web?: {
      uri?: string;
      title?: string;
    };
  }>,
  proxyUrl?: string,
): Promise<GroundedCitation[]> {
  const fetchImpl = resolveHttpFetch(proxyUrl);
  const rawCitations = chunks
    .filter((chunk) => typeof chunk.web?.uri === "string" && chunk.web.uri.length > 0)
    .map((chunk) => ({
      url: chunk.web!.uri!,
      title:
        typeof chunk.web?.title === "string" && chunk.web.title.length > 0
          ? chunk.web.title
          : undefined,
    }));

  const deduped = new Map<string, GroundedCitation>();
  for (let index = 0; index < rawCitations.length; index += 10) {
    const batch = rawCitations.slice(index, index + 10);
    const resolved = await Promise.all(
      batch.map(async (citation) => ({
        ...citation,
        url: await resolveCitationUrl(citation.url, fetchImpl),
      })),
    );
    for (const citation of resolved) {
      if (!deduped.has(citation.url)) {
        deduped.set(citation.url, citation);
      }
    }
  }
  return [...deduped.values()];
}

function sanitizeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/key=[^&\s]+/gi, "key=***");
}

function resolveHttpFetch(proxyUrl?: string): typeof fetch {
  const explicitProxy = readOptionalString(proxyUrl);
  if (explicitProxy) {
    return makeProxyFetch(explicitProxy);
  }
  const envProxyFetch = resolveProxyFetchFromEnv();
  return envProxyFetch ?? fetch;
}

const proxyFetchCache = new Map<string, typeof fetch>();

function makeProxyFetch(proxyUrl: string): typeof fetch {
  const cached = proxyFetchCache.get(proxyUrl);
  if (cached) {
    return cached;
  }
  const agent = new ProxyAgent(proxyUrl);
  const proxyFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as string | URL, {
      ...(init as Record<string, unknown>),
      dispatcher: agent,
    }) as unknown as Promise<Response>) as typeof fetch;
  proxyFetchCache.set(proxyUrl, proxyFetch);
  return proxyFetch;
}

function resolveProxyFetchFromEnv(): typeof fetch | undefined {
  try {
    const agent = new EnvHttpProxyAgent();
    return ((input: RequestInfo | URL, init?: RequestInit) =>
      undiciFetch(input as string | URL, {
        ...(init as Record<string, unknown>),
        dispatcher: agent,
      }) as unknown as Promise<Response>) as typeof fetch;
  } catch {
    return undefined;
  }
}

async function resolveCitationUrl(url: string, fetchImpl: typeof fetch): Promise<string> {
  try {
    const response = await fetchImpl(url, {
      method: "HEAD",
      redirect: "follow",
    });
    return typeof response.url === "string" && response.url.length > 0 ? response.url : url;
  } catch {
    return url;
  }
}

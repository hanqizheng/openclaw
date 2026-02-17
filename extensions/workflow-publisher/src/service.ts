import { setTimeout as sleep } from "node:timers/promises";
import type {
  PublishMode,
  PublishResult,
  WorkflowArticlePayload,
  WorkflowCandidate,
  WorkflowCandidateStatus,
} from "./types.js";
import {
  createFingerprint,
  createId,
  createIdempotencyKey,
  createNonce,
  isAllowedDomain,
  normalizePayload,
  slugify,
} from "./article.js";
import {
  resolveWorkflowConfig,
  resolveCategoryId,
  resolveSourceProfile,
  type WorkflowConfig,
} from "./config.js";
import { WorkflowStore } from "./db.js";

const SEARCH_CACHE_DELAY_MS = 120;

function stripExternalWrapper(input: string): string {
  const withoutMarkers = input
    .replaceAll("<<<EXTERNAL_UNTRUSTED_CONTENT>>>", "")
    .replaceAll("<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>", "")
    .replace(/SECURITY NOTICE:[\s\S]*?Send messages to third parties\s*/g, "")
    .trim();
  return withoutMarkers;
}

function summarizeText(params: {
  title: string;
  description: string;
  fetchedText: string;
  url: string;
}): string {
  const stripped = stripExternalWrapper(params.fetchedText);
  const lines = stripped
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  const summaryLines = lines.slice(0, 4);
  const leading = params.description.trim() ? `${params.description.trim()}\n\n` : "";
  const body = summaryLines.join("\n");
  const sourceLine = `\n\n来源: ${params.url}`;
  return `${leading}${body}${sourceLine}`.trim();
}

function buildQueries(params: {
  topic: string;
  profileQueries: string[];
  domains: string[];
}): string[] {
  const topic = params.topic.trim();
  const byTemplate = params.profileQueries
    .map((query) => query.replaceAll("{topic}", topic).trim())
    .filter(Boolean);
  if (byTemplate.length > 0) {
    return byTemplate;
  }
  return params.domains.map((domain) => `${topic} site:${domain}`).filter(Boolean);
}

function topicSlug(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildSeedUrls(params: {
  topic: string;
  domains: string[];
  profileQueries: string[];
}): string[] {
  const urls = new Set<string>();
  const slug = topicSlug(params.topic);
  for (const domain of params.domains) {
    const base = `https://${domain}`;
    urls.add(base);
    urls.add(`${base}/news`);
    urls.add(`${base}/announcements`);
    urls.add(`${base}/consular`);
    if (slug) {
      urls.add(`${base}/${slug}`);
      urls.add(`${base}/news/${slug}`);
    }
  }
  for (const query of params.profileQueries) {
    const trimmed = query.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      urls.add(trimmed);
    }
  }
  return [...urls];
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
}

function htmlToText(html: string): string {
  const noScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  return noScript
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function fetchReadableText(params: { url: string; maxChars: number }): Promise<string> {
  const response = await fetchWithTimeout(
    params.url,
    {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    },
    25_000,
  );
  if (!response.ok) {
    return "";
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const raw = await response.text();
  const text = contentType.includes("text/html") ? htmlToText(raw) : raw.trim();
  if (!text) {
    return "";
  }
  return text.slice(0, params.maxChars);
}

function decodeJsonResponse(responseText: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(responseText) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export type WorkflowPluginRuntimeLike = {
  state: {
    resolveStateDir: () => string;
  };
};

export type CollectParams = {
  topic: string;
  profile?: string;
  limit?: number;
  actor: string;
};

export type CollectResult = {
  topic: string;
  profile: string;
  added: number;
  skippedByDedupe: number;
  candidates: WorkflowCandidate[];
};

export type PrepareResult = {
  ok: boolean;
  reason?: string;
  candidate?: WorkflowCandidate;
  nonce?: string;
  expiresAt?: number;
};

export type ConfirmResult = {
  ok: boolean;
  reason?: string;
  candidate?: WorkflowCandidate;
  publishResult?: PublishResult;
  cached?: boolean;
};

export class WorkflowService {
  readonly config: WorkflowConfig;
  readonly store: WorkflowStore;

  constructor(params: { pluginConfig: unknown; runtime: WorkflowPluginRuntimeLike }) {
    this.config = resolveWorkflowConfig({
      pluginConfig: params.pluginConfig,
      stateDir: params.runtime.state.resolveStateDir(),
    });
    this.store = new WorkflowStore(this.config.sqlitePath);
  }

  close(): void {
    this.store.close();
  }

  listCandidates(params: {
    topic?: string;
    status?: WorkflowCandidateStatus;
    limit?: number;
  }): WorkflowCandidate[] {
    return this.store.listCandidates({
      topic: params.topic,
      status: params.status,
      limit: params.limit,
    });
  }

  async collect(params: CollectParams): Promise<CollectResult> {
    const topic = params.topic.trim();
    if (!topic) {
      throw new Error("topic required");
    }

    const profile = resolveSourceProfile(params.profile, this.config);
    const requestedLimit = Math.max(
      1,
      Math.min(this.config.maxCandidatesPerRun, params.limit ?? this.config.maxCandidatesPerRun),
    );
    const queryUrls = buildQueries({
      topic,
      profileQueries: profile.queries,
      domains: profile.domains,
    })
      .filter((entry) => /^https?:\/\//i.test(entry))
      .slice(0, this.config.maxSearchQueries);
    const seedUrls = buildSeedUrls({
      topic,
      domains: profile.domains,
      profileQueries: queryUrls,
    });
    const hits = seedUrls
      .filter((url) => isAllowedDomain(url, profile.domains))
      .slice(0, Math.max(requestedLimit * 3, 12))
      .map((url) => ({
        title: `Embassy Update - ${hostFromUrl(url)}`,
        url,
        description: "allowlist domain crawl",
      }));

    let added = 0;
    let skippedByDedupe = 0;
    const candidates: WorkflowCandidate[] = [];

    for (const hit of hits) {
      if (candidates.length >= requestedLimit) {
        break;
      }
      const fingerprint = createFingerprint(hit.title, hit.url);
      const cutoffMs = Date.now() - this.config.dedupeWindowDays * 24 * 60 * 60 * 1000;
      if (this.store.isFingerprintSeenWithinWindow(fingerprint, cutoffMs)) {
        skippedByDedupe += 1;
        continue;
      }

      let fetchedText = "";
      try {
        fetchedText = await fetchReadableText({
          url: hit.url,
          maxChars: this.config.fetchMaxChars,
        });
      } catch {
        fetchedText = "";
      }
      if (!fetchedText) {
        await sleep(SEARCH_CACHE_DELAY_MS);
        continue;
      }
      const summaryMd = summarizeText({
        title: hit.title,
        description: hit.description,
        fetchedText,
        url: hit.url,
      });

      const categoryId = resolveCategoryId(topic, this.config);
      const payload = normalizePayload({
        raw: {
          title: hit.title,
          slug: slugify(hit.title),
          excerpt: summaryMd.slice(0, 260),
          categoryId,
          isPublished: this.config.defaultIsPublished,
          dataSource: this.config.defaultDataSource,
        },
        fallbackTitle: hit.title,
        fallbackCategoryId: categoryId,
        defaultIsPublished: this.config.defaultIsPublished,
        defaultDataSource: this.config.defaultDataSource,
        sourceUrl: hit.url,
        summaryMd,
      });

      const now = Date.now();
      const candidate: WorkflowCandidate = {
        id: createId(),
        topic,
        title: payload.title,
        url: hit.url,
        domain: (() => {
          try {
            return new URL(hit.url).hostname.toLowerCase();
          } catch {
            return "";
          }
        })(),
        summaryMd,
        payload,
        sourceProfile: profile.name,
        score: 0,
        status: "candidate",
        fingerprint,
        createdAt: now,
        updatedAt: now,
      };

      this.store.upsertCandidate(candidate);
      this.store.touchFingerprint(fingerprint, candidate.id, now);
      this.store.recordAudit({
        actor: params.actor,
        action: "candidate.create",
        objectId: candidate.id,
        meta: {
          topic,
          profile: profile.name,
          url: candidate.url,
        },
        createdAt: now,
      });

      candidates.push(candidate);
      added += 1;
      await sleep(SEARCH_CACHE_DELAY_MS);
    }

    return {
      topic,
      profile: profile.name,
      added,
      skippedByDedupe,
      candidates,
    };
  }

  preparePublish(params: { candidateId: string; actor: string }): PrepareResult {
    const candidate = this.store.getCandidate(params.candidateId);
    if (!candidate) {
      return { ok: false, reason: "candidate_not_found" };
    }
    if (candidate.status !== "candidate") {
      return { ok: false, reason: "candidate_not_pending" };
    }

    const nonce = createNonce();
    const now = Date.now();
    const expiresAt = now + this.config.pendingTtlMinutes * 60 * 1000;
    this.store.createCallbackToken(candidate.id, nonce, expiresAt, now);
    this.store.recordAudit({
      actor: params.actor,
      action: "publish.prepare",
      objectId: candidate.id,
      meta: { expiresAt },
      createdAt: now,
    });

    return {
      ok: true,
      candidate,
      nonce,
      expiresAt,
    };
  }

  async confirmPublish(params: {
    candidateId: string;
    nonce: string;
    mode: PublishMode;
    actor: string;
  }): Promise<ConfirmResult> {
    const candidate = this.store.getCandidate(params.candidateId);
    if (!candidate) {
      return { ok: false, reason: "candidate_not_found" };
    }

    const token = this.store.consumeCallbackToken(candidate.id, params.nonce, Date.now());
    if (!token.ok) {
      return { ok: false, reason: `token_${token.reason}` };
    }

    const payload: WorkflowArticlePayload = {
      ...candidate.payload,
      isPublished: params.mode === "publish",
      slug: candidate.payload.slug || slugify(candidate.payload.title),
    };

    const idempotencyKey = createIdempotencyKey({
      candidateId: candidate.id,
      mode: params.mode,
      payload,
    });

    const cached = this.store.getRecentSuccessfulAttemptByIdempotency(idempotencyKey);
    if (cached) {
      return {
        ok: true,
        candidate,
        cached: true,
        publishResult: {
          ok: true,
          status: cached.statusCode,
          mode: params.mode,
          idempotencyKey,
          responseText: cached.responseJson,
          responseJson: decodeJsonResponse(cached.responseJson),
        },
      };
    }

    const publishResult = await this.importArticle({
      candidateId: candidate.id,
      payload,
      mode: params.mode,
      actor: params.actor,
      idempotencyKey,
    });

    if (!publishResult.ok) {
      return { ok: false, reason: "publish_failed", candidate, publishResult };
    }

    const now = Date.now();
    this.store.updateCandidateStatus(candidate.id, "published", now);
    this.store.recordAudit({
      actor: params.actor,
      action: "publish.confirm",
      objectId: candidate.id,
      meta: {
        mode: params.mode,
        idempotencyKey,
        status: publishResult.status,
      },
      createdAt: now,
    });

    return {
      ok: true,
      candidate,
      publishResult,
    };
  }

  cancelCandidate(params: { candidateId: string; actor: string }): {
    ok: boolean;
    reason?: string;
  } {
    const candidate = this.store.getCandidate(params.candidateId);
    if (!candidate) {
      return { ok: false, reason: "candidate_not_found" };
    }
    const now = Date.now();
    this.store.updateCandidateStatus(candidate.id, "discarded", now);
    this.store.recordAudit({
      actor: params.actor,
      action: "candidate.discard",
      objectId: candidate.id,
      meta: {},
      createdAt: now,
    });
    return { ok: true };
  }

  async importArticle(params: {
    candidateId: string;
    payload: WorkflowArticlePayload;
    mode: PublishMode;
    actor: string;
    idempotencyKey?: string;
  }): Promise<PublishResult> {
    const idempotencyKey =
      params.idempotencyKey ??
      createIdempotencyKey({
        candidateId: params.candidateId,
        mode: params.mode,
        payload: params.payload,
      });

    const token = process.env[this.config.publishApiTokenEnv];
    if (!token) {
      const responseText = `missing env: ${this.config.publishApiTokenEnv}`;
      this.store.recordPublishAttempt({
        idempotencyKey,
        candidateId: params.candidateId,
        mode: params.mode,
        requestedBy: params.actor,
        requestJson: JSON.stringify(params.payload),
        responseJson: responseText,
        statusCode: 500,
        resultStatus: "failed",
        createdAt: Date.now(),
      });
      return {
        ok: false,
        status: 500,
        mode: params.mode,
        idempotencyKey,
        responseText,
      };
    }

    const endpoint = new URL(
      this.config.publishApiImportPath,
      this.config.publishApiBaseUrl,
    ).toString();

    let response: Response;
    try {
      response = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(params.payload),
        },
        this.config.publishApiTimeoutMs,
      );
    } catch (error) {
      const responseText = `request failed: ${String(error)}`;
      this.store.recordPublishAttempt({
        idempotencyKey,
        candidateId: params.candidateId,
        mode: params.mode,
        requestedBy: params.actor,
        requestJson: JSON.stringify(params.payload),
        responseJson: responseText,
        statusCode: 500,
        resultStatus: "failed",
        createdAt: Date.now(),
      });
      return {
        ok: false,
        status: 500,
        mode: params.mode,
        idempotencyKey,
        responseText,
      };
    }

    const responseText = await response.text();
    const responseJson = decodeJsonResponse(responseText);

    const result: PublishResult = {
      ok: response.ok,
      status: response.status,
      mode: params.mode,
      idempotencyKey,
      responseText,
      responseJson,
    };

    this.store.recordPublishAttempt({
      idempotencyKey,
      candidateId: params.candidateId,
      mode: params.mode,
      requestedBy: params.actor,
      requestJson: JSON.stringify(params.payload),
      responseJson: responseText,
      statusCode: response.status,
      resultStatus: response.ok ? "success" : "failed",
      createdAt: Date.now(),
    });

    return result;
  }
}

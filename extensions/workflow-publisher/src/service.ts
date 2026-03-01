import { setTimeout as sleep } from "node:timers/promises";
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
import {
  SEARCH_CACHE_DELAY_MS,
  createAutoTitleSentinel,
  isAutoTitleSentinel,
  isTemplateTitle,
  summarizeText,
  buildQueries,
  normalizeDiscoveryResponse,
  buildSeedUrls,
  shouldRejectUrlByPath,
  isValidSourceContent,
  fetchReadableText,
} from "./discovery.js";
import { buildUniqueRetrySlug, isSlugConflict } from "./publishing.js";
import {
  type TranslationStage,
  type TranslationFailure,
  type BuildBilingualPayloadOptions,
  TranslationPipelineError,
  toTranslationFailure,
  normalizeTranslationApiResponse,
  resolveTranslationFallbackEndpoint,
  buildTranslationFallbackPrompt,
  clonePayload,
  applySecondaryLanguageVariant,
  parseBilingualResponse,
  hasLanguageVariant,
  validateGeneratedPayload,
  DEFAULT_TRANSLATION_FALLBACK_TIMEOUT_MS,
} from "./translation.js";
import type {
  PublishMode,
  PublishResult,
  WorkflowArticlePayload,
  WorkflowCandidate,
  WorkflowCandidateStatus,
} from "./types.js";
import { hostFromUrl, normalizeHttpUrl, decodeJsonResponse, fetchWithTimeout } from "./utils.js";

export type { TranslationFailure };

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
  skippedByFetch: number;
  skippedByDiscovery: number;
  skippedByQuality: number;
  skippedByTranslation: number;
  discoveryMode: "api" | "seed-fallback" | "seed-only";
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
  reasonDetail?: string;
  candidate?: WorkflowCandidate;
  translationFailure?: TranslationFailure;
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

  private async requestFallbackBilingualFromLLM(params: {
    token: string;
    requestPayload: Record<string, unknown>;
    stage: TranslationStage;
  }): Promise<Record<string, unknown>> {
    const endpoint = resolveTranslationFallbackEndpoint();
    const prompt = buildTranslationFallbackPrompt({ requestPayload: params.requestPayload });
    const timeoutMs = Math.max(
      this.config.translationTimeoutMs,
      DEFAULT_TRANSLATION_FALLBACK_TIMEOUT_MS,
    );

    let response: Response;
    try {
      response = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${params.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.config.translationModel,
            temperature: 0.2,
            messages: [
              { role: "system", content: prompt.system },
              { role: "user", content: prompt.user },
            ],
          }),
        },
        timeoutMs,
      );
    } catch (error) {
      throw new TranslationPipelineError({
        code: "translation_request_failed",
        message: `fallback translation request failed: ${String(error)}`,
        stage: params.stage,
        endpoint,
      });
    }

    const rawText = await response.text();
    if (!response.ok) {
      throw new TranslationPipelineError({
        code: "translation_http_error",
        message: `fallback translation endpoint returned ${response.status}: ${rawText || "empty response"}`,
        stage: params.stage,
        endpoint,
        status: response.status,
      });
    }

    const parsed = decodeJsonResponse(rawText);
    const normalized = parsed ? normalizeTranslationApiResponse(parsed) : undefined;
    if (!normalized) {
      throw new TranslationPipelineError({
        code: "translation_response_invalid",
        message: "fallback translation endpoint returned a non-JSON object payload",
        stage: params.stage,
        endpoint,
      });
    }
    return normalized;
  }

  async buildBilingualPayload(
    payload: WorkflowArticlePayload,
    options: BuildBilingualPayloadOptions = {},
  ): Promise<WorkflowArticlePayload> {
    const stage = options.stage ?? "confirm";
    const strict = options.strict ?? true;
    const base = clonePayload(payload);
    const fallbackPayload = applySecondaryLanguageVariant({
      primary: base,
      secondary: base,
      secondaryLanguage: "en",
    });

    if (!this.config.translationEnabled) {
      return fallbackPayload;
    }

    // Already bilingual and non-template payload; avoid unnecessary drift.
    if (
      hasLanguageVariant(base, "en") &&
      !isTemplateTitle(base.title) &&
      !isAutoTitleSentinel(base.title)
    ) {
      return base;
    }

    // Some deployments only provision import token env; allow translation to reuse it.
    const token =
      process.env[this.config.translationApiTokenEnv] ??
      process.env[this.config.publishApiTokenEnv];
    const endpoint = new URL(
      this.config.translationApiPath,
      this.config.translationApiBaseUrl,
    ).toString();
    if (!token) {
      if (strict) {
        throw new TranslationPipelineError({
          code: "translation_token_missing",
          message: `missing env: ${this.config.translationApiTokenEnv} (or ${this.config.publishApiTokenEnv})`,
          stage,
          endpoint,
        });
      }
      return fallbackPayload;
    }

    const requestPayload = {
      task: "workflow-publisher:bilingual",
      model: this.config.translationModel,
      primaryLanguage: "zh",
      secondaryLanguage: "en",
      requirements: {
        rewriteTitle: true,
        titleLanguage: "zh",
        generateSlug: true,
        slugLanguage: "en",
        titleSource: "source-content",
        requireFreshTitle: true,
      },
      source: options.sourceContext
        ? {
            topic: options.sourceContext.topic,
            url: options.sourceContext.url,
            summary: options.sourceContext.summaryMd,
            text: options.sourceContext.fetchedText,
            title: options.sourceContext.sourceTitle,
            language: options.sourceContext.sourceLanguage,
            publishedAt: options.sourceContext.sourcePublishedAt,
            contentChars: options.sourceContext.sourceContentChars,
            query: options.sourceContext.discoveryQuery,
          }
        : undefined,
      article: {
        title: base.title,
        excerpt: base.excerpt ?? "",
        blocks: base.blocks.map((block) => ({
          type: block.type,
          content: block.content,
          metadata: block.metadata,
          order: block.order,
        })),
      },
    };

    let translatedResponse: Record<string, unknown> | undefined;
    let translationEndpointUsed = endpoint;
    let primaryFailure: TranslationPipelineError | undefined;

    try {
      const response = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestPayload),
        },
        this.config.translationTimeoutMs,
      );
      const rawText = await response.text();
      if (!response.ok) {
        primaryFailure = new TranslationPipelineError({
          code: "translation_http_error",
          message: `translation endpoint returned ${response.status}: ${rawText || "empty response"}`,
          stage,
          endpoint,
          status: response.status,
        });
      } else {
        const parsed = decodeJsonResponse(rawText);
        const normalized = parsed ? normalizeTranslationApiResponse(parsed) : undefined;
        if (!normalized) {
          primaryFailure = new TranslationPipelineError({
            code: "translation_response_invalid",
            message: "translation endpoint returned a non-JSON object payload",
            stage,
            endpoint,
          });
        } else {
          translatedResponse = normalized;
        }
      }
    } catch (error) {
      primaryFailure = new TranslationPipelineError({
        code: "translation_request_failed",
        message: `translation request failed: ${String(error)}`,
        stage,
        endpoint,
      });
    }

    if (!translatedResponse) {
      try {
        translatedResponse = await this.requestFallbackBilingualFromLLM({
          token,
          requestPayload,
          stage,
        });
        translationEndpointUsed = resolveTranslationFallbackEndpoint();
      } catch (fallbackError) {
        if (strict) {
          if (fallbackError instanceof Error) {
            throw fallbackError;
          }
          if (primaryFailure) {
            throw primaryFailure;
          }
          throw new TranslationPipelineError({
            code: "translation_request_failed",
            message: String(fallbackError),
            stage,
            endpoint: translationEndpointUsed,
          });
        }
        return fallbackPayload;
      }
    }

    const translated = parseBilingualResponse({
      response: translatedResponse,
      fallback: base,
    });
    const primarySlugChanged =
      translated.zh.slug.trim().replace(/\s+/g, " ") !== base.slug.trim().replace(/\s+/g, " ");
    const generated = applySecondaryLanguageVariant({
      primary: translated.zh,
      secondary: translated.en,
      secondaryLanguage: "en",
      preservePrimarySlug: primarySlugChanged,
    });

    const validationError = validateGeneratedPayload({
      base,
      generated,
      stage,
      endpoint: translationEndpointUsed,
      sourceUrl: options.sourceContext?.url,
    });
    if (validationError) {
      if (strict) {
        throw validationError;
      }
      return fallbackPayload;
    }

    return generated;
  }

  private async runDiscovery(params: {
    topic: string;
    queries: string[];
    domains: string[];
    requestedLimit: number;
    actor: string;
  }): Promise<{
    uniqueHits: Map<
      string,
      {
        host: string;
        url: string;
        description: string;
        title?: string;
        language?: string;
        publishedAt?: string;
        query?: string;
      }
    >;
    skippedByDiscovery: number;
    discoveryMode: CollectResult["discoveryMode"];
  }> {
    const uniqueHits = new Map<
      string,
      {
        host: string;
        url: string;
        description: string;
        title?: string;
        language?: string;
        publishedAt?: string;
        query?: string;
      }
    >();
    let skippedByDiscovery = 0;
    let discoveryMode: CollectResult["discoveryMode"] = this.config.discoveryEnabled
      ? "api"
      : "seed-only";

    if (!this.config.discoveryEnabled) {
      return { uniqueHits, skippedByDiscovery, discoveryMode };
    }

    const discoveryToken =
      process.env[this.config.discoveryApiTokenEnv] ??
      process.env[this.config.translationApiTokenEnv] ??
      process.env[this.config.publishApiTokenEnv];
    const discoveryEndpoint = new URL(
      this.config.discoveryApiPath,
      this.config.discoveryApiBaseUrl,
    ).toString();

    if (!discoveryToken) {
      skippedByDiscovery += 1;
      discoveryMode = "seed-fallback";
      this.store.recordAudit({
        actor: params.actor,
        action: "candidate.discovery_failed",
        objectId: params.topic,
        meta: {
          endpoint: discoveryEndpoint,
          reason: `missing env: ${this.config.discoveryApiTokenEnv}`,
        },
        createdAt: Date.now(),
      });
      return { uniqueHits, skippedByDiscovery, discoveryMode };
    }

    try {
      const discoveryResponse = await fetchWithTimeout(
        discoveryEndpoint,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${discoveryToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            topic: params.topic,
            queries: params.queries,
            domains: params.domains,
            limit: this.config.discoveryMaxResultsPerQuery,
          }),
        },
        this.config.discoveryApiTimeoutMs,
      );
      const rawText = await discoveryResponse.text();
      if (!discoveryResponse.ok) {
        skippedByDiscovery += 1;
        discoveryMode = "seed-fallback";
        this.store.recordAudit({
          actor: params.actor,
          action: "candidate.discovery_failed",
          objectId: params.topic,
          meta: {
            endpoint: discoveryEndpoint,
            status: discoveryResponse.status,
            response: rawText,
          },
          createdAt: Date.now(),
        });
      } else {
        const parsed = decodeJsonResponse(rawText);
        if (!parsed) {
          skippedByDiscovery += 1;
          discoveryMode = "seed-fallback";
          this.store.recordAudit({
            actor: params.actor,
            action: "candidate.discovery_failed",
            objectId: params.topic,
            meta: {
              endpoint: discoveryEndpoint,
              reason: "non_json_response",
            },
            createdAt: Date.now(),
          });
        } else {
          const hits = normalizeDiscoveryResponse(parsed, params.queries)
            .filter((entry) => isAllowedDomain(entry.url, params.domains))
            .slice(0, Math.max(params.requestedLimit * 4, this.config.maxSearchQueries * 2));
          for (const hit of hits) {
            const url = normalizeHttpUrl(hit.url);
            if (!url) {
              continue;
            }
            uniqueHits.set(url, {
              host: hostFromUrl(url),
              url,
              description: hit.snippet ?? hit.title ?? "discovery search hit",
              title: hit.title,
              language: hit.language,
              publishedAt: hit.publishedAt,
              query: hit.query,
            });
          }
          if (hits.length === 0) {
            discoveryMode = "seed-fallback";
          }
        }
      }
    } catch (error) {
      skippedByDiscovery += 1;
      discoveryMode = "seed-fallback";
      this.store.recordAudit({
        actor: params.actor,
        action: "candidate.discovery_failed",
        objectId: params.topic,
        meta: {
          reason: String(error),
        },
        createdAt: Date.now(),
      });
    }

    return { uniqueHits, skippedByDiscovery, discoveryMode };
  }

  private async processHit(params: {
    hit: {
      host: string;
      url: string;
      description: string;
      title?: string;
      language?: string;
      publishedAt?: string;
      query?: string;
    };
    topic: string;
    profileName: string;
    actor: string;
  }): Promise<
    | { ok: true; candidate: WorkflowCandidate }
    | { ok: false; reason: "dedupe" | "path" | "fetch" | "quality" | "translation" }
  > {
    const { hit, topic, actor } = params;

    // Dedupe should be topic-scoped
    const fingerprint = createFingerprint(`${topic}::${hit.host}`, hit.url);
    const cutoffMs = Date.now() - this.config.dedupeWindowDays * 24 * 60 * 60 * 1000;
    if (this.store.isFingerprintSeenWithinWindow(fingerprint, cutoffMs)) {
      return { ok: false, reason: "dedupe" };
    }

    const pathCheck = shouldRejectUrlByPath({
      url: hit.url,
      allowedPathPatterns: this.config.discoveryAllowedPathPatterns,
      blockedPathPatterns: this.config.discoveryBlockedPathPatterns,
    });
    if (pathCheck.reject) {
      this.store.recordAudit({
        actor,
        action: "candidate.content_rejected",
        objectId: fingerprint,
        meta: { url: hit.url, reason: pathCheck.reason ?? "path_filtered" },
        createdAt: Date.now(),
      });
      return { ok: false, reason: "path" };
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
      return { ok: false, reason: "fetch" };
    }

    const sourceQuality = isValidSourceContent({
      text: fetchedText,
      minChars: this.config.discoveryMinContentChars,
    });
    if (!sourceQuality.valid) {
      this.store.recordAudit({
        actor,
        action: "candidate.content_rejected",
        objectId: fingerprint,
        meta: {
          url: hit.url,
          reason: sourceQuality.reason ?? "quality_gate",
          chars: sourceQuality.chars,
        },
        createdAt: Date.now(),
      });
      return { ok: false, reason: "quality" };
    }

    const summaryMd = summarizeText({
      description: hit.title ? `${hit.description}\n标题: ${hit.title}` : hit.description,
      fetchedText,
      url: hit.url,
    });

    const categoryId = resolveCategoryId(topic, this.config);
    const autoTitle = createAutoTitleSentinel({ topic, url: hit.url });
    const normalizedPayload = normalizePayload({
      raw: {
        title: autoTitle,
        slug: slugify(`${topic}-${hit.host}`),
        excerpt: summaryMd.slice(0, 260),
        categoryId,
        isPublished: this.config.defaultIsPublished,
        dataSource: this.config.defaultDataSource,
      },
      fallbackTitle: autoTitle,
      fallbackCategoryId: categoryId,
      defaultIsPublished: this.config.defaultIsPublished,
      defaultDataSource: this.config.defaultDataSource,
      sourceUrl: hit.url,
      summaryMd,
    });

    let payload: WorkflowArticlePayload;
    try {
      payload = await this.buildBilingualPayload(normalizedPayload, {
        strict: true,
        stage: "collect",
        sourceContext: {
          topic,
          url: hit.url,
          summaryMd,
          fetchedText,
          sourceTitle: hit.title,
          sourceLanguage: hit.language,
          sourcePublishedAt: hit.publishedAt,
          sourceContentChars: sourceQuality.chars,
          discoveryQuery: hit.query,
        },
      });
    } catch (error) {
      const failure = toTranslationFailure(error, { stage: "collect" });
      this.store.recordAudit({
        actor,
        action: "candidate.translation_failed",
        objectId: fingerprint,
        meta: { url: hit.url, ...failure },
        createdAt: Date.now(),
      });
      return { ok: false, reason: "translation" };
    }

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
      sourceProfile: params.profileName,
      score: 0,
      status: "candidate",
      fingerprint,
      createdAt: now,
      updatedAt: now,
    };

    this.store.upsertCandidate(candidate);
    this.store.touchFingerprint(fingerprint, candidate.id, now);
    this.store.recordAudit({
      actor,
      action: "candidate.create",
      objectId: candidate.id,
      meta: { topic, profile: params.profileName, url: candidate.url },
      createdAt: now,
    });

    return { ok: true, candidate };
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
    const queries = buildQueries({
      topic,
      profileQueries: profile.queries,
      domains: profile.domains,
    }).slice(0, this.config.maxSearchQueries);
    const seedUrls = buildSeedUrls({
      topic,
      domains: profile.domains,
      profileQueries: queries,
    });

    let added = 0;
    let skippedByDedupe = 0;
    let skippedByFetch = 0;
    let skippedByQuality = 0;
    let skippedByTranslation = 0;
    const candidates: WorkflowCandidate[] = [];

    const discovery = await this.runDiscovery({
      topic,
      queries,
      domains: profile.domains,
      requestedLimit,
      actor: params.actor,
    });
    let { skippedByDiscovery, discoveryMode } = discovery;
    const { uniqueHits } = discovery;

    if (!this.config.discoveryEnabled || uniqueHits.size === 0) {
      if (this.config.discoveryEnabled) {
        discoveryMode = "seed-fallback";
      }
      for (const seedUrl of seedUrls) {
        if (!isAllowedDomain(seedUrl, profile.domains)) {
          continue;
        }
        const url = normalizeHttpUrl(seedUrl);
        if (!url || uniqueHits.has(url)) {
          continue;
        }
        uniqueHits.set(url, {
          host: hostFromUrl(url),
          url,
          description: "allowlist domain crawl",
        });
      }
    }

    const hits = [...uniqueHits.values()].slice(0, Math.max(requestedLimit * 4, 12));

    for (const hit of hits) {
      if (candidates.length >= requestedLimit) {
        break;
      }

      const result = await this.processHit({
        hit,
        topic,
        profileName: profile.name,
        actor: params.actor,
      });

      if (result.ok) {
        candidates.push(result.candidate);
        added += 1;
      } else {
        switch (result.reason) {
          case "dedupe":
            skippedByDedupe += 1;
            break;
          case "fetch":
            skippedByFetch += 1;
            break;
          case "path":
          case "quality":
            skippedByQuality += 1;
            break;
          case "translation":
            skippedByTranslation += 1;
            break;
        }
      }
      await sleep(SEARCH_CACHE_DELAY_MS);
    }

    return {
      topic,
      profile: profile.name,
      added,
      skippedByDedupe,
      skippedByFetch,
      skippedByDiscovery,
      skippedByQuality,
      skippedByTranslation,
      discoveryMode,
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

    let payload: WorkflowArticlePayload;
    try {
      payload = await this.buildBilingualPayload(
        {
          ...candidate.payload,
          isPublished: params.mode === "publish",
          slug: candidate.payload.slug || slugify(candidate.payload.title),
        },
        {
          strict: true,
          stage: "confirm",
          sourceContext: {
            topic: candidate.topic,
            url: candidate.url,
            summaryMd: candidate.summaryMd,
            fetchedText: candidate.summaryMd,
          },
        },
      );
    } catch (error) {
      const failure = toTranslationFailure(error, { stage: "confirm" });
      this.store.recordAudit({
        actor: params.actor,
        action: "publish.translation_failed",
        objectId: candidate.id,
        meta: failure,
        createdAt: Date.now(),
      });
      return {
        ok: false,
        reason: "translation_failed",
        reasonDetail: failure.message,
        candidate,
        translationFailure: failure,
      };
    }

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
    allowSlugRetry?: boolean;
  }): Promise<PublishResult> {
    const idempotencyKey =
      params.idempotencyKey ??
      createIdempotencyKey({
        candidateId: params.candidateId,
        mode: params.mode,
        payload: params.payload,
      });

    const token =
      process.env[this.config.publishApiTokenEnv] ??
      process.env[this.config.translationApiTokenEnv] ??
      process.env[this.config.discoveryApiTokenEnv];
    if (!token) {
      const responseText =
        `missing env: ${this.config.publishApiTokenEnv}` +
        ` (fallbacks: ${this.config.translationApiTokenEnv}, ${this.config.discoveryApiTokenEnv})`;
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

    if (
      !result.ok &&
      params.allowSlugRetry !== false &&
      isSlugConflict({
        status: result.status,
        responseText: result.responseText,
        responseJson: result.responseJson,
      })
    ) {
      const retrySlug = buildUniqueRetrySlug({
        currentSlug: params.payload.slug,
        candidateId: params.candidateId,
      });
      if (retrySlug !== params.payload.slug) {
        const retryPayload: WorkflowArticlePayload = {
          ...params.payload,
          slug: retrySlug,
        };
        const retryIdempotencyKey = createIdempotencyKey({
          candidateId: params.candidateId,
          mode: params.mode,
          payload: retryPayload,
        });

        const cached = this.store.getRecentSuccessfulAttemptByIdempotency(retryIdempotencyKey);
        if (cached) {
          return {
            ok: true,
            status: cached.statusCode,
            mode: params.mode,
            idempotencyKey: retryIdempotencyKey,
            responseText: cached.responseJson,
            responseJson: decodeJsonResponse(cached.responseJson),
          };
        }

        return this.importArticle({
          ...params,
          payload: retryPayload,
          idempotencyKey: retryIdempotencyKey,
          allowSlugRetry: false,
        });
      }
    }

    return result;
  }
}

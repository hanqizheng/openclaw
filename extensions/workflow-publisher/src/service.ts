import { setTimeout as sleep } from "node:timers/promises";
import type {
  PublishMode,
  PublishResult,
  WorkflowArticleBlock,
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
const AUTO_TITLE_SENTINEL_PREFIX = "AUTO_TITLE::";
const TEMPLATE_TITLE_PATTERN = /^embassy update - [a-z0-9.-]+$/i;

type TranslationStage = "collect" | "confirm" | "tool";

type BuildBilingualPayloadOptions = {
  strict?: boolean;
  stage?: TranslationStage;
  sourceContext?: {
    topic: string;
    url: string;
    summaryMd: string;
    fetchedText: string;
  };
};

type TranslationErrorCode =
  | "translation_token_missing"
  | "translation_request_failed"
  | "translation_http_error"
  | "translation_response_invalid"
  | "translation_title_not_generated"
  | "translation_slug_not_generated"
  | "translation_secondary_variant_missing";

export type TranslationFailure = {
  code: TranslationErrorCode | "translation_unknown_error";
  message: string;
  stage: TranslationStage;
  endpoint?: string;
  status?: number;
};

class TranslationPipelineError extends Error {
  readonly code: TranslationErrorCode;
  readonly stage: TranslationStage;
  readonly endpoint?: string;
  readonly status?: number;

  constructor(params: {
    code: TranslationErrorCode;
    message: string;
    stage: TranslationStage;
    endpoint?: string;
    status?: number;
  }) {
    super(params.message);
    this.name = "TranslationPipelineError";
    this.code = params.code;
    this.stage = params.stage;
    this.endpoint = params.endpoint;
    this.status = params.status;
  }
}

function toTranslationFailure(
  error: unknown,
  defaults: { stage: TranslationStage; endpoint?: string },
): TranslationFailure {
  if (error instanceof TranslationPipelineError) {
    return {
      code: error.code,
      message: error.message,
      stage: error.stage,
      endpoint: error.endpoint,
      status: error.status,
    };
  }
  return {
    code: "translation_unknown_error",
    message: String(error),
    stage: defaults.stage,
    endpoint: defaults.endpoint,
  };
}

function createAutoTitleSentinel(params: { topic: string; url: string }): string {
  return `${AUTO_TITLE_SENTINEL_PREFIX}${params.topic.trim()}::${hostFromUrl(params.url)}`;
}

function isAutoTitleSentinel(value: string): boolean {
  return normalizeComparableString(value)
    .toUpperCase()
    .startsWith(AUTO_TITLE_SENTINEL_PREFIX.toUpperCase());
}

function isTemplateTitle(value: string): boolean {
  return TEMPLATE_TITLE_PATTERN.test(normalizeComparableString(value));
}

function stripExternalWrapper(input: string): string {
  const withoutMarkers = input
    .replaceAll("<<<EXTERNAL_UNTRUSTED_CONTENT>>>", "")
    .replaceAll("<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>", "")
    .replace(/SECURITY NOTICE:[\s\S]*?Send messages to third parties\s*/g, "")
    .trim();
  return withoutMarkers;
}

function summarizeText(params: { description: string; fetchedText: string; url: string }): string {
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

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cloneBlocks(blocks: WorkflowArticleBlock[]): WorkflowArticleBlock[] {
  return blocks.map((block, index) => ({
    ...block,
    metadata: { ...block.metadata },
    order: index,
  }));
}

function clonePayload(payload: WorkflowArticlePayload): WorkflowArticlePayload {
  return {
    ...payload,
    coverImage: payload.coverImage ? [...payload.coverImage] : undefined,
    blocks: cloneBlocks(payload.blocks),
    translations: payload.translations ? { ...payload.translations } : undefined,
    blockTranslations: payload.blockTranslations ? { ...payload.blockTranslations } : undefined,
  };
}

function readTranslatedBlockContent(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  const obj = asObject(value);
  return asString(obj.content) ?? asString(obj.text);
}

function readTranslatedBlockContentByLanguage(
  value: unknown,
  language: string | undefined,
): string | undefined {
  if (!language) {
    return readTranslatedBlockContent(value);
  }
  const obj = asObject(value);
  const languageValue = obj[language];
  const nested = readTranslatedBlockContent(languageValue);
  return nested ?? readTranslatedBlockContent(value);
}

function readTranslatedBlockMetadata(value: unknown): Record<string, unknown> | undefined {
  const obj = asObject(value);
  const metadata = asObject(obj.metadata);
  if (Object.keys(metadata).length === 0) {
    return undefined;
  }
  return metadata;
}

function readTranslatedBlockMetadataByLanguage(
  value: unknown,
  language: string | undefined,
): Record<string, unknown> | undefined {
  if (!language) {
    return readTranslatedBlockMetadata(value);
  }
  const obj = asObject(value);
  const languageValue = obj[language];
  const nested = readTranslatedBlockMetadata(languageValue);
  return nested ?? readTranslatedBlockMetadata(value);
}

function normalizeTranslatedBlocks(
  value: unknown,
  fallback: WorkflowArticleBlock[],
  language?: string,
): WorkflowArticleBlock[] {
  const asArray = Array.isArray(value) ? value : undefined;
  const asMap = asArray ? {} : asObject(value);
  if ((asArray && asArray.length === 0) || (!asArray && Object.keys(asMap).length === 0)) {
    return cloneBlocks(fallback);
  }

  return fallback.map((block, index) => {
    const entry = asArray ? asArray[index] : asMap[String(index)];
    const translatedContent = readTranslatedBlockContentByLanguage(entry, language);
    const translatedMetadata = readTranslatedBlockMetadataByLanguage(entry, language);
    return {
      ...block,
      metadata: translatedMetadata ? { ...translatedMetadata } : { ...block.metadata },
      content: translatedContent ?? block.content,
      order: index,
    };
  });
}

function applyLanguageVariant(
  fallback: WorkflowArticlePayload,
  value: unknown,
  language?: string,
): WorkflowArticlePayload {
  const raw = asObject(value);
  const coverImageRaw = raw.coverImage;
  const normalizedCoverImage =
    typeof coverImageRaw === "string" && coverImageRaw.trim()
      ? [coverImageRaw.trim()]
      : Array.isArray(coverImageRaw)
        ? coverImageRaw.filter(
            (entry): entry is string => typeof entry === "string" && entry.trim(),
          )
        : undefined;
  return {
    ...clonePayload(fallback),
    title: asString(raw.title) ?? fallback.title,
    slug: asString(raw.slug) ?? fallback.slug,
    excerpt: asString(raw.excerpt) ?? fallback.excerpt,
    coverImage:
      normalizedCoverImage && normalizedCoverImage.length > 0
        ? [normalizedCoverImage[0]]
        : fallback.coverImage,
    blocks: normalizeTranslatedBlocks(raw.blocks, fallback.blocks, language),
  };
}

function parseBilingualResponse(params: {
  response: Record<string, unknown>;
  fallback: WorkflowArticlePayload;
}): {
  zh: WorkflowArticlePayload;
  en: WorkflowArticlePayload;
} {
  const root = asObject(params.response.data ?? params.response.result ?? params.response);
  const explicitZh = asObject(root.zh);
  const explicitEn = asObject(root.en);
  const hasExplicitVariants =
    Object.keys(explicitZh).length > 0 || Object.keys(explicitEn).length > 0;

  if (hasExplicitVariants) {
    return {
      zh: applyLanguageVariant(params.fallback, explicitZh, "zh"),
      en: applyLanguageVariant(params.fallback, explicitEn, "en"),
    };
  }

  // Some translation APIs return a complete article payload shape:
  // { title, slug, excerpt, blocks, translations: { en: {...} }, blockTranslations: { "0": { en: {...} } } }
  const translations = asObject(root.translations);
  const topLevelEn = asObject(translations.en);
  const blockTranslations = asObject(root.blockTranslations);
  const enWithBlocks = {
    ...topLevelEn,
    blocks: Object.keys(blockTranslations).length > 0 ? blockTranslations : topLevelEn.blocks,
  };
  return {
    zh: applyLanguageVariant(params.fallback, root, "zh"),
    en: applyLanguageVariant(params.fallback, enWithBlocks, "en"),
  };
}

function normalizeComparableString(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function buildUniqueRetrySlug(params: { currentSlug: string; candidateId: string }): string {
  const suffix = params.candidateId.slice(0, 6).toLowerCase();
  const normalized = slugify(params.currentSlug || "article");
  const maxBaseLength = Math.max(1, 80 - suffix.length - 1);
  const trimmedBase = normalized.slice(0, maxBaseLength).replace(/-+$/g, "");
  return `${trimmedBase || "article"}-${suffix}`;
}

function isSlugConflict(params: {
  status: number;
  responseText: string;
  responseJson?: Record<string, unknown>;
}): boolean {
  if (params.status !== 409) {
    return false;
  }
  const root = asObject(params.responseJson);
  const nested = asObject(root.data);
  const message = [asString(root.error), asString(root.message), asString(nested.error)]
    .filter(Boolean)
    .join(" ");
  const haystack = `${message} ${params.responseText}`.toLowerCase();
  return haystack.includes("slug already exists") || haystack.includes("slug exists");
}

function metadataEquals(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeTopLevelTranslations(
  value: WorkflowArticlePayload["translations"] | undefined,
): Record<string, { title?: string; excerpt?: string }> {
  const translations: Record<string, { title?: string; excerpt?: string }> = {};
  for (const [language, rawValue] of Object.entries(asObject(value))) {
    const entry = asObject(rawValue);
    const title = asString(entry.title);
    const excerpt = asString(entry.excerpt);
    if (!title && !excerpt) {
      continue;
    }
    translations[language] = {
      ...(title ? { title } : {}),
      ...(excerpt ? { excerpt } : {}),
    };
  }
  return translations;
}

function normalizeStructuredBlockTranslations(
  value: WorkflowArticlePayload["blockTranslations"] | undefined,
): Record<string, Record<string, { content?: string; metadata?: Record<string, unknown> }>> {
  const blockTranslations: Record<
    string,
    Record<string, { content?: string; metadata?: Record<string, unknown> }>
  > = {};
  for (const [blockIndex, rawByLanguage] of Object.entries(asObject(value))) {
    const byLanguage: Record<string, { content?: string; metadata?: Record<string, unknown> }> = {};
    for (const [language, rawTranslation] of Object.entries(asObject(rawByLanguage))) {
      const translation = asObject(rawTranslation);
      const content = asString(translation.content);
      const metadata = asObject(translation.metadata);
      if (!content && Object.keys(metadata).length === 0) {
        continue;
      }
      byLanguage[language] = {
        ...(content ? { content } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      };
    }
    if (Object.keys(byLanguage).length > 0) {
      blockTranslations[blockIndex] = byLanguage;
    }
  }
  return blockTranslations;
}

function hasLanguageVariant(payload: WorkflowArticlePayload, language: string): boolean {
  const translations = normalizeTopLevelTranslations(payload.translations);
  const topLevel = translations[language];
  if (topLevel) {
    const titleChanged =
      topLevel.title &&
      normalizeComparableString(topLevel.title) !== normalizeComparableString(payload.title);
    const excerptChanged =
      topLevel.excerpt &&
      normalizeComparableString(topLevel.excerpt) !== normalizeComparableString(payload.excerpt);
    if (titleChanged || excerptChanged) {
      return true;
    }
  }

  const blockTranslations = normalizeStructuredBlockTranslations(payload.blockTranslations);
  return Object.entries(blockTranslations).some(([blockIndex, byLanguage]) => {
    const translated = byLanguage[language];
    if (!translated) {
      return false;
    }
    const index = Number.parseInt(blockIndex, 10);
    const original = Number.isNaN(index) ? undefined : payload.blocks[index];
    const contentChanged =
      translated.content &&
      normalizeComparableString(translated.content) !==
        normalizeComparableString(original?.content);
    const metadataChanged =
      translated.metadata && (!original || !metadataEquals(translated.metadata, original.metadata));
    return Boolean(contentChanged || metadataChanged);
  });
}

function hasLanguageEntry(payload: WorkflowArticlePayload, language: string): boolean {
  const topLevel = normalizeTopLevelTranslations(payload.translations)[language];
  if (topLevel) {
    return true;
  }
  const blockTranslations = normalizeStructuredBlockTranslations(payload.blockTranslations);
  return Object.values(blockTranslations).some((entry) => Boolean(entry[language]));
}

function validateGeneratedPayload(params: {
  base: WorkflowArticlePayload;
  generated: WorkflowArticlePayload;
  stage: TranslationStage;
  endpoint: string;
}): TranslationPipelineError | null {
  const generatedTitle = normalizeComparableString(params.generated.title);
  const generatedSlug = normalizeComparableString(params.generated.slug);
  const baseTitle = normalizeComparableString(params.base.title);
  const baseSlug = normalizeComparableString(params.base.slug);
  const requiresFreshTitle = isTemplateTitle(baseTitle) || isAutoTitleSentinel(baseTitle);

  if (!generatedTitle) {
    return new TranslationPipelineError({
      code: "translation_title_not_generated",
      message: "translation response is missing a generated zh title",
      stage: params.stage,
      endpoint: params.endpoint,
    });
  }
  if (requiresFreshTitle && generatedTitle === baseTitle) {
    return new TranslationPipelineError({
      code: "translation_title_not_generated",
      message: "translation response kept the source template title",
      stage: params.stage,
      endpoint: params.endpoint,
    });
  }
  if (isAutoTitleSentinel(generatedTitle) || isTemplateTitle(generatedTitle)) {
    return new TranslationPipelineError({
      code: "translation_title_not_generated",
      message: "translation response returned a template-like title",
      stage: params.stage,
      endpoint: params.endpoint,
    });
  }
  if (!generatedSlug) {
    return new TranslationPipelineError({
      code: "translation_slug_not_generated",
      message: "translation response is missing a generated slug",
      stage: params.stage,
      endpoint: params.endpoint,
    });
  }
  if (requiresFreshTitle && generatedSlug === baseSlug) {
    return new TranslationPipelineError({
      code: "translation_slug_not_generated",
      message: "translation response kept the source template slug",
      stage: params.stage,
      endpoint: params.endpoint,
    });
  }
  if (!hasLanguageEntry(params.generated, "en")) {
    return new TranslationPipelineError({
      code: "translation_secondary_variant_missing",
      message: "translation response is missing the required en variant",
      stage: params.stage,
      endpoint: params.endpoint,
    });
  }
  return null;
}

function applySecondaryLanguageVariant(params: {
  primary: WorkflowArticlePayload;
  secondary: WorkflowArticlePayload;
  secondaryLanguage: string;
  preservePrimarySlug?: boolean;
}): WorkflowArticlePayload {
  const primary = clonePayload(params.primary);
  const secondary = clonePayload(params.secondary);
  const translations = normalizeTopLevelTranslations(primary.translations);
  translations[params.secondaryLanguage] = {
    title: secondary.title,
    excerpt: secondary.excerpt ?? "",
  };

  const preferredSlugInput = secondary.title || secondary.slug;
  const generatedSlug = preferredSlugInput ? slugify(preferredSlugInput) : "";
  if (generatedSlug && !params.preservePrimarySlug) {
    primary.slug = generatedSlug;
  }

  const blockTranslations = normalizeStructuredBlockTranslations(primary.blockTranslations);
  for (let index = 0; index < primary.blocks.length; index += 1) {
    const primaryBlock = primary.blocks[index];
    const secondaryBlock = secondary.blocks[index];
    if (!primaryBlock || !secondaryBlock) {
      continue;
    }
    const contentChanged =
      normalizeComparableString(primaryBlock.content) !==
      normalizeComparableString(secondaryBlock.content);
    const metadataChanged = !metadataEquals(primaryBlock.metadata, secondaryBlock.metadata);
    if (!contentChanged && !metadataChanged) {
      continue;
    }
    const translatedEntry: { content?: string; metadata?: Record<string, unknown> } = {
      ...(contentChanged && secondaryBlock.content.trim()
        ? { content: secondaryBlock.content }
        : {}),
      ...(metadataChanged && Object.keys(secondaryBlock.metadata).length > 0
        ? { metadata: { ...secondaryBlock.metadata } }
        : {}),
    };
    if (Object.keys(translatedEntry).length === 0) {
      continue;
    }
    const blockKey = String(index);
    blockTranslations[blockKey] = {
      ...(blockTranslations[blockKey] ?? {}),
      [params.secondaryLanguage]: translatedEntry,
    };
  }

  return {
    ...primary,
    translations: Object.keys(translations).length > 0 ? translations : undefined,
    blockTranslations: Object.keys(blockTranslations).length > 0 ? blockTranslations : undefined,
  };
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

    let response: Response;
    try {
      response = await fetchWithTimeout(
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
    } catch (error) {
      if (strict) {
        throw new TranslationPipelineError({
          code: "translation_request_failed",
          message: `translation request failed: ${String(error)}`,
          stage,
          endpoint,
        });
      }
      return fallbackPayload;
    }

    const rawText = await response.text();
    if (!response.ok) {
      if (strict) {
        throw new TranslationPipelineError({
          code: "translation_http_error",
          message: `translation endpoint returned ${response.status}: ${rawText || "empty response"}`,
          stage,
          endpoint,
          status: response.status,
        });
      }
      return fallbackPayload;
    }

    const parsed = decodeJsonResponse(rawText);
    if (!parsed) {
      if (strict) {
        throw new TranslationPipelineError({
          code: "translation_response_invalid",
          message: "translation endpoint returned a non-JSON object payload",
          stage,
          endpoint,
        });
      }
      return fallbackPayload;
    }

    const translated = parseBilingualResponse({
      response: parsed,
      fallback: base,
    });
    const primarySlugChanged =
      normalizeComparableString(translated.zh.slug) !== normalizeComparableString(base.slug);
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
      endpoint,
    });
    if (validationError) {
      if (strict) {
        throw validationError;
      }
      return fallbackPayload;
    }

    return generated;
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
        host: hostFromUrl(url),
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
      // Dedupe should be topic-scoped; otherwise scans for different topics
      // collapse into the same fingerprint set and always show skip-only results.
      const fingerprint = createFingerprint(`${topic}::${hit.host}`, hit.url);
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
        description: hit.description,
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
          },
        });
      } catch (error) {
        const failure = toTranslationFailure(error, { stage: "collect" });
        this.store.recordAudit({
          actor: params.actor,
          action: "candidate.translation_failed",
          objectId: fingerprint,
          meta: {
            url: hit.url,
            ...failure,
          },
          createdAt: Date.now(),
        });
        throw new Error(`workflow-publisher collect blocked (${failure.code}): ${failure.message}`);
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

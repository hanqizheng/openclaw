import { createHash, randomBytes } from "node:crypto";
import {
  ARTICLE_BLOCK_TYPES,
  type ArticleBlockType,
  type WorkflowArticleBlock,
  type WorkflowArticleBlockTranslations,
  type WorkflowArticlePayload,
  type WorkflowArticleTranslations,
} from "./types.js";
import { asObject, asString, asStringArray } from "./utils.js";

const BLOCK_TYPES = new Set<ArticleBlockType>(ARTICLE_BLOCK_TYPES);

export function normalizeBlocks(value: unknown): WorkflowArticleBlock[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const blocks: WorkflowArticleBlock[] = [];
  for (const raw of value) {
    const obj = asObject(raw);
    const typeRaw = asString(obj.type)?.toUpperCase();
    if (!typeRaw || !BLOCK_TYPES.has(typeRaw as ArticleBlockType)) {
      continue;
    }
    const content = typeof obj.content === "string" ? obj.content : "";
    const metadata = asObject(obj.metadata);
    blocks.push({
      type: typeRaw as ArticleBlockType,
      content,
      metadata,
      order: blocks.length,
    });
  }

  return blocks;
}

export function defaultBlocks(params: {
  title: string;
  summaryMd: string;
  sourceUrl: string;
}): WorkflowArticleBlock[] {
  return [
    {
      type: "TEXT",
      content: `## ${params.title}\n\n${params.summaryMd}`,
      metadata: {},
      order: 0,
    },
    {
      type: "LINK",
      content: params.sourceUrl,
      metadata: {
        text: "\u9605\u8bfb\u539f\u6587",
        target: "_blank",
      },
      order: 1,
    },
  ];
}

export function slugify(input: string): string {
  const base = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (base) {
    return base;
  }
  return `article-${Date.now().toString(36)}`;
}

export function normalizePayload(params: {
  raw: Record<string, unknown>;
  fallbackTitle: string;
  fallbackCategoryId: number;
  defaultIsPublished: boolean;
  defaultDataSource: string;
  sourceUrl: string;
  summaryMd: string;
}): WorkflowArticlePayload {
  const title = asString(params.raw.title) ?? params.fallbackTitle;
  const slug = asString(params.raw.slug) ?? slugify(title);
  const excerpt = asString(params.raw.excerpt) ?? params.summaryMd.slice(0, 260);
  const rawCategoryId = params.raw.categoryId;
  const categoryId =
    typeof rawCategoryId === "number" && Number.isFinite(rawCategoryId) && rawCategoryId > 0
      ? Math.trunc(rawCategoryId)
      : params.fallbackCategoryId;

  const rawDataSource = asString(params.raw.dataSource);
  const dataSource = rawDataSource ?? params.defaultDataSource;
  const isPublished =
    typeof params.raw.isPublished === "boolean"
      ? params.raw.isPublished
      : params.defaultIsPublished;

  const normalizedBlocks = normalizeBlocks(params.raw.blocks);
  const blocks =
    normalizedBlocks.length > 0
      ? normalizedBlocks
      : defaultBlocks({ title, summaryMd: params.summaryMd, sourceUrl: params.sourceUrl });

  const translationsRaw = asObject(params.raw.translations);
  const translations: WorkflowArticleTranslations = {};
  for (const [lang, value] of Object.entries(translationsRaw)) {
    const entry = asObject(value);
    const entryTitle = asString(entry.title);
    const translatedExcerpt = asString(entry.excerpt);
    if (!entryTitle && !translatedExcerpt) {
      continue;
    }
    translations[lang] = {
      ...(entryTitle ? { title: entryTitle } : {}),
      ...(translatedExcerpt ? { excerpt: translatedExcerpt } : {}),
    };
  }

  const blockTranslationsRaw = asObject(params.raw.blockTranslations);
  const legacyBlockTranslations: Record<string, string> = {};
  const structuredBlockTranslations: WorkflowArticleBlockTranslations = {};
  for (const [key, value] of Object.entries(blockTranslationsRaw)) {
    if (typeof value === "string") {
      legacyBlockTranslations[key] = value;
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const byLanguage: Record<string, { content?: string; metadata?: Record<string, unknown> }> = {};
    for (const [lang, translated] of Object.entries(asObject(value))) {
      const translatedObject = asObject(translated);
      const translatedContent = asString(translatedObject.content);
      const translatedMetadataObject = asObject(translatedObject.metadata);
      const translatedMetadata =
        Object.keys(translatedMetadataObject).length > 0 ? translatedMetadataObject : undefined;
      if (!translatedContent && !translatedMetadata) {
        continue;
      }
      byLanguage[lang] = {
        ...(translatedContent ? { content: translatedContent } : {}),
        ...(translatedMetadata ? { metadata: translatedMetadata } : {}),
      };
    }
    if (Object.keys(byLanguage).length > 0) {
      structuredBlockTranslations[key] = byLanguage;
    }
  }

  const coverImage = (() => {
    const asSingle = asString(params.raw.coverImage);
    if (asSingle) {
      return asSingle;
    }
    const asList = asStringArray(params.raw.coverImage);
    return asList.length > 0 ? (asList[0] as string) : undefined;
  })();
  const legacyContent = (() => {
    if (typeof params.raw.legacyContent === "string") {
      return params.raw.legacyContent;
    }
    if (params.raw.legacyContent === null) {
      return null;
    }
    return null;
  })();

  return {
    title,
    slug,
    excerpt,
    isPublished,
    categoryId,
    dataSource,
    legacyContent,
    coverImage,
    blocks,
    translations: Object.keys(translations).length ? translations : undefined,
    blockTranslations:
      Object.keys(structuredBlockTranslations).length > 0
        ? structuredBlockTranslations
        : Object.keys(legacyBlockTranslations).length > 0
          ? legacyBlockTranslations
          : undefined,
  };
}

export function normalizeDomainFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isAllowedDomain(url: string, allowedDomains: string[]): boolean {
  const host = normalizeDomainFromUrl(url);
  if (!host) {
    return false;
  }
  return allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function createFingerprint(title: string, url: string): string {
  const normalizedTitle = title.trim().toLowerCase().replace(/\s+/g, " ");
  const canonicalUrl = (() => {
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      parsed.search = "";
      return parsed.toString().toLowerCase();
    } catch {
      return url.trim().toLowerCase();
    }
  })();
  return createHash("sha256").update(`${normalizedTitle}||${canonicalUrl}`).digest("hex");
}

export function createId(): string {
  return randomBytes(5).toString("hex");
}

export function createNonce(): string {
  return randomBytes(4).toString("hex");
}

export function createIdempotencyKey(params: {
  candidateId: string;
  mode: "draft" | "publish";
  payload: WorkflowArticlePayload;
}): string {
  const normalized = JSON.stringify({
    candidateId: params.candidateId,
    mode: params.mode,
    payload: params.payload,
  });
  return createHash("sha256").update(normalized).digest("hex");
}

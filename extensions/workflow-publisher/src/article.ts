import { createHash, randomBytes } from "node:crypto";
import {
  ARTICLE_BLOCK_TYPES,
  type ArticleBlockType,
  type WorkflowArticleBlock,
  type WorkflowArticlePayload,
} from "./types.js";

const BLOCK_TYPES = new Set<ArticleBlockType>(ARTICLE_BLOCK_TYPES);

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

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
        text: "阅读原文",
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

  const blockTranslationsRaw = asObject(params.raw.blockTranslations);
  const blockTranslations: Record<string, string> = {};
  for (const [key, value] of Object.entries(blockTranslationsRaw)) {
    if (typeof value === "string") {
      blockTranslations[key] = value;
    }
  }

  const coverImage = asStringArray(params.raw.coverImage);

  return {
    title,
    slug,
    excerpt,
    isPublished,
    categoryId,
    dataSource,
    coverImage: coverImage.length ? [coverImage[0] as string] : undefined,
    blocks,
    blockTranslations: Object.keys(blockTranslations).length ? blockTranslations : undefined,
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

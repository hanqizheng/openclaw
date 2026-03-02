/**
 * Article discovery: search API integration, seed URL fallback, content fetching and quality gates.
 */

import {
  asObject,
  asString,
  hostFromUrl,
  normalizeHttpUrl,
  pathFromUrl,
  stripExternalWrapper,
  fetchWithTimeout,
} from "./utils.js";

export const SEARCH_CACHE_DELAY_MS = 120;
export const AUTO_TITLE_SENTINEL_PREFIX = "AUTO_TITLE::";
export const TEMPLATE_TITLE_PATTERN = /^embassy update - [a-z0-9.-]+$/i;

export type DiscoveryHit = {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
  language?: string;
  query?: string;
};

export function createAutoTitleSentinel(params: { topic: string; url: string }): string {
  return `${AUTO_TITLE_SENTINEL_PREFIX}${params.topic.trim()}::${hostFromUrl(params.url)}`;
}

export function isAutoTitleSentinel(value: string): boolean {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase()
    .startsWith(AUTO_TITLE_SENTINEL_PREFIX.toUpperCase());
}

export function isTemplateTitle(value: string): boolean {
  return TEMPLATE_TITLE_PATTERN.test(value.trim().replace(/\s+/g, " "));
}

export function summarizeText(params: {
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

export function buildQueries(params: {
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

export function normalizeDiscoveryHits(value: unknown, queryFallback?: string): DiscoveryHit[] {
  const root = asObject(value);
  const candidates =
    (Array.isArray(root.results) ? root.results : undefined) ??
    (Array.isArray(root.items) ? root.items : undefined) ??
    (Array.isArray(root.hits) ? root.hits : undefined) ??
    (Array.isArray(root.data) ? root.data : undefined) ??
    (Array.isArray(root.urls) ? root.urls : undefined) ??
    [];

  const hits: DiscoveryHit[] = [];
  for (const rawCandidate of candidates) {
    if (typeof rawCandidate === "string") {
      const normalized = normalizeHttpUrl(rawCandidate);
      if (!normalized) {
        continue;
      }
      hits.push({ url: normalized, query: queryFallback });
      continue;
    }
    const obj = asObject(rawCandidate);
    const normalizedUrl = normalizeHttpUrl(
      asString(obj.url) ?? asString(obj.link) ?? asString(obj.href),
    );
    if (!normalizedUrl) {
      continue;
    }
    hits.push({
      url: normalizedUrl,
      title: asString(obj.title) ?? asString(obj.headline),
      snippet: asString(obj.snippet) ?? asString(obj.summary) ?? asString(obj.description),
      publishedAt: asString(obj.publishedAt) ?? asString(obj.published_at) ?? asString(obj.date),
      language: asString(obj.language) ?? asString(obj.lang),
      query: asString(obj.query) ?? queryFallback,
    });
  }
  return hits;
}

export function normalizeDiscoveryResponse(value: unknown, queries: string[]): DiscoveryHit[] {
  const root = asObject(asObject(value).data ?? asObject(value).result ?? value);
  const directHits = normalizeDiscoveryHits(root);
  if (directHits.length > 0) {
    return directHits;
  }

  const hits: DiscoveryHit[] = [];
  const byQuery =
    asObject(root.byQuery).results ??
    asObject(root.by_query).results ??
    root.byQuery ??
    root.by_query;
  const byQueryObj = asObject(byQuery);
  for (const query of queries) {
    const queryHits = normalizeDiscoveryHits(byQueryObj[query], query);
    for (const hit of queryHits) {
      hits.push(hit);
    }
  }
  return hits;
}

function topicSlug(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildSeedUrls(params: {
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

function matchesPathPattern(path: string, pattern: string): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  if (!normalizedPattern) {
    return false;
  }
  return path.includes(normalizedPattern);
}

export function shouldRejectUrlByPath(params: {
  url: string;
  allowedPathPatterns: string[];
  blockedPathPatterns: string[];
}): { reject: boolean; reason?: string } {
  const path = pathFromUrl(params.url);
  if (
    params.allowedPathPatterns.length > 0 &&
    !params.allowedPathPatterns.some((pattern) => matchesPathPattern(path, pattern))
  ) {
    return { reject: true, reason: "path_not_allowed" };
  }
  if (params.blockedPathPatterns.some((pattern) => matchesPathPattern(path, pattern))) {
    return { reject: true, reason: "path_blocked" };
  }
  return { reject: false };
}

function looksLikeListingPage(text: string): boolean {
  const compact = text.toLowerCase();
  const listingSignals = [
    "latest news",
    "recent posts",
    "all articles",
    "browse by",
    "categories",
    "tags",
    "read more",
    "subscribe",
  ];
  const signalCount = listingSignals.reduce(
    (count, signal) => count + (compact.includes(signal) ? 1 : 0),
    0,
  );
  return signalCount >= 3;
}

export function isValidSourceContent(params: { text: string; minChars: number }): {
  valid: boolean;
  reason?: string;
  chars: number;
} {
  const stripped = stripExternalWrapper(params.text);
  const chars = stripped.length;
  if (!stripped) {
    return { valid: false, reason: "empty_content", chars };
  }
  if (chars < params.minChars) {
    return { valid: false, reason: "content_too_short", chars };
  }
  if (looksLikeListingPage(stripped)) {
    return { valid: false, reason: "listing_page", chars };
  }
  return { valid: true, chars };
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

export async function fetchReadableText(params: {
  url: string;
  maxChars: number;
}): Promise<string> {
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

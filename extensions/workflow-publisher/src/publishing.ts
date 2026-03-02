/**
 * Publishing helpers: slug conflict detection and retry logic.
 */

import { slugify } from "./article.js";
import { asObject, asString } from "./utils.js";

export function buildUniqueRetrySlug(params: { currentSlug: string; candidateId: string }): string {
  const suffix = params.candidateId.slice(0, 6).toLowerCase();
  const normalized = slugify(params.currentSlug || "article");
  const maxBaseLength = Math.max(1, 80 - suffix.length - 1);
  const trimmedBase = normalized.slice(0, maxBaseLength).replace(/-+$/g, "");
  return `${trimmedBase || "article"}-${suffix}`;
}

export function isSlugConflict(params: {
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

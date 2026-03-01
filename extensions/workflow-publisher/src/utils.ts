/**
 * Shared utility functions used across the workflow-publisher plugin.
 */

export function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function asPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  return undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function normalizeHttpUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function normalizeComparableString(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

export function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
}

export function pathFromUrl(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "/";
  }
}

export function decodeJsonResponse(responseText: string): Record<string, unknown> | undefined {
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

export function stripExternalWrapper(input: string): string {
  const withoutMarkers = input
    .replaceAll("<<<EXTERNAL_UNTRUSTED_CONTENT>>>", "")
    .replaceAll("<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>", "")
    .replace(/SECURITY NOTICE:[\s\S]*?Send messages to third parties\s*/g, "")
    .trim();
  return withoutMarkers;
}

export function stripMarkdownCodeFence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  const withoutOpen = trimmed.replace(/^```[a-zA-Z0-9_-]*\s*/, "");
  return withoutOpen.replace(/\s*```$/, "").trim();
}

export function extractJsonObjectFromText(value: string): Record<string, unknown> | undefined {
  const normalized = stripMarkdownCodeFence(value);
  const direct = decodeJsonResponse(normalized);
  if (direct) {
    return direct;
  }

  const firstBrace = normalized.indexOf("{");
  const lastBrace = normalized.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return undefined;
  }
  return decodeJsonResponse(normalized.slice(firstBrace, lastBrace + 1));
}

export async function fetchWithTimeout(
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

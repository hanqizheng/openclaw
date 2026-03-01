import path from "node:path";
import { asObject, asString, asPositiveInt, asBoolean, asStringArray } from "./utils.js";

export type WorkflowSourceProfile = {
  name: string;
  domains: string[];
  queries: string[];
};

export type WorkflowConfig = {
  sqlitePath: string;
  maxCandidatesPerRun: number;
  maxSearchQueries: number;
  searchCountPerQuery: number;
  fetchMaxChars: number;
  discoveryEnabled: boolean;
  discoveryApiBaseUrl: string;
  discoveryApiPath: string;
  discoveryApiTokenEnv: string;
  discoveryApiTimeoutMs: number;
  discoveryMaxResultsPerQuery: number;
  discoveryMinContentChars: number;
  discoveryAllowedPathPatterns: string[];
  discoveryBlockedPathPatterns: string[];
  dedupeWindowDays: number;
  pendingTtlMinutes: number;
  approvers: string[];
  defaultSourceProfile: string;
  sourceProfiles: Record<string, WorkflowSourceProfile>;
  topicCategoryMap: Record<string, number>;
  defaultCategoryId: number;
  defaultIsPublished: boolean;
  defaultDataSource: string;
  publishApiBaseUrl: string;
  publishApiImportPath: string;
  publishApiTokenEnv: string;
  publishApiTimeoutMs: number;
  translationEnabled: boolean;
  translationApiBaseUrl: string;
  translationApiPath: string;
  translationApiTokenEnv: string;
  translationModel: string;
  translationTimeoutMs: number;
};

const DEFAULT_SOURCE_PROFILE = "default";
const DEFAULT_DISCOVERY_BLOCKED_PATH_PATTERNS = [
  "/tag/",
  "/tags/",
  "/category/",
  "/categories/",
  "/search",
  "/archive",
];

function normalizeDomain(input: string): string {
  return input
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function normalizePathPattern(input: string): string {
  return input.trim().toLowerCase();
}

export function resolveWorkflowConfig(params: {
  pluginConfig: unknown;
  stateDir: string;
}): WorkflowConfig {
  const cfg = asObject(params.pluginConfig);
  const storage = asObject(cfg.storage);
  const limits = asObject(cfg.limits);
  const dedupe = asObject(cfg.dedupe);
  const telegram = asObject(cfg.telegram);
  const sources = asObject(cfg.sources);
  const topics = asObject(cfg.topics);
  const publishing = asObject(cfg.publishing);
  const api = asObject(publishing.api);
  const translation = asObject(publishing.translation);
  const translationApi = asObject(translation.api);
  const discovery = asObject(publishing.discovery);
  const discoveryApi = asObject(discovery.api);

  const sqlitePath =
    asString(storage.sqlitePath) ?? path.join(params.stateDir, "workflow-publisher.sqlite");

  const rawProfiles = asObject(sources.profiles);
  const sourceProfiles: Record<string, WorkflowSourceProfile> = {};
  for (const [profileName, profileValue] of Object.entries(rawProfiles)) {
    const profileObj = asObject(profileValue);
    const domains = asStringArray(profileObj.domains).map(normalizeDomain).filter(Boolean);
    if (domains.length === 0) {
      continue;
    }
    const queries = asStringArray(profileObj.queries);
    sourceProfiles[profileName] = {
      name: profileName,
      domains,
      queries,
    };
  }

  if (!sourceProfiles[DEFAULT_SOURCE_PROFILE]) {
    sourceProfiles[DEFAULT_SOURCE_PROFILE] = {
      name: DEFAULT_SOURCE_PROFILE,
      domains: ["example.com"],
      queries: ["{topic} latest news"],
    };
  }

  const defaultSourceProfile =
    asString(sources.defaultProfile) && sourceProfiles[asString(sources.defaultProfile) ?? ""]
      ? (asString(sources.defaultProfile) as string)
      : DEFAULT_SOURCE_PROFILE;

  const rawCategoryMap = asObject(topics.categoryMap);
  const topicCategoryMap: Record<string, number> = {};
  for (const [topic, rawCategoryId] of Object.entries(rawCategoryMap)) {
    const categoryId = asPositiveInt(rawCategoryId);
    if (!categoryId) {
      continue;
    }
    topicCategoryMap[topic.trim().toLowerCase()] = categoryId;
  }

  const publishApiBaseUrl = asString(api.baseUrl) ?? "http://127.0.0.1:5789";
  const translationApiBaseUrl = asString(translationApi.baseUrl) ?? publishApiBaseUrl;
  const translationTimeoutSeconds =
    asPositiveInt(translationApi.timeoutSeconds) ?? asPositiveInt(translation.timeoutSeconds) ?? 30;
  const discoveryApiBaseUrl =
    asString(discoveryApi.baseUrl) ??
    asString(discovery.baseUrl) ??
    translationApiBaseUrl ??
    publishApiBaseUrl;
  const discoveryApiTimeoutSeconds =
    asPositiveInt(discoveryApi.timeoutSeconds) ?? asPositiveInt(discovery.timeoutSeconds) ?? 20;
  const discoveryAllowedPathPatterns = asStringArray(discovery.allowedPathPatterns).map(
    normalizePathPattern,
  );
  const discoveryBlockedPathPatterns = (
    asStringArray(discovery.blockedPathPatterns).length > 0
      ? asStringArray(discovery.blockedPathPatterns)
      : DEFAULT_DISCOVERY_BLOCKED_PATH_PATTERNS
  ).map(normalizePathPattern);

  return {
    sqlitePath,
    maxCandidatesPerRun: asPositiveInt(limits.maxCandidatesPerRun) ?? 10,
    maxSearchQueries: asPositiveInt(limits.maxSearchQueries) ?? 12,
    searchCountPerQuery: asPositiveInt(limits.searchCountPerQuery) ?? 5,
    fetchMaxChars: asPositiveInt(limits.fetchMaxChars) ?? 8000,
    discoveryEnabled: asBoolean(discovery.enabled) ?? true,
    discoveryApiBaseUrl,
    discoveryApiPath: asString(discoveryApi.path) ?? "/api/integrations/articles/search",
    discoveryApiTokenEnv: asString(discoveryApi.tokenEnv) ?? "ARTICLE_TRANSLATE_SECRET",
    discoveryApiTimeoutMs: discoveryApiTimeoutSeconds * 1000,
    discoveryMaxResultsPerQuery: asPositiveInt(discovery.maxResultsPerQuery) ?? 8,
    discoveryMinContentChars: asPositiveInt(discovery.minContentChars) ?? 800,
    discoveryAllowedPathPatterns,
    discoveryBlockedPathPatterns,
    dedupeWindowDays: asPositiveInt(dedupe.windowDays) ?? 7,
    pendingTtlMinutes: asPositiveInt(telegram.pendingTtlMinutes) ?? 15,
    approvers: asStringArray(telegram.approvers),
    defaultSourceProfile,
    sourceProfiles,
    topicCategoryMap,
    defaultCategoryId: asPositiveInt(topics.defaultCategoryId) ?? 1,
    defaultIsPublished:
      typeof publishing.defaultIsPublished === "boolean" ? publishing.defaultIsPublished : false,
    defaultDataSource: asString(publishing.defaultDataSource) ?? "NEW",
    publishApiBaseUrl,
    publishApiImportPath: asString(api.importPath) ?? "/api/integrations/articles/import",
    publishApiTokenEnv: asString(api.tokenEnv) ?? "ARTICLE_IMPORT_SECRET",
    publishApiTimeoutMs: (asPositiveInt(api.timeoutSeconds) ?? 45) * 1000,
    translationEnabled: typeof translation.enabled === "boolean" ? translation.enabled : true,
    translationApiBaseUrl,
    translationApiPath: asString(translationApi.path) ?? "/api/integrations/articles/translate",
    translationApiTokenEnv: asString(translationApi.tokenEnv) ?? "ARTICLE_TRANSLATE_SECRET",
    translationModel: asString(translation.model) ?? "gpt-4.1-mini",
    translationTimeoutMs: translationTimeoutSeconds * 1000,
  };
}

export function resolveCategoryId(topic: string, cfg: WorkflowConfig): number {
  const key = topic.trim().toLowerCase();
  return cfg.topicCategoryMap[key] ?? cfg.defaultCategoryId;
}

export function resolveSourceProfile(
  name: string | undefined,
  cfg: WorkflowConfig,
): WorkflowSourceProfile {
  const candidate = name?.trim();
  if (candidate && cfg.sourceProfiles[candidate]) {
    return cfg.sourceProfiles[candidate] as WorkflowSourceProfile;
  }
  return cfg.sourceProfiles[cfg.defaultSourceProfile] as WorkflowSourceProfile;
}

export function isApprover(
  senderId: string | undefined,
  isAuthorizedSender: boolean,
  cfg: WorkflowConfig,
): boolean {
  const normalizedSender = senderId?.trim();
  if (!cfg.approvers.length) {
    return isAuthorizedSender;
  }
  if (!normalizedSender) {
    return false;
  }
  return cfg.approvers.includes(normalizedSender);
}

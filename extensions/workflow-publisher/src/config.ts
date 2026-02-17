import path from "node:path";

type PluginConfigObject = Record<string, unknown>;

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
};

const DEFAULT_SOURCE_PROFILE = "default";

function asObject(value: unknown): PluginConfigObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as PluginConfigObject;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  return undefined;
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

function normalizeDomain(input: string): string {
  return input
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
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

  return {
    sqlitePath,
    maxCandidatesPerRun: asPositiveInt(limits.maxCandidatesPerRun) ?? 10,
    maxSearchQueries: asPositiveInt(limits.maxSearchQueries) ?? 12,
    searchCountPerQuery: asPositiveInt(limits.searchCountPerQuery) ?? 5,
    fetchMaxChars: asPositiveInt(limits.fetchMaxChars) ?? 8000,
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

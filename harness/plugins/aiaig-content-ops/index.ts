import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { buildArticleImportPayload, type BlockInput } from "./article-payload.ts";
import {
  createGroundedSearchDefaults,
  getGroundedSearchBudgetStatus,
  runBudgetedGroundedSearch,
} from "./grounded-search.ts";

const ARTICLE_DATA_SOURCES = ["NEW", "LEGACY"] as const;
const ARTICLE_BLOCK_TYPES = [
  "TEXT",
  "IMAGE",
  "VIDEO",
  "QUOTE",
  "CODE",
  "EMBED",
  "HTML",
  "LINK",
  "PROPERTY",
  "QA",
  "ARTICLE_REFERENCE",
] as const;
const PROPERTY_NATURES = ["NEW_HOUSE", "SECOND_HAND"] as const;
const PACKET_TYPES = ["candidate-topics", "article-draft", "article-preview"] as const;
const PACKET_STATUSES = ["pending", "selected", "draft", "published", "archived"] as const;
const PUBLISH_MODES = ["draft", "publish", "preserve"] as const;
const TRANSLATABLE_BLOCK_TYPES = new Set(["TEXT", "QUOTE", "HTML", "LINK", "QA"]);

type PacketType = (typeof PACKET_TYPES)[number];
type PublishMode = (typeof PUBLISH_MODES)[number];

type PluginConfig = {
  enabled: boolean;
  baseUrl?: string;
  importPath: string;
  importSecretEnv: string;
  stateDir: string;
  defaultCategoryId?: number;
  allowedCategoryIds: number[];
  requireEnglish: boolean;
  searchApiKeyEnv: string;
  searchModel: string;
  searchDailyLimit: number;
  searchCacheTtlMinutes: number;
  searchTimezone: string;
  searchProxyUrl?: string;
};

const GROUNDED_SEARCH_DEFAULTS = createGroundedSearchDefaults();

const pluginConfigJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    baseUrl: { type: "string" },
    importPath: { type: "string" },
    importSecretEnv: { type: "string" },
    stateDir: { type: "string" },
    defaultCategoryId: { type: "integer" },
    allowedCategoryIds: {
      type: "array",
      items: { type: "integer" },
    },
    requireEnglish: { type: "boolean" },
    searchApiKeyEnv: { type: "string" },
    searchModel: { type: "string" },
    searchDailyLimit: { type: "integer" },
    searchCacheTtlMinutes: { type: "integer" },
    searchTimezone: { type: "string" },
    searchProxyUrl: { type: "string" },
  },
};

const pluginConfigSchema = {
  jsonSchema: pluginConfigJsonSchema,
  parse(value: unknown): PluginConfig {
    const raw = asRecord(value);
    return {
      enabled: readBoolean(raw.enabled, true),
      baseUrl: readOptionalString(raw.baseUrl),
      importPath: readOptionalString(raw.importPath) ?? "/api/integrations/articles/import",
      importSecretEnv: readOptionalString(raw.importSecretEnv) ?? "AIAIG_ARTICLE_IMPORT_SECRET",
      stateDir: readOptionalString(raw.stateDir) ?? "var/aiaig/state",
      defaultCategoryId: readOptionalInteger(raw.defaultCategoryId),
      allowedCategoryIds: readIntegerArray(raw.allowedCategoryIds),
      requireEnglish: readBoolean(raw.requireEnglish, true),
      searchApiKeyEnv:
        readOptionalString(raw.searchApiKeyEnv) ?? GROUNDED_SEARCH_DEFAULTS.searchApiKeyEnv,
      searchModel: readOptionalString(raw.searchModel) ?? GROUNDED_SEARCH_DEFAULTS.searchModel,
      searchDailyLimit:
        readOptionalInteger(raw.searchDailyLimit) ?? GROUNDED_SEARCH_DEFAULTS.searchDailyLimit,
      searchCacheTtlMinutes:
        readOptionalInteger(raw.searchCacheTtlMinutes) ??
        GROUNDED_SEARCH_DEFAULTS.searchCacheTtlMinutes,
      searchTimezone:
        readOptionalString(raw.searchTimezone) ?? GROUNDED_SEARCH_DEFAULTS.searchTimezone,
      searchProxyUrl: readOptionalString(raw.searchProxyUrl),
    };
  },
};

function stringEnumSchema<T extends readonly string[]>(
  values: T,
  options: {
    description?: string;
  } = {},
) {
  return Type.String({
    enum: [...values],
    ...options,
  });
}

export default {
  id: "aiaig-content-ops",
  name: "AIAIG Content Ops",
  description: "State, validation, and publishing helpers for the AIAIG editorial workflow.",
  configSchema: pluginConfigSchema,
  register(api) {
    const config = pluginConfigSchema.parse(api.pluginConfig);

    api.registerTool(
      (ctx) => {
        const workspaceDir = ctx.workspaceDir ?? process.cwd();

        return [
          {
            name: "aiaig_packet_save",
            description:
              "Persist AIAIG workflow state such as candidate topics, article drafts, and preview packets.",
            parameters: Type.Object({
              packetType: stringEnumSchema(PACKET_TYPES, {
                description: "Workflow packet kind to store.",
              }),
              packetId: Type.Optional(
                Type.String({ description: "Existing packet id to overwrite." }),
              ),
              label: Type.String({ description: "Human-readable packet label." }),
              dataJson: Type.String({ description: "JSON payload to store inside the packet." }),
              status: Type.Optional(
                stringEnumSchema(PACKET_STATUSES, {
                  description: "Workflow packet lifecycle state.",
                }),
              ),
            }),
            async execute(_id, params) {
              const stateDir = await ensureStateDir(workspaceDir, config.stateDir);
              const packetId =
                readOptionalString(params.packetId) ?? createPacketId(params.packetType);
              const packetPath = path.join(stateDir, "packets", `${packetId}.json`);
              const payload = parseJsonString("dataJson", params.dataJson);
              const previous = await tryReadJsonFile(packetPath);
              const packet = {
                packetId,
                packetType: params.packetType,
                label: params.label.trim(),
                status: readOptionalString(params.status) ?? "pending",
                createdAt:
                  isRecord(previous) && typeof previous.createdAt === "string"
                    ? previous.createdAt
                    : new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                data: payload,
              };
              await fs.mkdir(path.dirname(packetPath), { recursive: true });
              await fs.writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
              return jsonResult({
                ok: true,
                packetId,
                packetPath,
                packetType: packet.packetType,
                status: packet.status,
              });
            },
          },
          {
            name: "aiaig_packet_get",
            description: "Load a previously saved AIAIG workflow packet by packet id.",
            parameters: Type.Object({
              packetId: Type.String({ description: "Packet id returned by aiaig_packet_save." }),
            }),
            async execute(_id, params) {
              const stateDir = await ensureStateDir(workspaceDir, config.stateDir);
              const packetPath = path.join(stateDir, "packets", `${params.packetId.trim()}.json`);
              const packet = await readJsonFile(packetPath);
              return jsonResult({
                ok: true,
                packetPath,
                packet,
              });
            },
          },
          {
            name: "aiaig_search_budget_status",
            description:
              "Show the current Gemini grounded-search daily budget and reset time for the AIAIG workflow.",
            parameters: Type.Object({}),
            async execute() {
              return jsonResult(
                await getGroundedSearchBudgetStatus(
                  createGroundedSearchConfig(workspaceDir, config),
                ),
              );
            },
          },
          {
            name: "aiaig_grounded_search",
            description:
              "Run Gemini grounded search with a persistent cache and a hard daily budget cap for AIAIG discovery.",
            parameters: Type.Object({
              query: Type.String({ description: "Grounded search query for discovery." }),
              forceRefresh: Type.Optional(
                Type.Boolean({ description: "Skip the local cache and consume one budget slot." }),
              ),
              maxCitations: Type.Optional(
                Type.Number({
                  description: "Maximum number of citations to return (1-10).",
                  minimum: 1,
                  maximum: 10,
                }),
              ),
            }),
            async execute(_id, params) {
              return jsonResult(
                await runBudgetedGroundedSearch({
                  config: createGroundedSearchConfig(workspaceDir, config),
                  query: params.query,
                  forceRefresh: params.forceRefresh === true,
                  maxCitations: readOptionalInteger(params.maxCitations),
                }),
              );
            },
          },
          {
            name: "aiaig_article_build_payload",
            description:
              "Build a valid bilingual AIAIG article-import payload from plain article fields. Supports multi-block payloads via `blocks` array, or a single TEXT block via `bodyMarkdownZh`/`bodyMarkdownEn`. Use this instead of hand-writing JSON.",
            parameters: Type.Object({
              slug: Type.String({ description: "Stable article slug." }),
              titleZh: Type.String({ description: "Chinese article title." }),
              titleEn: Type.String({ description: "English article title." }),
              excerptZh: Type.String({ description: "Chinese article excerpt/summary." }),
              excerptEn: Type.String({ description: "English article excerpt/summary." }),
              bodyMarkdownZh: Type.Optional(
                Type.String({
                  description:
                    "Chinese Markdown body for a single TEXT block. Use this OR blocks, not both.",
                }),
              ),
              bodyMarkdownEn: Type.Optional(
                Type.String({
                  description:
                    "English Markdown body for a single TEXT block. Use this OR blocks, not both.",
                }),
              ),
              blocks: Type.Optional(
                Type.Array(
                  Type.Object({
                    type: stringEnumSchema(ARTICLE_BLOCK_TYPES, {
                      description: "Block type. Prefer TEXT, HTML, or QA.",
                    }),
                    contentZh: Type.Optional(
                      Type.String({
                        description: "Chinese content: markdown for TEXT/HTML, text for QA.",
                      }),
                    ),
                    contentEn: Type.Optional(
                      Type.String({
                        description: "English content for translatable types (TEXT, HTML, QA).",
                      }),
                    ),
                  }),
                  {
                    description:
                      "Ordered list of content blocks. Provide this OR bodyMarkdownZh/bodyMarkdownEn.",
                  },
                ),
              ),
              categoryId: Type.Optional(
                Type.Number({ description: "AIAIG category id override." }),
              ),
              coverImage: Type.Optional(Type.String({ description: "Optional cover image URL." })),
              seoTitleZh: Type.Optional(
                Type.String({ description: "Optional Chinese SEO title." }),
              ),
              seoTitleEn: Type.Optional(
                Type.String({ description: "Optional English SEO title." }),
              ),
              seoDescriptionZh: Type.Optional(
                Type.String({ description: "Optional Chinese SEO description." }),
              ),
              seoDescriptionEn: Type.Optional(
                Type.String({ description: "Optional English SEO description." }),
              ),
              sourceLinks: Type.Optional(
                Type.Array(
                  Type.Object({
                    url: Type.String({ description: "Source URL." }),
                    label: Type.Optional(
                      Type.String({ description: "Shared source label when one label is enough." }),
                    ),
                    labelZh: Type.Optional(
                      Type.String({ description: "Chinese source label override." }),
                    ),
                    labelEn: Type.Optional(
                      Type.String({ description: "English source label override." }),
                    ),
                  }),
                ),
              ),
            }),
            async execute(_id, params) {
              // Pre-flight: require either blocks or bodyMarkdownZh+bodyMarkdownEn
              const hasBlocks = Array.isArray(params.blocks) && params.blocks.length > 0;
              const hasBody =
                typeof params.bodyMarkdownZh === "string" &&
                params.bodyMarkdownZh.trim().length > 0 &&
                typeof params.bodyMarkdownEn === "string" &&
                params.bodyMarkdownEn.trim().length > 0;
              if (!hasBlocks && !hasBody) {
                return jsonResult({
                  ok: false,
                  error:
                    "Provide either a `blocks` array or both `bodyMarkdownZh` and `bodyMarkdownEn`.",
                });
              }

              const blocks: BlockInput[] | undefined = hasBlocks
                ? (params.blocks as BlockInput[])
                : undefined;

              const built = buildArticleImportPayload(
                {
                  slug: params.slug,
                  titleZh: params.titleZh,
                  titleEn: params.titleEn,
                  excerptZh: params.excerptZh,
                  excerptEn: params.excerptEn,
                  bodyMarkdownZh: readOptionalString(params.bodyMarkdownZh),
                  bodyMarkdownEn: readOptionalString(params.bodyMarkdownEn),
                  blocks,
                  categoryId: readOptionalInteger(params.categoryId),
                  coverImage: readOptionalString(params.coverImage),
                  seoTitleZh: readOptionalString(params.seoTitleZh),
                  seoTitleEn: readOptionalString(params.seoTitleEn),
                  seoDescriptionZh: readOptionalString(params.seoDescriptionZh),
                  seoDescriptionEn: readOptionalString(params.seoDescriptionEn),
                  sourceLinks: Array.isArray(params.sourceLinks) ? params.sourceLinks : [],
                },
                {
                  defaultCategoryId: config.defaultCategoryId,
                },
              );
              return jsonResult({
                ok: true,
                ...built,
              });
            },
          },
          {
            name: "aiaig_article_validate",
            description:
              "Validate an AIAIG article-import payload before sending it to the website integration API.",
            parameters: Type.Object({
              payloadJson: Type.String({
                description: "Full JSON payload for /api/integrations/articles/import.",
              }),
              requireEnglish: Type.Optional(
                Type.Boolean({
                  description: "Require translations.en and English block translations.",
                }),
              ),
            }),
            async execute(_id, params) {
              let rawPayload: unknown;
              try {
                rawPayload = parseJsonString("payloadJson", params.payloadJson);
              } catch (error) {
                return jsonResult({
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                  validation: {
                    errors: [error instanceof Error ? error.message : String(error)],
                    warnings: [],
                    summary: null,
                  },
                });
              }
              const normalized = normalizeArticlePayload(rawPayload, config, "preserve");
              const validation = validateArticlePayload(normalized, {
                allowedCategoryIds: config.allowedCategoryIds,
                requireEnglish:
                  typeof params.requireEnglish === "boolean"
                    ? params.requireEnglish
                    : config.requireEnglish,
              });
              return jsonResult({
                ok: validation.errors.length === 0,
                normalizedPayload: normalized,
                validation,
              });
            },
          },
          {
            name: "aiaig_article_publish",
            description:
              "Publish or draft an AIAIG article through the article import API using the configured secret env var.",
            ownerOnly: true,
            parameters: Type.Object({
              payloadJson: Type.String({
                description: "Full JSON payload for /api/integrations/articles/import.",
              }),
              mode: Type.Optional(
                stringEnumSchema(PUBLISH_MODES, {
                  description:
                    "draft forces isPublished=false, publish forces true, preserve keeps input.",
                }),
              ),
              dryRun: Type.Optional(
                Type.Boolean({
                  description: "Skip the HTTP request and return the prepared payload only.",
                }),
              ),
            }),
            async execute(_id, params) {
              const mode =
                (readOptionalString(params.mode) as PublishMode | undefined) ?? "preserve";
              let rawPayload: unknown;
              try {
                rawPayload = parseJsonString("payloadJson", params.payloadJson);
              } catch (error) {
                return jsonResult({
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
              const normalized = normalizeArticlePayload(rawPayload, config, mode);
              const validation = validateArticlePayload(normalized, {
                allowedCategoryIds: config.allowedCategoryIds,
                requireEnglish: config.requireEnglish,
              });

              if (validation.errors.length > 0) {
                return jsonResult({
                  ok: false,
                  error: "payload validation failed",
                  normalizedPayload: normalized,
                  validation,
                });
              }

              const baseUrl = config.baseUrl?.trim();
              if (!baseUrl) {
                throw new Error("Plugin config missing baseUrl.");
              }

              const importSecret = process.env[config.importSecretEnv]?.trim();
              if (!importSecret) {
                throw new Error(`Missing env var ${config.importSecretEnv}.`);
              }

              const targetUrl = new URL(config.importPath, ensureTrailingSlash(baseUrl)).toString();
              if (params.dryRun === true) {
                return jsonResult({
                  ok: true,
                  dryRun: true,
                  request: {
                    url: targetUrl,
                    mode,
                    isPublished: normalized.isPublished,
                    slug: normalized.slug,
                  },
                  normalizedPayload: normalized,
                  validation,
                });
              }

              const response = await fetch(targetUrl, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${importSecret}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(normalized),
              });

              const responseText = await response.text();
              const parsedResponse = tryParseJson(responseText);
              return jsonResult({
                ok: response.ok,
                status: response.status,
                mode,
                request: {
                  url: targetUrl,
                  isPublished: normalized.isPublished,
                  slug: normalized.slug,
                },
                response: parsedResponse ?? responseText,
              });
            },
          },
        ];
      },
      {
        names: [
          "aiaig_packet_save",
          "aiaig_packet_get",
          "aiaig_search_budget_status",
          "aiaig_grounded_search",
          "aiaig_article_build_payload",
          "aiaig_article_validate",
          "aiaig_article_publish",
        ],
      },
    );
  },
};

function createGroundedSearchConfig(workspaceDir: string, config: PluginConfig) {
  return {
    workspaceDir,
    stateDir: config.stateDir,
    apiKeyEnv: config.searchApiKeyEnv,
    model: config.searchModel,
    dailyLimit: config.searchDailyLimit,
    cacheTtlMinutes: config.searchCacheTtlMinutes,
    timezone: config.searchTimezone,
    proxyUrl: config.searchProxyUrl,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readOptionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function readIntegerArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is number => typeof entry === "number" && Number.isInteger(entry),
  );
}

function parseJsonString(label: string, value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} must be valid JSON: ${detail}`, { cause: error });
  }
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

async function ensureStateDir(workspaceDir: string, configuredStateDir: string): Promise<string> {
  const stateDir = path.resolve(workspaceDir, configuredStateDir);
  await fs.mkdir(path.join(stateDir, "packets"), { recursive: true });
  return stateDir;
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function tryReadJsonFile(filePath: string): Promise<unknown> {
  try {
    return await readJsonFile(filePath);
  } catch {
    return undefined;
  }
}

function createPacketId(packetType: PacketType): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${packetType}-${Date.now()}-${suffix}`;
}

function normalizeArticlePayload(raw: unknown, config: PluginConfig, mode: PublishMode) {
  const payload = asRecord(raw);
  const normalized = { ...payload } as Record<string, unknown>;
  if (normalized.dataSource === undefined) {
    normalized.dataSource = "NEW";
  }
  if (normalized.categoryId === undefined && config.defaultCategoryId !== undefined) {
    normalized.categoryId = config.defaultCategoryId;
  }
  if (mode === "draft") {
    normalized.isPublished = false;
  } else if (mode === "publish") {
    normalized.isPublished = true;
  }
  return normalized;
}

function validateArticlePayload(
  payload: Record<string, unknown>,
  options: { allowedCategoryIds: number[]; requireEnglish: boolean },
) {
  const errors: string[] = [];
  const warnings: string[] = [];

  const title = readOptionalString(payload.title);
  const slug = readOptionalString(payload.slug);
  if (!title) {
    errors.push("title is required");
  }
  if (!slug) {
    errors.push("slug is required");
  }

  const dataSource = readOptionalString(payload.dataSource) ?? "NEW";
  if (!ARTICLE_DATA_SOURCES.includes(dataSource as (typeof ARTICLE_DATA_SOURCES)[number])) {
    errors.push(`dataSource must be one of: ${ARTICLE_DATA_SOURCES.join(", ")}`);
  }

  const categoryId = readOptionalInteger(payload.categoryId);
  if (
    options.allowedCategoryIds.length > 0 &&
    categoryId !== undefined &&
    !options.allowedCategoryIds.includes(categoryId)
  ) {
    errors.push(`categoryId ${categoryId} is not in allowedCategoryIds`);
  }

  if (Array.isArray(payload.coverImage) && payload.coverImage.length > 1) {
    warnings.push("coverImage contains multiple values; the API will keep only the first image.");
  }

  const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
  const blockOrders = new Set<number>();
  const translatableOrders: number[] = [];

  blocks.forEach((entry, index) => {
    const block = asRecord(entry);
    const blockType = readOptionalString(block.type);
    const order = readOptionalInteger(block.order);

    if (
      !blockType ||
      !ARTICLE_BLOCK_TYPES.includes(blockType as (typeof ARTICLE_BLOCK_TYPES)[number])
    ) {
      errors.push(`blocks[${index}].type must be one of: ${ARTICLE_BLOCK_TYPES.join(", ")}`);
      return;
    }
    if (order === undefined) {
      errors.push(`blocks[${index}].order must be an integer`);
      return;
    }
    if (blockOrders.has(order)) {
      errors.push(`blocks[${index}].order duplicates order ${order}`);
    }
    blockOrders.add(order);

    if (TRANSLATABLE_BLOCK_TYPES.has(blockType)) {
      translatableOrders.push(order);
    }

    if (blockType === "PROPERTY") {
      const metadata = asRecord(block.metadata);
      const nature = readOptionalString(metadata.nature);
      if (nature && !PROPERTY_NATURES.includes(nature as (typeof PROPERTY_NATURES)[number])) {
        errors.push(
          `blocks[${index}].metadata.nature must be one of: ${PROPERTY_NATURES.join(", ")}`,
        );
      }
    }

    if (blockType === "QA") {
      const metadata = asRecord(block.metadata);
      const qaItems = metadata.qaItems;
      if (!Array.isArray(qaItems) || qaItems.length === 0) {
        errors.push(`blocks[${index}].metadata.qaItems must be a non-empty array`);
      }
    }

    if (blockType === "ARTICLE_REFERENCE") {
      const metadata = asRecord(block.metadata);
      const articleIds = metadata.articleIds;
      if (!Array.isArray(articleIds) || articleIds.length === 0) {
        warnings.push(
          `blocks[${index}].metadata.articleIds is empty; the front-end will render nothing.`,
        );
      }
    }
  });

  if (dataSource === "NEW" && blocks.length === 0) {
    errors.push("blocks must be non-empty when dataSource=NEW");
  }
  if (
    dataSource === "LEGACY" &&
    !readOptionalString(payload.legacyContent) &&
    blocks.length === 0
  ) {
    errors.push("legacyContent or blocks is required when dataSource=LEGACY");
  }

  if (blocks.length > 0) {
    const orders = [...blockOrders].toSorted((left, right) => left - right);
    orders.forEach((order, index) => {
      if (order !== index) {
        warnings.push(
          "blocks.order should be contiguous and start at 0 for the safest import behavior.",
        );
      }
    });
  }

  if (options.requireEnglish) {
    const translations = asRecord(payload.translations);
    const english = asRecord(translations.en);
    if (!readOptionalString(english.title)) {
      errors.push("translations.en.title is required");
    }
    if (payload.excerpt !== undefined && !readOptionalString(english.excerpt)) {
      warnings.push("translations.en.excerpt is missing while root excerpt is present.");
    }

    const blockTranslations = asRecord(payload.blockTranslations);
    for (const order of translatableOrders) {
      const orderTranslation = asRecord(blockTranslations[String(order)]);
      const englishBlock = asRecord(orderTranslation.en);
      if (Object.keys(englishBlock).length === 0) {
        warnings.push(`blockTranslations.${order}.en is missing for a translatable block.`);
      }
    }
  }

  return {
    errors,
    warnings,
    summary: {
      title,
      slug,
      dataSource,
      categoryId,
      blockCount: blocks.length,
      hasEnglishTranslations: Boolean(asRecord(asRecord(payload.translations).en).title),
    },
  };
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

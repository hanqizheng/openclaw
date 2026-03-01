import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { normalizePayload } from "./article.js";
import { resolveCategoryId } from "./config.js";
import type { WorkflowService } from "./service.js";
import type { PublishMode } from "./types.js";
import { asObject } from "./utils.js";

function toToolResult(payload: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function parseMode(raw: unknown): PublishMode {
  return raw === "publish" ? "publish" : "draft";
}

function buildCollectTool(service: WorkflowService): AnyAgentTool {
  return {
    name: "workflow_collect",
    label: "Workflow Collect",
    description:
      "Collect topic-related content from fixed allowlisted sites, dedupe, and create publish candidates.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        topic: { type: "string" },
        profile: { type: "string" },
        limit: { type: "number" },
        actor: { type: "string" },
      },
      required: ["topic"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const topic = typeof params.topic === "string" ? params.topic.trim() : "";
      if (!topic) {
        throw new Error("topic required");
      }
      const result = await service.collect({
        topic,
        profile: typeof params.profile === "string" ? params.profile : undefined,
        limit: typeof params.limit === "number" ? Math.trunc(params.limit) : undefined,
        actor: typeof params.actor === "string" && params.actor.trim() ? params.actor : "tool",
      });
      return toToolResult(result);
    },
  };
}

function buildCandidateListTool(service: WorkflowService): AnyAgentTool {
  return {
    name: "workflow_candidate_list",
    label: "Workflow Candidate List",
    description: "List collected candidates with optional status/topic filters.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        topic: { type: "string" },
        status: { type: "string" },
        limit: { type: "number" },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const statusRaw = typeof params.status === "string" ? params.status : undefined;
      const status =
        statusRaw === "candidate" || statusRaw === "published" || statusRaw === "discarded"
          ? statusRaw
          : undefined;
      const result = service.listCandidates({
        topic: typeof params.topic === "string" ? params.topic : undefined,
        status,
        limit: typeof params.limit === "number" ? Math.trunc(params.limit) : undefined,
      });
      return toToolResult({ count: result.length, candidates: result });
    },
  };
}

function buildPublishPrepareTool(service: WorkflowService): AnyAgentTool {
  return {
    name: "workflow_publish_prepare",
    label: "Workflow Publish Prepare",
    description: "Create a short-lived confirmation token for a candidate publish action.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        candidateId: { type: "string" },
        actor: { type: "string" },
      },
      required: ["candidateId"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const candidateId = typeof params.candidateId === "string" ? params.candidateId.trim() : "";
      if (!candidateId) {
        throw new Error("candidateId required");
      }
      const result = service.preparePublish({
        candidateId,
        actor: typeof params.actor === "string" && params.actor.trim() ? params.actor : "tool",
      });
      return toToolResult(result);
    },
  };
}

function buildPublishConfirmTool(service: WorkflowService): AnyAgentTool {
  return {
    name: "workflow_publish_confirm",
    label: "Workflow Publish Confirm",
    description: "Consume the publish token and import article payload to target API.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        candidateId: { type: "string" },
        nonce: { type: "string" },
        mode: { type: "string" },
        actor: { type: "string" },
      },
      required: ["candidateId", "nonce"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const candidateId = typeof params.candidateId === "string" ? params.candidateId.trim() : "";
      const nonce = typeof params.nonce === "string" ? params.nonce.trim() : "";
      if (!candidateId || !nonce) {
        throw new Error("candidateId and nonce required");
      }
      const result = await service.confirmPublish({
        candidateId,
        nonce,
        mode: parseMode(params.mode),
        actor: typeof params.actor === "string" && params.actor.trim() ? params.actor : "tool",
      });
      return toToolResult(result);
    },
  };
}

function buildSiteArticleImportTool(service: WorkflowService): AnyAgentTool {
  return {
    name: "site_article_import",
    label: "Site Article Import",
    description: "Directly call the configured article import endpoint with a normalized payload.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        candidateId: { type: "string" },
        topic: { type: "string" },
        mode: { type: "string" },
        actor: { type: "string" },
        payload: {
          type: "object",
          additionalProperties: true,
        },
      },
      required: ["payload"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const rawPayload = asObject(params.payload);
      const topic =
        typeof params.topic === "string" && params.topic.trim() ? params.topic : "manual";
      const fallbackCategoryId = resolveCategoryId(topic, service.config);
      const normalized = normalizePayload({
        raw: rawPayload,
        fallbackTitle:
          typeof rawPayload.title === "string" && rawPayload.title.trim()
            ? (rawPayload.title as string)
            : "Imported Article",
        fallbackCategoryId,
        defaultIsPublished: service.config.defaultIsPublished,
        defaultDataSource: service.config.defaultDataSource,
        sourceUrl: typeof rawPayload.url === "string" ? rawPayload.url : "https://example.com",
        summaryMd: typeof rawPayload.excerpt === "string" ? rawPayload.excerpt : "",
      });

      const candidateId =
        typeof params.candidateId === "string" && params.candidateId.trim()
          ? params.candidateId.trim()
          : "manual";

      const bilingualPayload = await service.buildBilingualPayload(normalized, {
        strict: true,
        stage: "tool",
      });
      const result = await service.importArticle({
        candidateId,
        payload: bilingualPayload,
        mode: parseMode(params.mode),
        actor: typeof params.actor === "string" && params.actor.trim() ? params.actor : "tool",
      });
      return toToolResult(result);
    },
  };
}

export function registerWorkflowTools(api: OpenClawPluginApi, service: WorkflowService): void {
  api.registerTool(buildCollectTool(service), { optional: true });
  api.registerTool(buildCandidateListTool(service), { optional: true });
  api.registerTool(buildPublishPrepareTool(service), { optional: true });
  api.registerTool(buildPublishConfirmTool(service), { optional: true });
  api.registerTool(buildSiteArticleImportTool(service), { optional: true });
}

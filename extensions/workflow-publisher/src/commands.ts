import type { OpenClawPluginApi, ReplyPayload } from "openclaw/plugin-sdk";
import type { WorkflowService } from "./service.js";
import type { WorkflowCandidate, PublishMode } from "./types.js";
import { isApprover } from "./config.js";

type WorkflowCommandContext = {
  senderId?: string;
  from?: string;
  channel: string;
  isAuthorizedSender: boolean;
  args?: string;
};

function toActor(ctx: WorkflowCommandContext): string {
  return ctx.senderId?.trim() || ctx.from?.trim() || "unknown";
}

function parseTokens(input: string | undefined): string[] {
  return (input ?? "")
    .trim()
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function formatCandidate(candidate: WorkflowCandidate, index: number): string {
  return [
    `${index + 1}. [${candidate.id}] ${candidate.title}`,
    `   topic=${candidate.topic} domain=${candidate.domain}`,
    `   ${candidate.url}`,
  ].join("\n");
}

function withTelegramButtons(
  text: string,
  rows: Array<Array<{ text: string; callback_data: string }>>,
): ReplyPayload {
  return {
    text,
    channelData: {
      telegram: {
        buttons: rows,
      },
    },
  };
}

function buildPrepareButtons(
  candidates: WorkflowCandidate[],
): Array<Array<{ text: string; callback_data: string }>> {
  return candidates.slice(0, 10).map((candidate, index) => [
    {
      text: `准备发布 #${index + 1}`,
      callback_data: `/pub prepare ${candidate.id}`,
    },
  ]);
}

function usageScan(): string {
  return ["用法:", "/scan <topic> [profile]", "示例:", "/scan ai 投研", "/scan 美股 default"].join(
    "\n",
  );
}

function usagePub(): string {
  return [
    "用法:",
    "/pub list [topic]",
    "/pub prepare <candidateId>",
    "/pub confirm <candidateId> <nonce> [draft|publish]",
    "/pub cancel <candidateId>",
  ].join("\n");
}

function parseMode(raw: string | undefined): PublishMode {
  return raw === "publish" ? "publish" : "draft";
}

export function registerWorkflowCommands(api: OpenClawPluginApi, service: WorkflowService): void {
  api.registerCommand({
    name: "scan",
    description: "采集固定站点资讯并生成候选。",
    acceptsArgs: true,
    handler: async (ctx) => {
      const tokens = parseTokens(ctx.args);
      if (tokens.length < 1) {
        return { text: usageScan() };
      }

      const topic = tokens[0] as string;
      const profile = tokens[1];
      const result = await service.collect({
        topic,
        profile,
        limit: service.config.maxCandidatesPerRun,
        actor: toActor(ctx),
      });

      if (result.candidates.length === 0) {
        return {
          text: `扫描完成: topic=${result.topic}, profile=${result.profile}\n新增 0 条，去重跳过 ${result.skippedByDedupe} 条。`,
        };
      }

      const lines = [
        `扫描完成: topic=${result.topic}, profile=${result.profile}`,
        `新增 ${result.added} 条，去重跳过 ${result.skippedByDedupe} 条。`,
        "",
        ...result.candidates.map((candidate, index) => formatCandidate(candidate, index)),
        "",
        "点击下方按钮进入两步发布流程。",
      ];
      const text = lines.join("\n");

      if (ctx.channel === "telegram") {
        return withTelegramButtons(text, buildPrepareButtons(result.candidates));
      }
      return { text };
    },
  });

  api.registerCommand({
    name: "pub",
    description: "候选发布工作流命令。",
    acceptsArgs: true,
    handler: async (ctx) => {
      const tokens = parseTokens(ctx.args);
      const action = tokens[0] ?? "help";
      const actor = toActor(ctx);

      if (action === "help") {
        return { text: usagePub() };
      }

      if (action === "list") {
        const topic = tokens[1];
        const candidates = service.listCandidates({
          topic,
          status: "candidate",
          limit: service.config.maxCandidatesPerRun,
        });
        if (candidates.length === 0) {
          return { text: "当前没有待发布候选。" };
        }
        const lines = [
          "待发布候选:",
          "",
          ...candidates.map((candidate, index) => formatCandidate(candidate, index)),
        ];
        const text = lines.join("\n");
        if (ctx.channel === "telegram") {
          return withTelegramButtons(text, buildPrepareButtons(candidates));
        }
        return { text };
      }

      const allowed = isApprover(ctx.senderId, ctx.isAuthorizedSender, service.config);
      if (!allowed) {
        return { text: "你没有发布权限。" };
      }

      if (action === "prepare") {
        const candidateId = tokens[1];
        if (!candidateId) {
          return { text: usagePub() };
        }
        const prepared = service.preparePublish({ candidateId, actor });
        if (!prepared.ok || !prepared.candidate || !prepared.nonce || !prepared.expiresAt) {
          return { text: `准备失败: ${prepared.reason ?? "unknown"}` };
        }

        const candidate = prepared.candidate;
        const exp = new Date(prepared.expiresAt).toLocaleString("zh-CN", { hour12: false });
        const preview = [
          `候选: ${candidate.id}`,
          `标题: ${candidate.payload.title}`,
          `slug: ${candidate.payload.slug}`,
          `categoryId: ${candidate.payload.categoryId}`,
          `blocks: ${candidate.payload.blocks.length}`,
          `到期: ${exp}`,
          "",
          "确认后将调用网站导入 API。",
        ].join("\n");

        const rows = [
          [
            {
              text: "确认存草稿",
              callback_data: `/pub confirm ${candidate.id} ${prepared.nonce} draft`,
            },
          ],
          [
            {
              text: "确认并发布",
              callback_data: `/pub confirm ${candidate.id} ${prepared.nonce} publish`,
            },
          ],
          [
            {
              text: "取消",
              callback_data: `/pub cancel ${candidate.id}`,
            },
          ],
        ];

        if (ctx.channel === "telegram") {
          return withTelegramButtons(preview, rows);
        }
        return {
          text:
            `${preview}\n\n` +
            `非 Telegram 渠道请手动执行:\n` +
            `/pub confirm ${candidate.id} ${prepared.nonce} draft`,
        };
      }

      if (action === "confirm") {
        const candidateId = tokens[1];
        const nonce = tokens[2];
        const mode = parseMode(tokens[3]);
        if (!candidateId || !nonce) {
          return { text: usagePub() };
        }
        const confirmed = await service.confirmPublish({
          candidateId,
          nonce,
          mode,
          actor,
        });
        if (!confirmed.ok || !confirmed.publishResult) {
          return { text: `发布失败: ${confirmed.reason ?? "unknown"}` };
        }
        const result = confirmed.publishResult;
        const cachedMark = confirmed.cached ? " (幂等命中)" : "";
        return {
          text: [
            `发布成功${cachedMark}`,
            `candidate: ${candidateId}`,
            `mode: ${mode}`,
            `status: ${result.status}`,
            `idempotencyKey: ${result.idempotencyKey.slice(0, 16)}...`,
          ].join("\n"),
        };
      }

      if (action === "cancel") {
        const candidateId = tokens[1];
        if (!candidateId) {
          return { text: usagePub() };
        }
        const cancelled = service.cancelCandidate({ candidateId, actor });
        if (!cancelled.ok) {
          return { text: `取消失败: ${cancelled.reason ?? "unknown"}` };
        }
        return { text: `已取消候选 ${candidateId}` };
      }

      return { text: usagePub() };
    },
  });
}

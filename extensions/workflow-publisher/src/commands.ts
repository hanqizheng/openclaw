import type { OpenClawPluginApi, ReplyPayload } from "openclaw/plugin-sdk";
import { isApprover } from "./config.js";
import type { WorkflowService } from "./service.js";
import type { WorkflowCandidate, PublishMode } from "./types.js";

type WorkflowCommandContext = {
  senderId?: string;
  from?: string;
  to?: string;
  accountId?: string;
  messageThreadId?: number;
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

function resolveTelegramTarget(ctx: WorkflowCommandContext): string | undefined {
  const to = ctx.to?.trim();
  if (to) {
    return to;
  }
  const senderId = ctx.senderId?.trim();
  if (senderId && /^\d+$/.test(senderId)) {
    return senderId;
  }
  return undefined;
}

function formatCandidateCard(candidate: WorkflowCandidate, index: number): string {
  return [
    `候选 #${index + 1}`,
    `ID: ${candidate.id}`,
    `标题: ${candidate.title}`,
    `topic=${candidate.topic} domain=${candidate.domain}`,
    candidate.url,
  ].join("\n");
}

function buildConfirmRows(
  candidateId: string,
  nonce: string,
): Array<Array<{ text: string; callback_data: string }>> {
  return [
    [
      {
        text: "确认存草稿",
        callback_data: `/pub confirm ${candidateId} ${nonce} draft`,
      },
    ],
    [
      {
        text: "确认并发布",
        callback_data: `/pub confirm ${candidateId} ${nonce} publish`,
      },
    ],
    [
      {
        text: "取消",
        callback_data: `/pub cancel ${candidateId}`,
      },
    ],
  ];
}

function buildPreparePreview(candidate: WorkflowCandidate, expiresAt: number): string {
  const exp = new Date(expiresAt).toLocaleString("zh-CN", { hour12: false });
  return [
    `候选: ${candidate.id}`,
    `标题: ${candidate.payload.title}`,
    `slug: ${candidate.payload.slug}`,
    `categoryId: ${candidate.payload.categoryId}`,
    `blocks: ${candidate.payload.blocks.length}`,
    `到期: ${exp}`,
    "",
    "确认后将调用网站导入 API。",
  ].join("\n");
}

function buildPrepareReply(params: {
  ctx: WorkflowCommandContext;
  candidate: WorkflowCandidate;
  nonce: string;
  expiresAt: number;
  notice?: string;
}): ReplyPayload {
  const preview = buildPreparePreview(params.candidate, params.expiresAt);
  const text = params.notice ? `${params.notice}\n\n${preview}` : preview;
  const rows = buildConfirmRows(params.candidate.id, params.nonce);
  if (params.ctx.channel === "telegram") {
    return withTelegramButtons(text, rows);
  }
  return {
    text:
      `${text}\n\n` +
      `非 Telegram 渠道请手动执行:\n` +
      `/pub confirm ${params.candidate.id} ${params.nonce} draft`,
  };
}

async function sendTelegramCandidateCards(
  api: OpenClawPluginApi,
  ctx: WorkflowCommandContext,
  candidates: WorkflowCandidate[],
): Promise<boolean> {
  const target = resolveTelegramTarget(ctx);
  if (!target) {
    return false;
  }

  // Defensive: Telegram channel API may not be available in all configurations
  const telegram = api.runtime.channel?.telegram;
  if (!telegram?.sendMessageTelegram) {
    return false;
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    await telegram.sendMessageTelegram(target, formatCandidateCard(candidate, index), {
      accountId: ctx.accountId,
      messageThreadId: ctx.messageThreadId,
      buttons: [
        [
          {
            text: "准备发布",
            callback_data: `/pub prepare ${candidate.id}`,
          },
        ],
      ],
    });
  }

  return true;
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

function formatCollectDiagnostics(result: Awaited<ReturnType<WorkflowService["collect"]>>): string {
  const lines = [
    `新增 ${result.added} 条，去重跳过 ${result.skippedByDedupe} 条。`,
    `发现模式: ${result.discoveryMode}`,
  ];
  const detailPairs: Array<[string, number]> = [
    ["discovery失败", result.skippedByDiscovery],
    ["抓取失败", result.skippedByFetch],
    ["内容拒绝", result.skippedByQuality],
    ["翻译失败", result.skippedByTranslation],
  ];
  const details = detailPairs
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label}: ${count}`);
  if (details.length > 0) {
    lines.push(`跳过明细: ${details.join(" / ")}`);
  }
  return lines.join("\n");
}

export function registerWorkflowCommands(api: OpenClawPluginApi, service: WorkflowService): void {
  api.registerCommand({
    name: "scan",
    description: "搜索并采集候选文章，生成可发布候选。",
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
          text:
            `扫描完成: topic=${result.topic}, profile=${result.profile}\n` +
            formatCollectDiagnostics(result),
        };
      }

      const lines = [
        `扫描完成: topic=${result.topic}, profile=${result.profile}`,
        formatCollectDiagnostics(result),
        "",
        ...result.candidates.map((candidate, index) => formatCandidate(candidate, index)),
        "",
        "点击下方按钮进入两步发布流程。",
      ];
      const text = lines.join("\n");

      if (ctx.channel === "telegram") {
        const sent = await sendTelegramCandidateCards(api, ctx, result.candidates);
        if (sent) {
          return {
            text:
              `扫描完成: topic=${result.topic}, profile=${result.profile}\n` +
              `${formatCollectDiagnostics(result)}\n` +
              `已发送 ${result.candidates.length} 条候选卡片，每条链接都有独立\u201c准备发布\u201d按钮。`,
          };
        }
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
          const sent = await sendTelegramCandidateCards(api, ctx, candidates);
          if (sent) {
            return {
              text: `已发送 ${candidates.length} 条候选卡片，每条链接都有独立\u201c准备发布\u201d按钮。`,
            };
          }
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
        return buildPrepareReply({
          ctx,
          candidate: prepared.candidate,
          nonce: prepared.nonce,
          expiresAt: prepared.expiresAt,
        });
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
          if (confirmed.reason === "token_used" || confirmed.reason === "token_expired") {
            const prepared = service.preparePublish({ candidateId, actor });
            if (prepared.ok && prepared.candidate && prepared.nonce && prepared.expiresAt) {
              return buildPrepareReply({
                ctx,
                candidate: prepared.candidate,
                nonce: prepared.nonce,
                expiresAt: prepared.expiresAt,
                notice:
                  confirmed.reason === "token_used"
                    ? "上一个确认按钮已使用，已为你生成新的确认按钮。"
                    : "上一个确认按钮已过期，已为你生成新的确认按钮。",
              });
            }
          }
          const details: string[] = [];
          if (confirmed.translationFailure?.code) {
            details.push(`code: ${confirmed.translationFailure.code}`);
          }
          if (confirmed.reasonDetail) {
            details.push(`detail: ${confirmed.reasonDetail}`);
          }
          if (confirmed.translationFailure?.endpoint) {
            details.push(`endpoint: ${confirmed.translationFailure.endpoint}`);
          }
          if (confirmed.publishResult && !confirmed.publishResult.ok) {
            details.push(`status: ${confirmed.publishResult.status}`);
            if (confirmed.publishResult.responseText) {
              details.push(`response: ${confirmed.publishResult.responseText.slice(0, 300)}`);
            }
          }
          const detailText = details.length > 0 ? `\n${details.join("\n")}` : "";
          return { text: `发布失败: ${confirmed.reason ?? "unknown"}${detailText}` };
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

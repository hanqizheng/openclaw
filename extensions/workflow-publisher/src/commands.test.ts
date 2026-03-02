import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { registerWorkflowCommands } from "./commands.js";
import type { WorkflowService } from "./service.js";
import type { WorkflowCandidate } from "./types.js";

function makeCandidate(id: string, url: string): WorkflowCandidate {
  const now = Date.now();
  return {
    id,
    topic: "ai",
    title: `Title ${id}`,
    url,
    domain: "example.com",
    summaryMd: "summary",
    payload: {
      title: `Title ${id}`,
      slug: `title-${id}`,
      excerpt: "summary",
      isPublished: false,
      categoryId: 1,
      dataSource: "NEW",
      blocks: [{ type: "TEXT", content: "hi", metadata: {}, order: 0 }],
    },
    sourceProfile: "default",
    score: 0,
    status: "candidate",
    fingerprint: `fp-${id}`,
    createdAt: now,
    updatedAt: now,
  };
}

function createHarness(params?: {
  collectCandidates?: WorkflowCandidate[];
  listCandidates?: WorkflowCandidate[];
}) {
  const collectCandidates = params?.collectCandidates ?? [
    makeCandidate("c1", "https://example.com/a"),
  ];
  const listCandidates = params?.listCandidates ?? collectCandidates;

  const sendMessageTelegram = vi.fn(async () => ({ messageId: "m1", chatId: "chat1" }));
  const service = {
    config: {
      maxCandidatesPerRun: 10,
      approvers: [],
    },
    collect: vi.fn(async () => ({
      topic: "ai",
      profile: "default",
      added: collectCandidates.length,
      skippedByDedupe: 0,
      skippedByFetch: 0,
      skippedByDiscovery: 0,
      skippedByQuality: 0,
      skippedByTranslation: 0,
      discoveryMode: "api",
      candidates: collectCandidates,
    })),
    listCandidates: vi.fn(() => listCandidates),
    preparePublish: vi.fn(),
    confirmPublish: vi.fn(),
    cancelCandidate: vi.fn(),
  } as unknown as WorkflowService;

  const registered = new Map<
    string,
    (ctx: Record<string, unknown>) => Promise<Record<string, unknown>>
  >();
  const api = {
    runtime: {
      channel: {
        telegram: {
          sendMessageTelegram,
        },
      },
    },
    registerCommand: (command: {
      name: string;
      handler: (ctx: Record<string, unknown>) => Promise<Record<string, unknown>>;
    }) => {
      registered.set(command.name, command.handler);
    },
  } as unknown as OpenClawPluginApi;

  registerWorkflowCommands(api, service);

  const scan = registered.get("scan");
  const pub = registered.get("pub");
  if (!scan || !pub) {
    throw new Error("workflow commands not registered");
  }

  return {
    scan,
    pub,
    service,
    sendMessageTelegram,
  };
}

describe("workflow-publisher commands", () => {
  it("sends one Telegram card per candidate for /scan", async () => {
    const candidates = [
      makeCandidate("c1", "https://example.com/a"),
      makeCandidate("c2", "https://example.com/b"),
    ];
    const { scan, sendMessageTelegram } = createHarness({ collectCandidates: candidates });

    const reply = await scan({
      channel: "telegram",
      args: "ai",
      senderId: "12345",
      from: "telegram:12345",
      to: "telegram:-100123456",
      accountId: "default",
      messageThreadId: 7,
      isAuthorizedSender: true,
    });

    expect(sendMessageTelegram).toHaveBeenCalledTimes(2);
    const firstScanCall = sendMessageTelegram.mock.calls[0] as unknown[] | undefined;
    const secondScanCall = sendMessageTelegram.mock.calls[1] as unknown[] | undefined;
    expect(firstScanCall?.[1]).toContain("https://example.com/a");
    expect(secondScanCall?.[1]).toContain("https://example.com/b");
    expect(firstScanCall?.[2]).toMatchObject({
      accountId: "default",
      messageThreadId: 7,
      buttons: [[{ text: "准备发布", callback_data: "/pub prepare c1" }]],
    });
    expect(secondScanCall?.[2]).toMatchObject({
      buttons: [[{ text: "准备发布", callback_data: "/pub prepare c2" }]],
    });
    expect(reply.text).toContain("已发送 2 条候选卡片");
  });

  it("sends one Telegram card per candidate for /pub list", async () => {
    const candidates = [
      makeCandidate("c1", "https://example.com/a"),
      makeCandidate("c2", "https://example.com/b"),
    ];
    const { pub, sendMessageTelegram } = createHarness({ listCandidates: candidates });

    const reply = await pub({
      channel: "telegram",
      args: "list ai",
      senderId: "12345",
      from: "telegram:12345",
      to: "telegram:-100123456",
      isAuthorizedSender: true,
    });

    expect(sendMessageTelegram).toHaveBeenCalledTimes(2);
    const firstListCall = sendMessageTelegram.mock.calls[0] as unknown[] | undefined;
    const secondListCall = sendMessageTelegram.mock.calls[1] as unknown[] | undefined;
    expect(firstListCall?.[2]).toMatchObject({
      buttons: [[{ text: "准备发布", callback_data: "/pub prepare c1" }]],
    });
    expect(secondListCall?.[2]).toMatchObject({
      buttons: [[{ text: "准备发布", callback_data: "/pub prepare c2" }]],
    });
    expect(reply.text).toContain("独立“准备发布”按钮");
  });

  it("falls back to single text list when Telegram target is missing", async () => {
    const candidates = [makeCandidate("c1", "https://example.com/a")];
    const { pub, sendMessageTelegram } = createHarness({ listCandidates: candidates });

    const reply = await pub({
      channel: "telegram",
      args: "list",
      senderId: "not-a-chat-id",
      from: "telegram:not-a-chat-id",
      isAuthorizedSender: true,
    });

    expect(sendMessageTelegram).not.toHaveBeenCalled();
    expect(reply.text).toContain("待发布候选");
    expect(reply.text).toContain("https://example.com/a");
  });

  it("regenerates confirm buttons when nonce is already used", async () => {
    const candidate = makeCandidate("c1", "https://example.com/a");
    const { pub, service } = createHarness({ listCandidates: [candidate] });

    const prepareMock = vi.spyOn(service, "preparePublish").mockReturnValue({
      ok: true,
      candidate,
      nonce: "newnonce",
      expiresAt: Date.now() + 60_000,
    });
    vi.spyOn(service, "confirmPublish").mockResolvedValue({
      ok: false,
      reason: "token_used",
    });

    const reply = await pub({
      channel: "telegram",
      args: "confirm c1 oldnonce draft",
      senderId: "12345",
      from: "telegram:12345",
      to: "telegram:-100123456",
      isAuthorizedSender: true,
    });

    expect(prepareMock).toHaveBeenCalledWith({ candidateId: "c1", actor: "12345" });
    expect(reply.text).toContain("已为你生成新的确认按钮");
    expect(reply.channelData).toMatchObject({
      telegram: {
        buttons: [
          [{ text: "确认存草稿", callback_data: "/pub confirm c1 newnonce draft" }],
          [{ text: "确认并发布", callback_data: "/pub confirm c1 newnonce publish" }],
          [{ text: "取消", callback_data: "/pub cancel c1" }],
        ],
      },
    });
  });
});

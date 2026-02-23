import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowCandidate } from "./types.js";
import { WorkflowService } from "./service.js";

function buildCandidate(id: string): WorkflowCandidate {
  const now = Date.now();
  return {
    id,
    topic: "ai",
    title: "A title",
    url: "https://example.com/a",
    domain: "example.com",
    summaryMd: "summary",
    payload: {
      title: "A title",
      slug: "a-title",
      excerpt: "summary",
      isPublished: false,
      categoryId: 1,
      dataSource: "NEW",
      blocks: [{ type: "TEXT", content: "hello", metadata: {}, order: 0 }],
    },
    sourceProfile: "default",
    score: 0,
    status: "candidate",
    fingerprint: "fp-a",
    createdAt: now,
    updatedAt: now,
  };
}

describe("workflow service", () => {
  beforeEach(() => {
    delete process.env.ARTICLE_IMPORT_SECRET;
    delete process.env.ARTICLE_TRANSLATE_SECRET;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns failed publish result when import token is missing", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    try {
      const service = new WorkflowService({
        pluginConfig: {
          storage: { sqlitePath: path.join(tempDir, "workflow.sqlite") },
          sources: { profiles: { default: { domains: ["example.com"] } } },
          publishing: {
            api: {
              baseUrl: "http://127.0.0.1:5789",
              tokenEnv: "ARTICLE_IMPORT_SECRET",
            },
            translation: {
              enabled: false,
            },
          },
        },
        runtime: {
          state: { resolveStateDir: () => tempDir },
        },
      });

      const candidate = buildCandidate("cand-1");
      service.store.upsertCandidate(candidate);

      const prepared = service.preparePublish({ candidateId: candidate.id, actor: "u1" });
      expect(prepared.ok).toBe(true);

      const confirmed = await service.confirmPublish({
        candidateId: candidate.id,
        nonce: prepared.nonce as string,
        mode: "draft",
        actor: "u1",
      });
      expect(confirmed.ok).toBe(false);
      expect(confirmed.reason).toBe("publish_failed");
      expect(confirmed.publishResult?.ok).toBe(false);

      service.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("builds bilingual payload when translation endpoint succeeds", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    process.env.ARTICLE_TRANSLATE_SECRET = "token";
    try {
      const service = new WorkflowService({
        pluginConfig: {
          storage: { sqlitePath: path.join(tempDir, "workflow.sqlite") },
          sources: { profiles: { default: { domains: ["example.com"] } } },
          publishing: {
            translation: {
              enabled: true,
              model: "mock-model",
              api: {
                baseUrl: "http://127.0.0.1:5789",
                path: "/api/integrations/articles/translate",
                tokenEnv: "ARTICLE_TRANSLATE_SECRET",
                timeoutSeconds: 10,
              },
            },
          },
        },
        runtime: {
          state: { resolveStateDir: () => tempDir },
        },
      });

      const fetchMock = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            zh: {
              title: "中文标题",
              excerpt: "中文摘要",
              blocks: [{ content: "中文正文" }],
            },
            en: {
              title: "English title",
              excerpt: "English excerpt",
              blocks: [{ content: "English body" }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const translated = await service.buildBilingualPayload(buildCandidate("cand-1").payload);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(translated.title).toBe("中文标题");
      expect(translated.excerpt).toBe("中文摘要");
      expect(translated.blocks[0]?.content).toBe("中文正文");
      expect(translated.slug).toBe("english-title");

      const enTranslation = translated.translations?.en as {
        title?: string;
        excerpt?: string;
      };
      expect(enTranslation.title).toBe("English title");
      expect(enTranslation.excerpt).toBe("English excerpt");

      const blockTranslations = translated.blockTranslations as
        | Record<string, Record<string, { content?: string }>>
        | undefined;
      expect(blockTranslations?.["0"]?.en?.content).toBe("English body");
      expect(blockTranslations?.en).toBeUndefined();

      service.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("parses full article-style bilingual payload response", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    process.env.ARTICLE_TRANSLATE_SECRET = "token";
    try {
      const service = new WorkflowService({
        pluginConfig: {
          storage: { sqlitePath: path.join(tempDir, "workflow.sqlite") },
          sources: { profiles: { default: { domains: ["example.com"] } } },
          publishing: {
            translation: {
              enabled: true,
              model: "mock-model",
              api: {
                baseUrl: "http://127.0.0.1:5789",
                path: "/api/integrations/articles/translate",
                tokenEnv: "ARTICLE_TRANSLATE_SECRET",
                timeoutSeconds: 10,
              },
            },
          },
        },
        runtime: {
          state: { resolveStateDir: () => tempDir },
        },
      });

      const fetchMock = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            title: "新加坡乌节路适合家庭长期居住吗？生活便利与学区分析",
            slug: "singapore-orchard-road-family-living-convenience-schools",
            excerpt: "中文摘要",
            blocks: [{ type: "TEXT", content: "中文正文", metadata: {}, order: 0 }],
            translations: {
              en: {
                title: "Is Orchard Road Suitable for Long-Term Family Living in Singapore?",
                excerpt: "English excerpt",
              },
            },
            blockTranslations: {
              "0": {
                en: {
                  content: "English body",
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const translated = await service.buildBilingualPayload(
        buildCandidate("cand-article").payload,
      );
      expect(translated.title).toBe("新加坡乌节路适合家庭长期居住吗？生活便利与学区分析");
      expect(translated.slug).toBe("singapore-orchard-road-family-living-convenience-schools");
      expect(translated.excerpt).toBe("中文摘要");
      expect(translated.blocks[0]?.content).toBe("中文正文");
      expect(translated.translations?.en?.title).toBe(
        "Is Orchard Road Suitable for Long-Term Family Living in Singapore?",
      );
      expect(
        (translated.blockTranslations as Record<string, Record<string, { content?: string }>>)?.[
          "0"
        ]?.en?.content,
      ).toBe("English body");

      service.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses import token as fallback for translation token", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    process.env.ARTICLE_IMPORT_SECRET = "import-token";
    try {
      const service = new WorkflowService({
        pluginConfig: {
          storage: { sqlitePath: path.join(tempDir, "workflow.sqlite") },
          sources: { profiles: { default: { domains: ["example.com"] } } },
          publishing: {
            api: {
              baseUrl: "http://127.0.0.1:5789",
              tokenEnv: "ARTICLE_IMPORT_SECRET",
            },
            translation: {
              enabled: true,
              model: "mock-model",
              api: {
                baseUrl: "http://127.0.0.1:5789",
                path: "/api/integrations/articles/translate",
                tokenEnv: "ARTICLE_TRANSLATE_SECRET",
                timeoutSeconds: 10,
              },
            },
          },
        },
        runtime: {
          state: { resolveStateDir: () => tempDir },
        },
      });

      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
          "Bearer import-token",
        );
        return new Response(
          JSON.stringify({
            zh: {
              title: "中文标题",
              excerpt: "中文摘要",
              blocks: [{ content: "中文正文" }],
            },
            en: {
              title: "English title",
              excerpt: "English excerpt",
              blocks: [{ content: "English body" }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const translated = await service.buildBilingualPayload(
        buildCandidate("cand-fallback").payload,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(translated.title).toBe("中文标题");
      expect(translated.translations?.en?.title).toBe("English title");
      expect(
        (translated.blockTranslations as Record<string, Record<string, { content?: string }>>)?.[
          "0"
        ]?.en?.content,
      ).toBe("English body");

      service.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("retranslates when existing en bundle is only a mirrored fallback", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    process.env.ARTICLE_TRANSLATE_SECRET = "token";
    try {
      const service = new WorkflowService({
        pluginConfig: {
          storage: { sqlitePath: path.join(tempDir, "workflow.sqlite") },
          sources: { profiles: { default: { domains: ["example.com"] } } },
          publishing: {
            translation: {
              enabled: true,
              model: "mock-model",
              api: {
                baseUrl: "http://127.0.0.1:5789",
                path: "/api/integrations/articles/translate",
                tokenEnv: "ARTICLE_TRANSLATE_SECRET",
                timeoutSeconds: 10,
              },
            },
          },
        },
        runtime: {
          state: { resolveStateDir: () => tempDir },
        },
      });

      const mirrored = buildCandidate("cand-mirror").payload;
      mirrored.translations = {
        en: {
          title: mirrored.title,
          excerpt: mirrored.excerpt,
        },
      };

      const fetchMock = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            zh: {
              title: "中文标题",
              excerpt: "中文摘要",
              blocks: [{ content: "中文正文" }],
            },
            en: {
              title: "English title",
              excerpt: "English excerpt",
              blocks: [{ content: "English body" }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const translated = await service.buildBilingualPayload(mirrored);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(translated.title).toBe("中文标题");
      expect(translated.translations?.en?.title).toBe("English title");

      service.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("throws when translation is unavailable in strict mode", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    try {
      const service = new WorkflowService({
        pluginConfig: {
          storage: { sqlitePath: path.join(tempDir, "workflow.sqlite") },
          sources: { profiles: { default: { domains: ["example.com"] } } },
          publishing: {
            translation: {
              enabled: true,
              api: {
                baseUrl: "http://127.0.0.1:5789",
                path: "/api/integrations/articles/translate",
                tokenEnv: "ARTICLE_TRANSLATE_SECRET",
              },
            },
          },
        },
        runtime: {
          state: { resolveStateDir: () => tempDir },
        },
      });

      const payload = buildCandidate("cand-1").payload;
      await expect(service.buildBilingualPayload(payload)).rejects.toThrow("missing env");
      service.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("blocks confirm publish when translation pipeline fails", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    try {
      const service = new WorkflowService({
        pluginConfig: {
          storage: { sqlitePath: path.join(tempDir, "workflow.sqlite") },
          sources: { profiles: { default: { domains: ["example.com"] } } },
          publishing: {
            api: {
              baseUrl: "http://127.0.0.1:5789",
              importPath: "/api/integrations/articles/import",
              tokenEnv: "ARTICLE_IMPORT_SECRET",
            },
            translation: {
              enabled: true,
              model: "mock-model",
              api: {
                baseUrl: "http://127.0.0.1:5789",
                path: "/api/integrations/articles/translate",
                tokenEnv: "ARTICLE_TRANSLATE_SECRET",
              },
            },
          },
        },
        runtime: {
          state: { resolveStateDir: () => tempDir },
        },
      });

      const candidate = buildCandidate("cand-translation-fail");
      service.store.upsertCandidate(candidate);
      const prepared = service.preparePublish({ candidateId: candidate.id, actor: "u1" });
      const confirmed = await service.confirmPublish({
        candidateId: candidate.id,
        nonce: prepared.nonce as string,
        mode: "draft",
        actor: "u1",
      });

      expect(confirmed.ok).toBe(false);
      expect(confirmed.reason).toBe("translation_failed");
      expect(confirmed.translationFailure?.code).toBe("translation_token_missing");
      expect(confirmed.publishResult).toBeUndefined();

      service.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses structured translations schema when confirming draft publish", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    process.env.ARTICLE_IMPORT_SECRET = "import-token";
    process.env.ARTICLE_TRANSLATE_SECRET = "translate-token";
    try {
      const service = new WorkflowService({
        pluginConfig: {
          storage: { sqlitePath: path.join(tempDir, "workflow.sqlite") },
          sources: { profiles: { default: { domains: ["example.com"] } } },
          publishing: {
            api: {
              baseUrl: "http://127.0.0.1:5789",
              importPath: "/api/integrations/articles/import",
              tokenEnv: "ARTICLE_IMPORT_SECRET",
            },
            translation: {
              enabled: true,
              model: "mock-model",
              api: {
                baseUrl: "http://127.0.0.1:5789",
                path: "/api/integrations/articles/translate",
                tokenEnv: "ARTICLE_TRANSLATE_SECRET",
              },
            },
          },
        },
        runtime: {
          state: { resolveStateDir: () => tempDir },
        },
      });

      let importRequestBody: Record<string, unknown> | undefined;
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/integrations/articles/translate")) {
          return new Response(
            JSON.stringify({
              zh: {
                title: "中文标题",
                excerpt: "中文摘要",
                blocks: [{ content: "中文正文" }],
              },
              en: {
                title: "English title",
                excerpt: "English excerpt",
                blocks: [{ content: "English body" }],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (url.endsWith("/api/integrations/articles/import")) {
          importRequestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          return new Response(JSON.stringify({ success: true, data: { id: 999, slug: "ok" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const candidate = buildCandidate("cand-1");
      service.store.upsertCandidate(candidate);
      const prepared = service.preparePublish({ candidateId: candidate.id, actor: "u1" });
      const confirmed = await service.confirmPublish({
        candidateId: candidate.id,
        nonce: prepared.nonce as string,
        mode: "draft",
        actor: "u1",
      });

      expect(confirmed.ok).toBe(true);
      expect(importRequestBody).toBeDefined();
      const translations = (importRequestBody?.translations ?? {}) as Record<
        string,
        { title?: string; excerpt?: string }
      >;
      expect(translations.en?.title).toBe("English title");
      expect(translations.en?.excerpt).toBe("English excerpt");
      const blockTranslations = (importRequestBody?.blockTranslations ?? {}) as Record<
        string,
        Record<string, { content?: string }>
      >;
      expect(blockTranslations["0"]?.en?.content).toBe("English body");
      expect((importRequestBody?.blockTranslations as Record<string, unknown>)?.en).toBeUndefined();

      service.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("retries with unique slug after slug conflict", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    process.env.ARTICLE_IMPORT_SECRET = "import-token";
    try {
      const service = new WorkflowService({
        pluginConfig: {
          storage: { sqlitePath: path.join(tempDir, "workflow.sqlite") },
          sources: { profiles: { default: { domains: ["example.com"] } } },
          publishing: {
            api: {
              baseUrl: "http://127.0.0.1:5789",
              importPath: "/api/integrations/articles/import",
              tokenEnv: "ARTICLE_IMPORT_SECRET",
            },
            translation: {
              enabled: false,
            },
          },
        },
        runtime: {
          state: { resolveStateDir: () => tempDir },
        },
      });

      const importPayloads: Array<Record<string, unknown>> = [];
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        importPayloads.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        if (importPayloads.length === 1) {
          return new Response(
            JSON.stringify({ success: false, error: "Article slug already exists." }),
            {
              status: 409,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify({ success: true, data: { id: 1001, slug: "ok" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const candidate = buildCandidate("abcdef1234");
      service.store.upsertCandidate(candidate);
      const prepared = service.preparePublish({ candidateId: candidate.id, actor: "u1" });
      const confirmed = await service.confirmPublish({
        candidateId: candidate.id,
        nonce: prepared.nonce as string,
        mode: "draft",
        actor: "u1",
      });

      expect(confirmed.ok).toBe(true);
      expect(importPayloads).toHaveLength(2);
      const firstSlug = String(importPayloads[0]?.slug ?? "");
      const secondSlug = String(importPayloads[1]?.slug ?? "");
      expect(firstSlug).toBe(candidate.payload.slug);
      expect(secondSlug).not.toBe(firstSlug);
      expect(secondSlug).toContain(candidate.id.slice(0, 6));

      service.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses LLM-generated title and slug during collect", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    process.env.ARTICLE_TRANSLATE_SECRET = "translate-token";
    try {
      const service = new WorkflowService({
        pluginConfig: {
          storage: { sqlitePath: path.join(tempDir, "workflow.sqlite") },
          sources: { profiles: { default: { domains: ["example.com"] } } },
          publishing: {
            translation: {
              enabled: true,
              model: "mock-model",
              api: {
                baseUrl: "http://127.0.0.1:5789",
                path: "/api/integrations/articles/translate",
                tokenEnv: "ARTICLE_TRANSLATE_SECRET",
              },
            },
          },
        },
        runtime: {
          state: { resolveStateDir: () => tempDir },
        },
      });

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/integrations/articles/translate")) {
          return new Response(
            JSON.stringify({
              zh: {
                title: "越南签证新规解读",
                slug: "vietnam-visa-rule-update",
                excerpt: "中文摘要",
                blocks: [{ content: "中文正文" }],
              },
              en: {
                title: "Vietnam Visa Rule Update",
                excerpt: "English excerpt",
                blocks: [{ content: "English body" }],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("<html><body><h1>Homepage</h1><p>Latest bulletin.</p></body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await service.collect({ topic: "越南", actor: "u1", limit: 1 });
      expect(result.added).toBe(1);
      expect(result.candidates[0]?.title).toBe("越南签证新规解读");
      expect(result.candidates[0]?.payload.slug).toBe("vietnam-visa-rule-update");
      expect(result.candidates[0]?.payload.title).not.toMatch(/^Embassy Update -/i);

      service.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("scopes collect dedupe by topic", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    try {
      const service = new WorkflowService({
        pluginConfig: {
          storage: { sqlitePath: path.join(tempDir, "workflow.sqlite") },
          sources: { profiles: { default: { domains: ["example.com"] } } },
          publishing: {
            translation: {
              enabled: false,
            },
          },
        },
        runtime: {
          state: { resolveStateDir: () => tempDir },
        },
      });

      const fetchMock = vi.fn(async () => {
        return new Response("<html><body><h1>Update</h1><p>Latest bulletin.</p></body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const firstTopic = await service.collect({ topic: "japan", actor: "u1" });
      expect(firstTopic.added).toBeGreaterThan(0);
      expect(firstTopic.skippedByDedupe).toBe(0);

      const secondTopic = await service.collect({ topic: "thailand", actor: "u1" });
      expect(secondTopic.added).toBeGreaterThan(0);
      expect(secondTopic.skippedByDedupe).toBe(0);

      const repeatSameTopic = await service.collect({ topic: "thailand", actor: "u1" });
      expect(repeatSameTopic.added).toBe(0);
      expect(repeatSameTopic.skippedByDedupe).toBeGreaterThan(0);

      service.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

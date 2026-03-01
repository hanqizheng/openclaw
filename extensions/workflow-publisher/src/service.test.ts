import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowService } from "./service.js";
import type { WorkflowCandidate } from "./types.js";

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
      legacyContent: null,
      blocks: [{ type: "TEXT", content: "hello", metadata: {}, order: 0 }],
    },
    sourceProfile: "default",
    score: 0,
    status: "candidate",
    fingerprint: `fp-${id}`,
    createdAt: now,
    updatedAt: now,
  };
}

function makeService(params: {
  tempDir: string;
  publishing?: Record<string, unknown>;
  sources?: Record<string, unknown>;
}): WorkflowService {
  return new WorkflowService({
    pluginConfig: {
      storage: { sqlitePath: path.join(params.tempDir, "workflow.sqlite") },
      sources: params.sources ?? { profiles: { default: { domains: ["example.com"] } } },
      publishing: params.publishing ?? {
        translation: {
          enabled: false,
        },
      },
    },
    runtime: {
      state: { resolveStateDir: () => params.tempDir },
    },
  });
}

function longHtmlContent(): string {
  return `<html><body><article><h1>Story</h1><p>${"news content ".repeat(120)}</p></article></body></html>`;
}

describe("workflow service", () => {
  beforeEach(() => {
    delete process.env.ARTICLE_IMPORT_SECRET;
    delete process.env.ARTICLE_TRANSLATE_SECRET;
    delete process.env.ARTICLE_DISCOVERY_SECRET;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns failed publish result when import token is missing", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    try {
      const service = makeService({
        tempDir,
        publishing: {
          api: {
            baseUrl: "http://127.0.0.1:5789",
            tokenEnv: "ARTICLE_IMPORT_SECRET",
          },
          translation: {
            enabled: false,
          },
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

  it("uses translation token as fallback for publish import token", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    process.env.ARTICLE_TRANSLATE_SECRET = "shared-token";
    try {
      const service = makeService({
        tempDir,
        publishing: {
          api: {
            baseUrl: "http://127.0.0.1:5789",
            importPath: "/api/integrations/articles/import",
            tokenEnv: "ARTICLE_IMPORT_SECRET",
          },
          translation: {
            enabled: false,
            api: {
              baseUrl: "http://127.0.0.1:5789",
              path: "/api/integrations/articles/translate",
              tokenEnv: "ARTICLE_TRANSLATE_SECRET",
            },
          },
          discovery: {
            enabled: false,
            api: {
              baseUrl: "http://127.0.0.1:5789",
              path: "/api/integrations/articles/search",
              tokenEnv: "ARTICLE_DISCOVERY_SECRET",
            },
          },
        },
      });

      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
          "Bearer shared-token",
        );
        return new Response(JSON.stringify({ success: true, data: { id: 1, slug: "ok" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const candidate = buildCandidate("cand-import-fallback");
      service.store.upsertCandidate(candidate);
      const prepared = service.preparePublish({ candidateId: candidate.id, actor: "u1" });
      const confirmed = await service.confirmPublish({
        candidateId: candidate.id,
        nonce: prepared.nonce as string,
        mode: "draft",
        actor: "u1",
      });

      expect(confirmed.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      service.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("builds bilingual payload when translation endpoint succeeds", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    process.env.ARTICLE_TRANSLATE_SECRET = "token";
    try {
      const service = makeService({
        tempDir,
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
      expect(translated.translations?.en?.title).toBe("English title");
      expect(translated.translations?.en?.excerpt).toBe("English excerpt");
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

  it("falls back to direct llm when translation endpoint returns 404", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    process.env.ARTICLE_TRANSLATE_SECRET = "token";
    try {
      const service = makeService({
        tempDir,
        publishing: {
          translation: {
            enabled: true,
            model: "deepseek-chat",
            api: {
              baseUrl: "http://127.0.0.1:5789",
              path: "/api/integrations/articles/translate",
              tokenEnv: "ARTICLE_TRANSLATE_SECRET",
              timeoutSeconds: 10,
            },
          },
        },
      });

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/integrations/articles/translate")) {
          return new Response("<html>not found</html>", {
            status: 404,
            headers: { "Content-Type": "text/html" },
          });
        }
        if (url === "https://api.deepseek.com/v1/chat/completions") {
          return new Response(
            JSON.stringify({
              id: "chatcmpl-fallback",
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      zh: {
                        title: "越南领事服务办理指南",
                        slug: "vietnam-consular-service-guide",
                        excerpt: "中文摘要",
                        blocks: [{ content: "中文正文" }],
                      },
                      en: {
                        title: "Vietnam Consular Service Guide",
                        excerpt: "English excerpt",
                        blocks: [{ content: "English body" }],
                      },
                    }),
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error(`unexpected fetch url: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const translated = await service.buildBilingualPayload(
        buildCandidate("cand-fallback").payload,
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(translated.title).toBe("越南领事服务办理指南");
      expect(translated.slug).toBe("vietnam-consular-service-guide");
      expect(translated.translations?.en?.title).toBe("Vietnam Consular Service Guide");

      service.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("throws when translation token is missing in strict mode", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    try {
      const service = makeService({
        tempDir,
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
      });

      await expect(service.buildBilingualPayload(buildCandidate("cand-2").payload)).rejects.toThrow(
        "missing env",
      );
      service.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("blocks confirm publish when translation pipeline fails", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    try {
      const service = makeService({
        tempDir,
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

  it("retries with unique slug after slug conflict", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    process.env.ARTICLE_IMPORT_SECRET = "import-token";
    try {
      const service = makeService({
        tempDir,
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

  it("collect uses discovery hits and generates title/slug from translation", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    process.env.ARTICLE_TRANSLATE_SECRET = "translate-token";
    try {
      const service = makeService({
        tempDir,
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
          discovery: {
            enabled: true,
            maxResultsPerQuery: 5,
            minContentChars: 800,
            api: {
              baseUrl: "http://127.0.0.1:5789",
              path: "/api/integrations/articles/search",
              tokenEnv: "ARTICLE_TRANSLATE_SECRET",
            },
          },
        },
      });

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/integrations/articles/search")) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  url: "https://example.com/news/story-1",
                  title: "Story One",
                  snippet: "Discovery snippet",
                  language: "en",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
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
        return new Response(longHtmlContent(), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await service.collect({ topic: "越南", actor: "u1", limit: 1 });
      expect(result.discoveryMode).toBe("api");
      expect(result.added).toBe(1);
      expect(result.candidates[0]?.title).toBe("越南签证新规解读");
      expect(result.candidates[0]?.payload.slug).toBe("vietnam-visa-rule-update");
      expect(result.skippedByDiscovery).toBe(0);

      service.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to seed crawl when discovery API fails", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    process.env.ARTICLE_TRANSLATE_SECRET = "translate-token";
    try {
      const service = makeService({
        tempDir,
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
          discovery: {
            enabled: true,
            maxResultsPerQuery: 5,
            minContentChars: 800,
            api: {
              baseUrl: "http://127.0.0.1:5789",
              path: "/api/integrations/articles/search",
              tokenEnv: "ARTICLE_TRANSLATE_SECRET",
            },
          },
        },
      });

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/integrations/articles/search")) {
          return new Response(JSON.stringify({ error: "timeout" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith("/api/integrations/articles/translate")) {
          return new Response(
            JSON.stringify({
              zh: {
                title: "降级抓取成功",
                slug: "fallback-crawl-success",
                excerpt: "中文摘要",
                blocks: [{ content: "中文正文" }],
              },
              en: {
                title: "Fallback Crawl Success",
                excerpt: "English excerpt",
                blocks: [{ content: "English body" }],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(longHtmlContent(), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await service.collect({ topic: "越南", actor: "u1", limit: 1 });
      expect(result.discoveryMode).toBe("seed-fallback");
      expect(result.skippedByDiscovery).toBe(1);
      expect(result.added).toBe(1);

      service.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects candidate when source content is too short", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    process.env.ARTICLE_TRANSLATE_SECRET = "translate-token";
    try {
      const service = makeService({
        tempDir,
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
          discovery: {
            enabled: true,
            maxResultsPerQuery: 5,
            minContentChars: 800,
            api: {
              baseUrl: "http://127.0.0.1:5789",
              path: "/api/integrations/articles/search",
              tokenEnv: "ARTICLE_TRANSLATE_SECRET",
            },
          },
        },
      });

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/integrations/articles/search")) {
          return new Response(
            JSON.stringify({
              results: [{ url: "https://example.com/news/short-story", title: "Short Story" }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/integrations/articles/translate")) {
          throw new Error("translation should not be called for rejected content");
        }
        return new Response("<html><body><p>tiny content</p></body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await service.collect({ topic: "越南", actor: "u1", limit: 1 });
      expect(result.added).toBe(0);
      expect(result.skippedByQuality).toBe(1);
      expect(result.skippedByTranslation).toBe(0);

      service.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("hard-fails template title generation during collect without storing candidate", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    process.env.ARTICLE_TRANSLATE_SECRET = "translate-token";
    try {
      const service = makeService({
        tempDir,
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
          discovery: {
            enabled: true,
            maxResultsPerQuery: 5,
            minContentChars: 800,
            api: {
              baseUrl: "http://127.0.0.1:5789",
              path: "/api/integrations/articles/search",
              tokenEnv: "ARTICLE_TRANSLATE_SECRET",
            },
          },
        },
      });

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/integrations/articles/search")) {
          return new Response(
            JSON.stringify({
              results: [
                { url: "https://example.com/news/template-story", title: "Template Story" },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/integrations/articles/translate")) {
          return new Response(
            JSON.stringify({
              zh: {
                title: "Embassy Update - example.com",
                slug: "embassy-update-example-com",
                excerpt: "模板摘要",
                blocks: [{ content: "模板正文" }],
              },
              en: {
                title: "Embassy Update - example.com",
                excerpt: "template excerpt",
                blocks: [{ content: "template body" }],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(longHtmlContent(), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await service.collect({ topic: "越南", actor: "u1", limit: 1 });
      expect(result.added).toBe(0);
      expect(result.skippedByTranslation).toBe(1);
      expect(service.listCandidates({ status: "candidate" })).toHaveLength(0);

      service.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("scopes collect dedupe by topic", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
    try {
      const service = makeService({
        tempDir,
        publishing: {
          translation: {
            enabled: false,
          },
          discovery: {
            enabled: false,
            minContentChars: 200,
          },
        },
      });

      const fetchMock = vi.fn(async () => {
        return new Response(longHtmlContent(), {
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

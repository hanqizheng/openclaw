import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
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
});

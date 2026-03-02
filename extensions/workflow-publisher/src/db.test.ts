import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowStore } from "./db.js";
import type { WorkflowCandidate } from "./types.js";

function makeCandidate(id: string): WorkflowCandidate {
  const now = Date.now();
  return {
    id,
    topic: "ai",
    title: "Title",
    url: "https://example.com/a",
    domain: "example.com",
    summaryMd: "summary",
    payload: {
      title: "Title",
      slug: "title",
      excerpt: "summary",
      isPublished: false,
      categoryId: 1,
      dataSource: "NEW",
      blocks: [{ type: "TEXT", content: "hi", metadata: {}, order: 0 }],
    },
    sourceProfile: "default",
    score: 0,
    status: "candidate",
    fingerprint: "fp-1",
    createdAt: now,
    updatedAt: now,
  };
}

describe("workflow-publisher store", () => {
  it("stores candidates and handles callback token lifecycle", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "workflow-publisher-db-"));
    try {
      const store = new WorkflowStore(path.join(tempDir, "workflow.sqlite"));
      const candidate = makeCandidate("c1");
      store.upsertCandidate(candidate);
      const listed = store.listCandidates({ status: "candidate", limit: 5 });
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe("c1");

      const now = Date.now();
      store.createCallbackToken("c1", "nonce-1", now + 60_000, now);
      const consumed = store.consumeCallbackToken("c1", "nonce-1", now + 1_000);
      expect(consumed.ok).toBe(true);
      const consumedAgain = store.consumeCallbackToken("c1", "nonce-1", now + 2_000);
      expect(consumedAgain.ok).toBe(false);
      expect(consumedAgain.reason).toBe("used");

      store.recordPublishAttempt({
        idempotencyKey: "idem-1",
        candidateId: "c1",
        mode: "draft",
        requestedBy: "u1",
        requestJson: "{}",
        responseJson: '{"ok":true}',
        statusCode: 200,
        resultStatus: "success",
        createdAt: now,
      });
      const cached = store.getRecentSuccessfulAttemptByIdempotency("idem-1");
      expect(cached?.statusCode).toBe(200);

      store.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

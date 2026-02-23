import { describe, expect, it } from "vitest";
import { normalizeBlocks, normalizePayload, slugify } from "./article.js";

describe("workflow-publisher article helpers", () => {
  it("normalizes valid block types and reindexes order", () => {
    const blocks = normalizeBlocks([
      { type: "text", content: "a", metadata: {}, order: 99 },
      { type: "IMAGE", content: "https://img", metadata: { alt: "x" }, order: 0 },
      { type: "bad", content: "skip", metadata: {}, order: 1 },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe("TEXT");
    expect(blocks[0]?.order).toBe(0);
    expect(blocks[1]?.type).toBe("IMAGE");
    expect(blocks[1]?.order).toBe(1);
  });

  it("fills defaults when payload fields are missing", () => {
    const payload = normalizePayload({
      raw: {},
      fallbackTitle: "Hello World",
      fallbackCategoryId: 9,
      defaultIsPublished: false,
      defaultDataSource: "NEW",
      sourceUrl: "https://example.com/a",
      summaryMd: "summary",
    });
    expect(payload.title).toBe("Hello World");
    expect(payload.slug).toBe("hello-world");
    expect(payload.categoryId).toBe(9);
    expect(payload.blocks.length).toBeGreaterThan(0);
  });

  it("slugify falls back to timestamp format for non-ascii-only titles", () => {
    const slug = slugify("你好");
    expect(slug.startsWith("article-")).toBe(true);
  });

  it("normalizes coverImage from string or array and defaults legacyContent to null", () => {
    const fromString = normalizePayload({
      raw: {
        coverImage: "cover-a.jpg",
      },
      fallbackTitle: "Hello World",
      fallbackCategoryId: 9,
      defaultIsPublished: false,
      defaultDataSource: "NEW",
      sourceUrl: "https://example.com/a",
      summaryMd: "summary",
    });
    expect(fromString.coverImage).toBe("cover-a.jpg");
    expect(fromString.legacyContent).toBeNull();

    const fromArray = normalizePayload({
      raw: {
        coverImage: ["cover-b.jpg", "cover-c.jpg"],
        legacyContent: "legacy markdown",
      },
      fallbackTitle: "Hello World",
      fallbackCategoryId: 9,
      defaultIsPublished: false,
      defaultDataSource: "NEW",
      sourceUrl: "https://example.com/a",
      summaryMd: "summary",
    });
    expect(fromArray.coverImage).toBe("cover-b.jpg");
    expect(fromArray.legacyContent).toBe("legacy markdown");
  });
});

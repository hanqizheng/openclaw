type SourceLinkInput = {
  url: string;
  label?: string;
  labelZh?: string;
  labelEn?: string;
};

export type BlockInput = {
  type: string; // TEXT | HTML | QA
  contentZh?: string; // Chinese content (markdown for TEXT/HTML, text for QA)
  contentEn?: string; // English content for translatable types
};

type BuildArticlePayloadInput = {
  slug: string;
  titleZh: string;
  titleEn: string;
  excerptZh: string;
  excerptEn: string;
  bodyMarkdownZh?: string;
  bodyMarkdownEn?: string;
  blocks?: BlockInput[];
  categoryId?: number;
  coverImage?: string;
  seoTitleZh?: string;
  seoTitleEn?: string;
  seoDescriptionZh?: string;
  seoDescriptionEn?: string;
  sourceLinks?: SourceLinkInput[];
};

type BuildArticlePayloadDefaults = {
  defaultCategoryId?: number;
};

export function buildArticleImportPayload(
  input: BuildArticlePayloadInput,
  defaults: BuildArticlePayloadDefaults,
) {
  const sourceLinks = normalizeSourceLinks(input.sourceLinks);
  const { blocks, blockTranslations } = resolveBlocks(input, sourceLinks);
  const categoryId =
    typeof input.categoryId === "number" && Number.isInteger(input.categoryId)
      ? input.categoryId
      : defaults.defaultCategoryId;

  const payload = compactRecord({
    title: input.titleZh.trim(),
    slug: input.slug.trim(),
    excerpt: input.excerptZh.trim(),
    coverImage: readOptionalString(input.coverImage),
    isPublished: false,
    categoryId,
    dataSource: "NEW",
    legacyContent: null,
    metadata: compactRecord({
      seoTitle: readOptionalString(input.seoTitleZh) ?? `${input.titleZh.trim()} | AIAIG`,
      seoDescription: readOptionalString(input.seoDescriptionZh) ?? input.excerptZh.trim(),
    }),
    blocks,
    translations: {
      en: compactRecord({
        title: input.titleEn.trim(),
        excerpt: input.excerptEn.trim(),
        metadata: compactRecord({
          seoTitle: readOptionalString(input.seoTitleEn) ?? `${input.titleEn.trim()} | AIAIG`,
          seoDescription: readOptionalString(input.seoDescriptionEn) ?? input.excerptEn.trim(),
        }),
      }),
    },
    blockTranslations,
  });

  return {
    payload,
    payloadJson: `${JSON.stringify(payload, null, 2)}\n`,
    preview: {
      titleZh: input.titleZh.trim(),
      titleEn: input.titleEn.trim(),
      slug: input.slug.trim(),
      categoryId,
      blockCount: blocks.length,
      sourceCount: sourceLinks.length,
      excerptZh: input.excerptZh.trim(),
      excerptEn: input.excerptEn.trim(),
    },
  };
}

const TRANSLATABLE_BLOCK_TYPES = new Set(["TEXT", "QUOTE", "HTML", "LINK", "QA"]);

/** Build payload blocks + blockTranslations from explicit blocks array or legacy single-body fields. */
function resolveBlocks(
  input: BuildArticlePayloadInput,
  sourceLinks: SourceLinkInput[],
): {
  blocks: Array<{
    type: string;
    content: string;
    metadata: Record<string, unknown>;
    order: number;
  }>;
  blockTranslations: Record<string, { en: { content: string; metadata: Record<string, unknown> } }>;
} {
  if (Array.isArray(input.blocks) && input.blocks.length > 0) {
    return resolveExplicitBlocks(input.blocks, sourceLinks);
  }
  // Backward compat: single TEXT block from bodyMarkdownZh/bodyMarkdownEn
  return resolveLegacySingleBlock(input, sourceLinks);
}

function resolveExplicitBlocks(
  inputBlocks: BlockInput[],
  sourceLinks: SourceLinkInput[],
): {
  blocks: Array<{
    type: string;
    content: string;
    metadata: Record<string, unknown>;
    order: number;
  }>;
  blockTranslations: Record<string, { en: { content: string; metadata: Record<string, unknown> } }>;
} {
  const blocks: Array<{
    type: string;
    content: string;
    metadata: Record<string, unknown>;
    order: number;
  }> = [];
  const blockTranslations: Record<
    string,
    { en: { content: string; metadata: Record<string, unknown> } }
  > = {};

  // Find the last TEXT block index so we can append source links to it
  let lastTextIndex = -1;
  for (let i = inputBlocks.length - 1; i >= 0; i--) {
    if (inputBlocks[i].type === "TEXT") {
      lastTextIndex = i;
      break;
    }
  }

  for (let i = 0; i < inputBlocks.length; i++) {
    const block = inputBlocks[i];
    const built = buildSingleBlock(block, i);

    // Append source links to the last TEXT block
    if (i === lastTextIndex && sourceLinks.length > 0) {
      built.content = appendSourcesSection(built.content, sourceLinks, "zh");
    }

    blocks.push(built);

    if (TRANSLATABLE_BLOCK_TYPES.has(block.type)) {
      const translation = buildSingleBlockTranslation(block);

      // Append source links to the last TEXT block's English translation too
      if (i === lastTextIndex && sourceLinks.length > 0) {
        translation.content = appendSourcesSection(translation.content, sourceLinks, "en");
      }

      blockTranslations[String(i)] = { en: translation };
    }
  }

  return { blocks, blockTranslations };
}

function resolveLegacySingleBlock(
  input: BuildArticlePayloadInput,
  sourceLinks: SourceLinkInput[],
): {
  blocks: Array<{
    type: string;
    content: string;
    metadata: Record<string, unknown>;
    order: number;
  }>;
  blockTranslations: Record<string, { en: { content: string; metadata: Record<string, unknown> } }>;
} {
  const bodyZh = appendSourcesSection(
    normalizeMarkdown(input.bodyMarkdownZh ?? ""),
    sourceLinks,
    "zh",
  );
  const bodyEn = appendSourcesSection(
    normalizeMarkdown(input.bodyMarkdownEn ?? ""),
    sourceLinks,
    "en",
  );

  return {
    blocks: [{ type: "TEXT", content: bodyZh, metadata: {}, order: 0 }],
    blockTranslations: {
      "0": { en: { content: bodyEn, metadata: {} } },
    },
  };
}

/** Build a single payload block from a BlockInput. */
function buildSingleBlock(
  block: BlockInput,
  order: number,
): { type: string; content: string; metadata: Record<string, unknown>; order: number } {
  return {
    type: block.type,
    content: normalizeMarkdown(block.contentZh ?? ""),
    metadata: {},
    order,
  };
}

/** Build a single block English translation from a BlockInput. */
function buildSingleBlockTranslation(block: BlockInput): {
  content: string;
  metadata: Record<string, unknown>;
} {
  return { content: normalizeMarkdown(block.contentEn ?? ""), metadata: {} };
}

function normalizeMarkdown(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function normalizeSourceLinks(sourceLinks: SourceLinkInput[] | undefined): SourceLinkInput[] {
  if (!Array.isArray(sourceLinks)) {
    return [];
  }

  const deduped = new Map<string, SourceLinkInput>();
  for (const entry of sourceLinks) {
    const url = readOptionalString(entry.url);
    if (!url) {
      continue;
    }
    if (!deduped.has(url)) {
      deduped.set(url, {
        url,
        label: readOptionalString(entry.label),
        labelZh: readOptionalString(entry.labelZh),
        labelEn: readOptionalString(entry.labelEn),
      });
    }
  }
  return [...deduped.values()];
}

function appendSourcesSection(
  body: string,
  sourceLinks: SourceLinkInput[],
  locale: "zh" | "en",
): string {
  if (sourceLinks.length === 0) {
    return body;
  }

  const heading = locale === "zh" ? "## 参考来源" : "## Sources";
  const lines = sourceLinks.map((entry) => {
    const label =
      (locale === "zh" ? entry.labelZh : entry.labelEn) ??
      entry.label ??
      deriveHostnameLabel(entry.url);
    return `- [${label}](${entry.url})`;
  });

  return [body, heading, ...lines].filter((part) => part.length > 0).join("\n\n");
}

function deriveHostnameLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function compactRecord<T extends Record<string, unknown>>(value: T): T {
  const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
  return Object.fromEntries(entries) as T;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

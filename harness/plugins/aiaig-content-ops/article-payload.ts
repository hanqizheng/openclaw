type SourceLinkInput = {
  url: string;
  label?: string;
  labelZh?: string;
  labelEn?: string;
};

type BuildArticlePayloadInput = {
  slug: string;
  titleZh: string;
  titleEn: string;
  excerptZh: string;
  excerptEn: string;
  bodyMarkdownZh: string;
  bodyMarkdownEn: string;
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
  const bodyZh = appendSourcesSection(normalizeMarkdown(input.bodyMarkdownZh), sourceLinks, "zh");
  const bodyEn = appendSourcesSection(normalizeMarkdown(input.bodyMarkdownEn), sourceLinks, "en");
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
    blocks: [
      {
        type: "TEXT",
        content: bodyZh,
        metadata: {},
        order: 0,
      },
    ],
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
    blockTranslations: {
      "0": {
        en: {
          content: bodyEn,
          metadata: {},
        },
      },
    },
  });

  return {
    payload,
    payloadJson: `${JSON.stringify(payload, null, 2)}\n`,
    preview: {
      titleZh: input.titleZh.trim(),
      titleEn: input.titleEn.trim(),
      slug: input.slug.trim(),
      categoryId,
      blockCount: 1,
      sourceCount: sourceLinks.length,
      excerptZh: input.excerptZh.trim(),
      excerptEn: input.excerptEn.trim(),
    },
  };
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

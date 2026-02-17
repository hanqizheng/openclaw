export const ARTICLE_BLOCK_TYPES = [
  "TEXT",
  "IMAGE",
  "VIDEO",
  "QUOTE",
  "CODE",
  "EMBED",
  "HTML",
  "LINK",
  "PROPERTY",
  "QA",
  "ARTICLE_REFERENCE",
] as const;

export type ArticleBlockType = (typeof ARTICLE_BLOCK_TYPES)[number];

export type WorkflowArticleBlock = {
  type: ArticleBlockType;
  content: string;
  metadata: Record<string, unknown>;
  order: number;
};

export type WorkflowArticlePayload = {
  title: string;
  slug: string;
  excerpt?: string;
  isPublished: boolean;
  categoryId: number;
  dataSource: string;
  coverImage?: string[];
  blocks: WorkflowArticleBlock[];
  blockTranslations?: Record<string, string>;
};

export type WorkflowCandidateStatus = "candidate" | "published" | "discarded";

export type WorkflowCandidate = {
  id: string;
  topic: string;
  title: string;
  url: string;
  domain: string;
  summaryMd: string;
  payload: WorkflowArticlePayload;
  sourceProfile: string;
  score: number;
  status: WorkflowCandidateStatus;
  fingerprint: string;
  createdAt: number;
  updatedAt: number;
};

export type PublishMode = "draft" | "publish";

export type PublishResult = {
  ok: boolean;
  status: number;
  mode: PublishMode;
  idempotencyKey: string;
  responseText: string;
  responseJson?: Record<string, unknown>;
};

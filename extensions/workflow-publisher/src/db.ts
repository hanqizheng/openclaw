import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { PublishMode, WorkflowCandidate, WorkflowCandidateStatus } from "./types.js";

type ListCandidateParams = {
  status?: WorkflowCandidateStatus;
  topic?: string;
  limit?: number;
};

type PublishAttemptRecord = {
  idempotencyKey: string;
  candidateId: string;
  mode: PublishMode;
  requestedBy: string;
  requestJson: string;
  responseJson: string;
  statusCode: number;
  resultStatus: "success" | "failed";
  createdAt: number;
};

type RawCandidateRow = {
  id: string;
  topic: string;
  title: string;
  url: string;
  domain: string;
  summary_md: string;
  payload_json: string;
  source_profile: string;
  score: number;
  status: WorkflowCandidateStatus;
  fingerprint: string;
  created_at: number;
  updated_at: number;
};

function toCandidate(row: RawCandidateRow): WorkflowCandidate {
  return {
    id: row.id,
    topic: row.topic,
    title: row.title,
    url: row.url,
    domain: row.domain,
    summaryMd: row.summary_md,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    payload: JSON.parse(row.payload_json) as WorkflowCandidate["payload"],
    sourceProfile: row.source_profile,
    score: row.score,
    status: row.status,
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WorkflowStore {
  private readonly db: DatabaseSync;

  constructor(private readonly dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  summary_md TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  source_profile TEXT NOT NULL,
  score REAL NOT NULL,
  status TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_status_created ON candidates(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_candidates_topic_status_created ON candidates(topic, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_candidates_fingerprint ON candidates(fingerprint);

CREATE TABLE IF NOT EXISTS callback_tokens (
  candidate_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(candidate_id, nonce)
);

CREATE TABLE IF NOT EXISTS dedupe_fingerprints (
  fingerprint TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS publish_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  result_status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publish_attempts_idempotency ON publish_attempts(idempotency_key, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  object_id TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
    `);
  }

  close(): void {
    this.db.close();
  }

  upsertCandidate(candidate: WorkflowCandidate): void {
    this.db
      .prepare(
        `
INSERT INTO candidates(
  id, topic, title, url, domain, summary_md, payload_json,
  source_profile, score, status, fingerprint, created_at, updated_at
) VALUES (
  :id, :topic, :title, :url, :domain, :summaryMd, :payloadJson,
  :sourceProfile, :score, :status, :fingerprint, :createdAt, :updatedAt
)
ON CONFLICT(id) DO UPDATE SET
  topic = excluded.topic,
  title = excluded.title,
  url = excluded.url,
  domain = excluded.domain,
  summary_md = excluded.summary_md,
  payload_json = excluded.payload_json,
  source_profile = excluded.source_profile,
  score = excluded.score,
  status = excluded.status,
  fingerprint = excluded.fingerprint,
  updated_at = excluded.updated_at
        `,
      )
      .run({
        id: candidate.id,
        topic: candidate.topic,
        title: candidate.title,
        url: candidate.url,
        domain: candidate.domain,
        summaryMd: candidate.summaryMd,
        payloadJson: JSON.stringify(candidate.payload),
        sourceProfile: candidate.sourceProfile,
        score: candidate.score,
        status: candidate.status,
        fingerprint: candidate.fingerprint,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
      });
  }

  listCandidates(params: ListCandidateParams = {}): WorkflowCandidate[] {
    const where: string[] = [];
    const binds: Record<string, SQLInputValue> = {};
    if (params.status) {
      where.push("status = :status");
      binds.status = params.status;
    }
    if (params.topic) {
      where.push("topic = :topic");
      binds.topic = params.topic;
    }
    const limit = Math.max(1, Math.min(50, params.limit ?? 10));
    binds.limit = limit;
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const stmt = this.db.prepare(`
SELECT *
FROM candidates
${whereSql}
ORDER BY created_at DESC
LIMIT :limit
    `);
    const rows = stmt.all(binds) as RawCandidateRow[];
    return rows.map(toCandidate);
  }

  getCandidate(id: string): WorkflowCandidate | null {
    const row = this.db.prepare("SELECT * FROM candidates WHERE id = ?").get(id) as
      | RawCandidateRow
      | undefined;
    return row ? toCandidate(row) : null;
  }

  updateCandidateStatus(id: string, status: WorkflowCandidateStatus, updatedAt: number): void {
    this.db
      .prepare("UPDATE candidates SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, updatedAt, id);
  }

  isFingerprintSeenWithinWindow(fingerprint: string, cutoffMs: number): boolean {
    const row = this.db
      .prepare("SELECT last_seen_at FROM dedupe_fingerprints WHERE fingerprint = ?")
      .get(fingerprint) as { last_seen_at?: number } | undefined;
    return (row?.last_seen_at ?? 0) >= cutoffMs;
  }

  touchFingerprint(fingerprint: string, candidateId: string, nowMs: number): void {
    this.db
      .prepare(
        `
INSERT INTO dedupe_fingerprints(fingerprint, candidate_id, first_seen_at, last_seen_at)
VALUES(:fingerprint, :candidateId, :nowMs, :nowMs)
ON CONFLICT(fingerprint) DO UPDATE SET
  candidate_id = excluded.candidate_id,
  last_seen_at = excluded.last_seen_at
        `,
      )
      .run({ fingerprint, candidateId, nowMs });
  }

  createCallbackToken(
    candidateId: string,
    nonce: string,
    expiresAt: number,
    createdAt: number,
  ): void {
    this.db
      .prepare(
        `
INSERT INTO callback_tokens(candidate_id, nonce, expires_at, used_at, created_at)
VALUES (?, ?, ?, NULL, ?)
ON CONFLICT(candidate_id, nonce) DO UPDATE SET
  expires_at = excluded.expires_at,
  used_at = NULL,
  created_at = excluded.created_at
        `,
      )
      .run(candidateId, nonce, expiresAt, createdAt);
  }

  consumeCallbackToken(
    candidateId: string,
    nonce: string,
    nowMs: number,
  ): {
    ok: boolean;
    reason?: "missing" | "expired" | "used";
  } {
    const row = this.db
      .prepare(
        "SELECT expires_at, used_at FROM callback_tokens WHERE candidate_id = ? AND nonce = ?",
      )
      .get(candidateId, nonce) as { expires_at?: number; used_at?: number | null } | undefined;

    if (!row) {
      return { ok: false, reason: "missing" };
    }
    if ((row.used_at ?? 0) > 0) {
      return { ok: false, reason: "used" };
    }
    if ((row.expires_at ?? 0) < nowMs) {
      return { ok: false, reason: "expired" };
    }

    this.db
      .prepare("UPDATE callback_tokens SET used_at = ? WHERE candidate_id = ? AND nonce = ?")
      .run(nowMs, candidateId, nonce);
    return { ok: true };
  }

  getRecentSuccessfulAttemptByIdempotency(idempotencyKey: string): {
    statusCode: number;
    responseJson: string;
    createdAt: number;
  } | null {
    const row = this.db
      .prepare(
        `
SELECT status_code, response_json, created_at
FROM publish_attempts
WHERE idempotency_key = ? AND result_status = 'success'
ORDER BY created_at DESC
LIMIT 1
        `,
      )
      .get(idempotencyKey) as
      | { status_code: number; response_json: string; created_at: number }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      statusCode: row.status_code,
      responseJson: row.response_json,
      createdAt: row.created_at,
    };
  }

  recordPublishAttempt(record: PublishAttemptRecord): void {
    this.db
      .prepare(
        `
INSERT INTO publish_attempts(
  idempotency_key,
  candidate_id,
  mode,
  requested_by,
  request_json,
  response_json,
  status_code,
  result_status,
  created_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        record.idempotencyKey,
        record.candidateId,
        record.mode,
        record.requestedBy,
        record.requestJson,
        record.responseJson,
        record.statusCode,
        record.resultStatus,
        record.createdAt,
      );
  }

  recordAudit(params: {
    actor: string;
    action: string;
    objectId: string;
    meta: Record<string, unknown>;
    createdAt: number;
  }): void {
    this.db
      .prepare(
        "INSERT INTO audit_logs(actor, action, object_id, meta_json, created_at) VALUES(?, ?, ?, ?, ?)",
      )
      .run(
        params.actor,
        params.action,
        params.objectId,
        JSON.stringify(params.meta),
        params.createdAt,
      );
  }
}

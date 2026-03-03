import fs from "node:fs";
import path from "node:path";
import { resolveApiSecret, type DbBackupConfig } from "./config.js";
import type { TelegramNotifier } from "./notify.js";

export type BackupResult = {
  ok: boolean;
  filePath?: string;
  sizeBytes?: number;
  durationMs?: number;
  error?: string;
};

/**
 * POST to backup API, save the response body as a .sql.gz file, and prune old backups.
 */
export async function runBackup(params: {
  config: DbBackupConfig;
  backupDir: string;
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
  notifier?: TelegramNotifier;
}): Promise<BackupResult> {
  const { config, backupDir, logger, notifier } = params;
  const startMs = Date.now();

  fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[T]/g, "-").replace(/[:.]/g, "").slice(0, 17);
  const fileName = `backup-${timestamp}.sql.gz`;
  const filePath = path.join(backupDir, fileName);

  try {
    const secret = resolveApiSecret(config);
    if (!secret) {
      const error = `env var ${config.apiSecretEnv} is not set`;
      logger.warn(`db-backup: ${error}`);
      await notifier?.send(`❌ 数据库备份失败\n${error}`);
      return { ok: false, error, durationMs: Date.now() - startMs };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.apiTimeoutMs);

    let response: Response;
    try {
      response = await fetch(config.apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          Accept: "application/gzip",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const error = `HTTP ${response.status}: ${body.slice(0, 200)}`;
      logger.warn(`db-backup: API error — ${error}`);
      await notifier?.send(`❌ 数据库备份失败\n${error}`);
      return { ok: false, error, durationMs: Date.now() - startMs };
    }

    const buf = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filePath, buf);
    const durationMs = Date.now() - startMs;

    logger.info(
      `db-backup: saved ${fileName} (${(buf.length / 1024).toFixed(1)} KB, ${durationMs}ms)`,
    );

    // Prune old backups
    pruneOldBackups(backupDir, config.retentionDays, logger);

    await notifier?.send(
      `✅ 数据库备份成功\n文件: ${fileName}\n大小: ${(buf.length / 1024).toFixed(1)} KB\n耗时: ${(durationMs / 1000).toFixed(1)}s`,
    );

    return { ok: true, filePath, sizeBytes: buf.length, durationMs };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn(`db-backup: failed — ${error}`);
    await notifier?.send(`❌ 数据库备份失败\n${error}`);
    return { ok: false, error, durationMs: Date.now() - startMs };
  }
}

function pruneOldBackups(
  backupDir: string,
  retentionDays: number,
  logger: { info: (msg: string) => void },
): void {
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const entry of fs.readdirSync(backupDir)) {
    if (!entry.startsWith("backup-") || !entry.endsWith(".sql.gz")) {
      continue;
    }
    const fullPath = path.join(backupDir, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs < cutoffMs) {
        fs.unlinkSync(fullPath);
        removed += 1;
      }
    } catch {
      // Ignore stat/unlink errors for individual files
    }
  }

  if (removed > 0) {
    logger.info(`db-backup: pruned ${removed} old backup(s)`);
  }
}

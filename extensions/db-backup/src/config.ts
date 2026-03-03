import { asObject, asString, asPositiveInt } from "./utils.js";

export type DbBackupConfig = {
  apiUrl: string;
  /** Environment variable name that holds the API secret */
  apiSecretEnv: string;
  apiTimeoutMs: number;
  cronExpr: string;
  timezone: string;
  /** Custom backup directory; undefined = use default stateDir/backups */
  backupDir: string | undefined;
  retentionDays: number;
  telegramChatId: string | undefined;
};

/** Read the actual secret value from the environment at call time. */
export function resolveApiSecret(config: DbBackupConfig): string {
  return process.env[config.apiSecretEnv]?.trim() ?? "";
}

export function resolveDbBackupConfig(pluginConfig: unknown): DbBackupConfig {
  const cfg = asObject(pluginConfig);
  const api = asObject(cfg.api);
  const schedule = asObject(cfg.schedule);
  const storage = asObject(cfg.storage);
  const telegram = asObject(cfg.telegram);

  return {
    apiUrl: asString(api.url) ?? "https://www.aiaig.com/api/integrations/db-backup",
    apiSecretEnv: asString(api.secretEnv) ?? "DB_BACKUP_SECRET",
    apiTimeoutMs: (asPositiveInt(api.timeoutSeconds) ?? 120) * 1000,
    cronExpr: asString(schedule.cronExpr) ?? "0 1 * * *",
    timezone: asString(schedule.timezone) ?? "Asia/Shanghai",
    backupDir: asString(storage.backupDir),
    retentionDays: asPositiveInt(storage.retentionDays) ?? 30,
    telegramChatId: asString(telegram.chatId),
  };
}

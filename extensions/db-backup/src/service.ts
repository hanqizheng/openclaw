import path from "node:path";
import { Cron } from "croner";
import { runBackup } from "./backup.js";
import { resolveDbBackupConfig, type DbBackupConfig } from "./config.js";
import type { TelegramNotifier } from "./notify.js";

export class DbBackupService {
  readonly config: DbBackupConfig;
  private readonly stateDir: string;
  private cron: Cron | undefined;
  private running = false;
  private notifier: TelegramNotifier | undefined;

  constructor(params: { pluginConfig: unknown; stateDir: string }) {
    this.config = resolveDbBackupConfig(params.pluginConfig);
    this.stateDir = params.stateDir;
  }

  get backupDir(): string {
    return this.config.backupDir ?? path.join(this.stateDir, "backups");
  }

  setNotifier(notifier: TelegramNotifier | undefined): void {
    this.notifier = notifier;
  }

  async triggerBackup(logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  }): Promise<{
    ok: boolean;
    error?: string;
    filePath?: string;
    sizeBytes?: number;
    durationMs?: number;
  }> {
    if (this.running) {
      return { ok: false, error: "backup already in progress" };
    }
    this.running = true;
    try {
      return await runBackup({
        config: this.config,
        backupDir: this.backupDir,
        logger,
        notifier: this.notifier,
      });
    } finally {
      this.running = false;
    }
  }

  startCron(logger: { info: (msg: string) => void; warn: (msg: string) => void }): void {
    if (this.cron) {
      return;
    }

    this.cron = new Cron(
      this.config.cronExpr,
      {
        timezone: this.config.timezone,
        catch: (err) => {
          logger.warn(`db-backup: cron error — ${err}`);
        },
      },
      () => {
        void this.triggerBackup(logger);
      },
    );

    logger.info(`db-backup: cron scheduled (${this.config.cronExpr}, tz=${this.config.timezone})`);
  }

  stopCron(): void {
    if (this.cron) {
      this.cron.stop();
      this.cron = undefined;
    }
  }
}

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerBackupCommands } from "./commands.js";
import { createTelegramNotifier } from "./notify.js";
import { DbBackupService } from "./service.js";

export function registerDbBackup(api: OpenClawPluginApi): void {
  const stateDir = api.runtime.state.resolveStateDir("db-backup");

  const service = new DbBackupService({
    pluginConfig: api.pluginConfig,
    stateDir,
  });

  const notifier = createTelegramNotifier(api, service.config.telegramChatId);
  service.setNotifier(notifier);

  registerBackupCommands(api, service);

  api.registerService({
    id: "db-backup-scheduler",
    start: () => {
      service.startCron({
        info: (msg) => api.logger.info(msg),
        warn: (msg) => api.logger.warn(msg),
      });
      api.logger.info("db-backup service started");
    },
    stop: () => {
      service.stopCron();
      api.logger.info("db-backup service stopped");
    },
  });
}

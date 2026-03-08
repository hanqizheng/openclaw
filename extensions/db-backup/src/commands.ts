import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { DbBackupService } from "./service.js";

export function registerBackupCommands(api: OpenClawPluginApi, service: DbBackupService): void {
  api.registerCommand({
    name: "backup",
    description: "手动触发数据库备份。",
    acceptsArgs: false,
    requireAuth: false,
    handler: async () => {
      const result = await service.triggerBackup({
        info: (msg) => api.logger.info(msg),
        warn: (msg) => api.logger.warn(msg),
      });

      if (!result.ok) {
        return { text: `备份失败: ${result.error ?? "unknown"}` };
      }

      const lines = [
        "备份成功",
        `文件: ${result.filePath ?? "unknown"}`,
        `大小: ${result.sizeBytes ? `${(result.sizeBytes / 1024).toFixed(1)} KB` : "unknown"}`,
        `耗时: ${result.durationMs ? `${(result.durationMs / 1000).toFixed(1)}s` : "unknown"}`,
      ];
      return { text: lines.join("\n") };
    },
  });
}

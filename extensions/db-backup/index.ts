import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerDbBackup } from "./src/plugin.js";

const plugin = {
  id: "db-backup",
  name: "DB Backup",
  description: "Scheduled database backups via HTTP API with Telegram notifications.",
  register(api: OpenClawPluginApi) {
    registerDbBackup(api);
  },
};

export default plugin;

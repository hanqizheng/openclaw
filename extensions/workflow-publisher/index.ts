import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerWorkflowPublisher } from "./src/plugin.js";

const plugin = {
  id: "workflow-publisher",
  name: "Workflow Publisher",
  description:
    "Curated web collection with Telegram approval buttons and article import publishing.",
  register(api: OpenClawPluginApi) {
    registerWorkflowPublisher(api);
  },
};

export default plugin;

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerWorkflowCommands } from "./commands.js";
import { WorkflowService } from "./service.js";
import { registerWorkflowTools } from "./tools.js";

export function registerWorkflowPublisher(api: OpenClawPluginApi): void {
  const service = new WorkflowService({
    pluginConfig: api.pluginConfig,
    runtime: {
      state: {
        resolveStateDir: api.runtime.state.resolveStateDir,
      },
    },
  });

  registerWorkflowTools(api, service);
  registerWorkflowCommands(api, service);

  api.registerService({
    id: "workflow-publisher-store",
    start: async () => {
      api.logger.info("workflow-publisher ready");
    },
    stop: async () => {
      service.close();
    },
  });
}

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
      const translationEndpoint = (() => {
        try {
          return new URL(
            service.config.translationApiPath,
            service.config.translationApiBaseUrl,
          ).toString();
        } catch {
          return `${service.config.translationApiBaseUrl}${service.config.translationApiPath}`;
        }
      })();
      api.logger.info(
        `workflow-publisher ready (translation=${service.config.translationEnabled ? "enabled" : "disabled"} model=${service.config.translationModel} endpoint=${translationEndpoint} discovery=${service.config.discoveryEnabled ? "enabled" : "disabled"})`,
      );
    },
    stop: async () => {
      service.close();
    },
  });
}

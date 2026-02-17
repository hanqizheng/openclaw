import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerWorkflowPublisher } from "./src/plugin.js";

export default function register(api: OpenClawPluginApi) {
  registerWorkflowPublisher(api);
}

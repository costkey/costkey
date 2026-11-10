import type { ObservabilityBridge, ObservabilityExporter } from "@mastra/core/observability";
import { CostKeyMastraBridge, CostKeyMastraExporter } from "../integrations/mastra.js";

export const bridge: ObservabilityBridge = new CostKeyMastraBridge();
export const exporter: ObservabilityExporter = new CostKeyMastraExporter();

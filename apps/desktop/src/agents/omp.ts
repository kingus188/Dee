import { openAcp } from "./acp.js";
import type { AgentDriver, DriverOptions } from "./types.js";

export async function openOmp(options: DriverOptions): Promise<AgentDriver> {
  return openAcp({
    ...options,
    config: { ...options.config, args: ["acp"] },
  });
}

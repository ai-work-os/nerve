import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function readNerveConfig(): Record<string, unknown> {
  try {
    const raw = readFileSync(join(homedir(), ".nerve", "config.json"), "utf8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    return config && typeof config === "object" ? config : {};
  } catch {
    return {};
  }
}

export function readStringConfig(config: Record<string, unknown>, snakeKey: string, camelKey: string): string | undefined {
  const value = config[snakeKey] ?? config[camelKey];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function getDefaultAgentCwd(): string | undefined {
  return process.env.NERVE_DEFAULT_AGENT_CWD || readStringConfig(readNerveConfig(), "default_agent_cwd", "defaultAgentCwd");
}

export function resolveSpawnCwd(cwd?: string): string {
  return resolve(cwd || getDefaultAgentCwd() || process.cwd());
}

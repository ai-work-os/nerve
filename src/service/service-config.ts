/**
 * service-config — 读 ~/.nerve/services.json，提供进程监督器所需配置。
 *
 * 文件格式：
 * {
 *   "services": [
 *     {
 *       "name": "mac-clipboard",
 *       "cmd": "node",
 *       "args": ["dist/index.js"],
 *       "cwd": "/path/to/plugin",
 *       "env": { "NERVE_HOST": "100.75.43.90" },
 *       "restart": "always"
 *     }
 *   ]
 * }
 *
 * - 文件不存在 → 返回 { services: [] }（合法状态，不抛错）
 * - JSON 非法 → 抛错
 * - 每个 service 必须有非空的 name 和 cmd，否则抛错
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface ServiceSpec {
  name: string;
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  restart?: "always" | "never";
}

export interface ServiceConfig {
  services: ServiceSpec[];
}

export function defaultServiceConfigPath(): string {
  return resolve(homedir(), ".nerve/services.json");
}

export function loadServiceConfig(path: string = defaultServiceConfigPath()): ServiceConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return { services: [] };
    }
    throw err;
  }

  // Throws SyntaxError on bad JSON — intentional, propagate to caller
  const parsed = JSON.parse(raw);

  const rawServices: unknown[] = Array.isArray(parsed.services) ? parsed.services : [];

  const services: ServiceSpec[] = rawServices.map((entry: unknown, idx: number) => {
    const e = entry as Record<string, unknown>;

    if (!e.name || typeof e.name !== "string") {
      throw new Error(
        `service-config: entry[${idx}] has invalid or missing "name" (got ${JSON.stringify(e.name)})`
      );
    }
    if (!e.cmd || typeof e.cmd !== "string") {
      throw new Error(
        `service-config: entry[${idx}] (name=${JSON.stringify(e.name)}) has invalid or missing "cmd" (got ${JSON.stringify(e.cmd)})`
      );
    }

    const spec: ServiceSpec = {
      name: e.name,
      cmd: e.cmd,
      args: Array.isArray(e.args) ? (e.args as string[]) : [],
      restart: e.restart === "never" ? "never" : "always",
    };

    if (e.cwd && typeof e.cwd === "string") {
      spec.cwd = e.cwd;
    }
    if (e.env && typeof e.env === "object" && !Array.isArray(e.env)) {
      spec.env = e.env as Record<string, string>;
    }

    return spec;
  });

  return { services };
}

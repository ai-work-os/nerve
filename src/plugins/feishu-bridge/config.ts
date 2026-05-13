/**
 * Load Feishu app credentials from ~/.nerve/feishu.json.
 *
 * 文件格式：
 * {
 *   "app_id": "cli_xxx",
 *   "app_secret": "...",
 *   "encrypt_key": "...",          // optional
 *   "verification_token": "..."     // optional
 * }
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface FeishuConfig {
  app_id: string;
  app_secret: string;
  encrypt_key?: string;
  verification_token?: string;
}

export function defaultConfigPath(): string {
  return resolve(homedir(), ".nerve/feishu.json");
}

export function loadConfig(path: string = defaultConfigPath()): FeishuConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new Error(`feishu config not found: ${path}`);
    }
    throw err;
  }

  const parsed = JSON.parse(raw);
  if (!parsed.app_id || typeof parsed.app_id !== "string") {
    throw new Error(`feishu config missing app_id (${path})`);
  }
  if (!parsed.app_secret || typeof parsed.app_secret !== "string") {
    throw new Error(`feishu config missing app_secret (${path})`);
  }
  return {
    app_id: parsed.app_id,
    app_secret: parsed.app_secret,
    encrypt_key: typeof parsed.encrypt_key === "string" ? parsed.encrypt_key : undefined,
    verification_token: typeof parsed.verification_token === "string" ? parsed.verification_token : undefined,
  };
}

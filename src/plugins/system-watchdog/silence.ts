/**
 * Silence — 去重窗口，避免节点连环挂时报警风暴。
 * 同一 nodeName:metric 在 silenceWindowMs 内只 emit 一次。
 *
 * 状态持久化在 ~/.nerve/plugins/system-watchdog/silence.json。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Alert } from "./evaluator.js";

export type SilenceState = Record<string, number>;  // key → lastAlertedAt

export function alertKey(alert: Alert): string {
  return `${alert.nodeName}:${alert.metric}`;
}

export function shouldEmit(
  key: string,
  state: SilenceState,
  silenceWindowMs: number,
  now: number,
): boolean {
  const last = state[key];
  if (last === undefined) return true;
  return now - last >= silenceWindowMs;
}

export function loadSilence(path: string): SilenceState {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

export function saveSilence(path: string, state: SilenceState): void {
  writeFileSync(path, JSON.stringify(state, null, 2));
}

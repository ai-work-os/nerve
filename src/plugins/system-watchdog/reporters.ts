/**
 * Reporters — alert 输出格式化 + 文件追加。
 *
 * 文件格式：按天分段 markdown
 *   ## YYYY-MM-DD
 *   - HH:MM:SS  node  metric  detail
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Alert } from "./evaluator.js";

function pad2(n: number): string { return n < 10 ? "0" + n : "" + n; }

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fmtTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function formatAlertLine(alert: Alert, now: Date): string {
  return `- ${fmtTime(now)}  ${alert.nodeName}  ${alert.metric}  ${alert.detail}`;
}

export function formatChannelMessage(alerts: Alert[]): string {
  if (alerts.length === 0) return "";
  const header = `🔴 system-watchdog: ${alerts.length} 节点异常`;
  const lines = alerts.map(a => `- ${a.nodeName}  ${a.metric}  ${a.detail}`);
  const footer = "详情: ~/.ai/ops/state/system-alerts.md";
  return [header, ...lines, footer].join("\n");
}

export function appendAlertsToFile(path: string, alerts: Alert[], now: Date): void {
  if (alerts.length === 0) return;

  mkdirSync(dirname(path), { recursive: true });

  const dateHeader = `## ${fmtDate(now)}`;
  const newLines = alerts.map(a => formatAlertLine(a, now));
  let existing = "";
  if (existsSync(path)) existing = readFileSync(path, "utf-8");

  if (!existing.includes(dateHeader)) {
    const prefix = existing.length > 0 && !existing.endsWith("\n\n") ? "\n\n" : "";
    appendFileSync(path, `${prefix}${dateHeader}\n\n${newLines.join("\n")}\n`);
  } else {
    appendFileSync(path, `${newLines.join("\n")}\n`);
  }
}

/**
 * Reporters — channel publishing for duty-monitor events.
 *
 * Responsibilities:
 *  - formatHealthAlertMessage() — health alert body
 *  - formatProcessAlertMessage() — process memory alert body
 *  - formatSchedule() — human-readable schedule string
 *
 * Publishing (emit) is done via callbacks injected from DutyMonitor to avoid
 * coupling this module to PluginBase. Callers pass an emit function.
 */

import { child as childLogger } from "../../infra/logger.js";
import type { HealthAlert } from "./health-check.js";
import type { Schedule } from "./cron-scheduler.js";

const log = childLogger({ module: "plugin:duty-monitor:reporters" });

// --- Formatting helpers ---

export function formatSchedule(s: Schedule): string {
  if (s.intervalMinutes !== undefined) return `every ${s.intervalMinutes}min`;
  const time = `${s.hour}:${String(s.minute ?? 0).padStart(2, "0")}`;
  if (s.dayOfWeek !== undefined) {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return `${days[s.dayOfWeek]} ${time}`;
  }
  return time;
}

export function formatHealthAlertDetail(alerts: HealthAlert[]): string {
  return alerts.map(a => `${a.metric}: ${a.value}%>${a.threshold}%`).join(", ");
}

export function formatProcessAlertDetail(alerts: HealthAlert[]): string {
  return alerts.map(a => `${a.metric}: ${a.value}MB>${a.threshold}MB`).join(", ");
}

// --- Channel publishers ---

type EmitFn = (event: string, nodeId: undefined | string, content: string) => Promise<void>;

export async function publishHealthAlerts(
  systemAlerts: HealthAlert[],
  processAlerts: HealthAlert[],
  emit: EmitFn,
): Promise<void> {
  if (systemAlerts.length > 0) {
    const detail = formatHealthAlertDetail(systemAlerts);
    log.warn(`system health alerts: ${detail}`);
    await emit("health_alert", undefined, `分析异常：${detail}`);
  }
  if (processAlerts.length > 0) {
    const detail = formatProcessAlertDetail(processAlerts);
    log.warn(`process health alerts: ${detail}`);
    await emit("health_alert", undefined, `分析异常：nerve ${detail}`);
  }
}

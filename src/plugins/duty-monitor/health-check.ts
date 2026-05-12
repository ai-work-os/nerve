/**
 * Health check — system metrics reading and threshold evaluation.
 *
 * Responsibilities:
 *  - HealthAlert type
 *  - getMemoryUsage(), getDiskUsage(), getCpuUsage()
 *  - checkHealth(), checkProcessHealth()
 *
 * Thresholds are injected via parameters — this module does NOT read env vars.
 */

import * as os from "node:os";
import { statfs } from "node:fs/promises";
import { child as childLogger } from "../../logger.js";

const log = childLogger({ module: "plugin:duty-monitor:health-check" });

// --- Types ---

export interface HealthAlert {
  metric: string;
  value: number;
  threshold: number;
}

// --- System metrics ---

export function getMemoryUsage(): { used: number; total: number } {
  const total = os.totalmem();
  const free = os.freemem();
  return { used: total - free, total };
}

export async function getDiskUsage(): Promise<{ used: number; total: number; path: string }> {
  const stats = await statfs("/");
  const total = stats.bsize * stats.blocks;
  const free = stats.bsize * stats.bfree;
  return { used: total - free, total, path: "/" };
}

export function getCpuUsage(prev: os.CpuInfo[], curr: os.CpuInfo[]): number {
  let totalDiff = 0;
  let idleDiff = 0;
  for (let i = 0; i < curr.length; i++) {
    const p = prev[i].times;
    const c = curr[i].times;
    const pTotal = p.user + p.nice + p.sys + p.idle + p.irq;
    const cTotal = c.user + c.nice + c.sys + c.idle + c.irq;
    totalDiff += cTotal - pTotal;
    idleDiff += c.idle - p.idle;
  }
  if (totalDiff === 0) return 0;
  return ((totalDiff - idleDiff) / totalDiff) * 100;
}

// --- Threshold evaluation ---

export function checkHealth(
  cpuPercent: number,
  memUsed: number,
  memTotal: number,
  diskUsed: number,
  diskTotal: number,
  thresholds: { cpu: number; mem: number; disk: number },
): HealthAlert[] {
  const alerts: HealthAlert[] = [];
  if (cpuPercent > thresholds.cpu) {
    alerts.push({ metric: "cpu", value: Math.round(cpuPercent), threshold: thresholds.cpu });
  }
  const memPercent = (memUsed / memTotal) * 100;
  if (memPercent > thresholds.mem) {
    alerts.push({ metric: "memory", value: Math.round(memPercent), threshold: thresholds.mem });
  }
  const diskPercent = (diskUsed / diskTotal) * 100;
  if (diskPercent > thresholds.disk) {
    alerts.push({ metric: "disk", value: Math.round(diskPercent), threshold: thresholds.disk });
  }
  return alerts;
}

export function checkProcessHealth(
  usage: { heapUsedMB: number; rssMB: number },
  thresholds: { heapThreshold: number; rssThreshold: number },
): HealthAlert[] {
  const alerts: HealthAlert[] = [];
  if (usage.heapUsedMB > thresholds.heapThreshold) {
    alerts.push({ metric: "v8_heap", value: usage.heapUsedMB, threshold: thresholds.heapThreshold });
  }
  if (usage.rssMB > thresholds.rssThreshold) {
    alerts.push({ metric: "rss", value: usage.rssMB, threshold: thresholds.rssThreshold });
  }
  return alerts;
}

/**
 * Run a full health check (system + process) and return all alerts.
 * Thresholds are injected — caller reads from env.
 */
export async function runHealthCheck(thresholds: {
  cpu: number;
  mem: number;
  disk: number;
  heap: number;
  rss: number;
}): Promise<{ systemAlerts: HealthAlert[]; processAlerts: HealthAlert[] }> {
  const cpuPrev = os.cpus();
  await new Promise(r => setTimeout(r, 1000));
  const cpuCurr = os.cpus();
  const cpuPercent = getCpuUsage(cpuPrev, cpuCurr);
  const mem = getMemoryUsage();
  const disk = await getDiskUsage();

  const memPercent = (mem.used / mem.total) * 100;
  const diskPercent = (disk.used / disk.total) * 100;

  log.info(
    `metrics: cpu=${Math.round(cpuPercent)}%, mem=${Math.round(memPercent)}%, disk=${Math.round(diskPercent)}%`,
  );

  const systemAlerts = checkHealth(cpuPercent, mem.used, mem.total, disk.used, disk.total, {
    cpu: thresholds.cpu,
    mem: thresholds.mem,
    disk: thresholds.disk,
  });

  const procMem = process.memoryUsage();
  const heapUsedMB = Math.round(procMem.heapUsed / 1024 / 1024);
  const rssMB = Math.round(procMem.rss / 1024 / 1024);
  const processAlerts = checkProcessHealth(
    { heapUsedMB, rssMB },
    { heapThreshold: thresholds.heap, rssThreshold: thresholds.rss },
  );

  return { systemAlerts, processAlerts };
}

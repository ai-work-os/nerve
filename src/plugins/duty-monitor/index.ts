#!/usr/bin/env node
/**
 * Duty Monitor — scheduled tasks (daily report, worklog, health check) for duty-agent.
 *
 * Connects to nerve, registers cron jobs, posts @duty-agent messages to channel.
 *
 * Usage:
 *   npx tsx src/plugins/duty-monitor/index.ts [options]
 *
 * Options:
 *   --port <n>  nerve port (default: 4800)
 */

import * as os from "node:os";
import { statfs } from "node:fs/promises";
import { PluginBase, type CommandDef } from "../plugin-base.js";

// --- CLI args ---

function getArg(flag: string, defaultVal: string): string {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : defaultVal;
}

const PORT = parseInt(getArg("--port", "4800"));

// --- Thresholds from env ---

const CPU_THRESHOLD = parseInt(process.env.DUTY_CPU_THRESHOLD ?? "80");
const MEM_THRESHOLD = parseInt(process.env.DUTY_MEM_THRESHOLD ?? "85");
const DISK_THRESHOLD = parseInt(process.env.DUTY_DISK_THRESHOLD ?? "90");

// --- Types ---

export interface CronJob {
  name: string;
  schedule: { hour?: number; minute?: number; dayOfWeek?: number; intervalMinutes?: number };
  action: () => void | Promise<void>;
  lastRun?: number;
}

export interface HealthAlert {
  metric: string;
  value: number;
  threshold: number;
}

// --- CronScheduler ---

export class CronScheduler {
  jobs: CronJob[] = [];

  addJob(job: CronJob): void {
    this.jobs.push(job);
  }

  /**
   * Check all jobs against the given time and fire matching actions.
   * Returns list of job names that fired.
   */
  tick(now: Date): string[] {
    const hour = now.getHours();
    const minute = now.getMinutes();
    const dayOfWeek = now.getDay(); // 0=Sun
    const minuteKey = hour * 60 + minute;
    const fired: string[] = [];

    for (const job of this.jobs) {
      const s = job.schedule;

      // Same-minute dedup
      if (job.lastRun === minuteKey) continue;

      if (s.intervalMinutes !== undefined) {
        // Interval-based: fire if enough time has passed since lastRun
        if (job.lastRun === undefined) {
          // First run
          job.lastRun = minuteKey;
          job.action();
          fired.push(job.name);
          continue;
        }
        let elapsed = minuteKey - job.lastRun;
        if (elapsed < 0) elapsed += 24 * 60; // wrapped midnight
        if (elapsed >= s.intervalMinutes) {
          job.lastRun = minuteKey;
          job.action();
          fired.push(job.name);
        }
        continue;
      }

      // Fixed-time match
      if (s.hour !== undefined && s.hour !== hour) continue;
      if (s.minute !== undefined && s.minute !== minute) continue;
      if (s.dayOfWeek !== undefined && s.dayOfWeek !== dayOfWeek) continue;

      job.lastRun = minuteKey;
      job.action();
      fired.push(job.name);
    }

    return fired;
  }
}

// --- Health check functions ---

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

// --- DutyMonitor ---

const TICK_INTERVAL_MS = 30_000; // 30s tick to prevent drift

class DutyMonitor extends PluginBase {
  private scheduler = new CronScheduler();
  private tickTimer?: ReturnType<typeof setInterval>;
  private channelId?: string;
  private isChecking = false;

  constructor() {
    super({
      port: PORT,
      name: "duty-monitor",
      capabilities: ["monitor"],
      permissions: "observer",
    });
  }

  override getCommands(): Record<string, CommandDef> {
    return {
      status: { description: "显示当前状态和下次触发时间" },
      trigger: { description: "手动触发指定任务", args: { task: "daily|worklog|health" } },
      check: { description: "立即执行健康检查" },
    };
  }

  /** Capture channelId from incoming channel messages */
  protected override handleChannelMessage(params: any): void {
    const channelId = params?.channelId as string | undefined;
    if (channelId && !this.channelId) {
      this.channelId = channelId;
      this.log("info", `channel discovered: ${channelId}`);
    }
    // Delegate to base for @mention command dispatch
    super.handleChannelMessage(params);
  }

  protected override async onReady(): Promise<void> {
    this.log("info", `config: cpu_threshold=${CPU_THRESHOLD}%, mem_threshold=${MEM_THRESHOLD}%, disk_threshold=${DISK_THRESHOLD}%`);
    this.log("info", `tick interval: ${TICK_INTERVAL_MS}ms`);

    // Discover channel: poll channel.list until found (scene may not have joined us yet)
    this.discoverChannel();

    // Register cron jobs
    this.scheduler.addJob({
      name: "daily-report",
      schedule: { hour: 22, minute: 0 },
      action: () => this.triggerDaily(),
    });

    this.scheduler.addJob({
      name: "weekly-worklog",
      schedule: { hour: 8, minute: 0, dayOfWeek: 1 }, // Monday
      action: () => this.triggerWorklog(),
    });

    this.scheduler.addJob({
      name: "health-check",
      schedule: { intervalMinutes: 60 },
      action: () => this.runHealthCheck(),
    });

    this.log("info", `registered ${this.scheduler.jobs.length} cron jobs: ${this.scheduler.jobs.map(j => j.name).join(", ")}`);

    // Start tick loop
    this.tickTimer = setInterval(() => {
      const now = new Date();
      const fired = this.scheduler.tick(now);
      if (fired.length > 0) {
        this.log("info", `tick fired: ${fired.join(", ")}`);
      }
    }, TICK_INTERVAL_MS);
  }

  protected override onDisconnect(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  protected override onCommand(command: string, args: Record<string, string>, from?: string): string | void {
    switch (command) {
      case "status": {
        const jobs = this.scheduler.jobs.map(j => {
          const s = j.schedule;
          let schedule = "";
          if (s.intervalMinutes !== undefined) {
            schedule = `every ${s.intervalMinutes}min`;
          } else {
            const parts: string[] = [];
            if (s.hour !== undefined) parts.push(`${s.hour}:${String(s.minute ?? 0).padStart(2, "0")}`);
            if (s.dayOfWeek !== undefined) parts.push(`day=${s.dayOfWeek}`);
            schedule = parts.join(" ");
          }
          const lastRun = j.lastRun !== undefined
            ? `${Math.floor(j.lastRun / 60)}:${String(j.lastRun % 60).padStart(2, "0")}`
            : "never";
          return `${j.name}: ${schedule} (last: ${lastRun})`;
        });
        this.log("info", `status: channel=${this.channelId || "none"}`);
        for (const line of jobs) {
          this.log("info", `  ${line}`);
        }
        break;
      }
      case "trigger": {
        const task = args["0"] || args.task;
        this.log("info", `manual trigger: ${task} by ${from || "unknown"}`);
        switch (task) {
          case "daily": this.triggerDaily(); break;
          case "worklog": this.triggerWorklog(); break;
          case "health": this.runHealthCheck(); break;
          default:
            return `unknown task: "${task}". available: daily, worklog, health`;
        }
        break;
      }
      case "check":
        this.log("info", `manual health check by ${from || "unknown"}`);
        this.runHealthCheck();
        break;
    }
  }

  /** Poll channel.list until we find a channel (max 6 attempts, 5s apart) */
  private async discoverChannel(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      try {
        const result = await this.request("channel.list");
        const channels: any[] = result.channels || [];
        if (channels.length > 0) {
          this.channelId = channels[0].id || channels[0].channelId;
          this.log("info", `channel discovered via list: ${this.channelId}`);
          return;
        }
      } catch (err) {
        this.log("warn", `channel.list attempt ${i + 1} failed: ${err}`);
      }
      if (i < 5) await new Promise(r => setTimeout(r, 5000));
    }
    this.log("warn", "channel not found after polling, will rely on handleChannelMessage fallback");
  }

  private async postToChannelSafe(content: string): Promise<void> {
    // Lazy channel discovery: if channelId not yet known, try once
    if (!this.channelId) {
      try {
        const result = await this.request("channel.list");
        const channels: any[] = result.channels || [];
        if (channels.length > 0) {
          this.channelId = channels[0].id || channels[0].channelId;
          this.log("info", `channel discovered lazily: ${this.channelId}`);
        }
      } catch {}
    }
    if (!this.channelId) {
      this.log("warn", `no channel, cannot post: ${content}`);
      return;
    }
    try {
      await this.request("channel.post", { channelId: this.channelId, content });
      this.log("info", `posted to channel: ${content.slice(0, 50)}`);
    } catch (err) {
      this.log("error", `channel post failed: ${err}`);
    }
  }

  private triggerDaily(): void {
    this.log("info", "triggering daily report");
    this.postToChannelSafe("@duty-agent 写日报");
  }

  private triggerWorklog(): void {
    this.log("info", "triggering worklog");
    this.postToChannelSafe("@duty-agent 整理 worklog");
  }

  private async runHealthCheck(): Promise<void> {
    if (this.isChecking) {
      this.log("info", "health check already in progress, skipping");
      return;
    }
    this.isChecking = true;
    this.log("info", "running health check");
    try {
      // CPU: two samples 1s apart
      const cpuPrev = os.cpus();
      await new Promise(r => setTimeout(r, 1000));
      const cpuCurr = os.cpus();
      const cpuPercent = getCpuUsage(cpuPrev, cpuCurr);

      // Memory
      const mem = getMemoryUsage();

      // Disk
      const disk = await getDiskUsage();

      const memPercent = (mem.used / mem.total) * 100;
      const diskPercent = (disk.used / disk.total) * 100;

      this.log("info", `health check: cpu=${Math.round(cpuPercent)}%, mem=${Math.round(memPercent)}%, disk=${Math.round(diskPercent)}% — ${
        cpuPercent <= CPU_THRESHOLD && memPercent <= MEM_THRESHOLD && diskPercent <= DISK_THRESHOLD ? "all OK" : "ALERT"
      }`);

      // Check thresholds
      const alerts = checkHealth(cpuPercent, mem.used, mem.total, disk.used, disk.total, {
        cpu: CPU_THRESHOLD,
        mem: MEM_THRESHOLD,
        disk: DISK_THRESHOLD,
      });

      if (alerts.length > 0) {
        const detail = alerts.map(a => `${a.metric}: ${a.value}%>${a.threshold}%`).join(", ");
        this.log("warn", `health alerts: ${detail}`);
        this.postToChannelSafe(`@duty-agent 分析异常：${detail}`);
      }
    } catch (err) {
      this.log("error", `health check failed: ${err}`);
    } finally {
      this.isChecking = false;
    }
  }
}

// --- Main (only when run directly, not when imported for testing) ---

const isDirectRun = process.argv[1]?.endsWith("duty-monitor/index.ts") ||
                    process.argv[1]?.endsWith("duty-monitor/index.js");

if (isDirectRun) {
  const monitor = new DutyMonitor();

  monitor.start().catch((err) => {
    console.error(`[duty-monitor] failed to start: ${err}`);
    process.exit(1);
  });

  // Graceful shutdown
  process.on("SIGTERM", () => { monitor.stop(); process.exit(0); });
  process.on("SIGINT", () => { monitor.stop(); process.exit(0); });
}

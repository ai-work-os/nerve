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
import { mkdirSync, readFileSync, writeFileSync, existsSync, watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { PluginBase, type CommandDef, type CommandResult } from "../plugin-base.js";

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

// Process-level thresholds (used in runHealthCheck)
// NERVE_HEAP_THRESHOLD (MB, default 1500) and NERVE_RSS_THRESHOLD (MB, default 2000)
// are read inside runHealthCheck() directly

// --- Types ---

export interface CronJob {
  name: string;
  schedule: { hour?: number; minute?: number; dayOfWeek?: number; intervalMinutes?: number };
  action: () => void | Promise<void>;
  lastRun?: number;
  lastRunKey?: string;
}

export interface HealthAlert {
  metric: string;
  value: number;
  threshold: number;
}

// --- Schedule parsing ---

const DAY_MAP: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

export type Schedule = { hour?: number; minute?: number; dayOfWeek?: number; intervalMinutes?: number };

export function parseSchedule(input: string): Schedule | null {
  if (!input) return null;

  // Interval: "every:60m"
  const intervalMatch = input.match(/^every:(\d+)m$/);
  if (intervalMatch) {
    const minutes = parseInt(intervalMatch[1]);
    if (minutes <= 0) return null;
    return { intervalMinutes: minutes };
  }

  // Day + time: "Mon:08:00"
  const dayTimeMatch = input.match(/^([A-Za-z]{3}):(\d{1,2}):(\d{2})$/);
  if (dayTimeMatch) {
    const day = DAY_MAP[dayTimeMatch[1].toLowerCase()];
    if (day === undefined) return null;
    const hour = parseInt(dayTimeMatch[2]);
    const minute = parseInt(dayTimeMatch[3]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { hour, minute, dayOfWeek: day };
  }

  // Fixed time: "22:00" or "8:05"
  const timeMatch = input.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const hour = parseInt(timeMatch[1]);
    const minute = parseInt(timeMatch[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { hour, minute };
  }

  return null;
}

// --- TaskDef & TaskStore ---

export interface TaskDef {
  name: string;
  schedule: Schedule;
  message: string;
}

export class TaskStore {
  private tasks: TaskDef[] = [];
  private filePath: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = resolve(dataDir, "tasks.json");
    this.load();
  }

  get path(): string {
    return this.filePath;
  }

  add(task: TaskDef): void {
    if (!task.name) {
      task.name = task.message.replace(/^@\S+\s*/, "").slice(0, 20).trim() || `task-${Date.now()}`;
    }
    const idx = this.tasks.findIndex(t => t.name === task.name);
    if (idx >= 0) {
      this.tasks[idx] = task;
    } else {
      this.tasks.push(task);
    }
    this.save();
  }

  remove(name: string): boolean {
    const idx = this.tasks.findIndex(t => t.name === name);
    if (idx < 0) return false;
    this.tasks.splice(idx, 1);
    this.save();
    return true;
  }

  list(): TaskDef[] {
    return [...this.tasks];
  }

  reload(): boolean {
    return this.load();
  }

  normalizeMessages(): string[] {
    const changed: string[] = [];
    for (const task of this.tasks) {
      const normalized = normalizeLegacyAiWorkspacePaths(task.message);
      if (normalized.changed) {
        task.message = normalized.message;
        changed.push(task.name);
      }
    }
    if (changed.length > 0) this.save();
    return changed;
  }

  private load(): boolean {
    if (!existsSync(this.filePath)) { this.tasks = []; return true; }
    try {
      this.tasks = JSON.parse(readFileSync(this.filePath, "utf-8"));
      return true;
    } catch {
      this.tasks = [];
      return false;
    }
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.tasks, null, 2));
  }
}

export function extractReferencedPaths(message: string): string[] {
  const matches = message.match(/\/[^\s`"'，。；:]+?\.(?:md|json|ya?ml)\b/g) ?? [];
  return [...new Set(matches)];
}

export function validateReferencedPaths(message: string): { ok: boolean; missing: string[] } {
  const missing = extractReferencedPaths(message).filter(path => !existsSync(path));
  return { ok: missing.length === 0, missing };
}

export function normalizeLegacyAiWorkspacePaths(message: string): { message: string; changed: boolean } {
  const paths = extractReferencedPaths(message);
  let normalized = message;
  for (const path of paths) {
    if (!path.includes("/.ai/projects/") || existsSync(path)) continue;
    const candidate = path.replace("/.ai/projects/", "/.ai/workspace/projects/");
    if (existsSync(candidate)) {
      normalized = normalized.split(path).join(candidate);
    }
  }
  return { message: normalized, changed: normalized !== message };
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
    const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const fired: string[] = [];

    for (const job of this.jobs) {
      const s = job.schedule;

      if (s.intervalMinutes !== undefined) {
        // Same-minute dedup for interval jobs
        if (job.lastRun === minuteKey) continue;
        // Interval-based: fire if enough time has passed since lastRun
        if (job.lastRun === undefined) {
          // First run
          job.lastRun = minuteKey;
          void job.action();
          fired.push(job.name);
          continue;
        }
        let elapsed = minuteKey - job.lastRun;
        if (elapsed < 0) elapsed += 24 * 60; // wrapped midnight
        if (elapsed >= s.intervalMinutes) {
          job.lastRun = minuteKey;
          void job.action();
          fired.push(job.name);
        }
        continue;
      }

      // Fixed-time match
      if (s.hour !== undefined && s.hour !== hour) continue;
      if (s.minute !== undefined && s.minute !== minute) continue;
      if (s.dayOfWeek !== undefined && s.dayOfWeek !== dayOfWeek) continue;

      const runKey = `${dateKey}:${minuteKey}`;
      if (job.lastRunKey === runKey) continue;

      job.lastRun = minuteKey;
      job.lastRunKey = runKey;
      void job.action();
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

// --- DutyMonitor ---

const TICK_INTERVAL_MS = 30_000; // 30s tick to prevent drift

function formatSchedule(s: Schedule): string {
  if (s.intervalMinutes !== undefined) return `every ${s.intervalMinutes}min`;
  const time = `${s.hour}:${String(s.minute ?? 0).padStart(2, "0")}`;
  if (s.dayOfWeek !== undefined) {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return `${days[s.dayOfWeek]} ${time}`;
  }
  return time;
}

class DutyMonitor extends PluginBase {
  private scheduler = new CronScheduler();
  private taskStore!: TaskStore;
  private tickTimer?: ReturnType<typeof setInterval>;
  private watchers: FSWatcher[] = [];
  private isChecking = false;

  constructor() {
    super({
      port: PORT,
      name: "duty-monitor",
      capabilities: ["monitor"],
      permissions: "observer",
    });
  }

  override getEvents(): string[] {
    return ["task_fired", "health_alert"];
  }

  override getCommands(): Record<string, CommandDef> {
    return {
      add: { description: "添加定时任务", args: { schedule: "HH:MM | Day:HH:MM | every:Nm", message: "@target 消息内容" } },
      remove: { description: "删除任务", args: { name: "任务名" } },
      list: { description: "列出所有任务" },
      trigger: { description: "立即触发任务", args: { name: "任务名" } },
      status: { description: "显示运行状态" },
      check: { description: "立即执行健康检查" },
    };
  }

  protected override async onReady(): Promise<void> {
    this.taskStore = new TaskStore(this.dataDir);
    this.log("info", `tick interval: ${TICK_INTERVAL_MS}ms, data: ${this.dataDir}`);

    this.normalizeStoredTaskMessages("startup");
    this.syncTasksToScheduler();
    this.refreshWatchers();
    this.log("info", `loaded ${this.taskStore.list().length} tasks from disk`);

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
    this.closeWatchers();
  }

  protected override onCommand(command: string, args: Record<string, string>, from?: string): CommandResult {
    switch (command) {
      case "add":
        return this.handleAdd(args, from);
      case "remove":
        return this.handleRemove(args.name, from);
      case "list":
        return this.handleList();
      case "trigger":
        return this.handleTrigger(args.name, from);
      case "status":
        return this.handleStatus();
      case "check":
        this.log("info", `manual health check by ${from || "unknown"}`);
        void this.runHealthCheck();
        break;
    }
  }

  private handleAdd(args: Record<string, string>, from?: string): CommandResult {
    const scheduleStr = args.schedule;
    const message = args.message;

    if (!scheduleStr || !message) {
      this.log("error", `add: missing schedule or message from ${from || "unknown"}`);
      return { reply: "格式：add <schedule> <message>\nschedule: HH:MM | Day:HH:MM | every:Nm" };
    }

    const name = args.name || "";
    const schedule = parseSchedule(scheduleStr);

    if (!schedule) {
      this.log("error", `add: invalid schedule "${scheduleStr}" from ${from || "unknown"}`);
      return { reply: `无法解析 schedule: "${scheduleStr}"\n支持: 22:00 | Mon:08:00 | every:60m` };
    }

    const task: TaskDef = { name, schedule, message };
    this.taskStore.add(task);
    this.normalizeStoredTaskMessages("add");
    this.syncTasksToScheduler();
    this.refreshWatchers();
    const finalTask = this.taskStore.list().find(t => t.name === task.name);
    const finalName = finalTask?.name || task.name || name;
    const finalMessage = finalTask?.message || message;
    this.log("info", `add: task "${finalName}" schedule=${formatSchedule(schedule)} message="${finalMessage}" by ${from || "unknown"}`);
    return { reply: `已添加: ${finalName} (${formatSchedule(schedule)})` };
  }

  private handleRemove(name: string, from?: string): CommandResult {
    if (!name) {
      this.log("error", `remove: no task name from ${from || "unknown"}`);
      return { reply: "格式：remove <任务名>" };
    }
    const ok = this.taskStore.remove(name);
    if (ok) {
      this.syncTasksToScheduler();
      this.refreshWatchers();
      this.log("info", `removed task "${name}" by ${from || "unknown"}`);
      return { reply: `已删除: ${name}` };
    }
    this.log("warn", `remove: task "${name}" not found, from ${from || "unknown"}`);
    const available = this.taskStore.list().map(t => t.name).join(", ") || "无";
    return { reply: `任务 "${name}" 不存在。当前任务: ${available}` };
  }

  private handleList(): CommandResult {
    const tasks = this.taskStore.list();
    if (tasks.length === 0) {
      this.log("info", "list: no tasks");
      return { reply: "当前无任务。用 add <schedule> <message> 添加" };
    }
    const lines = tasks.map(t => {
      const job = this.scheduler.jobs.find(j => j.name === t.name);
      const lastRun = job?.lastRun !== undefined
        ? `${Math.floor(job.lastRun / 60)}:${String(job.lastRun % 60).padStart(2, "0")}`
        : "never";
      return `• ${t.name}: ${formatSchedule(t.schedule)} → ${t.message.slice(0, 40)} (last: ${lastRun})`;
    });
    this.log("info", `list: ${tasks.length} tasks`);
    return { reply: lines.join("\n") };
  }

  private handleTrigger(name: string, from?: string): CommandResult {
    if (!name) {
      this.log("error", `trigger: no task name from ${from || "unknown"}`);
      return { reply: "格式：trigger <任务名>" };
    }
    this.reloadTasksFromDisk("manual-trigger");
    const task = this.taskStore.list().find(t => t.name === name);
    if (!task) {
      this.log("warn", `trigger: task "${name}" not found, from ${from || "unknown"}`);
      return { reply: `任务 "${name}" 不存在` };
    }
    const validation = validateReferencedPaths(task.message);
    if (!validation.ok) {
      const detail = validation.missing.join(", ");
      this.log("error", `trigger: task "${name}" missing referenced file(s): ${detail}`);
      return { reply: `任务 "${name}" 引用文件不存在: ${detail}` };
    }
    this.log("info", `trigger: "${name}" by ${from || "unknown"}`);
    void this.emit("task_fired", task.name, task.message);
    return { reply: `已触发: ${name}` };
  }

  private handleStatus(): CommandResult {
    const tasks = this.taskStore.list();
    const lines = [
      `channel=${this.channelId || "none"}`,
      `tasks=${tasks.length}`,
      `tick=${TICK_INTERVAL_MS}ms`,
    ];
    for (const job of this.scheduler.jobs) {
      const lastRun = job.lastRun !== undefined
        ? `${Math.floor(job.lastRun / 60)}:${String(job.lastRun % 60).padStart(2, "0")}`
        : "never";
      lines.push(`  ${job.name}: last=${lastRun}`);
    }
    return { reply: lines.join("\n") };
  }

  private syncTasksToScheduler(): void {
    const previous = new Map(this.scheduler.jobs.map(job => [job.name, { lastRun: job.lastRun, lastRunKey: job.lastRunKey }]));
    this.scheduler.jobs = [];
    for (const task of this.taskStore.list()) {
      const lastRun = previous.get(task.name);
      this.scheduler.addJob({
        name: task.name,
        schedule: task.schedule,
        lastRun: lastRun?.lastRun,
        lastRunKey: lastRun?.lastRunKey,
        action: () => {
          this.fireTask(task.name, "cron");
        },
      });
    }
  }

  private fireTask(name: string, reason: string): void {
    this.reloadTasksFromDisk(`before-${reason}`);
    const task = this.taskStore.list().find(t => t.name === name);
    if (!task) {
      this.log("error", `${reason}: task "${name}" disappeared before trigger`);
      return;
    }

    const validation = validateReferencedPaths(task.message);
    if (!validation.ok) {
      this.log("error", `${reason}: task "${name}" missing referenced file(s): ${validation.missing.join(", ")}`);
      return;
    }

    this.log("info", `${reason} fired: "${task.name}" → ${task.message.slice(0, 50)}`);
    void this.emit("task_fired", task.name, task.message);
  }

  private reloadTasksFromDisk(reason: string): void {
    const ok = this.taskStore.reload();
    if (!ok) {
      this.log("error", `reload failed (${reason}): ${this.taskStore.path}`);
      return;
    }
    this.normalizeStoredTaskMessages(reason);
    this.syncTasksToScheduler();
    this.refreshWatchers();
    this.log("info", `reload ok (${reason}): ${this.taskStore.list().length} tasks`);
  }

  private normalizeStoredTaskMessages(reason: string): void {
    const changed = this.taskStore.normalizeMessages();
    for (const name of changed) {
      this.log("info", `normalized legacy task path (${reason}): ${name}`);
    }
  }

  private refreshWatchers(): void {
    this.closeWatchers();
    const paths = new Set<string>([this.taskStore.path]);
    for (const task of this.taskStore.list()) {
      for (const path of extractReferencedPaths(task.message)) paths.add(path);
    }

    for (const path of paths) {
      if (!existsSync(path)) {
        this.log("warn", `watch skipped missing file: ${path}`);
        continue;
      }
      try {
        const watcher = watch(path, { persistent: false }, () => {
          this.log("info", `watch reload requested: ${path}`);
          this.reloadTasksFromDisk(`watch:${path}`);
        });
        watcher.on("error", err => {
          this.log("error", `watch failed for ${path}: ${err.message}`);
        });
        this.watchers.push(watcher);
      } catch (err) {
        this.log("error", `watch failed for ${path}: ${err}`);
      }
    }
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // ignore close races during reload
      }
    }
    this.watchers = [];
  }

  private async runHealthCheck(): Promise<void> {
    if (this.isChecking) {
      this.log("info", "health check already in progress, skipping");
      return;
    }
    this.isChecking = true;
    this.log("info", "running health check");
    try {
      const cpuPrev = os.cpus();
      await new Promise(r => setTimeout(r, 1000));
      const cpuCurr = os.cpus();
      const cpuPercent = getCpuUsage(cpuPrev, cpuCurr);
      const mem = getMemoryUsage();
      const disk = await getDiskUsage();

      const memPercent = (mem.used / mem.total) * 100;
      const diskPercent = (disk.used / disk.total) * 100;

      this.log("info", `health: cpu=${Math.round(cpuPercent)}%, mem=${Math.round(memPercent)}%, disk=${Math.round(diskPercent)}% — ${
        cpuPercent <= CPU_THRESHOLD && memPercent <= MEM_THRESHOLD && diskPercent <= DISK_THRESHOLD ? "all OK" : "ALERT"
      }`);

      const alerts = checkHealth(cpuPercent, mem.used, mem.total, disk.used, disk.total, {
        cpu: CPU_THRESHOLD, mem: MEM_THRESHOLD, disk: DISK_THRESHOLD,
      });
      if (alerts.length > 0) {
        const detail = alerts.map(a => `${a.metric}: ${a.value}%>${a.threshold}%`).join(", ");
        this.log("warn", `health alerts: ${detail}`);
        void this.emit("health_alert", undefined, `分析异常：${detail}`);
      }

      const heapThreshold = parseInt(process.env.NERVE_HEAP_THRESHOLD ?? "1500");
      const rssThreshold = parseInt(process.env.NERVE_RSS_THRESHOLD ?? "2000");
      const procMem = process.memoryUsage();
      const heapUsedMB = Math.round(procMem.heapUsed / 1024 / 1024);
      const rssMB = Math.round(procMem.rss / 1024 / 1024);
      const processAlerts = checkProcessHealth(
        { heapUsedMB, rssMB },
        { heapThreshold, rssThreshold },
      );
      if (processAlerts.length > 0) {
        const detail = processAlerts.map(a => `${a.metric}: ${a.value}MB>${a.threshold}MB`).join(", ");
        this.log("warn", `process health alerts: ${detail}`);
        void this.emit("health_alert", undefined, `分析异常：nerve ${detail}`);
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

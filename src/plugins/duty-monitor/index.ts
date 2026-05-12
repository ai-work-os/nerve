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

import { PluginBase, type CommandDef, type CommandResult } from "../plugin-base.js";
import { child as childLogger } from "../../infra/logger.js";
import { CronScheduler, parseSchedule } from "./cron-scheduler.js";
import { runHealthCheck, checkHealth, checkProcessHealth, getMemoryUsage, getDiskUsage, getCpuUsage } from "./health-check.js";
import { formatSchedule, publishHealthAlerts } from "./reporters.js";
import { TaskStore, extractReferencedPaths, validateReferencedPaths, normalizeLegacyAiWorkspacePaths } from "./task-store.js";
import { FileWatcher } from "./file-watcher.js";

const log = childLogger({ module: "plugin:duty-monitor" });

// --- Re-exports for backward compatibility (test imports these from index.js) ---
export { CronScheduler, parseSchedule } from "./cron-scheduler.js";
export type { CronJob, Schedule } from "./cron-scheduler.js";
export { getMemoryUsage, getDiskUsage, getCpuUsage, checkHealth, checkProcessHealth } from "./health-check.js";
export type { HealthAlert } from "./health-check.js";
export { TaskStore, extractReferencedPaths, validateReferencedPaths, normalizeLegacyAiWorkspacePaths } from "./task-store.js";
export type { TaskDef } from "./task-store.js";

// --- CLI args ---

function getArg(flag: string, defaultVal: string): string {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : defaultVal;
}

const PORT = parseInt(getArg("--port", "4800"));

// Thresholds from env — read here, injected into sub-modules
const CPU_THRESHOLD = parseInt(process.env.DUTY_CPU_THRESHOLD ?? "80");
const MEM_THRESHOLD = parseInt(process.env.DUTY_MEM_THRESHOLD ?? "85");
const DISK_THRESHOLD = parseInt(process.env.DUTY_DISK_THRESHOLD ?? "90");

const TICK_INTERVAL_MS = 30_000; // 30s tick to prevent drift

// --- DutyMonitor ---

class DutyMonitor extends PluginBase {
  private scheduler = new CronScheduler();
  private taskStore!: TaskStore;
  private watcher = new FileWatcher();
  private tickTimer?: ReturnType<typeof setInterval>;
  private isChecking = false;

  constructor() {
    super({ port: PORT, name: "duty-monitor", capabilities: ["monitor"], permissions: "observer" });
  }

  override getEvents(): string[] { return ["task_fired", "health_alert"]; }

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
    this.normalizeAndSync("startup");
    this.log("info", `loaded ${this.taskStore.list().length} tasks from disk`);
    this.tickTimer = setInterval(() => {
      const fired = this.scheduler.tick(new Date());
      if (fired.length > 0) this.log("info", `tick fired: ${fired.join(", ")}`);
    }, TICK_INTERVAL_MS);
  }

  protected override onDisconnect(): void {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = undefined; }
    this.watcher.close();
  }

  protected override onCommand(command: string, args: Record<string, string>, from?: string): CommandResult {
    switch (command) {
      case "add":     return this.handleAdd(args, from);
      case "remove":  return this.handleRemove(args.name, from);
      case "list":    return this.handleList();
      case "trigger": return this.handleTrigger(args.name, from);
      case "status":  return this.handleStatus();
      case "check":
        this.log("info", `manual health check by ${from || "unknown"}`);
        void this.doHealthCheck();
        break;
    }
  }

  private handleAdd(args: Record<string, string>, from?: string): CommandResult {
    const { schedule: scheduleStr, message, name: nameArg = "" } = args;
    if (!scheduleStr || !message) {
      this.log("error", `add: missing schedule or message from ${from || "unknown"}`);
      return { reply: "格式：add <schedule> <message>\nschedule: HH:MM | Day:HH:MM | every:Nm" };
    }
    const schedule = parseSchedule(scheduleStr);
    if (!schedule) {
      this.log("error", `add: invalid schedule "${scheduleStr}" from ${from || "unknown"}`);
      return { reply: `无法解析 schedule: "${scheduleStr}"\n支持: 22:00 | Mon:08:00 | every:60m` };
    }
    this.taskStore.add({ name: nameArg, schedule, message });
    this.normalizeAndSync("add");
    const saved = this.taskStore.list().find(t => t.name === nameArg) ?? { name: nameArg, message };
    this.log("info", `add: task "${saved.name}" schedule=${formatSchedule(schedule)} message="${saved.message}" by ${from || "unknown"}`);
    return { reply: `已添加: ${saved.name} (${formatSchedule(schedule)})` };
  }

  private handleRemove(name: string, from?: string): CommandResult {
    if (!name) {
      this.log("error", `remove: no task name from ${from || "unknown"}`);
      return { reply: "格式：remove <任务名>" };
    }
    if (this.taskStore.remove(name)) {
      this.normalizeAndSync("remove");
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
    this.reloadFromDisk("manual-trigger");
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
      ...this.scheduler.jobs.map(job => {
        const lastRun = job.lastRun !== undefined
          ? `${Math.floor(job.lastRun / 60)}:${String(job.lastRun % 60).padStart(2, "0")}`
          : "never";
        return `  ${job.name}: last=${lastRun}`;
      }),
    ];
    return { reply: lines.join("\n") };
  }

  /** Normalize task messages, sync scheduler, refresh file watchers. */
  private normalizeAndSync(reason: string): void {
    const changed = this.taskStore.normalizeMessages();
    for (const name of changed) this.log("info", `normalized legacy task path (${reason}): ${name}`);
    this.syncScheduler();
    this.resetWatchers();
  }

  private syncScheduler(): void {
    const prev = new Map(this.scheduler.jobs.map(j => [j.name, { lastRun: j.lastRun, lastRunKey: j.lastRunKey }]));
    this.scheduler.jobs = [];
    for (const task of this.taskStore.list()) {
      const state = prev.get(task.name);
      this.scheduler.addJob({
        name: task.name, schedule: task.schedule,
        lastRun: state?.lastRun, lastRunKey: state?.lastRunKey,
        action: () => { this.fireTask(task.name, "cron"); },
      });
    }
  }

  private fireTask(name: string, reason: string): void {
    this.reloadFromDisk(`before-${reason}`);
    const task = this.taskStore.list().find(t => t.name === name);
    if (!task) { this.log("error", `${reason}: task "${name}" disappeared before trigger`); return; }
    const v = validateReferencedPaths(task.message);
    if (!v.ok) { this.log("error", `${reason}: task "${name}" missing file(s): ${v.missing.join(", ")}`); return; }
    this.log("info", `${reason} fired: "${task.name}" → ${task.message.slice(0, 50)}`);
    void this.emit("task_fired", task.name, task.message);
  }

  private reloadFromDisk(reason: string): void {
    if (!this.taskStore.reload()) {
      this.log("error", `reload failed (${reason}): ${this.taskStore.path}`);
      return;
    }
    this.normalizeAndSync(reason);
    this.log("info", `reload ok (${reason}): ${this.taskStore.list().length} tasks`);
  }

  private resetWatchers(): void {
    const paths = new Set<string>([this.taskStore.path]);
    for (const task of this.taskStore.list()) {
      for (const p of extractReferencedPaths(task.message)) paths.add(p);
    }
    this.watcher.reset(paths, (path) => {
      this.log("info", `watch reload requested: ${path}`);
      this.reloadFromDisk(`watch:${path}`);
    });
  }

  private async doHealthCheck(): Promise<void> {
    if (this.isChecking) { this.log("info", "health check already in progress, skipping"); return; }
    this.isChecking = true;
    log.info("running health check");
    try {
      const { systemAlerts, processAlerts } = await runHealthCheck({
        cpu: CPU_THRESHOLD, mem: MEM_THRESHOLD, disk: DISK_THRESHOLD,
        heap: parseInt(process.env.NERVE_HEAP_THRESHOLD ?? "1500"),
        rss: parseInt(process.env.NERVE_RSS_THRESHOLD ?? "2000"),
      });
      this.log("info", `health check done — ${systemAlerts.length + processAlerts.length === 0 ? "all OK" : "ALERT"}`);
      await publishHealthAlerts(systemAlerts, processAlerts, (event, nodeId, content) =>
        this.emit(event, nodeId, content));
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
  monitor.start().catch((err) => { log.error(`failed to start: ${err}`); process.exit(1); });
  process.on("SIGTERM", () => { monitor.stop(); process.exit(0); });
  process.on("SIGINT",  () => { monitor.stop(); process.exit(0); });
}

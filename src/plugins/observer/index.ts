#!/usr/bin/env node
/**
 * Observer — watches all channel messages and node lifecycle events,
 * records them as JSONL for later analysis.
 *
 * Phase 1: pure data collection. No analysis, no reports.
 *
 * Usage:
 *   npx tsx src/plugins/observer/index.ts [options]
 *
 * Options:
 *   --port <n>  nerve port (default: 4800)
 */

import { appendFile, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { PluginBase, type CommandDef, type CommandResult } from "../plugin-base.js";
import {
  formatChannelMessage,
  formatNodeRegistered,
  formatNodeStopped,
  formatNodeStatusChanged,
  type ObserverEvent,
} from "./events.js";
import {
  readDayEvents,
  readDateRange,
  aggregateStats,
  formatDailyReport,
  formatWeeklyReport,
} from "./stats.js";

function getArg(flag: string, defaultVal: string): string {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : defaultVal;
}

const PORT = parseInt(getArg("--port", "4800"));

/** Local date as YYYY-MM-DD (not UTC) */
function localDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** ISO 8601 week number */
function isoWeek(d: Date): { year: number; week: number } {
  const target = new Date(d.getTime());
  target.setHours(0, 0, 0, 0);
  // Set to nearest Thursday: current date + 4 - current day number (Mon=1, Sun=7)
  target.setDate(target.getDate() + 4 - (target.getDay() || 7));
  const yearStart = new Date(target.getFullYear(), 0, 1);
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: target.getFullYear(), week };
}

/** Map of channelId → channelName for enriching events */
type ChannelNameMap = Map<string, string>;

class Observer extends PluginBase {
  private eventsDir: string;
  private reportsDir: string;
  private channelNames: ChannelNameMap = new Map();
  private eventCount = 0;
  /** Serialized write queue — ensures JSONL order matches event arrival order */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor() {
    super({
      port: PORT,
      name: "observer",
      capabilities: ["monitor"],
      permissions: "observer",
    });
    this.eventsDir = resolve(this.dataDir, "events");
    this.reportsDir = resolve(this.dataDir, "reports");
    mkdirSync(this.eventsDir, { recursive: true });
    mkdirSync(this.reportsDir, { recursive: true });
  }

  override getCommands(): Record<string, CommandDef> {
    return {
      status: { description: "Show observer status (event counts, channels)" },
      report: { description: "Generate report", args: { type: "daily|weekly" } },
    };
  }

  override getEvents(): string[] {
    return ["observer.report_generated"];
  }

  protected override onCommand(command: string, args: Record<string, string>, from?: string): CommandResult {
    switch (command) {
      case "status":
        return { reply: `${this.eventCount} events, ${this.channelNames.size} channels` };
      case "report":
        void this.handleReport(args["0"] || "daily");
        break;
      default:
        return `unknown command: ${command}`;
    }
  }

  private handleStatus(): void {
    const channels = this.channelNames.size;
    this.log("info", `status: ${this.eventCount} events collected, ${channels} channels observed`);
  }

  private async handleReport(type: string): Promise<void> {
    try {
      if (type === "daily") {
        await this.generateDailyReport();
      } else if (type === "weekly") {
        await this.generateWeeklyReport();
      } else {
        this.log("error", `unknown report type: ${type}, use daily|weekly`);
      }
    } catch (err) {
      this.log("error", `report generation failed: ${err}`);
    }
  }

  private async generateDailyReport(): Promise<void> {
    const today = localDate();
    this.log("info", `generating daily report for ${today}`);

    const events = await readDayEvents(this.eventsDir, today);
    const stats = aggregateStats(events, today);
    const report = formatDailyReport(stats);

    const reportPath = resolve(this.reportsDir, `daily-${today}.md`);
    await writeFile(reportPath, report);
    this.log("info", `daily report written to ${reportPath} (${events.length} events)`);
  }

  private async generateWeeklyReport(): Promise<void> {
    const now = new Date();
    // Get Monday of current week (local time)
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    const from = localDate(monday);
    const to = localDate(sunday);

    const { year, week } = isoWeek(now);
    const weekLabel = `${year}-W${String(week).padStart(2, "0")}`;

    this.log("info", `generating weekly report for ${weekLabel} (${from} to ${to})`);

    // Aggregate each day separately
    const dailyStatsList = [];
    for (let d = new Date(monday); d <= sunday; d.setDate(d.getDate() + 1)) {
      const date = localDate(d);
      const events = await readDayEvents(this.eventsDir, date);
      dailyStatsList.push(aggregateStats(events, date));
    }

    const report = formatWeeklyReport(dailyStatsList, weekLabel);
    const reportPath = resolve(this.reportsDir, `weekly-${weekLabel}.md`);
    await writeFile(reportPath, report);
    this.log("info", `weekly report written to ${reportPath}`);
  }

  protected override registerNotifications(): void {
    // channel.message — record events AND dispatch commands via PluginBase
    this.onNotification("channel.message", (params) => {
      // Record event first
      this.recordEvent(formatChannelMessage({
        ...params,
        channelName: this.channelNames.get(params.channelId) ?? params.channelId,
      }));
      // Dispatch @observer commands via PluginBase's handler
      this.handleChannelMessage(params);
    });

    // node.message — DM command dispatch
    this.onNotification("node.message", (params) => {
      this.dispatchCommand(params?.content as string, params?.from as string);
    });

    // channel.created — auto-join new channels
    this.onNotification("channel.created", (params) => {
      const { channelId, name } = params;
      this.log("info", `channel.created: ${name || channelId}, auto-joining`);
      if (name) this.channelNames.set(channelId, name);
      void this.autoJoin(channelId);
    });

    // node lifecycle broadcasts
    this.onNotification("node.registered", (params) => {
      this.recordEvent(formatNodeRegistered(params));
    });

    this.onNotification("node.stopped", (params) => {
      this.recordEvent(formatNodeStopped(params));
    });

    this.onNotification("node.statusChanged", (params) => {
      this.recordEvent(formatNodeStatusChanged(params));
    });
  }

  protected override async onReady(): Promise<void> {
    this.log("info", "observer ready, joining existing channels");

    // Join all existing channels
    try {
      const result = await this.request("channel.list");
      const channels = result.channels || [];
      for (const ch of channels) {
        if (ch.name) this.channelNames.set(ch.id, ch.name);
        await this.autoJoin(ch.id);
      }
      this.log("info", `joined ${channels.length} existing channels`);
    } catch (err) {
      this.log("warn", `failed to list/join existing channels: ${err}`);
    }

    await this.setActivity("observing");
  }

  private async autoJoin(channelId: string): Promise<void> {
    try {
      await this.request("channel.join", { channelId });
      this.log("info", `joined channel ${channelId}`);
    } catch (err) {
      // Already in channel or channel gone — not critical
      this.log("debug", `join ${channelId} failed (may already be member): ${err}`);
    }
  }

  private async setActivity(activity: string): Promise<void> {
    try {
      await this.request("node.activity", { activity });
    } catch {
      // best-effort
    }
  }

  /** Enqueue an event write — serialized to preserve arrival order */
  private recordEvent(event: ObserverEvent): void {
    this.eventCount++;
    // Derive local date from event timestamp (not current time) to avoid cross-midnight bucketing
    const date = localDate(new Date(event.ts));
    const path = resolve(this.eventsDir, `${date}.jsonl`);
    const line = JSON.stringify(event) + "\n";

    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await appendFile(path, line);
      } catch (err) {
        this.log("error", `failed to write event: ${err}`);
      }
    });

    // Update activity periodically
    if (this.eventCount % 50 === 0) {
      this.writeQueue = this.writeQueue.then(() => this.setActivity(`observing (${this.eventCount} events)`));
    }
  }

  /** Flush pending writes — called before shutdown */
  async flush(): Promise<void> {
    await this.writeQueue;
  }
}

// --- Main ---

const observer = new Observer();

observer.start().catch((err) => {
  console.error(`[observer] failed to start: ${err}`);
  process.exit(1);
});

async function shutdown() {
  observer.stop();
  await observer.flush();
  process.exit(0);
}
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });

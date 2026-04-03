/**
 * Observer stats — read JSONL events and compute aggregations.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ObserverEvent } from "./events.js";

/** Read events from a single day's JSONL file */
export async function readDayEvents(eventsDir: string, date: string): Promise<ObserverEvent[]> {
  const path = resolve(eventsDir, `${date}.jsonl`);
  if (!existsSync(path)) return [];

  const content = await readFile(path, "utf-8");
  const events: ObserverEvent[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return events;
}

/** Local date string YYYY-MM-DD from Date */
function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse a YYYY-MM-DD string as local midnight (not UTC) */
function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Read events for a date range (inclusive, local dates) */
export async function readDateRange(eventsDir: string, from: string, to: string): Promise<ObserverEvent[]> {
  const events: ObserverEvent[] = [];
  const start = parseLocalDate(from);
  const end = parseLocalDate(to);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const date = localDateStr(d);
    const dayEvents = await readDayEvents(eventsDir, date);
    events.push(...dayEvents);
  }
  return events;
}

export interface ChannelStats {
  name: string;
  messageCount: number;
  participants: Set<string>;
}

export interface AgentStats {
  name: string;
  messageCount: number;
  channels: Set<string>;
  statusChanges: number;
  wasSpawned: boolean;
  wasStopped: boolean;
}

export interface DailyStats {
  date: string;
  totalEvents: number;
  messageCount: number;
  nodeRegistered: number;
  nodeStopped: number;
  statusChanges: number;
  channels: Map<string, ChannelStats>;
  agents: Map<string, AgentStats>;
  /** Hourly message distribution (0-23) */
  hourlyMessages: number[];
}

/** Aggregate events into stats */
export function aggregateStats(events: ObserverEvent[], date: string): DailyStats {
  const stats: DailyStats = {
    date,
    totalEvents: events.length,
    messageCount: 0,
    nodeRegistered: 0,
    nodeStopped: 0,
    statusChanges: 0,
    channels: new Map(),
    agents: new Map(),
    hourlyMessages: new Array(24).fill(0),
  };

  for (const event of events) {
    switch (event.type) {
      case "channel.message": {
        stats.messageCount++;
        const hour = new Date(event.ts).getHours();
        stats.hourlyMessages[hour]++;

        const chId = (event.ch ?? "unknown") as string;
        const chName = (event.chName ?? chId) as string;
        if (!stats.channels.has(chId)) {
          stats.channels.set(chId, { name: chName, messageCount: 0, participants: new Set() });
        }
        const ch = stats.channels.get(chId)!;
        ch.messageCount++;
        if (event.from) ch.participants.add(event.from as string);

        const from = event.from as string | undefined;
        if (from) {
          if (!stats.agents.has(from)) {
            stats.agents.set(from, { name: from, messageCount: 0, channels: new Set(), statusChanges: 0, wasSpawned: false, wasStopped: false });
          }
          const agent = stats.agents.get(from)!;
          agent.messageCount++;
          agent.channels.add(chId);
        }
        break;
      }

      case "node.registered": {
        stats.nodeRegistered++;
        const name = event.node as string;
        if (name) {
          if (!stats.agents.has(name)) {
            stats.agents.set(name, { name, messageCount: 0, channels: new Set(), statusChanges: 0, wasSpawned: false, wasStopped: false });
          }
          stats.agents.get(name)!.wasSpawned = true;
        }
        break;
      }

      case "node.stopped": {
        stats.nodeStopped++;
        const name = event.node as string;
        if (name) {
          if (!stats.agents.has(name)) {
            stats.agents.set(name, { name, messageCount: 0, channels: new Set(), statusChanges: 0, wasSpawned: false, wasStopped: false });
          }
          stats.agents.get(name)!.wasStopped = true;
        }
        break;
      }

      case "node.statusChanged": {
        stats.statusChanges++;
        const name = event.node as string;
        if (name) {
          if (!stats.agents.has(name)) {
            stats.agents.set(name, { name, messageCount: 0, channels: new Set(), statusChanges: 0, wasSpawned: false, wasStopped: false });
          }
          stats.agents.get(name)!.statusChanges++;
        }
        break;
      }
    }
  }

  return stats;
}

/** Format stats into a human-readable markdown report */
export function formatDailyReport(stats: DailyStats): string {
  const lines: string[] = [];
  lines.push(`# 日报 — ${stats.date}`);
  lines.push("");
  lines.push("## 概览");
  lines.push("");
  lines.push(`- 总事件: ${stats.totalEvents}`);
  lines.push(`- 频道消息: ${stats.messageCount}`);
  lines.push(`- 节点启动: ${stats.nodeRegistered}`);
  lines.push(`- 节点停止: ${stats.nodeStopped}`);
  lines.push(`- 状态变化: ${stats.statusChanges}`);
  lines.push(`- 活跃频道: ${stats.channels.size}`);
  lines.push(`- 活跃 Agent: ${stats.agents.size}`);

  if (stats.channels.size > 0) {
    lines.push("");
    lines.push("## 频道活跃度");
    lines.push("");
    lines.push("| 频道 | 消息数 | 参与者 |");
    lines.push("|------|--------|--------|");
    const sorted = [...stats.channels.values()].sort((a, b) => b.messageCount - a.messageCount);
    for (const ch of sorted) {
      lines.push(`| ${ch.name} | ${ch.messageCount} | ${[...ch.participants].join(", ")} |`);
    }
  }

  if (stats.agents.size > 0) {
    lines.push("");
    lines.push("## Agent 活跃度");
    lines.push("");
    lines.push("| Agent | 消息数 | 状态变化 | 频道数 | 生命周期 |");
    lines.push("|-------|--------|----------|--------|----------|");
    const sorted = [...stats.agents.values()].sort((a, b) => b.messageCount - a.messageCount);
    for (const a of sorted) {
      const lifecycle = [a.wasSpawned ? "spawned" : "", a.wasStopped ? "stopped" : ""].filter(Boolean).join(", ") || "-";
      lines.push(`| ${a.name} | ${a.messageCount} | ${a.statusChanges} | ${a.channels.size} | ${lifecycle} |`);
    }
  }

  // Hourly distribution (only non-zero hours)
  const activeHours = stats.hourlyMessages
    .map((count, hour) => ({ hour, count }))
    .filter(h => h.count > 0);

  if (activeHours.length > 0) {
    lines.push("");
    lines.push("## 时间分布");
    lines.push("");
    const maxCount = Math.max(...activeHours.map(h => h.count));
    for (const { hour, count } of activeHours) {
      const bar = "█".repeat(Math.ceil((count / maxCount) * 20));
      lines.push(`${String(hour).padStart(2, "0")}:00  ${bar} ${count}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/** Format a weekly summary from multiple daily stats */
export function formatWeeklyReport(dailyStatsList: DailyStats[], weekLabel: string): string {
  const lines: string[] = [];
  lines.push(`# 周报 — ${weekLabel}`);
  lines.push("");

  const totalEvents = dailyStatsList.reduce((s, d) => s + d.totalEvents, 0);
  const totalMessages = dailyStatsList.reduce((s, d) => s + d.messageCount, 0);
  const totalSpawns = dailyStatsList.reduce((s, d) => s + d.nodeRegistered, 0);
  const totalStops = dailyStatsList.reduce((s, d) => s + d.nodeStopped, 0);
  const activeDays = dailyStatsList.filter(d => d.totalEvents > 0).length;

  lines.push("## 概览");
  lines.push("");
  lines.push(`- 活跃天数: ${activeDays}/7`);
  lines.push(`- 总事件: ${totalEvents}`);
  lines.push(`- 频道消息: ${totalMessages}`);
  lines.push(`- 节点启动/停止: ${totalSpawns}/${totalStops}`);

  if (dailyStatsList.length > 0) {
    lines.push("");
    lines.push("## 每日趋势");
    lines.push("");
    lines.push("| 日期 | 事件 | 消息 | Agent | 频道 |");
    lines.push("|------|------|------|-------|------|");
    for (const d of dailyStatsList) {
      lines.push(`| ${d.date} | ${d.totalEvents} | ${d.messageCount} | ${d.agents.size} | ${d.channels.size} |`);
    }
  }

  // Aggregate top agents across the week
  const agentTotals = new Map<string, number>();
  for (const d of dailyStatsList) {
    for (const [name, a] of d.agents) {
      agentTotals.set(name, (agentTotals.get(name) ?? 0) + a.messageCount);
    }
  }
  const topAgents = [...agentTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  if (topAgents.length > 0) {
    lines.push("");
    lines.push("## 本周最活跃 Agent");
    lines.push("");
    for (const [name, count] of topAgents) {
      lines.push(`- ${name}: ${count} 条消息`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

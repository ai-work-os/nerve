/**
 * Dialog Reporter — aggregates daily stats and generates markdown reports.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DialogEntry } from "./scanner.js";

export interface DailyStats {
  date: string;
  totalMessages: number;
  totalSessions: number;
  projects: Record<string, { messages: number; sessions: Set<string> }>;
  hourDistribution: number[];  // 24 slots, each = message count in that hour
  entries: DialogEntry[];      // raw entries for timeline
}

/** Read a day's JSONL dialogs file, compute aggregate stats */
export async function aggregateDailyStats(
  dialogsDir: string,
  date: string,
): Promise<DailyStats> {
  const empty: DailyStats = {
    date,
    totalMessages: 0,
    totalSessions: 0,
    projects: {},
    hourDistribution: Array(24).fill(0),
    entries: [],
  };

  const filePath = resolve(dialogsDir, `${date}.jsonl`);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    console.log(`[reporter] no data file for ${date}`);
    return empty;
  }

  const lines = raw.split("\n").filter(l => l.trim() !== "");
  const entries: DialogEntry[] = [];
  const sessions = new Set<string>();
  const projects: Record<string, { messages: number; sessions: Set<string> }> = {};
  const hourDistribution = Array(24).fill(0);

  for (const line of lines) {
    let entry: DialogEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      console.log(`[reporter] skip unparseable line in ${filePath}`);
      continue;
    }

    entries.push(entry);
    sessions.add(entry.sessionId);

    // Project stats
    if (!projects[entry.project]) {
      projects[entry.project] = { messages: 0, sessions: new Set() };
    }
    projects[entry.project].messages++;
    projects[entry.project].sessions.add(entry.sessionId);

    // Hour distribution
    const hour = new Date(entry.ts).getUTCHours();
    if (!isNaN(hour)) hourDistribution[hour]++;
  }

  console.log(`[reporter] ${date}: ${entries.length} messages, ${sessions.size} sessions`);

  return {
    date,
    totalMessages: entries.length,
    totalSessions: sessions.size,
    projects,
    hourDistribution,
    entries,
  };
}

/** Format DailyStats into a Markdown report */
export function formatDailyReport(stats: DailyStats): string {
  const lines: string[] = [];

  lines.push(`# Dialog Report — ${stats.date}`);
  lines.push("");
  lines.push(`## Overview`);
  lines.push(`- Messages: ${stats.totalMessages}`);
  lines.push(`- Sessions: ${stats.totalSessions}`);
  lines.push("");

  // Projects
  lines.push(`## Projects`);
  for (const [name, info] of Object.entries(stats.projects)) {
    lines.push(`- **${name}**: ${info.messages} messages, ${info.sessions.size} sessions`);
  }
  lines.push("");

  // Timeline — sorted by ts
  lines.push(`## Timeline`);
  const sorted = [...stats.entries].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const entry of sorted) {
    const time = entry.ts.slice(11, 16); // HH:MM
    const preview = entry.content.length > 80 ? entry.content.slice(0, 80) + "..." : entry.content;
    lines.push(`- ${time} [${entry.project}] "${preview}"`);
  }

  return lines.join("\n");
}

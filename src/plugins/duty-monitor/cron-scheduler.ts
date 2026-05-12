/**
 * CronScheduler — cron job registration and tick-based dispatch.
 *
 * Responsibilities:
 *  - CronJob type and Schedule type
 *  - CronScheduler class: addJob(), tick()
 *  - Schedule string parsing: parseSchedule()
 *
 * No side effects on import. No env reads.
 */

import { child as childLogger } from "../../logger.js";

const log = childLogger({ module: "plugin:duty-monitor:cron-scheduler" });

// --- Types ---

export type Schedule = { hour?: number; minute?: number; dayOfWeek?: number; intervalMinutes?: number };

export interface CronJob {
  name: string;
  schedule: { hour?: number; minute?: number; dayOfWeek?: number; intervalMinutes?: number };
  action: () => void | Promise<void>;
  lastRun?: number;
  lastRunKey?: string;
}

// --- Schedule parsing ---

const DAY_MAP: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

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

// --- CronScheduler ---

export class CronScheduler {
  jobs: CronJob[] = [];

  addJob(job: CronJob): void {
    this.jobs.push(job);
    log.debug(`addJob: ${job.name} schedule=${JSON.stringify(job.schedule)}`);
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

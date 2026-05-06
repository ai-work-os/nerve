/**
 * DailyFileWriter — appends transcript lines to a per-day text file.
 *
 * One file per local day named YYYY-MM-DD.txt under `dir`. Each call writes
 * exactly one line: "[HH:MM:SS] text\n". Synchronous append so a crash only
 * loses lines that never reached this method. Day rollover is handled per-call
 * (the writer keeps no state about "current day").
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface DailyStats {
  /** Today's file path (may not exist yet if no writes today). */
  file: string;
  /** Lines written to today's file. 0 if file missing. */
  lines: number;
  /** Total character count of text portions only (excluding timestamps and newlines). */
  chars: number;
}

export class DailyFileWriter {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /** Append one transcript line for the given timestamp's local day. */
  append(text: string, ts: Date): void {
    const safe = text.replace(/[\r\n]+/g, " ").trim();
    if (safe.length === 0) return;
    const day = formatDate(ts);
    const time = formatTime(ts);
    const path = join(this.dir, `${day}.txt`);
    appendFileSync(path, `[${time}] ${safe}\n`);
  }

  /** Stats for today's file (where "today" is the local day of `now`). */
  stats(now: Date = new Date()): DailyStats {
    const day = formatDate(now);
    const file = join(this.dir, `${day}.txt`);
    if (!existsSync(file)) return { file, lines: 0, chars: 0 };
    const content = readFileSync(file, "utf8");
    const lines = content.length === 0 ? 0 : content.split("\n").filter(l => l.length > 0).length;
    let chars = 0;
    for (const line of content.split("\n")) {
      const m = line.match(/^\[\d{2}:\d{2}:\d{2}\] (.*)$/);
      if (m) chars += m[1].length;
    }
    return { file, lines, chars };
  }
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatTime(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

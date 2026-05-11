/**
 * DailyFileWriter — appends transcript lines to a per-day text file.
 *
 * One file per local day named YYYY-MM-DD.txt under `dir`. Each line:
 *   "[HH:MM:SS][source] text\n"
 * `appendOrInsert` keeps lines sorted by (time, source) so that late-arriving
 * remote chunks land in the right place. Synchronous I/O so a crash only
 * loses lines that never reached this method. Day rollover is handled per-call
 * (the writer keeps no state about "current day").
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface DailyStats {
  /** Today's file path (may not exist yet if no writes today). */
  file: string;
  /** Lines written to today's file. 0 if file missing. */
  lines: number;
  /** Total character count of text portions only (excluding timestamps and newlines). */
  chars: number;
}

/** "[HH:MM:SS][source] text" — line format on disk. */
const LINE_RE = /^\[(\d{2}):(\d{2}):(\d{2})\]\[([^\]]+)\] (.*)$/;

interface ParsedLine {
  hh: number; mm: number; ss: number;
  source: string;
  text: string;
  raw: string;
}

export class DailyFileWriter {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /**
   * Legacy append (no source) — kept for backward compat with any caller still
   * using the old signature; defaults to source="mac".
   * @deprecated use appendOrInsert
   */
  append(text: string, ts: Date): void {
    this.appendOrInsert(text, ts, "mac");
  }

  /**
   * Insert one transcript line into the day file at the correct chronological
   * position. Fast path when the new line is later than the last existing line.
   */
  appendOrInsert(text: string, ts: Date, source: string): void {
    const safe = text.replace(/[\r\n]+/g, " ").trim();
    if (safe.length === 0) return;
    const day = formatDate(ts);
    const time = formatTime(ts);
    const path = join(this.dir, `${day}.txt`);
    const newLine = `[${time}][${source}] ${safe}\n`;

    if (!existsSync(path)) {
      writeFileSync(path, newLine);
      return;
    }
    const content = readFileSync(path, "utf8");
    const lines = content.length === 0 ? [] : content.split("\n").filter(l => l.length > 0);
    if (lines.length === 0) {
      writeFileSync(path, newLine);
      return;
    }
    const last = parseLine(lines[lines.length - 1]);
    const newKey = sortKey(time, source);
    if (last && sortKey(`${pad(last.hh)}:${pad(last.mm)}:${pad(last.ss)}`, last.source) <= newKey) {
      // fast path: append
      appendFileSync(path, newLine);
      return;
    }
    // slow path: parse all, insert, rewrite
    const parsed: ParsedLine[] = lines.map(l => parseLine(l) ?? { hh: 0, mm: 0, ss: 0, source: "?", text: l, raw: l });
    const newParsed: ParsedLine = {
      hh: ts.getHours(), mm: ts.getMinutes(), ss: ts.getSeconds(),
      source, text: safe, raw: newLine.trimEnd(),
    };
    parsed.push(newParsed);
    parsed.sort((a, b) => sortKey(`${pad(a.hh)}:${pad(a.mm)}:${pad(a.ss)}`, a.source)
                         .localeCompare(sortKey(`${pad(b.hh)}:${pad(b.mm)}:${pad(b.ss)}`, b.source)));
    writeFileSync(path, parsed.map(p => p.raw).join("\n") + "\n");
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
      const m = line.match(LINE_RE);
      if (m) chars += m[5].length;
    }
    return { file, lines, chars };
  }
}

function parseLine(line: string): ParsedLine | null {
  const m = line.match(LINE_RE);
  if (!m) return null;
  return {
    hh: parseInt(m[1], 10), mm: parseInt(m[2], 10), ss: parseInt(m[3], 10),
    source: m[4], text: m[5], raw: line,
  };
}

function sortKey(time: string, source: string): string {
  return `${time}|${source}`;
}

function pad(n: number): string { return String(n).padStart(2, "0"); }

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

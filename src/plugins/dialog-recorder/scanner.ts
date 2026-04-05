/**
 * Dialog Scanner — scans Claude Code conversation files,
 * extracts user messages incrementally.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, basename, dirname } from "node:path";

export interface DialogEntry {
  ts: string;
  sessionId: string;
  project: string;
  cwd: string;
  gitBranch?: string;
  content: string;
  contentLength: number;
}

export interface ScanResult {
  entries: DialogEntry[];
  newOffsets: Record<string, number>;  // filePath → lineOffset
}

/** Remove HTML-style tags and their content (system-reminder, local-command-*, etc.) */
export function cleanContent(raw: string): string {
  return raw.replace(/<([a-zA-Z][\w-]*)>[^]*?<\/\1>/gs, "");
}

/** Read a JSONL file from startLine, extract user messages into DialogEntry[] */
export async function extractUserMessages(
  filePath: string,
  startLine: number,
): Promise<{ entries: DialogEntry[]; linesRead: number }> {
  const content = await readFile(filePath, "utf-8");
  const allLines = content.split("\n").filter(l => l.trim() !== "");
  const lines = allLines.slice(startLine);
  const project = basename(dirname(filePath));
  const entries: DialogEntry[] = [];

  for (const line of lines) {
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      console.log(`[scanner] skip unparseable line in ${filePath}`);
      continue;
    }

    if (record.type !== "user") continue;

    const rawContent = record.message?.content;
    let text: string;
    if (typeof rawContent === "string") {
      text = rawContent;
    } else if (Array.isArray(rawContent)) {
      text = rawContent
        .filter((item: any) => item.type === "text")
        .map((item: any) => item.text)
        .join("");
    } else {
      text = "";
    }

    const cleaned = cleanContent(text);

    entries.push({
      ts: record.timestamp ?? "",
      sessionId: record.sessionId ?? "",
      project,
      cwd: record.cwd ?? "",
      gitBranch: record.gitBranch,
      content: cleaned,
      contentLength: cleaned.length,
    });
  }

  console.log(`[scanner] ${filePath}: read ${lines.length} lines from offset ${startLine}, found ${entries.length} user messages`);
  return { entries, linesRead: lines.length };
}

/** Scan all project subdirs for .jsonl files, extract user messages incrementally */
export async function scanProjects(
  projectsDir: string,
  offsets: Record<string, number>,
): Promise<ScanResult> {
  const entries: DialogEntry[] = [];
  const newOffsets: Record<string, number> = { ...offsets };

  let subdirs: string[];
  try {
    const dirEntries = await readdir(projectsDir);
    subdirs = [];
    for (const name of dirEntries) {
      const full = resolve(projectsDir, name);
      const s = await stat(full);
      if (s.isDirectory()) subdirs.push(name);
    }
  } catch (e) {
    console.log(`[scanner] cannot read projectsDir: ${e}`);
    return { entries, newOffsets };
  }

  for (const subdir of subdirs) {
    try {
      const dirPath = resolve(projectsDir, subdir);
      const files = (await readdir(dirPath)).filter(f => f.endsWith(".jsonl"));

      for (const file of files) {
        try {
          const filePath = resolve(dirPath, file);
          // Offset tracking assumes JSONL files are append-only (lines are never modified/deleted)
          const startLine = offsets[filePath] ?? 0;
          const result = await extractUserMessages(filePath, startLine);
          entries.push(...result.entries);
          newOffsets[filePath] = startLine + result.linesRead;
        } catch (e) {
          console.log(`[scanner] warn: failed to process ${subdir}/${file}, skipping: ${e}`);
        }
      }
    } catch (e) {
      console.log(`[scanner] warn: failed to read subdir ${subdir}, skipping: ${e}`);
    }
  }

  console.log(`[scanner] scanProjects: ${subdirs.length} projects, ${entries.length} new entries`);
  return { entries, newOffsets };
}

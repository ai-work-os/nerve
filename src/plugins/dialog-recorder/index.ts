#!/usr/bin/env node
/**
 * Dialog Recorder — nerve plugin node.
 * Scans Claude Code conversations, extracts user messages, generates daily reports.
 */

import { PluginBase, type CommandDef } from "../plugin-base.js";
import { scanProjects } from "./scanner.js";
import { aggregateDailyStats, formatDailyReport } from "./reporter.js";
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";

function getArg(flag: string, defaultVal: string): string {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : defaultVal;
}

const PORT = parseInt(getArg("--port", "4800"));
const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class DialogRecorder extends PluginBase {
  private projectsDir: string;
  private dialogsDir: string;
  private reportsDir: string;
  private offsetsPath: string;
  private offsets: Record<string, number> = {};
  private scanTimer?: ReturnType<typeof setInterval>;
  private scanning = false;

  constructor() {
    super({
      port: PORT,
      name: "dialog-recorder",
      capabilities: ["monitor"],
      permissions: "observer",
    });
    this.projectsDir = resolve(homedir(), ".claude/projects");
    this.dialogsDir = resolve(this.dataDir, "dialogs");
    this.reportsDir = resolve(this.dataDir, "reports");
    this.offsetsPath = resolve(this.dataDir, "offsets.json");
  }

  override getCommands(): Record<string, CommandDef> {
    return {
      status: { description: "Show scan status: files tracked, today's message count" },
      scan: { description: "Trigger an immediate scan" },
      report: { description: "Generate daily report for today (or specified date)" },
    };
  }

  override getEvents(): string[] {
    return ["dialog-recorder.scan_complete"];
  }

  protected override onCommand(command: string, args: Record<string, string>, _from?: string): string | void {
    switch (command) {
      case "status":
        this.handleStatus();
        break;
      case "scan":
        this.runScan();
        break;
      case "report":
        this.handleReport(args["0"] || this.todayDate());
        break;
    }
  }

  protected override async onReady(): Promise<void> {
    await this.loadOffsets();
    this.log("info", `starting initial scan, tracking ${Object.keys(this.offsets).length} files`);
    await this.runScan();
    this.scanTimer = setInterval(() => this.runScan(), SCAN_INTERVAL_MS);
    this.log("info", "periodic scan started (every 5 min)");
  }

  private clearScanTimer(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = undefined;
    }
  }

  protected override onDisconnect(): void {
    this.clearScanTimer();
    this.log("info", "disconnected, scan timer cleared");
  }

  override stop(): void {
    this.clearScanTimer();
    super.stop();
  }

  /** Run a full incremental scan, persist results */
  private async runScan(): Promise<void> {
    if (this.scanning) {
      this.log("info", "scan already in progress, skipping");
      return;
    }
    this.scanning = true;
    this.log("info", "scan started");
    const result = await scanProjects(this.projectsDir, this.offsets);
    this.offsets = result.newOffsets;

    if (result.entries.length > 0) {
      // Group entries by date and append to daily JSONL files
      await mkdir(this.dialogsDir, { recursive: true });
      const byDate = new Map<string, typeof result.entries>();
      for (const entry of result.entries) {
        const date = entry.ts.slice(0, 10); // YYYY-MM-DD
        if (!byDate.has(date)) byDate.set(date, []);
        byDate.get(date)!.push(entry);
      }
      for (const [date, entries] of byDate) {
        const filePath = resolve(this.dialogsDir, `${date}.jsonl`);
        const lines = entries.map(e => JSON.stringify(e)).join("\n") + "\n";
        await appendFile(filePath, lines);
      }
      this.log("info", `wrote ${result.entries.length} entries across ${byDate.size} date files`);
    }

    await this.saveOffsets();
    this.scanning = false;
    this.log("info", `scan complete: ${result.entries.length} new messages, ${Object.keys(this.offsets).length} files tracked`);
  }

  private async handleStatus(): Promise<void> {
    const filesTracked = Object.keys(this.offsets).length;
    const today = this.todayDate();
    const stats = await aggregateDailyStats(this.dialogsDir, today);
    this.log("info", `status: ${filesTracked} files tracked, ${stats.totalMessages} messages today (${today}), ${stats.totalSessions} sessions`);
  }

  private async handleReport(date: string): Promise<void> {
    const stats = await aggregateDailyStats(this.dialogsDir, date);
    const report = formatDailyReport(stats);
    await mkdir(this.reportsDir, { recursive: true });
    const reportPath = resolve(this.reportsDir, `${date}.md`);
    await writeFile(reportPath, report);
    this.log("info", `report generated: ${reportPath}`);
  }

  private async loadOffsets(): Promise<void> {
    try {
      const raw = await readFile(this.offsetsPath, "utf-8");
      this.offsets = JSON.parse(raw);
      this.log("info", `loaded offsets: ${Object.keys(this.offsets).length} files`);
    } catch {
      this.offsets = {};
      this.log("info", "no existing offsets, starting fresh");
    }
  }

  private async saveOffsets(): Promise<void> {
    await writeFile(this.offsetsPath, JSON.stringify(this.offsets, null, 2));
  }

  private todayDate(): string {
    return new Date().toISOString().slice(0, 10);
  }
}

// Auto-start when run directly
const isMain = process.argv[1]?.endsWith("dialog-recorder/index.ts") ||
               process.argv[1]?.endsWith("dialog-recorder/index.js");
if (isMain) {
  const recorder = new DialogRecorder();
  recorder.start().catch(err => {
    console.error("dialog-recorder failed to start:", err);
    process.exit(1);
  });
}

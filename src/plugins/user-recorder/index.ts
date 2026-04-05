#!/usr/bin/env node
/**
 * User Recorder — nerve plugin node that records messages from client nodes.
 *
 * Only records messages where metadata.nodeType === "websocket" (TUI, Android, Web).
 * Ignores AI agents ("stdio") and other plugins ("program").
 *
 * Each channel/session gets its own JSONL file in ~/.nerve/plugins/user-recorder/sessions/.
 *
 * Commands:
 *   status  — current recording stats
 *   report  — today's summary (or report date=YYYY-MM-DD)
 */

import { appendFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { PluginBase, type CommandDef } from "../plugin-base.js";
import {
  shouldRecord,
  formatRecord,
  sessionKey,
  formatStatusReport,
  formatDateReport,
} from "./logic.js";

function getArg(flag: string, defaultVal: string): string {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : defaultVal;
}

const PORT = parseInt(getArg("--port", "4800"));

/** Local date as YYYY-MM-DD */
function localDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export class UserRecorder extends PluginBase {
  private sessionsDir: string;
  private recordCount = 0;
  /** Serialized write queue to preserve message order */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(port: number = PORT) {
    super({
      port,
      name: "user-recorder",
      capabilities: ["monitor"],
      permissions: "observer",
    });
    this.sessionsDir = resolve(this.dataDir, "sessions");
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  override getCommands(): Record<string, CommandDef> {
    return {
      status: { description: "Show recording stats (message count, session count)" },
      report: { description: "Date report (default: today)", args: { date: "YYYY-MM-DD" } },
    };
  }

  override getEvents(): string[] {
    return [];
  }

  protected override registerNotifications(): void {
    // channel.message — filter and record client messages
    this.onNotification("channel.message", (params) => {
      const metadata = params?.message?.metadata ?? params?.metadata;
      if (shouldRecord(metadata)) {
        this.recordMessage(params);
      }
      // Also dispatch @user-recorder commands
      this.handleChannelMessage(params);
    });

    // DM command dispatch
    this.onNotification("node.message", (params) => {
      this.dispatchCommand(params?.content as string, params?.from as string);
    });
  }

  protected override onCommand(command: string, args: Record<string, string>, from?: string): string | void {
    switch (command) {
      case "status":
        this.handleStatus();
        break;
      case "report":
        this.handleReport(args.date || args["0"] || localDate());
        break;
      default:
        return `unknown command: ${command}`;
    }
  }

  protected override async onReady(): Promise<void> {
    this.log("info", "user-recorder ready, joining existing channels");

    // Join all existing channels to receive messages
    try {
      const result = await this.request("channel.list");
      const channels = result.channels || [];
      for (const ch of channels) {
        await this.autoJoin(ch.id);
      }
      this.log("info", `joined ${channels.length} existing channels`);
    } catch (err) {
      this.log("warn", `failed to list/join channels: ${err}`);
    }

    // Auto-join new channels
    this.onNotification("channel.created", (params) => {
      this.log("info", `channel.created: ${params.name || params.channelId}, auto-joining`);
      this.autoJoin(params.channelId);
    });

    await this.setActivity("recording");
  }

  private async autoJoin(channelId: string): Promise<void> {
    try {
      await this.request("channel.join", { channelId });
      this.log("info", `joined channel ${channelId}`);
    } catch (err) {
      this.log("debug", `join ${channelId} skipped (may already be member): ${err}`);
    }
  }

  private async setActivity(activity: string): Promise<void> {
    try {
      await this.request("node.activity", { activity });
    } catch {
      // best-effort
    }
  }

  private recordMessage(params: any): void {
    const record = formatRecord(params);
    const key = sessionKey(record.channelId);
    const filePath = resolve(this.sessionsDir, `${key}.jsonl`);
    const line = JSON.stringify(record) + "\n";

    this.recordCount++;
    this.log("info", `recording message: from=${record.from} channel=${record.channelId} session=${key}`);

    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await appendFile(filePath, line);
      } catch (err) {
        this.log("error", `failed to write record: ${err}`);
      }
    });
  }

  private handleStatus(): void {
    const status = formatStatusReport(this.sessionsDir);
    this.log("info", `status: ${status} (${this.recordCount} in current session)`);
  }

  private handleReport(date: string): void {
    const report = formatDateReport(this.sessionsDir, date);
    this.log("info", `report for ${date}:\n${report}`);
  }

  /** Flush pending writes */
  async flush(): Promise<void> {
    await this.writeQueue;
  }
}

// --- Main ---

const isDirectRun = process.argv[1]?.endsWith("user-recorder/index.ts") ||
                    process.argv[1]?.endsWith("user-recorder/index.js");

if (isDirectRun) {
  const recorder = new UserRecorder();

  recorder.start().catch((err) => {
    console.error(`[user-recorder] failed to start: ${err}`);
    process.exit(1);
  });

  async function shutdown() {
    recorder.stop();
    await recorder.flush();
    process.exit(0);
  }
  process.on("SIGTERM", () => { shutdown(); });
  process.on("SIGINT", () => { shutdown(); });
}

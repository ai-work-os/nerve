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

import { appendFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { PluginBase } from "../plugin-base.js";
import {
  formatChannelMessage,
  formatNodeRegistered,
  formatNodeStopped,
  formatNodeStatusChanged,
  type ObserverEvent,
} from "./events.js";

function getArg(flag: string, defaultVal: string): string {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : defaultVal;
}

const PORT = parseInt(getArg("--port", "4800"));

/** Map of channelId → channelName for enriching events */
type ChannelNameMap = Map<string, string>;

class Observer extends PluginBase {
  private eventsDir: string;
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
    mkdirSync(this.eventsDir, { recursive: true });
  }

  protected override registerNotifications(): void {
    // channel.message — from channels we've joined
    this.onNotification("channel.message", (params) => {
      this.recordEvent(formatChannelMessage({
        ...params,
        channelName: this.channelNames.get(params.channelId) ?? params.channelId,
      }));
    });

    // channel.created — auto-join new channels
    this.onNotification("channel.created", (params) => {
      const { channelId, name } = params;
      this.log("info", `channel.created: ${name || channelId}, auto-joining`);
      if (name) this.channelNames.set(channelId, name);
      this.autoJoin(channelId);
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
    const date = event.ts.slice(0, 10); // YYYY-MM-DD
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
process.on("SIGTERM", () => { shutdown(); });
process.on("SIGINT", () => { shutdown(); });

#!/usr/bin/env node
/**
 * screenshot — receives phone screenshots, stores them content-addressed,
 * logs a perception line, posts a reference message to #screenshots, and
 * tracks Mac delivery. No AI analysis in Phase 1.
 *
 * Commands: status.
 */
import { resolve } from "node:path";
import { PluginBase, type CommandDef, type CommandResult } from "../plugin-base.js";
import type { HealthContract } from "../../transport/protocol.js";
import { BlobStore } from "./blob-store.js";
import { ScreenshotIndex } from "./screenshot-index.js";
import { processUpload } from "./upload-handler.js";
import { ScreenshotHttpServer } from "./http-server.js";

function getArg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const PORT = parseInt(getArg("--port", "4800"));
const HTTP_PORT = parseInt(process.env.SCREENSHOT_HTTP_PORT ?? "4811", 10);
const CHANNEL_NAME = process.env.SCREENSHOT_CHANNEL ?? "screenshots";
const MAX_BYTES = parseInt(process.env.SCREENSHOT_MAX_BYTES ?? String(25 * 1024 * 1024), 10);

class ScreenshotPlugin extends PluginBase {
  private blobs!: BlobStore;
  private index!: ScreenshotIndex;
  private logDir!: string;
  private http: ScreenshotHttpServer | null = null;
  private startTime = Date.now();
  private errorReason: string | null = null;

  constructor() {
    super({ port: PORT, name: "screenshot", capabilities: ["monitor"], permissions: "member" });
    this.blobs = new BlobStore(resolve(this.dataDir, "blobs"));
    this.index = new ScreenshotIndex(resolve(this.dataDir, "index.json"));
    this.logDir = resolve(this.dataDir, "log");
  }

  protected async onReady(): Promise<void> {
    try {
      await this.ensureChannel(CHANNEL_NAME);
    } catch (err: any) {
      this.errorReason = `channel setup failed: ${err.message}`;
      this.log("error", this.errorReason);
    }

    this.http = new ScreenshotHttpServer({
      port: HTTP_PORT,
      maxBytes: MAX_BYTES,
      onUpload: (data, meta) => {
        const { record, channelText } = processUpload(
          { blobs: this.blobs, index: this.index, logDir: this.logDir }, data, meta,
        );
        this.log("info", `screenshot stored: blob=${record.blobId} source=${record.source} analyze=${record.analyze}`);
        if (this.channelId) {
          this.postToChannel(this.channelId, channelText);
        } else {
          this.log("warn", `no channel — screenshot ${record.blobId} not announced`);
        }
        return record.blobId;
      },
      getBlob: (id) => {
        const data = this.blobs.get(id);
        if (!data) return null;
        const record = this.index.all().find(r => r.blobId === id);
        // Blob bytes exist but no index record — fall back to a generic type.
        return { data, mimeType: record?.mimeType ?? "application/octet-stream" };
      },
      listPendingMac: () => this.index.pendingMac().map(r => ({
        blobId: r.blobId, takenAtMs: r.takenAtMs, source: r.source,
      })),
      onAckMac: (id) => {
        const ok = this.index.markDelivered(id);
        this.log("info", ok ? `mac ack: ${id}` : `mac ack unknown blob: ${id}`);
        return ok;
      },
      log: (l, m) => this.log(l, `[http] ${m}`),
    });

    try {
      const actual = await this.http.start();
      this.log("info", `screenshot plugin ready: http :${actual}, channel #${CHANNEL_NAME}`);
    } catch (err: any) {
      this.errorReason = `http start failed: ${err.message}`;
      this.log("error", this.errorReason);
    }
  }

  /** Find or create the target channel, then join it. */
  private async ensureChannel(name: string): Promise<void> {
    const list = await this.request("channel.list");
    const found = (list?.channels ?? []).find((c: any) => c.name === name);
    const channelId = found ? found.channelId : (await this.request("channel.create", { name })).channelId;
    await this.request("channel.join", { channelId });
    this.channelId = channelId;
    this.log("info", `joined channel ${channelId} (#${name})`);
  }

  protected onDisconnect(): void {
    void this.http?.stop();
  }

  override getCommands(): Record<string, CommandDef> {
    return { status: { description: "查看状态：HTTP 端口、累计截图数、未投递 Mac 数" } };
  }

  override getHealth(): HealthContract {
    return { liveness: "connection", maxIdleMs: "none" };
  }

  protected override onCommand(command: string, _args: Record<string, string>, _from?: string): CommandResult {
    if (command === "status") {
      const total = this.index.all().length;
      const pending = this.index.pendingMac().length;
      const uptime = Math.round((Date.now() - this.startTime) / 1000);
      const mode = this.errorReason ? `error: ${this.errorReason}` : "ok";
      return { reply: `${mode}; uptime=${uptime}s; http=:${HTTP_PORT}; screenshots=${total}; pending-mac=${pending}` };
    }
    return {};
  }
}

// --- Main ---
import { fileURLToPath as _flu } from "node:url";
const _thisFile = _flu(import.meta.url);
const _isMain = process.argv[1] && (
  process.argv[1] === _thisFile ||
  process.argv[1].endsWith("screenshot/index.ts") ||
  process.argv[1].endsWith("screenshot/index.js")
);

if (_isMain) {
  const plugin = new ScreenshotPlugin();
  plugin.start().catch((err) => {
    console.error(`[screenshot] failed to start: ${err}`);
    process.exit(1);
  });
  process.on("SIGTERM", () => { plugin.stop(); process.exit(0); });
  process.on("SIGINT", () => { plugin.stop(); process.exit(0); });
}

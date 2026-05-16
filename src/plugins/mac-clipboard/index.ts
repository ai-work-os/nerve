#!/usr/bin/env node
/**
 * mac-clipboard — runs on a Mac, connects to a nerve (possibly remote, e.g.
 * home over tailscale), subscribes to #screenshots, and for each screenshot:
 * downloads the blob, saves it to ~/Screenshots/from-phone/, copies it to the
 * Mac clipboard, then acks delivery. On (re)connect it drains pending-mac so a
 * Mac that was asleep catches up.
 *
 * Config via env:
 *   NERVE_HOST            nerve WS host (default 127.0.0.1)
 *   NERVE_PORT            nerve WS port (default 4800)
 *   SCREENSHOT_HTTP_URL   screenshot plugin HTTP base (default http://<NERVE_HOST>:4811)
 *   SCREENSHOT_CHANNEL    channel name (default screenshots)
 *   MAC_INBOX_DIR         save dir (default ~/Screenshots/from-phone)
 */
import { resolve } from "node:path";
import { homedir } from "node:os";
import { PluginBase, type CommandDef, type CommandResult } from "../plugin-base.js";
import type { HealthContract } from "../../transport/protocol.js";
import { parseScreenshotMessage } from "./message-parser.js";
import { downloadBlob, fetchPendingMac, ackMac, type PendingEntry } from "./blob-client.js";
import { saveScreenshot } from "./screenshot-saver.js";
import { copyImageToClipboard } from "./clipboard.js";

function getArg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const HOST = process.env.NERVE_HOST ?? "127.0.0.1";
const PORT = parseInt(getArg("--port", process.env.NERVE_PORT ?? "4800"), 10);
const HTTP_URL = process.env.SCREENSHOT_HTTP_URL ?? `http://${HOST}:4811`;
const CHANNEL_NAME = process.env.SCREENSHOT_CHANNEL ?? "screenshots";
const INBOX_DIR = process.env.MAC_INBOX_DIR ?? resolve(homedir(), "Screenshots/from-phone");

class MacClipboardPlugin extends PluginBase {
  private processed = new Set<string>();
  private startTime = Date.now();
  private delivered = 0;

  constructor() {
    super({ host: HOST, port: PORT, name: "mac-clipboard", capabilities: ["monitor"], permissions: "member" });
  }

  protected async onReady(): Promise<void> {
    try {
      await this.ensureChannel(CHANNEL_NAME);
    } catch (err: any) {
      this.log("error", `channel setup failed: ${err.message}`);
    }
    this.log("info", `mac-clipboard ready: nerve=${HOST}:${PORT}, http=${HTTP_URL}, inbox=${INBOX_DIR}`);
    await this.drainPending();
  }

  /** Find or create the target channel, then join it. */
  private async ensureChannel(name: string): Promise<void> {
    const list = await this.request("channel.list");
    const found = (list?.channels ?? []).find((c: any) => c.name === name);
    // channel.list returns { id } but channel.create returns { channelId }
    const channelId = found ? (found.channelId ?? found.id) : (await this.request("channel.create", { name })).channelId;
    if (!channelId) throw new Error(`could not resolve channel #${name}`);
    await this.request("channel.join", { channelId });
    this.channelId = channelId;
    this.log("info", `joined channel ${channelId} (#${name})`);
  }

  /** On (re)connect: process every screenshot the server still has pending for Mac. */
  private async drainPending(): Promise<void> {
    let pending: PendingEntry[] = [];
    try {
      pending = await fetchPendingMac(HTTP_URL);
    } catch (err: any) {
      this.log("warn", `fetchPendingMac failed: ${err.message}`);
      return;
    }
    if (pending.length === 0) { this.log("info", "no pending screenshots"); return; }
    this.log("info", `draining ${pending.length} pending screenshot(s)`);
    for (const p of pending) {
      await this.handleScreenshot(p.blobId, p.takenAtMs);
    }
  }

  /** Channel-message hook: PluginBase only dispatches @mentions, so we override
   *  to catch the screenshot announcements (which are not @mentions). */
  protected override handleChannelMessage(params: any): void {
    const content = (params?.message?.content ?? params?.content) as string | undefined;
    if (!content) return;
    const parsed = parseScreenshotMessage(content);
    if (!parsed) {
      super.handleChannelMessage(params);  // still allow @mention commands (status)
      return;
    }
    void this.handleScreenshot(parsed.blobId, Date.now());
  }

  /** Download → save → clipboard → ack. Idempotent per blobId within a session. */
  private async handleScreenshot(blobId: string, takenAtMs: number): Promise<void> {
    if (this.processed.has(blobId)) {
      this.log("debug", `screenshot ${blobId} already processed this session`);
      return;
    }
    this.processed.add(blobId);
    try {
      const blob = await downloadBlob(HTTP_URL, blobId);
      if (!blob) {
        this.log("warn", `screenshot ${blobId} download returned null (404?)`);
        this.processed.delete(blobId);
        return;
      }
      const path = saveScreenshot(INBOX_DIR, blobId, blob.data, blob.mimeType, takenAtMs);
      this.log("info", `screenshot saved: ${path} (${blob.data.length}B, ${blob.mimeType})`);
      const clipped = copyImageToClipboard(path, blob.mimeType);
      this.log("info", clipped
        ? `screenshot ${blobId} copied to clipboard`
        : `screenshot ${blobId} not clipboard-copied (unsupported type ${blob.mimeType}); file saved`);
      await ackMac(HTTP_URL, blobId);
      this.delivered++;
      this.log("info", `acked ${blobId} to screenshot plugin`);
    } catch (err: any) {
      this.log("error", `handleScreenshot ${blobId} failed: ${err.message}`);
      this.processed.delete(blobId);  // allow retry on next pending drain
    }
  }

  override getCommands(): Record<string, CommandDef> {
    return { status: { description: "查看状态：nerve 连接、已投递截图数" } };
  }

  override getHealth(): HealthContract {
    return { liveness: "connection", maxIdleMs: "none" };
  }

  protected override onCommand(command: string): CommandResult {
    if (command === "status") {
      const uptime = Math.round((Date.now() - this.startTime) / 1000);
      return { reply: `ok; uptime=${uptime}s; nerve=${HOST}:${PORT}; delivered=${this.delivered}` };
    }
    return {};
  }
}

// --- Main ---
import { fileURLToPath as _flu } from "node:url";
const _thisFile = _flu(import.meta.url);
const _isMain = process.argv[1] && (
  process.argv[1] === _thisFile ||
  process.argv[1].endsWith("mac-clipboard/index.ts") ||
  process.argv[1].endsWith("mac-clipboard/index.js")
);

if (_isMain) {
  const plugin = new MacClipboardPlugin();
  plugin.start().catch((err) => {
    console.error(`[mac-clipboard] failed to start: ${err}`);
    process.exit(1);
  });
  process.on("SIGTERM", () => { plugin.stop(); process.exit(0); });
  process.on("SIGINT", () => { plugin.stop(); process.exit(0); });
}

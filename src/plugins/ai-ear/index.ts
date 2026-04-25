#!/usr/bin/env node
/**
 * ai-ear — Meeting transcription plugin for nerve.
 *
 * Captures audio (mic/system/both) via native binary, sends to DashScope ASR,
 * writes transcripts to file, pushes to channel via buffer strategy.
 *
 * Usage:
 *   Spawn via nerve: :spawn ai-ear
 *   Manual: npx tsx src/plugins/ai-ear/index.ts [--port 4800]
 *
 * Environment:
 *   DASHSCOPE_API_KEY    — Required for ASR
 *   DASHSCOPE_MODEL      — ASR model (default: qwen3-asr-flash-realtime)
 *   MC_AUDIO_SOURCE      — mic / system / both (default: mic)
 *   MC_PUSH_INTERVAL     — Buffer flush interval ms (default: 30000)
 *   MC_PUSH_LINES        — Buffer flush line threshold (default: 10)
 */

import { appendFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { PluginBase, type CommandDef, type CommandResult } from "../plugin-base.js";
import { AudioCapture, type AudioSource } from "./audio-capture.js";
import { AsrClient } from "./asr-client.js";

// --- Config from environment ---

function getArg(flag: string, defaultVal: string): string {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : defaultVal;
}

const PORT = parseInt(getArg("--port", "4800"));
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || "";
const DASHSCOPE_MODEL = process.env.DASHSCOPE_MODEL || "qwen3-asr-flash-realtime";
const AUDIO_SOURCE = (process.env.MC_AUDIO_SOURCE || "mic") as AudioSource;
let PUSH_INTERVAL = parseInt(process.env.MC_PUSH_INTERVAL || "300000");
let PUSH_LINES = parseInt(process.env.MC_PUSH_LINES || "10");

// --- Transcript Buffer (exported for testing) ---

export type FlushReason = "interval" | "line_count" | "manual" | "stop";

export interface TranscriptBufferConfig {
  pushInterval: number;
  pushLines: number;
  onFlush: (lines: string[], reason: FlushReason) => void;
}

export class TranscriptBuffer {
  private lines: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private config: TranscriptBufferConfig;

  constructor(config: TranscriptBufferConfig) {
    this.config = config;
    this.timer = setInterval(() => this.doFlush("interval"), config.pushInterval);
  }

  add(line: string): void {
    this.lines.push(line);
    if (this.lines.length >= this.config.pushLines) {
      this.doFlush("line_count");
    }
  }

  flush(): void {
    this.doFlush("manual");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.doFlush("stop");
  }

  private doFlush(reason: FlushReason): void {
    if (this.lines.length === 0) return;
    const batch = this.lines;
    this.lines = [];
    this.config.onFlush(batch, reason);
  }
}

// --- Slice Writer (exported for testing) ---

export class SliceWriter {
  private sliceIndex = 0;
  private tmpDir: string;
  private baseTs: string;

  constructor(tmpDir: string, baseTs: string) {
    this.tmpDir = tmpDir;
    this.baseTs = baseTs;
    // Clean and recreate tmp dir for new session
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
  }

  /** Write lines to a numbered slice file, return the file path */
  write(lines: string[]): string {
    this.sliceIndex++;
    const num = String(this.sliceIndex).padStart(3, "0");
    const filePath = resolve(this.tmpDir, `${this.baseTs}_${num}.txt`);
    writeFileSync(filePath, lines.join("\n") + "\n");
    return filePath;
  }

  /** Extract time range from lines like "[+120s][mic] text" */
  static timeRange(lines: string[]): string {
    const extract = (line: string): string | null => {
      const m = line.match(/^\[(\+\d+s)\]/);
      return m ? m[1] : null;
    };
    const first = extract(lines[0]);
    const last = extract(lines[lines.length - 1]);
    if (first && last && first !== last) return `${first}-${last}`;
    if (first) return first;
    return "?";
  }
}

// --- Plugin ---

class AiEarPlugin extends PluginBase {
  private capture: AudioCapture | null = null;
  private asr: AsrClient | null = null;
  private meetingFile: string | null = null;
  private meetingsDir: string;
  private startTime = 0;
  private buffer: TranscriptBuffer | null = null;
  private channelId: string | null = null;
  private recording = false;
  private subscribers = new Set<string>();
  private sliceWriter: SliceWriter | null = null;
  private tmpDir: string;

  constructor() {
    super({
      port: PORT,
      name: "ai-ear",
      capabilities: ["monitor"],
      permissions: "member",
    });
    this.meetingsDir = resolve(this.dataDir, "meetings");
    this.tmpDir = resolve(this.dataDir, "tmp");
    mkdirSync(this.meetingsDir, { recursive: true });
  }

  protected registerNotifications(): void {
    super.registerNotifications();

    // Track channel membership — must be registered before node.register
    // to catch nodeJoined from scene setup
    this.onNotification("channel.nodeJoined", (params: any) => {
      if (params?.nodeName === this.options.name) {
        this.channelId = params.channelId;
        this.log("info", `joined channel ${this.channelId}`);
      }
    });
    this.onNotification("channel.nodeLeft", (params: any) => {
      if (params?.nodeName === this.options.name && params?.channelId === this.channelId) {
        this.channelId = null;
      }
      // Auto-unsubscribe nodes that leave the channel
      if (params?.nodeName && this.subscribers.has(params.nodeName)) {
        this.subscribers.delete(params.nodeName);
        this.log("info", `auto-unsubscribed ${params.nodeName} (left channel)`);
      }
    });

    // Auto-unsubscribe nodes that stop
    this.onNotification("node.stopped", (params: any) => {
      const name = params?.name;
      if (name && this.subscribers.has(name)) {
        this.subscribers.delete(name);
        this.log("info", `auto-unsubscribed ${name} (node stopped)`);
      }
    });

    // Note: channel.message handling is in base class (handleChannelMessage)
  }

  protected async onReady(): Promise<void> {
    this.log("info", `ready, audio=${AUDIO_SOURCE}, model=${DASHSCOPE_MODEL}`);
    await this.setActivity("idle — waiting for start command");
  }

  protected onDisconnect(): void {
    if (this.recording) {
      this.stopRecording().catch((e) => this.log("warn", `stopRecording on disconnect failed: ${e}`));
    }
  }

  override getCommands(): Record<string, CommandDef> {
    return {
      start: { description: "Start recording", args: { source: "mic / system / both" } },
      stop: { description: "Stop recording" },
      continue: { description: "Resume recording" },
      status: { description: "Show current status" },
      subscribe: { description: "Subscribe to transcript pushes", args: { name: "subscriber name, or 'me' for self" } },
      unsubscribe: { description: "Unsubscribe from transcript pushes", args: { name: "subscriber name, or 'me' for self" } },
      subscribers: { description: "List current subscribers" },
      config: { description: "Set config (e.g. config interval 10)", args: { key: "interval", value: "seconds" } },
      flush: { description: "Immediately push buffered transcript to subscribers" },
    };
  }

  override getEvents(): string[] {
    return ["transcription", "status_change"];
  }

  protected override onCommand(command: string, args: Record<string, string>, from?: string): CommandResult {
    this.log("info", `command: ${command} ${JSON.stringify(args)} from=${from || "unknown"}`);

    switch (command) {
      case "start": {
        const source = (args.source || args["0"] || AUDIO_SOURCE) as AudioSource;
        void this.startRecording(source, from, this.channelId ?? undefined);
        break;
      }
      case "stop":
        void this.stopRecording();
        break;
      case "continue":
        if (!this.recording) {
          void this.startRecording();
        } else {
          this.log("info", "already recording, continue is no-op");
        }
        break;
      case "status":
        return { reply: `recording=${this.recording}, file=${this.meetingFile || "none"}, subscribers=[${[...this.subscribers].join(",")}]` };
      case "subscribe": {
        const target = this.resolveSubscriberName(args, from);
        if (target) {
          this.subscribers.add(target);
          this.log("info", `subscribed: ${target}, total=${this.subscribers.size}`);
        }
        break;
      }
      case "unsubscribe": {
        const target = this.resolveSubscriberName(args, from);
        if (target) {
          this.subscribers.delete(target);
          this.log("info", `unsubscribed: ${target}, total=${this.subscribers.size}`);
        }
        break;
      }
      case "subscribers":
        this.log("info", `subscribers: [${[...this.subscribers].join(", ")}]`);
        break;
      case "config": {
        const key = args["0"];
        const value = args["1"];
        if (key === "interval" && value) {
          const seconds = parseInt(value);
          if (seconds > 0) {
            const oldInterval = PUSH_INTERVAL;
            PUSH_INTERVAL = seconds * 1000;
            // Disable line-based flush when interval is explicitly set
            // (user wants time-based control only)
            PUSH_LINES = Infinity;
            this.rebuildBuffer();
            this.log("info", `config: interval ${oldInterval}ms → ${PUSH_INTERVAL}ms, lines=disabled`);
          } else {
            this.log("error", `config: invalid interval "${value}"`);
          }
        } else if (key === "lines" && value) {
          const lines = parseInt(value);
          if (lines > 0) {
            const oldLines = PUSH_LINES;
            PUSH_LINES = lines;
            this.rebuildBuffer();
            this.log("info", `config: lines ${oldLines} → ${lines}`);
          } else {
            this.log("error", `config: invalid lines "${value}"`);
          }
        } else {
          this.log("error", `config: usage: config interval <seconds> | config lines <count>`);
        }
        break;
      }
      case "flush":
        if (this.buffer) {
          this.buffer.flush();
          this.log("info", "manual flush triggered");
        } else {
          this.log("warn", "no active buffer to flush");
        }
        break;
    }
  }

  protected override handleChannelMessage(params: any): void {
    // Track channelId from channel messages
    if (params?.channelId) this.channelId = params.channelId;
    super.handleChannelMessage(params);
  }

  /** Resolve subscriber name: explicit name arg > "me" resolves to from > bare from */
  private resolveSubscriberName(args: Record<string, string>, from?: string): string | null {
    const explicit = args.name || args["0"];
    if (explicit && explicit.toLowerCase() !== "me") return explicit;
    // "me" or no arg — use sender's name
    if (from && from !== "unknown") return from;
    return null;
  }

  async startRecording(source: AudioSource = AUDIO_SOURCE, from?: string, channelId?: string): Promise<void> {
    if (this.recording) {
      this.reportError(channelId, from, "already recording");
      return;
    }

    if (!DASHSCOPE_API_KEY) {
      this.reportError(channelId, from, "DASHSCOPE_API_KEY not set");
      await this.setActivity("error: no API key");
      return;
    }

    this.recording = true;
    this.startTime = Date.now();
    this.meetingFile = this.createMeetingFile();
    const baseTs = basename(this.meetingFile, ".txt");
    this.sliceWriter = new SliceWriter(this.tmpDir, baseTs);
    this.log("info", `recording started: source=${source}, file=${this.meetingFile}`);

    // Init buffer
    this.buffer = new TranscriptBuffer({
      pushInterval: PUSH_INTERVAL,
      pushLines: PUSH_LINES,
      onFlush: (lines, reason) => this.onBufferFlush(lines, reason),
    });

    // Start ASR
    this.asr = new AsrClient({
      model: DASHSCOPE_MODEL,
      apiKey: DASHSCOPE_API_KEY,
    });

    this.asr.on("text", (text: string, interim: boolean) => {
      if (!interim) this.onTranscript(text, source);
    });

    this.asr.on("error", (err: Error) => {
      this.log("error", `ASR error: ${err.message}`);
    });

    this.asr.on("reconnecting", () => {
      this.log("info", "ASR disconnected, reconnecting...");
      this.setActivity(`recording (${source}) — ASR reconnecting`).catch(() => {});
    });

    this.asr.on("ready", () => {
      if (this.recording) {
        this.log("info", "ASR reconnected");
        this.setActivity(`recording (${source})`).catch(() => {});
      }
    });

    try {
      await this.asr.connect();
    } catch (err: any) {
      this.reportError(channelId, from, `ASR connect failed: ${err.message}`);
      this.recording = false;
      await this.setActivity("error: ASR connect failed");
      return;
    }

    // Start audio capture
    this.capture = new AudioCapture(source);

    this.capture.on("data", (pcm: Buffer) => {
      this.asr?.sendAudio(pcm);
    });

    this.capture.on("log", (line: string) => {
      this.log("info", `[capture] ${line}`);
    });

    this.capture.on("error", (err: Error) => {
      this.log("error", `capture error: ${err.message}`);
    });

    this.capture.on("exit", (code: number | null) => {
      this.log("info", `capture exited: code=${code}`);
      if (this.recording) {
        this.stopRecording().catch((e) => this.log("warn", `stopRecording on capture exit failed: ${e}`));
      }
    });

    try {
      await this.capture.start();
      await this.setActivity(`recording (${source})`);
    } catch (err: any) {
      this.reportError(channelId, from, `capture start failed: ${err.message}`);
      this.recording = false;
      this.asr.disconnect();
      await this.setActivity("error: capture failed");
    }
  }

  async stopRecording(): Promise<void> {
    if (!this.recording) return;

    this.recording = false;

    // Safe shutdown: each step independent, one failure doesn't block the rest
    try { this.capture?.stop(); } catch (err: any) {
      this.log("warn", `capture.stop() error: ${err.message}`);
    }
    try { this.asr?.disconnect(); } catch (err: any) {
      this.log("warn", `asr.disconnect() error: ${err.message}`);
    }
    try { this.buffer?.stop(); } catch (err: any) {
      this.log("warn", `buffer.stop() error: ${err.message}`);
    }

    const duration = Math.round((Date.now() - this.startTime) / 1000);
    this.log("info", `recording stopped. duration=${duration}s, file=${this.meetingFile}`);
    await this.setActivity("idle — recording stopped");

    this.capture = null;
    this.asr = null;
    this.buffer = null;
    this.sliceWriter = null;
  }

  private onTranscript(text: string, source: string): void {
    const elapsed = Math.round((Date.now() - this.startTime) / 1000);
    const line = `[+${elapsed}s][${source}] ${text}`;

    // Write to transcript file
    if (this.meetingFile) {
      appendFileSync(this.meetingFile, line + "\n");
    }

    // DM log
    this.log("info", line);

    // Buffer for channel push
    this.buffer?.add(line);
  }

  private rebuildBuffer(): void {
    if (this.buffer) {
      this.buffer.stop();
      this.buffer = new TranscriptBuffer({
        pushInterval: PUSH_INTERVAL,
        pushLines: PUSH_LINES,
        onFlush: (lines, reason) => this.onBufferFlush(lines, reason),
      });
    }
  }

  private onBufferFlush(lines: string[], reason: FlushReason): void {
    switch (reason) {
      case "interval":
        this.log("info", `flush triggered by interval (${PUSH_INTERVAL}ms), ${lines.length} lines`);
        break;
      case "line_count":
        this.log("info", `flush triggered by line count (${lines.length} >= ${PUSH_LINES})`);
        break;
      case "manual":
        this.log("info", `flush triggered by manual command, ${lines.length} lines`);
        break;
      case "stop":
        this.log("info", `flush triggered by stop, ${lines.length} lines`);
        break;
    }
    void this.pushToChannel(lines);
  }

  private async pushToChannel(lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    if (!this.channelId) {
      this.log("warn", "no channel to push transcript to");
      return;
    }
    if (this.subscribers.size === 0) {
      this.log("debug", "no subscribers, skipping channel post");
      return;
    }

    // Write slice file
    const slicePath = this.sliceWriter?.write(lines);
    if (slicePath) {
      this.log("debug", `slice written: ${slicePath} (${lines.length} lines)`);
    }
    const timeRange = SliceWriter.timeRange(lines);
    const mentions = [...this.subscribers].map(s => `@${s}`).join(" ");
    const content = `${mentions} 新增转录 [${timeRange}]，${lines.length}行，文件：${slicePath}`;
    try {
      await this.request("channel.post", { channelId: this.channelId, content });
      this.log("info", `channel push ok: channelId=${this.channelId}, subscribers=[${[...this.subscribers].join(",")}], slice=${slicePath || "none"}, lines=${lines.length}`);
    } catch (err: any) {
      this.log("warn", `channel push failed: ${err.message}`);
    }
  }

  private createMeetingFile(): string {
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
    return resolve(this.meetingsDir, `${ts}.txt`);
  }

  private async setActivity(activity: string): Promise<void> {
    try {
      await this.request("node.activity", { activity });
    } catch {
      // Best-effort
    }
  }
}

// --- Main (only when run as entry point, not when imported) ---

import { fileURLToPath as _flu } from "node:url";
const _thisFile = _flu(import.meta.url);
const _isMain = process.argv[1] && (
  process.argv[1] === _thisFile ||
  process.argv[1].endsWith("ai-ear/index.ts") ||
  process.argv[1].endsWith("ai-ear/index.js")
);

if (_isMain) {
  const plugin = new AiEarPlugin();

  plugin.start().catch((err) => {
    console.error(`[ai-ear] failed to start: ${err}`);
    process.exit(1);
  });

  process.on("SIGTERM", () => { plugin.stop(); process.exit(0); });
  process.on("SIGINT", () => { plugin.stop(); process.exit(0); });
}

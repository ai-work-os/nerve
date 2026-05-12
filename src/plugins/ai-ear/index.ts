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

import { mkdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { PluginBase, type CommandDef, type CommandResult } from "../plugin-base.js";
import { type AudioSource } from "./audio-capture.js";
import { child as childLogger } from "../../infra/logger.js";
import { CapturePipeline } from "./capture-pipeline.js";

// Re-exports for backward compatibility (tests import from index.ts)
export { TranscriptBuffer, type FlushReason, type TranscriptBufferConfig } from "./transcript-buffer.js";
export { SliceWriter } from "./capture-pipeline.js";

const log = childLogger({ module: "plugin:ai-ear" });

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

// --- Plugin ---

class AiEarPlugin extends PluginBase {
  private pipeline: CapturePipeline | null = null;
  private meetingFile: string | null = null;
  private meetingsDir: string;
  private recording = false;
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
        const source = (args.source || AUDIO_SOURCE) as AudioSource;
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
        return { reply: `recording=${this.recording}, file=${this.meetingFile || "none"}` };
      case "config": {
        const key = args.key;
        const value = args.value;
        if (key === "interval" && value) {
          const seconds = parseInt(value);
          if (seconds > 0) {
            const oldInterval = PUSH_INTERVAL;
            PUSH_INTERVAL = seconds * 1000;
            // Disable line-based flush when interval is explicitly set
            // (user wants time-based control only)
            PUSH_LINES = Infinity;
            this.pipeline?.rebuildBuffer(PUSH_INTERVAL, PUSH_LINES);
            this.log("info", `config: interval ${oldInterval}ms → ${PUSH_INTERVAL}ms, lines=disabled`);
          } else {
            this.log("error", `config: invalid interval "${value}"`);
          }
        } else if (key === "lines" && value) {
          const lines = parseInt(value);
          if (lines > 0) {
            const oldLines = PUSH_LINES;
            PUSH_LINES = lines;
            this.pipeline?.rebuildBuffer(PUSH_INTERVAL, PUSH_LINES);
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
        if (this.pipeline?.hasBuffer()) {
          this.pipeline.flushBuffer();
          this.log("info", "manual flush triggered");
        } else {
          this.log("warn", "no active buffer to flush");
        }
        break;
    }
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
    this.meetingFile = this.createMeetingFile();
    const baseTs = basename(this.meetingFile, ".txt");

    log.info(`recording started: source=${source}, file=${this.meetingFile}`);

    this.pipeline = new CapturePipeline({
      apiKey: DASHSCOPE_API_KEY,
      model: DASHSCOPE_MODEL,
      pushInterval: PUSH_INTERVAL,
      pushLines: PUSH_LINES,
      meetingFile: this.meetingFile,
      tmpDir: this.tmpDir,
      baseTs,
      onLog: (level, msg) => this.log(level, msg),
      onTranscriptLine: (line) => this.log("info", line),
      onFlushToChannel: async (lines, slicePath, timeRange) => {
        const content = `新增转录 [${timeRange}]，${lines.length}行，文件：${slicePath}`;
        await this.emit("transcription", undefined, content);
      },
      onCaptureExit: () => {
        if (this.recording) {
          this.stopRecording().catch((e) => this.log("warn", `stopRecording on capture exit failed: ${e}`));
        }
      },
      onActivity: (activity) => {
        this.setActivity(activity).catch(() => {});
      },
    });

    try {
      await this.pipeline.start(source);
      await this.setActivity(`recording (${source})`);
    } catch (err: any) {
      this.reportError(channelId, from, `start failed: ${err.message}`);
      this.recording = false;
      await this.pipeline.stop();
      this.pipeline = null;
      await this.setActivity("error: start failed");
    }
  }

  async stopRecording(): Promise<void> {
    if (!this.recording) return;

    this.recording = false;
    const startedAt = this.pipeline?.startedAt ?? 0;

    await this.pipeline?.stop();
    this.pipeline = null;

    const duration = Math.round((Date.now() - startedAt) / 1000);
    this.log("info", `recording stopped. duration=${duration}s, file=${this.meetingFile}`);
    await this.setActivity("idle — recording stopped");

    this.meetingFile = null;
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
    log.error(`failed to start: ${err}`);
    process.exit(1);
  });

  process.on("SIGTERM", () => { plugin.stop(); process.exit(0); });
  process.on("SIGINT", () => { plugin.stop(); process.exit(0); });
}

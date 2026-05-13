#!/usr/bin/env node
/**
 * ai-life-log — 24/7 microphone life-log plugin.
 *
 * Auto-spawned by nerve at boot. Captures mic via the shared Swift
 * AudioCapture binary (reused from ai-ear), runs sherpa-onnx VAD +
 * SenseVoice locally, and appends each detected utterance to a per-day
 * text file at <dataDir>/log/YYYY-MM-DD.txt.
 *
 * Commands: pause, resume, status.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { PluginBase, type CommandDef, type CommandResult } from "../plugin-base.js";
import { AsrPipeline, createRealAsrPipeline } from "./asr-pipeline.js";
import { DailyFileWriter } from "./daily-file-writer.js";
import { MacMicSource } from "./sources/mac-mic-source.js";
import { RemoteUploadSource } from "./sources/remote-upload-source.js";
import { cleanOldAudio } from "./audio-cleaner.js";
import { TranscriptFilter } from "./transcript-filter.js";

function getArg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const PORT = parseInt(getArg("--port", "4800"));

function findSenseVoiceDir(): string | null {
  // Order: env override → official sherpa-onnx model in node data dir → 闪电说目录。
  // Shandianshuo 0.6.x 的 model.onnx 缺 vocab_size 元数据，sherpa-onnx 1.13 加载
  // 会 SIGABRT，所以放最后；将来若闪电说升级兼容版可零成本切回（用户也可用
  // AI_LIFE_LOG_MODEL_DIR 强制指定）。
  const candidates = [
    process.env.AI_LIFE_LOG_MODEL_DIR,
    resolve(homedir(), ".nerve/plugins/ai-life-log/models/sensevoice-small"),
    resolve(homedir(), "Library/Application Support/Shandianshuo/models/sensevoice-small"),
  ].filter((p): p is string => !!p);
  for (const dir of candidates) {
    const hasModel = existsSync(resolve(dir, "model.onnx"));
    const hasTokens = existsSync(resolve(dir, "tokens.txt")) || existsSync(resolve(dir, "tokens.json"));
    if (hasModel && hasTokens) return dir;
  }
  return null;
}

function findSileroVad(): string | null {
  const candidates = [
    process.env.AI_LIFE_LOG_VAD_MODEL,
    resolve(homedir(), ".nerve/plugins/ai-life-log/models/silero_vad.onnx"),
  ].filter((p): p is string => !!p);
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

class AiLifeLogPlugin extends PluginBase {
  private macSource: MacMicSource | null = null;
  private remoteSource: RemoteUploadSource | null = null;
  private pipeline: AsrPipeline | null = null;
  private writer: DailyFileWriter;
  private startTime = Date.now();
  private errorReason: string | null = null;
  private rssTimer: ReturnType<typeof setInterval> | null = null;
  private cleanerTimer: ReturnType<typeof setInterval> | null = null;
  private filter = new TranscriptFilter();
  private filterLogEvery = 100;

  constructor() {
    super({
      port: PORT,
      name: "ai-life-log",
      capabilities: ["monitor"],
      permissions: "member",
    });
    // Primary: plugin dataDir. Mirror: ~/.ai/workspace/activity/life-log/{host}/
    // The {host} subdir (mac / home) prevents two writers — Mac mic source on
    // this machine and the remote-upload source running on home for phone audio —
    // from clobbering the same daily file when ~/.ai syncs both ways.
    const primary = resolve(this.dataDir, "log");
    const host = process.platform === "darwin" ? "mac" : "home";
    const mirror = resolve(homedir(), ".ai/workspace/activity/life-log", host);
    this.writer = new DailyFileWriter([primary, mirror]);
  }

  protected async onReady(): Promise<void> {
    const sense = findSenseVoiceDir();
    if (!sense) {
      this.errorReason = "SenseVoice model not found. Install 闪电说 (https://shandianshuo.cn) " +
        "or place model at ~/.nerve/plugins/ai-life-log/models/sensevoice-small/";
      this.log("error", this.errorReason);
      await this.setActivity("error: model not found");
      return;
    }

    const vadPath = findSileroVad();
    if (!vadPath) {
      this.errorReason = "silero_vad.onnx not found at ~/.nerve/plugins/ai-life-log/models/silero_vad.onnx. " +
        "Download from https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";
      this.log("error", this.errorReason);
      await this.setActivity("error: vad missing");
      return;
    }

    this.log("info", `model: ${sense}`);
    this.log("info", `vad: ${vadPath}`);

    try {
      this.pipeline = await createRealAsrPipeline({
        senseVoiceDir: sense,
        sileroVadPath: vadPath,
        sampleRate: 16000,
        language: "auto",
        numThreads: 2,
      });
    } catch (err: any) {
      this.errorReason = `pipeline init failed: ${err.message}`;
      this.log("error", this.errorReason);
      await this.setActivity("error: pipeline init failed");
      return;
    }

    this.pipeline.on("text", (text: string, ts: Date) => {
      if (!this.filter.accept(text)) {
        this.maybeLogFilterStats();
        return;
      }
      try {
        this.writer.appendOrInsert(text, ts, "mac");
        this.log("info", `[${ts.toISOString()}][mac] ${text}`);
      } catch (err: any) {
        this.log("error", `write failed: ${err.message}`);
      }
    });
    this.pipeline.on("error", (err: Error) => {
      this.log("error", `asr error: ${err.message}`);
    });

    if (process.platform === "darwin") {
      this.macSource = new MacMicSource({
        log: (l, m) => this.log(l, m),
        onActivity: (s) => void this.setActivity(s),
      });
      try {
        await this.macSource.start((pcm, _ts) => this.pipeline?.feed(pcm));
      } catch (err: any) {
        this.errorReason = `mac source start failed: ${err.message}`;
        this.log("error", this.errorReason);
        await this.setActivity(`error: ${this.errorReason}`);
      }
    } else {
      this.log("info", `mac mic source disabled on platform=${process.platform} (Swift AudioCapture is darwin-only)`);
    }

    // Optional remote upload server (mobile clients post Opus chunks here).
    const enableRemote = process.env.AI_LIFE_LOG_REMOTE_UPLOAD === "true";
    if (enableRemote) {
      const remotePort = parseInt(process.env.AI_LIFE_LOG_HTTP_PORT ?? "4810", 10);
      const audioDir = resolve(this.dataDir, "audio");
      this.remoteSource = new RemoteUploadSource({
        port: remotePort,
        audioDir,
        pipeline: this.pipeline,
        authToken: process.env.AI_LIFE_LOG_TOKEN,
        log: (l, m) => this.log(l, `[remote] ${m}`),
      });
      this.remoteSource.on("text", (text: string, tsMs: number, tag: string) => {
        if (!this.filter.accept(text)) {
          this.maybeLogFilterStats();
          return;
        }
        try {
          this.writer.appendOrInsert(text, new Date(tsMs), tag);
          this.log("info", `[${new Date(tsMs).toISOString()}][${tag}] ${text}`);
        } catch (err: any) {
          this.log("error", `remote write failed: ${err.message}`);
        }
      });
      try {
        const actualPort = await this.remoteSource.start();
        this.log("info", `remote upload http listening on :${actualPort}`);
      } catch (err: any) {
        this.log("error", `remote source start failed: ${err.message}`);
        this.remoteSource = null;
      }
    } else {
      this.log("info", "remote upload disabled (set AI_LIFE_LOG_REMOTE_UPLOAD=true)");
    }

    // Log RSS every 10 min for long-run memory observability
    this.rssTimer = setInterval(() => {
      const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      this.log("info", `rss=${rss}MB`);
    }, 600_000);

    // Daily audio retention sweep (covers audio/, corrupt/, failed/)
    const retainDays = parseInt(process.env.AI_LIFE_LOG_AUDIO_RETAIN_DAYS ?? "7", 10);
    const audioDir = resolve(this.dataDir, "audio");
    const initStats = cleanOldAudio(audioDir, retainDays);
    this.log("info", `cleaner: initial sweep removed ${initStats.deleted} files (retain=${retainDays}d)`);
    this.cleanerTimer = setInterval(() => {
      const stats = cleanOldAudio(audioDir, retainDays);
      if (stats.deleted > 0) this.log("info", `cleaner: deleted ${stats.deleted} old .opus files`);
    }, 86400_000);
  }

  protected onDisconnect(): void {
    void this.stopCapture();
  }

  override getCommands(): Record<string, CommandDef> {
    return {
      pause: { description: "暂停录音（保留进程）" },
      resume: { description: "恢复录音" },
      status: { description: "查看状态：运行中/暂停/错误，今日累计行数与字符数" },
    };
  }

  protected override onCommand(command: string, _args: Record<string, string>, _from?: string): CommandResult {
    switch (command) {
      case "pause":
        this.pipeline?.pause();
        void this.setActivity("paused");
        this.log("info", "paused");
        return { reply: "paused" };
      case "resume":
        this.pipeline?.resume();
        void this.setActivity("recording");
        this.log("info", "resumed");
        return { reply: "resumed" };
      case "status": {
        const stats = this.writer.stats();
        const mode = this.errorReason
          ? `error: ${this.errorReason}`
          : (this.pipeline?.isPaused() ? "paused" : (this.macSource ? "recording" : "idle"));
        const uptime = Math.round((Date.now() - this.startTime) / 1000);
        return { reply: `${mode}; uptime=${uptime}s; today: lines=${stats.lines}, chars=${stats.chars}, file=${stats.file}` };
      }
      default:
        return {};
    }
  }

  private maybeLogFilterStats(): void {
    const stats = this.filter.getStats();
    if (stats.dropped >= this.filterLogEvery) {
      this.log(
        "info",
        `transcript-filter: dropped=${stats.dropped} (punct=${stats.byReason.punct}, filler=${stats.byReason.filler}, dup=${stats.byReason.dup})`
      );
      this.filter.resetStats();
    }
  }

  private async stopCapture(): Promise<void> {
    try { await this.macSource?.stop(); } catch (err: any) { this.log("warn", `macSource.stop: ${err.message}`); }
    try { await this.remoteSource?.stop(); } catch (err: any) { this.log("warn", `remoteSource.stop: ${err.message}`); }
    try { this.pipeline?.stop(); } catch (err: any) { this.log("warn", `pipeline.stop: ${err.message}`); }
    if (this.rssTimer) { clearInterval(this.rssTimer); this.rssTimer = null; }
    if (this.cleanerTimer) { clearInterval(this.cleanerTimer); this.cleanerTimer = null; }
    this.macSource = null;
    this.remoteSource = null;
  }

  private async setActivity(activity: string): Promise<void> {
    try { await this.request("node.activity", { activity }); } catch { /* best-effort */ }
  }
}

// --- Main ---
import { fileURLToPath as _flu } from "node:url";
const _thisFile = _flu(import.meta.url);
const _isMain = process.argv[1] && (
  process.argv[1] === _thisFile ||
  process.argv[1].endsWith("ai-life-log/index.ts") ||
  process.argv[1].endsWith("ai-life-log/index.js")
);

if (_isMain) {
  const plugin = new AiLifeLogPlugin();
  plugin.start().catch((err) => {
    console.error(`[ai-life-log] failed to start: ${err}`);
    process.exit(1);
  });
  process.on("SIGTERM", () => { plugin.stop(); process.exit(0); });
  process.on("SIGINT", () => { plugin.stop(); process.exit(0); });
}

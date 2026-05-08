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
import { AudioCapture } from "../ai-ear/audio-capture.js";
import { AsrPipeline, createRealAsrPipeline } from "./asr-pipeline.js";
import { DailyFileWriter } from "./daily-file-writer.js";

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

// Watchdog interval: how often we tick to detect timer drift (= system sleep).
const WATCHDOG_TICK_MS = 30_000;
// If wall-clock advanced more than this between ticks, we infer the system slept
// and the AVAudioEngine is likely stuck — restart capture.
const SLEEP_DRIFT_MS = 60_000;
// Backoff for capture exit auto-restart, ms.
const RESTART_BACKOFF_MS = [1_000, 3_000, 10_000, 30_000];

class AiLifeLogPlugin extends PluginBase {
  private capture: AudioCapture | null = null;
  private pipeline: AsrPipeline | null = null;
  private writer: DailyFileWriter;
  private running = false;
  private startTime = Date.now();
  private errorReason: string | null = null;
  private rssTimer: ReturnType<typeof setInterval> | null = null;
  private wakeTimer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private restartAttempt = 0;
  private restarting = false;

  constructor() {
    super({
      port: PORT,
      name: "ai-life-log",
      capabilities: ["monitor"],
      permissions: "member",
    });
    this.writer = new DailyFileWriter(resolve(this.dataDir, "log"));
  }

  protected async onReady(): Promise<void> {
    if (process.platform !== "darwin") {
      this.errorReason = "ai-life-log requires macOS (Swift AudioCapture)";
      this.log("warn", this.errorReason);
      await this.setActivity(`error: ${this.errorReason}`);
      return;
    }

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
      try {
        this.writer.append(text, ts);
        this.log("info", `[${ts.toISOString()}] ${text}`);
      } catch (err: any) {
        this.log("error", `write failed: ${err.message}`);
      }
    });
    this.pipeline.on("error", (err: Error) => {
      this.log("error", `asr error: ${err.message}`);
    });

    await this.startCapture();

    // Log RSS every 10 min for long-run memory observability
    this.rssTimer = setInterval(() => {
      const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      this.log("info", `rss=${rss}MB`);
    }, 600_000);

    // Wake watchdog: detect macOS sleep via timer drift. AVAudioEngine inside the
    // AudioCapture binary often gets stuck across system sleep — process stays
    // alive and stdout pipe is open, but no PCM samples flow. Drift detection
    // catches this without needing OS-specific notifications.
    this.lastTick = Date.now();
    this.wakeTimer = setInterval(() => this.wakeTick(), WATCHDOG_TICK_MS);
  }

  private wakeTick(): void {
    const now = Date.now();
    const drift = now - this.lastTick - WATCHDOG_TICK_MS;
    this.lastTick = now;
    if (drift > SLEEP_DRIFT_MS && this.running && !this.restarting) {
      this.log("warn", `wake watchdog: detected ${Math.round(drift / 1000)}s drift, restarting capture`);
      void this.restartCapture("sleep-wake");
    }
  }

  private async restartCapture(reason: string): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    this.log("info", `restart capture (reason=${reason}, attempt=${this.restartAttempt + 1})`);
    try {
      try { this.capture?.stop(); } catch (err: any) { this.log("warn", `capture.stop in restart: ${err.message}`); }
      this.capture = null;
      this.running = false;
      // Drop any in-flight VAD state so post-restart audio doesn't get glued
      // to pre-sleep audio (would create one giant utterance + bad ASR).
      try { this.pipeline?.stop(); } catch { /* best effort */ }
      await this.startCapture();
      if (this.running) {
        this.restartAttempt = 0;
        this.errorReason = null;
        this.log("info", `capture restart succeeded (reason=${reason})`);
      }
    } finally {
      this.restarting = false;
    }
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
          : (this.pipeline?.isPaused() ? "paused" : (this.running ? "recording" : "idle"));
        const uptime = Math.round((Date.now() - this.startTime) / 1000);
        return { reply: `${mode}; uptime=${uptime}s; today: lines=${stats.lines}, chars=${stats.chars}, file=${stats.file}` };
      }
      default:
        return {};
    }
  }

  private async startCapture(): Promise<void> {
    if (!this.pipeline) return;
    this.capture = new AudioCapture("mic");
    this.capture.on("data", (pcm: Buffer) => this.pipeline?.feed(pcm));
    this.capture.on("log", (line: string) => this.log("info", `[capture] ${line}`));
    this.capture.on("error", (err: Error) => this.log("error", `capture error: ${err.message}`));
    this.capture.on("exit", (code: number | null) => {
      this.log("warn", `capture exited code=${code}`);
      this.running = false;
      if (this.restarting) return; // 我们正在主动重启，不再触发新一轮
      // Auto-restart with backoff. Most exits we'd see in the wild are transient
      // (sleep-wake, audio device hot-unplug). Cap retries to avoid tight loops
      // when something is fundamentally broken (mic permission revoked, etc).
      const attempt = this.restartAttempt;
      if (attempt >= RESTART_BACKOFF_MS.length) {
        this.errorReason = `capture exited (code=${code}); ${attempt} restarts failed, giving up`;
        this.log("error", this.errorReason);
        void this.setActivity("error: capture exited (give up)");
        return;
      }
      const delay = RESTART_BACKOFF_MS[attempt];
      this.restartAttempt = attempt + 1;
      this.errorReason = `capture exited (code=${code}); restarting in ${delay}ms (attempt ${this.restartAttempt})`;
      this.log("warn", this.errorReason);
      void this.setActivity(`error: capture exited, restart in ${delay}ms`);
      setTimeout(() => { void this.restartCapture(`capture-exit-code-${code}`); }, delay);
    });

    try {
      await this.capture.start();
      this.running = true;
      await this.setActivity("recording");
      this.log("info", "recording started (mic)");
    } catch (err: any) {
      this.errorReason = `capture start failed: ${err.message}`;
      this.log("error", this.errorReason);
      await this.setActivity(`error: ${this.errorReason}`);
    }
  }

  private async stopCapture(): Promise<void> {
    try { this.capture?.stop(); } catch (err: any) { this.log("warn", `capture.stop: ${err.message}`); }
    try { this.pipeline?.stop(); } catch (err: any) { this.log("warn", `pipeline.stop: ${err.message}`); }
    if (this.rssTimer) { clearInterval(this.rssTimer); this.rssTimer = null; }
    if (this.wakeTimer) { clearInterval(this.wakeTimer); this.wakeTimer = null; }
    this.capture = null;
    this.running = false;
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

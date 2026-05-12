/**
 * capture-pipeline.ts — Audio capture → ASR → file write + channel push orchestration.
 *
 * Also exports SliceWriter (file-based transcript slices).
 *
 * CapturePipeline manages the lifecycle of AudioCapture + AsrClient + TranscriptBuffer
 * + SliceWriter. AiEarPlugin holds one instance and delegates start/stop/rebuildBuffer.
 */

import { appendFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { AudioCapture, type AudioSource } from "./audio-capture.js";
import { AsrClient } from "./asr-client.js";
import { TranscriptBuffer, type FlushReason } from "./transcript-buffer.js";

// --- Slice Writer (exported for testing via index.ts re-export) ---

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

// --- CapturePipeline ---

export interface CapturePipelineConfig {
  apiKey: string;
  model: string;
  pushInterval: number;
  pushLines: number;
  meetingFile: string;
  tmpDir: string;
  baseTs: string;
  onLog: (level: "info" | "warn" | "error" | "debug", msg: string) => void;
  onTranscriptLine: (line: string) => void;
  onFlushToChannel: (lines: string[], slicePath: string | undefined, timeRange: string) => void;
  onCaptureExit: () => void;
  onActivity: (activity: string) => void;
}

export class CapturePipeline {
  private capture: AudioCapture | null = null;
  private asr: AsrClient | null = null;
  private buffer: TranscriptBuffer | null = null;
  private sliceWriter: SliceWriter | null = null;
  private startTime = 0;
  private cfg: CapturePipelineConfig;
  private pushInterval: number;
  private pushLines: number;

  constructor(cfg: CapturePipelineConfig) {
    this.cfg = cfg;
    this.pushInterval = cfg.pushInterval;
    this.pushLines = cfg.pushLines;
  }

  get isActive(): boolean {
    return this.capture !== null;
  }

  get startedAt(): number {
    return this.startTime;
  }

  async start(source: AudioSource): Promise<void> {
    this.startTime = Date.now();
    this.sliceWriter = new SliceWriter(this.cfg.tmpDir, this.cfg.baseTs);

    // Init buffer
    this.buffer = new TranscriptBuffer({
      pushInterval: this.pushInterval,
      pushLines: this.pushLines,
      onFlush: (lines, reason) => this.onBufferFlush(lines, reason),
    });

    // Start ASR
    this.asr = new AsrClient({
      model: this.cfg.model,
      apiKey: this.cfg.apiKey,
    });

    this.asr.on("text", (text: string, interim: boolean) => {
      if (!interim) this.onTranscript(text, source);
    });

    this.asr.on("error", (err: Error) => {
      this.cfg.onLog("error", `ASR error: ${err.message}`);
    });

    this.asr.on("reconnecting", () => {
      this.cfg.onLog("info", "ASR disconnected, reconnecting...");
      this.cfg.onActivity(`recording (${source}) — ASR reconnecting`);
    });

    this.asr.on("ready", () => {
      this.cfg.onLog("info", "ASR reconnected");
      this.cfg.onActivity(`recording (${source})`);
    });

    await this.asr.connect();

    // Start audio capture
    this.capture = new AudioCapture(source);

    this.capture.on("data", (pcm: Buffer) => {
      this.asr?.sendAudio(pcm);
    });

    this.capture.on("log", (line: string) => {
      this.cfg.onLog("info", `[capture] ${line}`);
    });

    this.capture.on("error", (err: Error) => {
      this.cfg.onLog("error", `capture error: ${err.message}`);
    });

    this.capture.on("exit", (code: number | null) => {
      this.cfg.onLog("info", `capture exited: code=${code}`);
      this.cfg.onCaptureExit();
    });

    await this.capture.start();
  }

  async stop(): Promise<void> {
    try { this.capture?.stop(); } catch (err: any) {
      this.cfg.onLog("warn", `capture.stop() error: ${err.message}`);
    }
    try { this.asr?.disconnect(); } catch (err: any) {
      this.cfg.onLog("warn", `asr.disconnect() error: ${err.message}`);
    }
    try { this.buffer?.stop(); } catch (err: any) {
      this.cfg.onLog("warn", `buffer.stop() error: ${err.message}`);
    }

    this.capture = null;
    this.asr = null;
    this.buffer = null;
    this.sliceWriter = null;
  }

  /** Rebuild buffer with new interval/lines settings (called after config command). */
  rebuildBuffer(pushInterval: number, pushLines: number): void {
    this.pushInterval = pushInterval;
    this.pushLines = pushLines;
    if (this.buffer) {
      this.buffer.stop();
      this.buffer = new TranscriptBuffer({
        pushInterval,
        pushLines,
        onFlush: (lines, reason) => this.onBufferFlush(lines, reason),
      });
    }
  }

  /** Flush buffered lines to channel immediately. */
  flushBuffer(): void {
    this.buffer?.flush();
  }

  /** True if a buffer is currently active. */
  hasBuffer(): boolean {
    return this.buffer !== null;
  }

  private onTranscript(text: string, source: string): void {
    const elapsed = Math.round((Date.now() - this.startTime) / 1000);
    const line = `[+${elapsed}s][${source}] ${text}`;

    // Write to transcript file
    appendFileSync(this.cfg.meetingFile, line + "\n");

    // Notify plugin (DM log)
    this.cfg.onTranscriptLine(line);

    // Buffer for channel push
    this.buffer?.add(line);
  }

  private onBufferFlush(lines: string[], reason: FlushReason): void {
    this.cfg.onLog("info", `flush triggered by ${reason}, ${lines.length} lines`);
    const slicePath = this.sliceWriter?.write(lines);
    if (slicePath) {
      this.cfg.onLog("debug", `slice written: ${slicePath} (${lines.length} lines)`);
    }
    const timeRange = SliceWriter.timeRange(lines);
    this.cfg.onFlushToChannel(lines, slicePath, timeRange);
  }
}

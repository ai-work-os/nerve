/**
 * MacMicSource — wraps the existing Swift AudioCapture binary for macOS mic input.
 * Encapsulates capture start/stop, sleep-wake watchdog (timer drift detection),
 * and capture-exit auto-restart with backoff. PCM Int16 LE mono is pushed
 * through a callback to whatever pipeline is listening.
 */
import { AudioCapture } from "../../ai-ear/audio-capture.js";
import type { AudioSource, PcmCallback } from "./audio-source.js";

// Watchdog interval: how often we tick to detect timer drift (= system sleep).
const WATCHDOG_TICK_MS = 30_000;
// If wall-clock advanced more than this between ticks, we infer the system slept
// and the AVAudioEngine is likely stuck — restart capture.
const SLEEP_DRIFT_MS = 60_000;
// Backoff for capture exit auto-restart, ms.
const RESTART_BACKOFF_MS = [1_000, 3_000, 10_000, 30_000];

export interface MacMicSourceConfig {
  log?: (level: "info" | "warn" | "error", msg: string) => void;
  onActivity?: (s: string) => void;
}

export class MacMicSource implements AudioSource {
  readonly tag = "mac";
  private capture: AudioCapture | null = null;
  private wakeTimer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private restartAttempt = 0;
  private restarting = false;
  private running = false;
  private onPcm: PcmCallback | null = null;
  private cfg: MacMicSourceConfig;

  constructor(cfg: MacMicSourceConfig = {}) {
    this.cfg = cfg;
  }

  async start(onPcm: PcmCallback): Promise<void> {
    if (process.platform !== "darwin") {
      throw new Error("MacMicSource requires macOS (Swift AudioCapture)");
    }
    this.onPcm = onPcm;
    await this.startCapture();
    this.lastTick = Date.now();
    this.wakeTimer = setInterval(() => this.wakeTick(), WATCHDOG_TICK_MS);
  }

  async stop(): Promise<void> {
    try { this.capture?.stop(); } catch (err: any) { this.log("warn", `capture.stop: ${err.message}`); }
    this.capture = null;
    this.running = false;
    if (this.wakeTimer) { clearInterval(this.wakeTimer); this.wakeTimer = null; }
  }

  private wakeTick(): void {
    const now = Date.now();
    const drift = now - this.lastTick - WATCHDOG_TICK_MS;
    this.lastTick = now;
    if (drift > SLEEP_DRIFT_MS && this.running && !this.restarting) {
      this.log("warn", `wake watchdog: ${Math.round(drift / 1000)}s drift, restart`);
      void this.restartCapture("sleep-wake");
    }
  }

  private async restartCapture(reason: string): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    this.log("info", `restart capture (reason=${reason}, attempt=${this.restartAttempt + 1})`);
    try {
      try { this.capture?.stop(); } catch { /* best-effort */ }
      this.capture = null;
      this.running = false;
      await this.startCapture();
      if (this.running) {
        this.restartAttempt = 0;
        this.log("info", `restart ok (${reason})`);
      }
    } finally {
      this.restarting = false;
    }
  }

  private async startCapture(): Promise<void> {
    this.capture = new AudioCapture("mic");
    this.capture.on("data", (pcm: Buffer) => this.onPcm?.(pcm, Date.now()));
    this.capture.on("log", (line: string) => this.log("info", `[capture] ${line}`));
    this.capture.on("error", (err: Error) => this.log("error", `capture error: ${err.message}`));
    this.capture.on("exit", (code: number | null) => {
      this.log("warn", `capture exited code=${code}`);
      this.running = false;
      if (this.restarting) return;
      const attempt = this.restartAttempt;
      if (attempt >= RESTART_BACKOFF_MS.length) {
        this.log("error", `${attempt} restarts failed, giving up`);
        return;
      }
      const delay = RESTART_BACKOFF_MS[attempt];
      this.restartAttempt = attempt + 1;
      setTimeout(() => { void this.restartCapture(`exit-${code}`); }, delay);
    });
    await this.capture.start();
    this.running = true;
    this.cfg.onActivity?.("recording");
  }

  private log(level: "info" | "warn" | "error", msg: string): void {
    this.cfg.log?.(level, msg);
  }
}

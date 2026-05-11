/**
 * MacMicSource — wraps the existing Swift AudioCapture binary for macOS mic input.
 * Encapsulates capture start/stop, sleep-wake watchdog (timer drift detection),
 * and capture-exit auto-restart with backoff. PCM Int16 LE mono is pushed
 * through a callback to whatever pipeline is listening.
 *
 * Restart safety: every teardown goes through AudioCapture.stopAndWait so the
 * old Swift binary actually exits (and releases the mic) before a new one is
 * spawned. Without this, sleep-wake watchdog storms would stack live
 * AudioCapture children all holding the mic, producing degenerate ASR output.
 */
import { EventEmitter } from "node:events";
import { AudioCapture } from "../../ai-ear/audio-capture.js";
import type { AudioSource, PcmCallback } from "./audio-source.js";

// Watchdog interval: how often we tick to detect timer drift (= system sleep).
const WATCHDOG_TICK_MS = 30_000;
// If wall-clock advanced more than this between ticks, we infer the system slept
// and the AVAudioEngine is likely stuck — restart capture.
const SLEEP_DRIFT_MS = 60_000;
// Backoff for capture exit auto-restart, ms.
const RESTART_BACKOFF_MS = [1_000, 3_000, 10_000, 30_000];
// stopAndWait timeout when tearing down a capture during restart.
const STOP_AND_WAIT_MS = 2_000;

/** Minimal shape MacMicSource needs — lets tests inject a fake without spawning. */
export interface CaptureLike extends EventEmitter {
  start(): Promise<void>;
  stop(): void;
  stopAndWait(timeoutMs?: number): Promise<void>;
  readonly running: boolean;
}

export interface MacMicSourceConfig {
  log?: (level: "info" | "warn" | "error", msg: string) => void;
  onActivity?: (s: string) => void;
  /** Test seam: override how AudioCapture instances are constructed. */
  captureFactory?: () => CaptureLike;
}

export class MacMicSource implements AudioSource {
  readonly tag = "mac";
  private capture: CaptureLike | null = null;
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
    this.onPcm = onPcm;
    await this.startCapture();
    this.lastTick = Date.now();
    this.wakeTimer = setInterval(() => this.wakeTick(), WATCHDOG_TICK_MS);
  }

  async stop(): Promise<void> {
    try {
      await this.capture?.stopAndWait(STOP_AND_WAIT_MS);
    } catch (err: any) {
      this.log("warn", `capture.stopAndWait: ${err.message}`);
    }
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
      // CRITICAL: wait for the old capture's child process to actually exit
      // before spawning a new one. stopAndWait sends SIGTERM and waits, then
      // escalates to SIGKILL on timeout. A bare stop() returns immediately
      // after sending SIGTERM and the Swift binary keeps holding the mic for
      // 100–300ms (longer across sleep-wake), so a second AudioCapture spawned
      // here would race the dying one — both hold mic, both push PCM into the
      // same pipeline, ASR sees interleaved garbage, output degenerates to
      // "对对对" / "点点点" repetition.
      try {
        await this.capture?.stopAndWait(STOP_AND_WAIT_MS);
      } catch (err: any) {
        this.log("warn", `capture.stopAndWait in restart: ${err.message}`);
      }
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

  private makeCapture(): CaptureLike {
    if (this.cfg.captureFactory) return this.cfg.captureFactory();
    if (process.platform !== "darwin") {
      throw new Error("MacMicSource requires macOS (Swift AudioCapture)");
    }
    return new AudioCapture("mic") as unknown as CaptureLike;
  }

  private async startCapture(): Promise<void> {
    this.capture = this.makeCapture();
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

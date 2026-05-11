/**
 * AudioCapture — wraps native Swift binary for audio capture.
 *
 * Spawns the native AudioCapture binary, reads raw PCM (16kHz/mono/Int16) from stdout.
 * Emits 'data' events with Buffer chunks, 'exit' on process end.
 */

import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NATIVE_DIR = resolve(__dirname, "native/AudioCapture/.build/release");
const APP_BINARY = resolve(NATIVE_DIR, "AudioCapture.app/Contents/MacOS/AudioCapture");
const RAW_BINARY = resolve(NATIVE_DIR, "AudioCapture");

// Prefer the .app bundle binary: it has a stable bundle id that macOS TCC
// can attach mic permission to, so launchd-spawned children (e.g. ai-life-log)
// can actually capture audio. Falls back to the raw binary for older builds.
const DEFAULT_BINARY = existsSync(APP_BINARY) ? APP_BINARY : RAW_BINARY;

export type AudioSource = "mic" | "system" | "both";

export interface AudioCaptureOptions {
  /** Override binary path (for testing) */
  binaryPath?: string;
  /** Override binary args (for testing) */
  binaryArgs?: string[];
}

export class AudioCapture extends EventEmitter {
  private proc: ChildProcess | null = null;
  private source: AudioSource;
  private binaryPath: string;
  private binaryArgs?: string[];

  constructor(source: AudioSource, opts?: AudioCaptureOptions) {
    super();
    this.source = source;
    this.binaryPath = opts?.binaryPath ?? DEFAULT_BINARY;
    this.binaryArgs = opts?.binaryArgs;
  }

  async start(): Promise<void> {
    if (!this.binaryArgs) {
      // Default: use native binary with source flags
      if (!existsSync(this.binaryPath)) {
        throw new Error(
          `AudioCapture binary not found: ${this.binaryPath}\n` +
          `Run 'cd native/AudioCapture && swift build -c release' to build it.`
        );
      }
      if (platform() !== "darwin") {
        throw new Error("AudioCapture native binary is macOS only");
      }
    }

    const args = this.binaryArgs ?? (
      this.source === "both"
        ? ["--mic", "--system"]
        : [`--${this.source}`]
    );

    this.proc = spawn(this.binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.emit("data", chunk);
    });

    this.proc.stderr!.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      // Filter out frame count updates (noisy)
      if (line && !line.startsWith("frame=") && !line.startsWith("size=")) {
        this.emit("log", line);
      }
    });

    this.proc.on("exit", (code) => {
      this.proc = null;
      this.emit("exit", code);
    });

    this.proc.on("error", (err) => {
      this.emit("error", err);
    });
  }

  stop(): void {
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
    }
  }

  /**
   * Send SIGTERM and wait for the child to actually exit. If it doesn't exit
   * within timeoutMs, escalate to SIGKILL. Returns when proc has been reaped.
   *
   * Critical for MacMicSource.restartCapture: stop() alone returns immediately
   * after sending SIGTERM, but the Swift binary takes 100–300ms (sometimes
   * longer across sleep-wake) to clean up its AVAudioEngine. If we spawn a new
   * AudioCapture before the old one releases the mic, both processes hold the
   * input simultaneously and PCM streams interleave into the same pipeline,
   * producing degenerate ASR output ("对对对", "点点点", "好好好好好").
   */
  async stopAndWait(timeoutMs: number = 2000): Promise<void> {
    const proc = this.proc;
    if (!proc || proc.killed || proc.exitCode !== null) return;

    const exited = new Promise<void>((resolveExit) => {
      proc.once("exit", () => resolveExit());
    });

    try { proc.kill("SIGTERM"); } catch { /* already dead */ }

    const timer = new Promise<"timeout">((resolveT) => setTimeout(() => resolveT("timeout"), timeoutMs));
    const which = await Promise.race([exited.then(() => "exited" as const), timer]);

    if (which === "timeout" && this.proc && !this.proc.killed && this.proc.exitCode === null) {
      try { proc.kill("SIGKILL"); } catch { /* race — already dying */ }
      await exited;
    }
  }

  get running(): boolean {
    return this.proc !== null && !this.proc.killed;
  }
}

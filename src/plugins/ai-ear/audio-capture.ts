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
const DEFAULT_BINARY = resolve(__dirname, "native/AudioCapture/.build/release/AudioCapture");

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

  get running(): boolean {
    return this.proc !== null && !this.proc.killed;
  }
}

/**
 * AsrPipeline — wires PCM stream → VAD → SenseVoice non-streaming recognizer.
 *
 * Owns no files and no nerve concerns. Emits text events the caller routes
 * to file / channel / wherever. Adapters are passed in to keep the unit
 * testable without the native sherpa addon.
 */

import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

/** Minimal subset of sherpa-onnx-node Vad we depend on. */
export interface VadAdapter {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  isDetected(): boolean;
  front(): { samples: Float32Array };
  pop(): void;
  flush(): void;
  reset(): void;
}

/** Minimal subset of sherpa-onnx-node OfflineRecognizer we depend on. */
export interface RecognizerAdapter {
  createStream(): {
    acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void;
  };
  decode(stream: unknown): void;
  getResult(stream: unknown): { text: string };
}

export interface AsrPipelineConfig {
  vad: VadAdapter;
  recognizer: RecognizerAdapter;
  sampleRate: number;
}

export interface AsrPipelineFactoryConfig {
  /** Directory containing model.onnx and either tokens.txt (sherpa-onnx) or tokens.json (Shandianshuo). */
  senseVoiceDir: string;
  /** Path to silero_vad.onnx. */
  sileroVadPath: string;
  /** Sample rate of incoming PCM. Default 16000. */
  sampleRate?: number;
  /** SenseVoice language, "auto" / "zh" / "en" / etc. Default "auto". */
  language?: string;
  /** ONNX runtime threads. Default 2. */
  numThreads?: number;
}

export class AsrPipeline extends EventEmitter {
  private vad: VadAdapter;
  private recognizer: RecognizerAdapter;
  private sampleRate: number;
  private paused = false;

  constructor(cfg: AsrPipelineConfig) {
    super();
    this.vad = cfg.vad;
    this.recognizer = cfg.recognizer;
    this.sampleRate = cfg.sampleRate;
  }

  /** Feed raw PCM Int16 little-endian mono. Triggers VAD + recognition. */
  feed(pcmInt16: Buffer): void {
    if (this.paused) return;
    const samples = int16ToFloat32(pcmInt16);
    this.vad.acceptWaveform(samples);
    this.drain();
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  isPaused(): boolean { return this.paused; }

  /** Stop and flush any pending VAD segment. */
  stop(): void {
    try { this.vad.flush(); } catch { /* best effort */ }
    this.drain();
  }

  private drain(): void {
    while (!this.vad.isEmpty()) {
      const seg = this.vad.front();
      this.vad.pop();
      if (!seg.samples || seg.samples.length === 0) continue;
      let text: string;
      try {
        const stream = this.recognizer.createStream();
        stream.acceptWaveform({ samples: seg.samples, sampleRate: this.sampleRate });
        this.recognizer.decode(stream);
        text = this.recognizer.getResult(stream).text ?? "";
      } catch (err) {
        this.emit("error", err);
        continue;
      }
      const trimmed = text.trim();
      if (trimmed.length > 0) this.emit("text", trimmed, new Date());
    }
  }
}

/** Convert little-endian Int16 PCM Buffer to Float32 in [-1, 1]. Trailing odd byte ignored. */
export function int16ToFloat32(buf: Buffer): Float32Array {
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = buf.readInt16LE(i * 2) / 32768;
  }
  return out;
}

/**
 * Async factory that loads real sherpa-onnx adapters from disk.
 * Throws with a descriptive message if either model is missing.
 */
export async function createRealAsrPipeline(cfg: AsrPipelineFactoryConfig): Promise<AsrPipeline> {
  const senseVoiceModel = join(cfg.senseVoiceDir, "model.onnx");
  if (!existsSync(senseVoiceModel)) {
    throw new Error(`SenseVoice model not found: ${senseVoiceModel}`);
  }
  // sherpa-onnx models ship as tokens.txt; some repos use tokens.json
  const tokensTxt = join(cfg.senseVoiceDir, "tokens.txt");
  const tokensJson = join(cfg.senseVoiceDir, "tokens.json");
  const tokens = existsSync(tokensTxt) ? tokensTxt : tokensJson;
  if (!existsSync(tokens)) {
    throw new Error(`SenseVoice tokens not found in: ${cfg.senseVoiceDir}`);
  }
  if (!existsSync(cfg.sileroVadPath)) {
    throw new Error(`silero-vad model not found: ${cfg.sileroVadPath}`);
  }

  // sherpa-onnx-node is CJS; ESM dynamic-import only puts class exports on .default
  // (Node's CJS interop), so use createRequire to get them directly. This also
  // keeps unit tests free of the native addon since this branch is only reached
  // by the integration test / production runtime.
  const sherpaRequire = createRequire(import.meta.url);
  const sherpa = sherpaRequire("sherpa-onnx-node");
  const sampleRate = cfg.sampleRate ?? 16000;

  const vad = new sherpa.Vad({
    sileroVad: {
      model: cfg.sileroVadPath,
      threshold: 0.5,
      minSilenceDuration: 0.5,
      minSpeechDuration: 0.25,
      maxSpeechDuration: 30,
      windowSize: 512,
    },
    sampleRate,
    numThreads: 1,
  } as any, 60);

  const recognizer = new sherpa.OfflineRecognizer({
    modelConfig: {
      senseVoice: {
        model: senseVoiceModel,
        language: cfg.language ?? "auto",
        useInverseTextNormalization: 1,
      },
      tokens,
      numThreads: cfg.numThreads ?? 2,
    },
  } as any);

  return new AsrPipeline({ vad: vad as unknown as VadAdapter, recognizer: recognizer as unknown as RecognizerAdapter, sampleRate });
}

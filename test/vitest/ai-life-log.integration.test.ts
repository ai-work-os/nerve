import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRealAsrPipeline } from "../../src/plugins/ai-life-log/asr-pipeline.js";
import { DailyFileWriter } from "../../src/plugins/ai-life-log/daily-file-writer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the SenseVoice model directory using the same search order as
 * index.ts findSenseVoiceDir(), but preferring sherpa-onnx native models
 * (tokens.txt) over Shandianshuo exports (tokens.json) to avoid ONNX
 * metadata incompatibilities at runtime.
 */
function findSenseVoiceDir(): string | null {
  const candidates = [
    process.env.AI_LIFE_LOG_MODEL_DIR,
    // Prefer the nerve plugin directory (sherpa-onnx native model with tokens.txt)
    // before Shandianshuo because Shandianshuo model.onnx lacks vocab_size metadata
    // required by sherpa-onnx and causes process abort.
    resolve(homedir(), ".nerve/plugins/ai-life-log/models/sensevoice-small"),
    resolve(homedir(), "Library/Application Support/Shandianshuo/models/sensevoice-small"),
  ].filter((p): p is string => !!p);

  for (const dir of candidates) {
    const hasModel = existsSync(join(dir, "model.onnx"));
    const hasTokens = existsSync(join(dir, "tokens.txt")) || existsSync(join(dir, "tokens.json"));
    if (hasModel && hasTokens) return dir;
  }
  return null;
}

const senseVoiceDir = findSenseVoiceDir();
const sileroVadPath = resolve(homedir(), ".nerve/plugins/ai-life-log/models/silero_vad.onnx");
const wavPath = resolve(__dirname, "..", "fixtures", "life-log-sample.wav");

const haveModels =
  senseVoiceDir !== null &&
  existsSync(sileroVadPath) &&
  existsSync(wavPath);

/**
 * Locate the PCM data chunk in a WAVE file.
 * Handles non-standard headers (e.g., JUNK or LIST chunks inserted by encoders)
 * by scanning chunk-by-chunk rather than assuming a fixed 44-byte offset.
 */
function extractWavPcm(buf: Buffer): Buffer {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a valid WAVE file");
  }
  let i = 12;
  while (i + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", i, i + 4);
    const chunkSize = buf.readUInt32LE(i + 4);
    if (chunkId === "data") {
      return buf.subarray(i + 8, i + 8 + chunkSize);
    }
    // advance: id(4) + size(4) + data, word-aligned
    i += 8 + chunkSize + (chunkSize % 2);
  }
  throw new Error("WAVE file has no 'data' chunk");
}

describe.skipIf(!haveModels)(
  "ai-life-log integration: real ASR end-to-end",
  () => {
    it(
      "transcribes a Chinese WAV and writes to today's file",
      async () => {
        // senseVoiceDir is non-null when haveModels is true
        const dir = senseVoiceDir!;
        const wav = readFileSync(wavPath);
        const pcm = extractWavPcm(wav);

        const pipeline = await createRealAsrPipeline({
          senseVoiceDir: dir,
          sileroVadPath,
          sampleRate: 16000,
          language: "zh",
          numThreads: 2,
        });

        const tmpLogDir = mkdtempSync(join(tmpdir(), "lifelog-int-"));
        try {
          const writer = new DailyFileWriter(tmpLogDir);
          const events: string[] = [];
          pipeline.on("text", (t: string, ts: Date) => {
            events.push(t);
            writer.append(t, ts);
          });

          // feed in 320ms chunks (~10240 bytes at 16kHz/16bit) to mimic real-time
          const chunkSize = 10240;
          for (let i = 0; i < pcm.length; i += chunkSize) {
            pipeline.feed(pcm.subarray(i, Math.min(i + chunkSize, pcm.length)));
          }
          pipeline.stop();

          // allow any async drain to settle
          await new Promise((r) => setTimeout(r, 500));

          expect(events.length).toBeGreaterThan(0);
          const joined = events.join("");
          console.log("[integration] transcript:", joined);
          // Chinese transcription should contain at least one CJK character
          expect(/[一-龥]/.test(joined)).toBe(true);

          const stats = writer.stats();
          expect(stats.lines).toBe(events.length);
          const fileContent = readFileSync(stats.file, "utf8");
          expect(fileContent).toMatch(/^\[\d{2}:\d{2}:\d{2}\]\[mac\] /);
        } finally {
          rmSync(tmpLogDir, { recursive: true, force: true });
        }
      },
      60_000,
    );
  },
);

/**
 * RemoteUploadSource — receives Opus chunks via HTTP, decodes, runs recognize,
 * emits text events tagged by device. Holds NO VAD state; uses
 * AsrPipeline.recognizeChunk for one-shot recognition per chunk.
 *
 * Failure isolation:
 *  - decode error → audio/{kind}/{date}/{chunkId}.opus moved to corrupt/
 *  - recognize error → moved to failed/
 *  - bad chunk does NOT prevent subsequent chunks from being processed.
 *
 * Note: this class is NOT an `AudioSource` — it emits already-recognized text
 * (one source produces multiple device tags). The plugin index.ts treats it as
 * a sibling of MacMicSource for log-writing purposes.
 */
import { EventEmitter } from "node:events";
import { renameSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { LifeLogHttpServer, type ChunkMeta } from "../http-server.js";
import { decodeOpusToPcm16 } from "../opus-decoder.js";
import type { AsrPipeline } from "../asr-pipeline.js";

export interface RemoteUploadSourceConfig {
  port: number;
  audioDir: string;
  pipeline: Pick<AsrPipeline, "recognizeChunk">;
  authToken?: string;
  log?: (l: "info" | "warn" | "error", m: string) => void;
}

export class RemoteUploadSource extends EventEmitter {
  private cfg: RemoteUploadSourceConfig;
  private server: LifeLogHttpServer | null = null;

  constructor(cfg: RemoteUploadSourceConfig) {
    super();
    this.cfg = cfg;
  }

  async start(): Promise<number> {
    this.server = new LifeLogHttpServer({
      port: this.cfg.port,
      audioDir: this.cfg.audioDir,
      authToken: this.cfg.authToken,
      log: this.cfg.log,
      onChunk: async (opusPath, meta) => this.handleChunk(opusPath, meta),
    });
    return await this.server.start();
  }

  async stop(): Promise<void> {
    await this.server?.stop();
    this.server = null;
  }

  private async handleChunk(opusPath: string, meta: ChunkMeta): Promise<void> {
    const tag = `android-${meta.deviceId}`;

    // 1. read + decode
    let pcm: Buffer;
    try {
      const opusBytes = readFileSync(opusPath);
      pcm = await decodeOpusToPcm16(opusBytes);
    } catch (err: any) {
      this.cfg.log?.("warn", `decode failed ${meta.chunkId}: ${err.message}`);
      this.quarantine(opusPath, "corrupt", meta);
      return;
    }
    if (pcm.length === 0) {
      this.cfg.log?.("warn", `empty pcm ${meta.chunkId}`);
      this.quarantine(opusPath, "corrupt", meta);
      return;
    }

    // 2. recognize
    let text: string;
    try {
      text = this.cfg.pipeline.recognizeChunk(pcm);
    } catch (err: any) {
      this.cfg.log?.("error", `recognize failed ${meta.chunkId}: ${err.message}`);
      this.quarantine(opusPath, "failed", meta);
      return;
    }

    // 3. emit
    if (text.length > 0) {
      this.emit("text", text, meta.recordedAtMs, tag);
    } else {
      this.cfg.log?.("info", `chunk ${meta.chunkId} produced empty transcript (silence?)`);
    }
  }

  private quarantine(opusPath: string, kind: "corrupt" | "failed", meta: ChunkMeta): void {
    const day = formatDate(new Date(meta.recordedAtMs));
    const target = join(this.cfg.audioDir, kind, day, `${meta.chunkId}.opus`);
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(opusPath)) {
      try { renameSync(opusPath, target); } catch (err: any) {
        this.cfg.log?.("error", `quarantine ${opusPath} → ${target}: ${err.message}`);
      }
    }
  }
}

function pad(n: number): string { return String(n).padStart(2, "0"); }
function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

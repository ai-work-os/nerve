/**
 * LifeLogHttpServer — receives Opus audio chunks from mobile clients via HTTP
 * multipart upload. Spawns its own Node http server on a configurable port
 * (separate from the nerve main port). Writes incoming chunks to disk under
 * `audioDir/{day}/{chunkId}.opus` and invokes a callback for downstream ASR.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Busboy from "busboy";

export interface ChunkMeta {
  deviceId: string;
  recordedAtMs: number;
  durationMs: number;
  chunkId: string;
}

export interface LifeLogHttpServerConfig {
  port: number;
  audioDir: string;
  /** Called after chunk lands on disk; receiver runs ASR async. */
  onChunk: (opusPath: string, meta: ChunkMeta) => Promise<void>;
  /** Optional shared-secret check; if undefined no auth required. */
  authToken?: string;
  /** Logger hook. */
  log?: (level: "info" | "warn" | "error", msg: string) => void;
}

export class LifeLogHttpServer {
  private server: Server | null = null;
  private cfg: LifeLogHttpServerConfig;

  constructor(cfg: LifeLogHttpServerConfig) {
    this.cfg = cfg;
    mkdirSync(cfg.audioDir, { recursive: true });
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handle(req, res));
      this.server.once("error", reject);
      this.server.listen(this.cfg.port, "0.0.0.0", () => {
        const addr = this.server!.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : this.cfg.port;
        this.log("info", `http listening on :${actualPort}`);
        resolve(actualPort);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" || req.url !== "/plugins/ai-life-log/upload") {
      res.writeHead(404); res.end(); return;
    }
    if (this.cfg.authToken) {
      const got = req.headers["x-lifelog-token"];
      if (got !== this.cfg.authToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
    }

    let metaJson: string | null = null;
    let fileBuf: Buffer = Buffer.alloc(0);
    const bb = Busboy({ headers: req.headers });
    const fileChunks: Buffer[] = [];
    bb.on("field", (name, val) => { if (name === "meta") metaJson = val; });
    bb.on("file", (name, stream) => {
      if (name !== "file") { stream.resume(); return; }
      stream.on("data", (c: Buffer) => fileChunks.push(c));
      stream.on("end", () => { fileBuf = Buffer.concat(fileChunks); });
    });
    bb.on("error", (err) => {
      this.log("error", `busboy: ${(err as Error).message}`);
      res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "parse error" }));
    });
    bb.on("finish", async () => {
      if (!metaJson) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "missing meta" }));
        return;
      }
      let meta: ChunkMeta;
      try {
        const parsed = JSON.parse(metaJson) as Partial<ChunkMeta>;
        if (!parsed.deviceId || !parsed.chunkId || typeof parsed.recordedAtMs !== "number" || typeof parsed.durationMs !== "number") {
          throw new Error("missing required fields");
        }
        meta = parsed as ChunkMeta;
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `bad meta: ${(err as Error).message}` }));
        return;
      }
      const day = formatDate(new Date(meta.recordedAtMs));
      const dayDir = join(this.cfg.audioDir, day);
      mkdirSync(dayDir, { recursive: true });
      const opusPath = join(dayDir, `${meta.chunkId}.opus`);
      writeFileSync(opusPath, fileBuf);
      this.log("info", `chunk landed: ${meta.deviceId} ${meta.chunkId} ${fileBuf.length}B`);
      // Fire-and-forget — ASR is async
      this.cfg.onChunk(opusPath, meta).catch((err) => this.log("error", `onChunk: ${err}`));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, chunkId: meta.chunkId }));
    });
    req.pipe(bb);
  }

  private log(l: "info" | "warn" | "error", m: string): void { this.cfg.log?.(l, m); }
}

function pad(n: number): string { return String(n).padStart(2, "0"); }
function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

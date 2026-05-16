/**
 * ScreenshotHttpServer — standalone HTTP server for the screenshot plugin.
 * Endpoints:
 *   POST /screenshot/upload      raw image body; headers X-Source/X-Analyze/X-Taken-At
 *   GET  /screenshot/blob/:id    raw image bytes
 *   GET  /screenshot/pending-mac JSON list of screenshots not yet delivered to Mac
 *   POST /screenshot/ack-mac     JSON { blobId } — mark delivered
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";

export interface PendingEntry {
  blobId: string;
  takenAtMs: number;
  source: string;
}

export interface ScreenshotHttpServerConfig {
  port: number;
  maxBytes: number;
  onUpload: (data: Buffer, meta: { source: string; analyze: boolean; takenAtMs: number }) => string;
  getBlob: (id: string) => Buffer | null;
  listPendingMac: () => PendingEntry[];
  onAckMac: (blobId: string) => boolean;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
}

export class ScreenshotHttpServer {
  private server: Server | null = null;
  constructor(private readonly cfg: ScreenshotHttpServerConfig) {}

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch(err => {
          this.log("error", `handler crash: ${err}`);
          if (!res.headersSent) { res.writeHead(500); res.end(); }
        });
      });
      this.server.once("error", reject);
      this.server.listen(this.cfg.port, "0.0.0.0", () => {
        const addr = this.server!.address();
        const actual = typeof addr === "object" && addr ? addr.port : this.cfg.port;
        this.log("info", `http listening on :${actual}`);
        resolve(actual);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>(r => this.server!.close(() => r()));
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = (req.url ?? "").split("?")[0];

    if (req.method === "POST" && url === "/screenshot/upload") {
      return this.handleUpload(req, res);
    }
    if (req.method === "GET" && url.startsWith("/screenshot/blob/")) {
      const id = decodeURIComponent(url.slice("/screenshot/blob/".length));
      const blob = this.cfg.getBlob(id);
      if (!blob) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(blob);
      return;
    }
    if (req.method === "GET" && url === "/screenshot/pending-mac") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.cfg.listPendingMac()));
      return;
    }
    if (req.method === "POST" && url === "/screenshot/ack-mac") {
      const body = await this.readBody(req, this.cfg.maxBytes);
      if (body === null) { res.writeHead(413); res.end(); return; }
      let blobId = "";
      try { blobId = JSON.parse(body.toString()).blobId ?? ""; } catch { /* ignore */ }
      const ok = blobId ? this.cfg.onAckMac(blobId) : false;
      res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok }));
      return;
    }

    res.writeHead(404); res.end();
  }

  private async handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const declared = Number(req.headers["content-length"] ?? "0");
    if (declared > this.cfg.maxBytes) { res.writeHead(413); res.end(); return; }
    const body = await this.readBody(req, this.cfg.maxBytes);
    if (body === null) { res.writeHead(413); res.end(); return; }

    const source = (req.headers["x-source"] as string) || "unknown";
    const analyze = (req.headers["x-analyze"] as string) === "true";
    const takenAtMs = Number(req.headers["x-taken-at"] ?? "0") || Date.now();

    const blobId = this.cfg.onUpload(body, { source, analyze, takenAtMs });
    this.log("info", `upload: source=${source} analyze=${analyze} bytes=${body.length} blob=${blobId}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ blobId }));
  }

  /** Read the request body, returning null if it exceeds maxBytes. */
  private readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) { resolve(null); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", () => resolve(null));
    });
  }

  private log(l: "info" | "warn" | "error", m: string): void { this.cfg.log?.(l, m); }
}

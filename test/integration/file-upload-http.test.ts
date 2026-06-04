import { createServer, type Server as HttpServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChannelManager } from "../../src/channel/channel-manager.js";
import { HttpRouter } from "../../src/transport/http-router.js";

describe("HttpRouter file upload", () => {
  let dataDir: string;
  let cm: ChannelManager;
  let server: HttpServer;
  let baseUrl: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "nerve-file-upload-http-"));
    cm = new ChannelManager({ dataDir, port: 0 });
    await new Promise<void>((resolve) => {
      server = createServer((req, res) => new HttpRouter(cm, 0).handle(req, res));
      server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("missing server address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("POST /files/upload accepts raw bytes and returns AI-readable path metadata", async () => {
    const res = await fetch(`${baseUrl}/files/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "text/markdown",
        "X-File-Name": "../notes.md",
      },
      body: "# Notes\nhello\n",
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.name).toBe("notes.md");
    expect(json.mimeType).toBe("text/markdown");
    expect(json.sizeBytes).toBe(14);
    expect(json.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(json.path).toContain("/uploads/");
    expect(readFileSync(json.path, "utf8")).toBe("# Notes\nhello\n");
  });

  it("POST /files/upload rejects bodies over the configured max size", async () => {
    const previous = process.env.NERVE_FILE_UPLOAD_MAX_BYTES;
    process.env.NERVE_FILE_UPLOAD_MAX_BYTES = "4";
    try {
      const res = await fetch(`${baseUrl}/files/upload`, {
        method: "POST",
        headers: { "X-File-Name": "big.bin" },
        body: Buffer.from("12345"),
      });

      expect(res.status).toBe(413);
      const json = await res.json() as any;
      expect(json.error).toContain("too large");
    } finally {
      if (previous === undefined) delete process.env.NERVE_FILE_UPLOAD_MAX_BYTES;
      else process.env.NERVE_FILE_UPLOAD_MAX_BYTES = previous;
    }
  });

  it("POST /files/upload decodes UTF-8 encoded filenames", async () => {
    const res = await fetch(`${baseUrl}/files/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "text/markdown",
        "X-File-Name-Encoded": encodeURIComponent("需求说明.md"),
      },
      body: "# hi\n",
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.name).toBe("需求说明.md");
    expect(json.path).toContain("需求说明.md");
    expect(readFileSync(json.path, "utf8")).toBe("# hi\n");
  });
});

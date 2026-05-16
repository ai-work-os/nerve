/**
 * BlobStore — content-addressed byte storage for screenshots.
 * Files land at <dir>/<sha256>.bin. Identical content dedups automatically.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ID_RE = /^[a-f0-9]{64}$/;

export class BlobStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /** Store bytes, return sha256 hex content address. */
  put(data: Buffer): string {
    const id = createHash("sha256").update(data).digest("hex");
    const p = this.pathFor(id);
    if (p && !existsSync(p)) writeFileSync(p, data);
    return id;
  }

  /** Return stored bytes, or null if absent / id malformed. */
  get(id: string): Buffer | null {
    const p = this.pathFor(id);
    if (!p || !existsSync(p)) return null;
    return readFileSync(p);
  }

  has(id: string): boolean {
    const p = this.pathFor(id);
    return !!p && existsSync(p);
  }

  /** Reject anything that is not a clean sha256 hex id (path-traversal guard). */
  private pathFor(id: string): string | null {
    if (!ID_RE.test(id)) return null;
    return join(this.dir, `${id}.bin`);
  }
}

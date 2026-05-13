import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** Threshold in bytes — messages larger than this are stored as blobs */
export const BLOB_THRESHOLD = 4096;

/** Preview length in characters */
const PREVIEW_LEN = 100;

export interface BlobRef {
  type: "blob";
  id: string;
  preview: string;
  size: number;
}

export class BlobStore {
  private dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "blobs");
    mkdirSync(this.dir, { recursive: true });
  }

  /** Save content to a blob file, return blob ID (content hash) */
  save(content: string): string {
    const id = createHash("sha256").update(content).digest("hex").slice(0, 16);
    const filePath = join(this.dir, `${id}.md`);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, content, "utf8");
    }
    return id;
  }

  /** Read blob content by ID */
  get(blobId: string): string | null {
    const filePath = join(this.dir, `${blobId}.md`);
    try {
      return readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
  }

  /** If content exceeds threshold, save as blob and return ref; otherwise return null */
  maybeStore(content: string): BlobRef | null {
    if (Buffer.byteLength(content, "utf8") <= BLOB_THRESHOLD) {
      return null;
    }
    const id = this.save(content);
    return {
      type: "blob",
      id,
      preview: content.slice(0, PREVIEW_LEN),
      size: content.length,
    };
  }
}

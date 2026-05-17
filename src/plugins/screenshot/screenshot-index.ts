/**
 * ScreenshotIndex — per-screenshot metadata, JSON-persisted.
 * Tracks Mac delivery state so an offline Mac can catch up on reconnect.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface ScreenshotRecord {
  blobId: string;
  source: string;
  mimeType: string;
  takenAtMs: number;
  receivedAtMs: number;
  analyze: boolean;
  deliveredToMac: boolean;
}

export class ScreenshotIndex {
  private records: ScreenshotRecord[] = [];

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    if (existsSync(filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, "utf8"));
        if (Array.isArray(parsed)) this.records = parsed;
      } catch {
        this.records = [];
      }
    }
  }

  add(rec: ScreenshotRecord): void {
    this.records.push(rec);
    this.save();
  }

  /**
   * Mark every record for a screenshot delivered to Mac. Returns false if the
   * blobId is unknown. Marks all matches because content-addressed blobs mean
   * the same image uploaded twice yields duplicate records under one blobId.
   */
  markDelivered(blobId: string): boolean {
    const matches = this.records.filter(x => x.blobId === blobId);
    if (matches.length === 0) return false;
    for (const r of matches) r.deliveredToMac = true;
    this.save();
    return true;
  }

  pendingMac(): ScreenshotRecord[] {
    return this.records.filter(r => !r.deliveredToMac);
  }

  all(): ScreenshotRecord[] {
    return [...this.records];
  }

  /**
   * Drop any record whose blobId is not in `keepBlobIds`, persist, and return
   * the number of records removed. Keeps the index from growing unbounded.
   */
  prune(keepBlobIds: Set<string>): number {
    const before = this.records.length;
    this.records = this.records.filter(r => keepBlobIds.has(r.blobId));
    const removed = before - this.records.length;
    if (removed > 0) this.save();
    return removed;
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.records, null, 2));
  }
}

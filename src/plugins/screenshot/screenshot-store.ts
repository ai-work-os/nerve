/**
 * ScreenshotStore — single owner of screenshot persistence.
 *
 * Combines three formerly-separate concerns: content-addressed blob storage
 * (raw bytes), per-screenshot metadata (index.json), and per-day perception
 * log (text files). Callers see one interface: store/get/pending/markDelivered.
 *
 * Layout under dataDir:
 *   blobs/<sha256>.bin     content-addressed bytes (dedup automatic)
 *   index.json             [ScreenshotRecord, ...]
 *   log/YYYY-MM-DD.txt     human-readable perception log
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { localIso } from "../../infra/time-util.js";

const ID_RE = /^[a-f0-9]{64}$/;

export interface ScreenshotRecord {
  blobId: string;
  source: string;
  mimeType: string;
  takenAtMs: number;
  receivedAtMs: number;
  analyze: boolean;
  deliveredToMac: boolean;
}

export interface StoreInput {
  source: string;
  analyze: boolean;
  takenAtMs: number;
  /** MIME type of the uploaded image. Defaults to "image/png" if absent. */
  mimeType?: string;
}

export interface StoreResult {
  record: ScreenshotRecord;
  channelText: string;
}

export interface BlobBytes {
  data: Buffer;
  mimeType: string;
}

export interface PendingMacEntry {
  blobId: string;
  takenAtMs: number;
  source: string;
}

export class ScreenshotStore {
  private readonly blobDir: string;
  private readonly indexFile: string;
  private readonly logDir: string;
  private records: ScreenshotRecord[] = [];

  constructor(dataDir: string) {
    this.blobDir = resolve(dataDir, "blobs");
    this.indexFile = resolve(dataDir, "index.json");
    this.logDir = resolve(dataDir, "log");
    mkdirSync(this.blobDir, { recursive: true });
    mkdirSync(dirname(this.indexFile), { recursive: true });
    this.loadIndex();
  }

  /**
   * Store one screenshot: write blob, append index, append perception log,
   * build the channel announce text.
   */
  store(data: Buffer, meta: StoreInput): StoreResult {
    const blobId = this.putBlob(data);
    const record: ScreenshotRecord = {
      blobId,
      source: meta.source,
      mimeType: meta.mimeType || "image/png",
      takenAtMs: meta.takenAtMs,
      receivedAtMs: Date.now(),
      analyze: meta.analyze,
      deliveredToMac: false,
    };
    this.records.push(record);
    this.saveIndex();
    this.appendPerceptionLog(record);
    const channelText =
      `📷 screenshot | blob=${blobId} | source=${meta.source} | analyze=${meta.analyze}`;
    return { record, channelText };
  }

  /** Return blob bytes + mime type, or null if unknown / id malformed. */
  get(blobId: string): BlobBytes | null {
    const p = this.blobPathFor(blobId);
    if (!p || !existsSync(p)) return null;
    const data = readFileSync(p);
    const record = this.records.find(r => r.blobId === blobId);
    // Blob bytes exist but no index record — fall back to generic mime.
    return { data, mimeType: record?.mimeType ?? "application/octet-stream" };
  }

  /**
   * Mark every record for `blobId` delivered to Mac. Returns false if unknown.
   * Marks all matches because content-addressed blobs mean the same image
   * uploaded twice yields duplicate records under one blobId.
   */
  markDelivered(blobId: string): boolean {
    const matches = this.records.filter(r => r.blobId === blobId);
    if (matches.length === 0) return false;
    for (const r of matches) r.deliveredToMac = true;
    this.saveIndex();
    return true;
  }

  pendingMac(): PendingMacEntry[] {
    return this.records
      .filter(r => !r.deliveredToMac)
      .map(r => ({ blobId: r.blobId, takenAtMs: r.takenAtMs, source: r.source }));
  }

  /** All records, for status/diagnostics. Returns a copy. */
  all(): ScreenshotRecord[] {
    return [...this.records];
  }

  /**
   * Drop any record whose blobId is not in `keepBlobIds`, persist, and return
   * the number of records removed. Keeps the index from growing unbounded.
   * Does not delete blob files — call separately if disk pressure matters.
   */
  prune(keepBlobIds: Set<string>): number {
    const before = this.records.length;
    this.records = this.records.filter(r => keepBlobIds.has(r.blobId));
    const removed = before - this.records.length;
    if (removed > 0) this.saveIndex();
    return removed;
  }

  // --- internals ---

  private putBlob(data: Buffer): string {
    const id = createHash("sha256").update(data).digest("hex");
    const p = this.blobPathFor(id);
    if (p && !existsSync(p)) writeFileSync(p, data);
    return id;
  }

  /** Reject anything that is not a clean sha256 hex id (path-traversal guard). */
  private blobPathFor(id: string): string | null {
    if (!ID_RE.test(id)) return null;
    return join(this.blobDir, `${id}.bin`);
  }

  private loadIndex(): void {
    if (!existsSync(this.indexFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.indexFile, "utf8"));
      if (Array.isArray(parsed)) this.records = parsed;
    } catch {
      this.records = [];
    }
  }

  private saveIndex(): void {
    writeFileSync(this.indexFile, JSON.stringify(this.records, null, 2));
  }

  private appendPerceptionLog(rec: ScreenshotRecord): void {
    mkdirSync(this.logDir, { recursive: true });
    const path = join(this.logDir, dayFile(rec.receivedAtMs));
    const line = `${localIso()} [${rec.source}] screenshot blob=${rec.blobId} analyze=${rec.analyze}`;
    appendFileSync(path, line + "\n");
  }
}

function pad(n: number): string { return String(n).padStart(2, "0"); }

function dayFile(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.txt`;
}

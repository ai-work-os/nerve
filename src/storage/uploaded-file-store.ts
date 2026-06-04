import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

export interface UploadedFileInput {
  name?: string;
  mimeType?: string;
  receivedAtMs?: number;
}

export interface UploadedFileRecord {
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

export class UploadedFileStore {
  private readonly uploadDir: string;

  constructor(dataDir: string) {
    this.uploadDir = resolve(dataDir, "uploads");
  }

  store(data: Buffer, input: UploadedFileInput = {}): UploadedFileRecord {
    const receivedAtMs = input.receivedAtMs ?? Date.now();
    const day = dayString(receivedAtMs);
    const sha256 = createHash("sha256").update(data).digest("hex");
    const name = sanitizeFileName(input.name);
    const fileName = `${sha256.slice(0, 12)}-${name}`;
    const dir = resolve(this.uploadDir, day);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, fileName);
    writeFileSync(path, data);
    return {
      path,
      name,
      mimeType: normalizeMime(input.mimeType),
      sizeBytes: data.length,
      sha256,
    };
  }
}

function sanitizeFileName(raw?: string): string {
  const base = basename((raw ?? "upload.bin").trim()) || "upload.bin";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.*/, "")
    .slice(0, 120);
  if (cleaned) return cleaned;
  return `upload${extname(base) || ".bin"}`;
}

function normalizeMime(raw?: string): string {
  const mime = (raw ?? "").split(";")[0].trim();
  return mime || "application/octet-stream";
}

function dayString(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

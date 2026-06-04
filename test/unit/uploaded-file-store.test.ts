import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { UploadedFileStore } from "../../src/storage/uploaded-file-store.js";

describe("UploadedFileStore", () => {
  let dataDir: string | undefined;

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  function store(): UploadedFileStore {
    dataDir = mkdtempSync(join(tmpdir(), "nerve-upload-store-"));
    return new UploadedFileStore(dataDir);
  }

  it("stores raw bytes under a server-controlled absolute path with metadata", () => {
    const s = store();
    const data = Buffer.from("# Notes\nhello\n");

    const result = s.store(data, {
      name: "../notes.md",
      mimeType: "text/markdown",
      receivedAtMs: Date.UTC(2026, 5, 4, 12),
    });

    expect(result.name).toBe("notes.md");
    expect(result.mimeType).toBe("text/markdown");
    expect(result.sizeBytes).toBe(data.length);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.path).toContain("/uploads/2026-06-04/");
    expect(basename(result.path)).toMatch(/^[a-f0-9]{12}-notes\.md$/);
    expect(readFileSync(result.path)).toEqual(data);
  });

  it("does not allow client filenames to traverse out of uploads", () => {
    const s = store();

    const result = s.store(Buffer.from("x"), {
      name: "../../.ssh/authorized_keys",
      mimeType: "application/octet-stream",
      receivedAtMs: Date.UTC(2026, 5, 4, 12),
    });

    expect(result.path).toContain("/uploads/2026-06-04/");
    expect(result.path).not.toContain("..");
    expect(basename(result.path)).toMatch(/^[a-f0-9]{12}-authorized_keys$/);
  });

  it("keeps readable unicode filenames while still controlling the path", () => {
    const s = store();

    const result = s.store(Buffer.from("x"), {
      name: "需求说明.md",
      mimeType: "text/markdown",
      receivedAtMs: Date.UTC(2026, 5, 4, 12),
    });

    expect(result.name).toBe("需求说明.md");
    expect(result.path).toContain("/uploads/2026-06-04/");
    expect(basename(result.path)).toMatch(/^[a-f0-9]{12}-需求说明\.md$/u);
  });
});

#!/usr/bin/env npx tsx
/**
 * EventLogger unit tests
 * Run: npx tsx test/unit/event-logger.test.ts
 */

import { mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventLogger } from "../../../src/infra/event-logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
const TEST_DIR = resolve(ROOT, ".test-event-logger");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, name: string, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    const msg = detail ? `${name}: ${detail}` : name;
    failures.push(msg);
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

function cleanup(): void {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
}

function testFailOpenWhenPathIsDirectory() {
  console.log("\n▸ EventLogger fail-open when target path is a directory");

  cleanup();
  mkdirSync(TEST_DIR, { recursive: true });
  const badPath = resolve(TEST_DIR, "events-dir");
  mkdirSync(badPath, { recursive: true });

  let ctorErr: Error | null = null;
  let logErr: Error | null = null;

  let logger: EventLogger | null = null;
  try {
    logger = new EventLogger(badPath);
  } catch (err: any) {
    ctorErr = err;
  }

  try {
    logger?.log("channel.created", { channelId: "ch-1" });
  } catch (err: any) {
    logErr = err;
  }

  assert(ctorErr === null, "constructor does not throw on invalid path", ctorErr?.message);
  assert(logErr === null, "log() does not throw on invalid path", logErr?.message);

  cleanup();
}

function main() {
  console.log("═══════════════════════════════════════");
  console.log("  EventLogger Unit Tests");
  console.log("═══════════════════════════════════════");

  testFailOpenWhenPathIsDirectory();

  console.log("\n═══════════════════════════════════════");
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const f of failures) console.log(`    ✗ ${f}`);
  }
  console.log("═══════════════════════════════════════\n");
  process.exit(failed > 0 ? 1 : 0);
}

main();

#!/usr/bin/env npx tsx
/**
 * Unit tests for adapter.ts — pure function tests, no server needed.
 */

import { getAdapter, listAdapters, listProgramAdapters } from "../src/adapter.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

// --- Tests ---

console.log("\n▸ getAdapter");
assert(!!getAdapter("claude"), "claude adapter exists");
assert(!!getAdapter("opencode"), "opencode adapter exists");
assert(!!getAdapter("ai-ear"), "ai-ear adapter exists");
assert(!getAdapter("mc"), "mc adapter removed");
assert(!getAdapter("nonexistent"), "nonexistent returns undefined");

console.log("\n▸ listAdapters");
const all = listAdapters();
assert(all.includes("claude"), "listAdapters includes claude");
assert(all.includes("opencode"), "listAdapters includes opencode");
assert(all.includes("ai-ear"), "listAdapters includes ai-ear");
assert(!all.includes("mc"), "listAdapters does not include mc");

console.log("\n▸ listProgramAdapters");
const progs = listProgramAdapters();
assert(Object.keys(progs).length > 0, "has program adapters");
assert(!progs["claude"], "excludes AI adapters");
assert(!progs["opencode"], "excludes opencode");
assert(!progs["c1"], "excludes c1");
assert(!progs["mock-program"], "excludes mock adapters");
assert(!progs["mock-program-timeout"], "excludes mock-program-timeout");

const ear = progs["ai-ear"];
assert(!!ear, "ai-ear in program adapters");
assert(ear?.description === "实时音频采集与转录", "ai-ear description correct");
assert(!!ear?.commands, "ai-ear has commands");
assert(!!ear?.commands?.start, "ai-ear has start command");
assert(!!ear?.commands?.stop, "ai-ear has stop command");
assert(!!ear?.commands?.subscribe, "ai-ear has subscribe command");
assert(!!ear?.commands?.flush, "ai-ear has flush command");
assert(!!ear?.commands?.config, "ai-ear has config command");
assert(Object.keys(ear?.commands || {}).length === 9, "ai-ear has 9 commands");

assert(!!progs["guardian"], "guardian in program adapters");
assert(!!progs["guardian"]?.description, "guardian has description");
assert(!!progs["duty-monitor"], "duty-monitor in program adapters");
assert(!!progs["duty-monitor"]?.description, "duty-monitor has description");
assert(!!progs["observer"], "observer in program adapters");
assert(!!progs["user-recorder"], "user-recorder in program adapters");

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

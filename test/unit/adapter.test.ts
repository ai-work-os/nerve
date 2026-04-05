#!/usr/bin/env npx tsx
/**
 * Adapter unit tests
 * Run: npx tsx test/unit/adapter.test.ts
 */

import { getAdapter, listAdapters } from "../../src/adapter.js";

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

function assertEq(actual: unknown, expected: unknown, name: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, name, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- Tests ---

function testGetAdapterClaude() {
  console.log("\n▸ getAdapter('claude')");
  const cfg = getAdapter("claude");
  assert(cfg !== undefined, "claude adapter exists");
  assertEq(cfg!.cmd, "claude-agent-acp", "cmd is claude-agent-acp");
}

function testGetAdapterMock() {
  console.log("\n▸ getAdapter('mock')");
  const cfg = getAdapter("mock");
  assert(cfg !== undefined, "mock adapter exists");
  assertEq(cfg!.cmd, "npx", "mock cmd is npx");
  assert(cfg!.args.includes("test/mock-agent.ts"), "mock args include mock-agent.ts");
}

function testGetAdapterNonexistent() {
  console.log("\n▸ getAdapter('nonexistent')");
  const cfg = getAdapter("nonexistent");
  assertEq(cfg, undefined, "nonexistent returns undefined");
}

function testGetAdapterAlias() {
  console.log("\n▸ getAdapter('context-guardian') === getAdapter('guardian')");
  const a = getAdapter("context-guardian");
  const b = getAdapter("guardian");
  assert(a !== undefined, "context-guardian exists");
  assert(a === b, "context-guardian is same object as guardian (alias)");
}

function testListAdaptersContents() {
  console.log("\n▸ listAdapters() contains expected adapters");
  const list = listAdapters();
  for (const name of ["claude", "mock", "gemini"]) {
    assert(list.includes(name), `listAdapters includes "${name}"`);
  }
}

function testListAdaptersLength() {
  console.log("\n▸ listAdapters() length > 10");
  const list = listAdapters();
  assert(list.length > 10, `listAdapters has ${list.length} entries (> 10)`);
}

// --- Main ---

function main() {
  console.log("═══════════════════════════════════════");
  console.log("  Adapter Unit Tests");
  console.log("═══════════════════════════════════════");

  testGetAdapterClaude();
  testGetAdapterMock();
  testGetAdapterNonexistent();
  testGetAdapterAlias();
  testListAdaptersContents();
  testListAdaptersLength();

  console.log("\n══════════════════════════════════════");
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const f of failures) console.log(`    ✗ ${f}`);
  }
  console.log("══════════════════════════════════════\n");
  process.exit(failed > 0 ? 1 : 0);
}

main();

#!/usr/bin/env npx tsx
/**
 * T3 Model Log Tests
 *
 * Tests for:
 * 1. NerveNode.pushUpdate — lastReportedSize tracks context size changes
 * 2. NerveNode.toInfo() — returns model field from adapter config
 *
 * Run: npx tsx test/test-t3-model-log.ts
 */

import { NerveNode } from "../src/node.js";
import { getAdapter } from "../src/adapter.js";

// --- Test infrastructure ---

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

// ============================================================
// pushUpdate — lastReportedSize tracking
// ============================================================

function makeNode(adapter?: string): NerveNode {
  return new NerveNode({
    id: "test-node-1",
    name: "test-agent",
    transport: { type: "stdio" } as any,
    adapter,
  });
}

function makeUsageUpdate(used: number, size: number, cost?: number): any {
  return {
    update: {
      sessionUpdate: "usage_update",
      used,
      size,
      cost: cost != null ? { amount: cost } : null,
    },
  };
}

function testLastReportedSizeUpdatesOnFirstPush() {
  console.log("\n▸ observeUpdate: first usage_update sets lastReportedSize");
  const node = makeNode("mock");
  // mock adapter model "mock-model-v1" → getContextWindow returns 999999
  node.observeUpdate(makeUsageUpdate(10_000, 200_000));
  assertEq((node as any).lastReportedSize, 999_999, "lastReportedSize set to normalized value after first observe");
}

function testLastReportedSizeUpdatesOnSizeChange() {
  console.log("\n▸ observeUpdate: two different sizes → lastReportedSize tracks latest (normalized)");
  const node = makeNode("mock");
  // mock adapter model "mock-model-v1" → getContextWindow returns 999999
  // Both observes normalize to 999999 regardless of raw size
  node.observeUpdate(makeUsageUpdate(10_000, 200_000));
  assertEq((node as any).lastReportedSize, 999_999, "lastReportedSize normalized after first observe");
  node.observeUpdate(makeUsageUpdate(50_000, 300_000));
  assertEq((node as any).lastReportedSize, 999_999, "lastReportedSize stays normalized after second observe");
}

// ============================================================
// toInfo() — model field
// ============================================================

function testToInfoReturnsModelForClaude() {
  console.log("\n▸ toInfo: adapter=claude → model field present");
  const node = makeNode("claude");
  const info = node.toInfo();
  const expected = getAdapter("claude")?.model;
  assertEq(info.model, expected, `model should be "${expected}"`);
}

function testToInfoReturnsUndefinedModelForNoAdapter() {
  console.log("\n▸ toInfo: no adapter → model is undefined");
  const node = makeNode(undefined);
  const info = node.toInfo();
  assertEq(info.model, undefined, "model should be undefined when no adapter");
}

function testToInfoReturnsModelForMock() {
  console.log("\n▸ toInfo: adapter=mock → model is mock-model-v1");
  const node = makeNode("mock");
  const info = node.toInfo();
  const expected = getAdapter("mock")?.model;
  assertEq(info.model, expected, `model should be ${JSON.stringify(expected)}`);
}

function testToInfoReturnsModelForC1() {
  console.log("\n▸ toInfo: adapter=c1 → model field matches claude adapter");
  const node = makeNode("c1");
  const info = node.toInfo();
  const expected = getAdapter("c1")?.model;
  assert(!!expected, "c1 adapter should have model configured");
  assertEq(info.model, expected, `model should be "${expected}"`);
}

function testToInfoReturnsModelForC2() {
  console.log("\n▸ toInfo: adapter=c2 → model field matches claude adapter");
  const node = makeNode("c2");
  const info = node.toInfo();
  const expected = getAdapter("c2")?.model;
  assert(!!expected, "c2 adapter should have model configured");
  assertEq(info.model, expected, `model should be "${expected}"`);
}

// ============================================================
// MAIN
// ============================================================

function main() {
  console.log("═══════════════════════════════════════");
  console.log("  T3 Model Log Tests");
  console.log("═══════════════════════════════════════");

  // 1. lastReportedSize tracking
  testLastReportedSizeUpdatesOnFirstPush();
  testLastReportedSizeUpdatesOnSizeChange();

  // 2. toInfo model field
  testToInfoReturnsModelForClaude();
  testToInfoReturnsUndefinedModelForNoAdapter();
  testToInfoReturnsModelForMock();
  testToInfoReturnsModelForC1();
  testToInfoReturnsModelForC2();

  // Summary
  console.log("\n══════════════════════════════════════");
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const f of failures) {
      console.log(`    ✗ ${f}`);
    }
  }
  console.log("══════════════════════════════════════\n");

  process.exit(failed > 0 ? 1 : 0);
}

main();

#!/usr/bin/env npx tsx
/**
 * Model Registry + Context Guardian Fix Tests
 *
 * Tests for:
 * 1. getContextWindow() — model → context window size mapping
 * 2. pushUpdate() — tokenSize override with model registry
 * 3. shouldTrigger() — correct behavior with 1M context models
 *
 * Run: npx tsx test/test-model-registry.ts
 */

import { getContextWindow } from "../../src/node/model-registry.js";

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
// MODEL REGISTRY — getContextWindow()
// ============================================================

function testGetContextWindowOpus1M() {
  console.log("\n▸ getContextWindow: opus[1m] → 1_000_000");
  assertEq(getContextWindow("opus[1m]"), 1_000_000, "opus[1m] returns 1M");
}

function testGetContextWindowOpus() {
  console.log("\n▸ getContextWindow: opus → 200_000");
  assertEq(getContextWindow("opus"), 200_000, "opus returns 200K");
}

function testGetContextWindowSonnet1M() {
  console.log("\n▸ getContextWindow: sonnet[1m] → 1_000_000");
  assertEq(getContextWindow("sonnet[1m]"), 1_000_000, "sonnet[1m] returns 1M");
}

function testGetContextWindowSonnet() {
  console.log("\n▸ getContextWindow: sonnet → 200_000");
  assertEq(getContextWindow("sonnet"), 200_000, "sonnet returns 200K");
}

function testGetContextWindowHaiku() {
  console.log("\n▸ getContextWindow: haiku → 200_000");
  assertEq(getContextWindow("haiku"), 200_000, "haiku returns 200K");
}

function testGetContextWindowUnknown() {
  console.log("\n▸ getContextWindow: unknown-model → undefined");
  assertEq(getContextWindow("unknown-model"), undefined, "unknown model returns undefined");
}

function testGetContextWindowUndefined() {
  console.log("\n▸ getContextWindow: undefined → undefined");
  assertEq(getContextWindow(undefined), undefined, "undefined input returns undefined");
}

function testGetContextWindowBracketFallback() {
  console.log("\n▸ getContextWindow: haiku[1m] (unknown variant) → falls back to haiku base");
  assertEq(getContextWindow("haiku[1m]"), 200_000, "haiku[1m] falls back to haiku base 200K");
}

// ============================================================
// pushUpdate SIMULATION — tokenSize override
// ============================================================

// Simulate the patched pushUpdate logic
interface NodeUsage {
  tokenUsed: number;
  tokenSize: number;
  cost: number;
  lastUpdated: number;
}

function simulatePushUpdate(
  adapterModel: string | undefined,
  acpUsed: number,
  acpSize: number,
  acpCost: number,
): NodeUsage {
  const actualSize = getContextWindow(adapterModel);
  return {
    tokenUsed: acpUsed || 0,
    tokenSize: actualSize ?? acpSize ?? 0,
    cost: acpCost || 0,
    lastUpdated: Date.now(),
  };
}

function testPushUpdateOpus1MOverride() {
  console.log("\n▸ pushUpdate: opus[1m] → tokenSize should be 1_000_000, not ACP's 200K");
  const usage = simulatePushUpdate("opus[1m]", 50_000, 200_000, 0.5);
  assertEq(usage.tokenSize, 1_000_000, "tokenSize overridden to 1M");
  assertEq(usage.tokenUsed, 50_000, "tokenUsed preserved from ACP");
}

function testPushUpdateUnknownModelFallback() {
  console.log("\n▸ pushUpdate: unknown model → tokenSize uses ACP reported value");
  const usage = simulatePushUpdate("unknown-model", 30_000, 200_000, 0.3);
  assertEq(usage.tokenSize, 200_000, "tokenSize falls back to ACP value");
  assertEq(usage.tokenUsed, 30_000, "tokenUsed preserved from ACP");
}

function testPushUpdateUndefinedModelFallback() {
  console.log("\n▸ pushUpdate: undefined model → tokenSize uses ACP reported value");
  const usage = simulatePushUpdate(undefined, 30_000, 200_000, 0.3);
  assertEq(usage.tokenSize, 200_000, "tokenSize falls back to ACP value when model undefined");
}

// ============================================================
// GUARDIAN shouldTrigger with 1M model
// ============================================================

interface GuardianNodeInfo {
  name: string;
  status: string;
  transport: string;
  usage?: { tokenUsed: number; tokenSize: number };
  sessionId?: string;
  channels: string[];
}

function shouldTrigger(
  node: GuardianNodeInfo,
  threshold: number,
  triggeredSessions: Map<string, string>,
): boolean {
  if (!node.usage || node.transport !== "stdio") return false;
  if (node.status !== "idle") return false;
  if (node.usage.tokenSize === 0) return false;
  if (node.usage.tokenUsed / node.usage.tokenSize < threshold) return false;
  if (triggeredSessions.get(node.name) === node.sessionId) return false;
  return true;
}

function testGuardian1MModelLowUsageNoTrigger() {
  console.log("\n▸ guardian: 1M model, 150K used (15%) → should NOT trigger at 50% threshold");
  const triggered = new Map<string, string>();
  const node: GuardianNodeInfo = {
    name: "agent-opus1m",
    status: "idle",
    transport: "stdio",
    usage: { tokenUsed: 150_000, tokenSize: 1_000_000 },  // 15% — correct 1M size
    sessionId: "sess-1m",
    channels: ["ch-1"],
  };
  assert(!shouldTrigger(node, 0.5, triggered), "15% < 50% threshold, no trigger");
}

function testGuardian200KModelSameUsageTriggers() {
  console.log("\n▸ guardian: 200K model (bug), 150K used (75%) → WOULD trigger (the bug)");
  const triggered = new Map<string, string>();
  const node: GuardianNodeInfo = {
    name: "agent-opus-bug",
    status: "idle",
    transport: "stdio",
    usage: { tokenUsed: 150_000, tokenSize: 200_000 },  // 75% — wrong 200K size (the bug)
    sessionId: "sess-bug",
    channels: ["ch-1"],
  };
  assert(shouldTrigger(node, 0.5, triggered), "75% > 50% threshold, triggers (demonstrates the bug)");
}

function testGuardian1MModelHighUsageTriggers() {
  console.log("\n▸ guardian: 1M model, 600K used (60%) → should trigger at 50% threshold");
  const triggered = new Map<string, string>();
  const node: GuardianNodeInfo = {
    name: "agent-opus1m-high",
    status: "idle",
    transport: "stdio",
    usage: { tokenUsed: 600_000, tokenSize: 1_000_000 },  // 60%
    sessionId: "sess-high",
    channels: ["ch-1"],
  };
  assert(shouldTrigger(node, 0.5, triggered), "60% > 50% threshold, triggers correctly");
}

// ============================================================
// MAIN
// ============================================================

function main() {
  console.log("═══════════════════════════════════════");
  console.log("  Model Registry + Guardian Fix Tests");
  console.log("═══════════════════════════════════════");

  // 1. getContextWindow tests
  testGetContextWindowOpus1M();
  testGetContextWindowOpus();
  testGetContextWindowSonnet1M();
  testGetContextWindowSonnet();
  testGetContextWindowHaiku();
  testGetContextWindowUnknown();
  testGetContextWindowUndefined();
  testGetContextWindowBracketFallback();

  // 2. pushUpdate override tests
  testPushUpdateOpus1MOverride();
  testPushUpdateUnknownModelFallback();
  testPushUpdateUndefinedModelFallback();

  // 3. guardian shouldTrigger with correct sizes
  testGuardian1MModelLowUsageNoTrigger();
  testGuardian200KModelSameUsageTriggers();
  testGuardian1MModelHighUsageTriggers();

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

#!/usr/bin/env npx tsx
/**
 * channel-manager unit tests — buildSystemPrompt
 * Run: npx tsx test/unit/channel-manager.test.ts
 */

import { buildSystemPrompt } from "../../src/channel-manager.js";

// --- Test infrastructure ---

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, name: string, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    const msg = detail ? `${name}: ${detail}` : name;
    failures.push(msg);
    console.log(`  \u2717 ${name}${detail ? " \u2014 " + detail : ""}`);
  }
}

// ============================================================
// buildSystemPrompt
// ============================================================

function testContainsAgentName() {
  console.log("\n\u25b8 buildSystemPrompt: contains agent name");
  const result = buildSystemPrompt("test-bot", "ch-1", ["alice", "bob"]);
  assert(result.includes("test-bot"), "prompt contains agent name");
}

function testContainsChannelId() {
  console.log("\n\u25b8 buildSystemPrompt: contains channel ID");
  const result = buildSystemPrompt("bot", "ch-abc123", ["alice"]);
  assert(result.includes("ch-abc123"), "prompt contains channel ID");
}

function testContainsMembers() {
  console.log("\n\u25b8 buildSystemPrompt: contains member list");
  const result = buildSystemPrompt("bot", "ch-1", ["alice", "bob", "charlie"]);
  assert(result.includes("alice") && result.includes("bob") && result.includes("charlie"), "all members present");
}

function testEmptyMembers() {
  console.log("\n\u25b8 buildSystemPrompt: empty members \u2192 (none yet)");
  const result = buildSystemPrompt("bot", "ch-1", []);
  assert(result.includes("(none yet)"), "shows (none yet) for empty members");
}

function testContainsNervePost() {
  console.log("\n\u25b8 buildSystemPrompt: contains nerve_post tool");
  const result = buildSystemPrompt("bot", "ch-1", ["alice"]);
  assert(result.includes("nerve_post"), "prompt mentions nerve_post");
}

function testContainsChannelRules() {
  console.log("\n\u25b8 buildSystemPrompt: contains channel rules");
  const result = buildSystemPrompt("bot", "ch-1", ["alice"]);
  assert(result.includes("\u9891\u9053\u89c4\u5219"), "prompt contains channel rules section");
  assert(result.includes("50 \u5b57\u4ee5\u5185"), "prompt contains 50 char limit rule");
}

// ============================================================
// MAIN
// ============================================================

function main() {
  console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
  console.log("  Channel Manager Tests (buildSystemPrompt)");
  console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");

  testContainsAgentName();
  testContainsChannelId();
  testContainsMembers();
  testEmptyMembers();
  testContainsNervePost();
  testContainsChannelRules();

  console.log("\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const f of failures) console.log(`    \u2717 ${f}`);
  }
  console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n");
  process.exit(failed > 0 ? 1 : 0);
}

main();

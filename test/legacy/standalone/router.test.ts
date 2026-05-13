#!/usr/bin/env npx tsx
/**
 * Router unit tests — parseMentions + route
 * Run: npx tsx test/unit/router.test.ts
 */

import { parseMentions, route } from "../../../src/channel/router.js";

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

function assertEq(actual: unknown, expected: unknown, name: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, name, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ============================================================
// parseMentions
// ============================================================

function testSingleMention() {
  console.log("\n\u25b8 parseMentions: single @mention");
  assertEq(parseMentions("hello @alice"), ["alice"], "single mention returns [\"alice\"]");
}

function testMultipleMentions() {
  console.log("\n\u25b8 parseMentions: multiple different @mentions");
  const result = parseMentions("@alice and @bob are here");
  assert(result.includes("alice") && result.includes("bob") && result.length === 2, "returns both names");
}

function testDuplicateMentions() {
  console.log("\n\u25b8 parseMentions: duplicate @mentions deduplicated");
  assertEq(parseMentions("@alice and @alice again"), ["alice"], "duplicates removed");
}

function testNoMentions() {
  console.log("\n\u25b8 parseMentions: no @mention");
  assertEq(parseMentions("no mentions here"), [], "returns empty array");
}

function testEmptyString() {
  console.log("\n\u25b8 parseMentions: empty string");
  assertEq(parseMentions(""), [], "returns empty array");
}

function testTrailingPunctuation() {
  console.log("\n\u25b8 parseMentions: trailing punctuation stripped");
  assertEq(parseMentions("@name."), ["name"], "@name. \u2192 name");
  assertEq(parseMentions("@name,"), ["name"], "@name, \u2192 name");
  assertEq(parseMentions("@name;"), ["name"], "@name; \u2192 name");
}

function testSpecialCharsInName() {
  console.log("\n\u25b8 parseMentions: supports _ . - in names");
  assertEq(parseMentions("@name_with-dots.and-dashes"), ["name_with-dots.and-dashes"], "complex name preserved");
}

function testEmailNotMatched() {
  console.log("\n\u25b8 parseMentions: email address not matched");
  assertEq(parseMentions("user@example.com"), [], "email @ not matched (no preceding space)");
}

function testLineStartMention() {
  console.log("\n\u25b8 parseMentions: @name at line start");
  assertEq(parseMentions("@alice hello"), ["alice"], "line-start mention matched via padding");
}

function testConsecutiveMentions() {
  console.log("\n\u25b8 parseMentions: consecutive @a @b @c");
  const result = parseMentions("@a @b @c");
  assert(
    result.includes("a") && result.includes("b") && result.includes("c") && result.length === 3,
    "all three matched",
  );
}

// ============================================================
// route
// ============================================================

function testRouteExistingNode() {
  console.log("\n\u25b8 route: mention existing node \u2192 returns target");
  const channel = { getNodeId: (name: string) => name === "bot" ? "id-bot" : undefined } as any;
  const msg = { id: "m1", channelId: "ch1", from: "user", content: "@bot help", timestamp: 0 };
  const targets = route(channel, msg);
  assertEq(targets, [{ nodeName: "bot", nodeId: "id-bot" }], "returns bot target");
}

function testRouteNonExistingNode() {
  console.log("\n\u25b8 route: mention non-existing node \u2192 skipped");
  const channel = { getNodeId: (_: string) => undefined } as any;
  const msg = { id: "m1", channelId: "ch1", from: "user", content: "@ghost hello", timestamp: 0 };
  const targets = route(channel, msg);
  assertEq(targets, [], "non-existing node skipped");
}

function testRouteSelfMention() {
  console.log("\n\u25b8 route: mention sender self \u2192 skipped");
  const channel = { getNodeId: (name: string) => "id-" + name } as any;
  const msg = { id: "m1", channelId: "ch1", from: "alice", content: "@alice reminder", timestamp: 0 };
  const targets = route(channel, msg);
  assertEq(targets, [], "self-mention skipped");
}

// ============================================================
// MAIN
// ============================================================

function main() {
  console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
  console.log("  Router Tests (parseMentions + route)");
  console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");

  // parseMentions
  testSingleMention();
  testMultipleMentions();
  testDuplicateMentions();
  testNoMentions();
  testEmptyString();
  testTrailingPunctuation();
  testSpecialCharsInName();
  testEmailNotMatched();
  testLineStartMention();
  testConsecutiveMentions();

  // route
  testRouteExistingNode();
  testRouteNonExistingNode();
  testRouteSelfMention();

  // Summary
  console.log("\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const f of failures) {
      console.log(`    \u2717 ${f}`);
    }
  }
  console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n");

  process.exit(failed > 0 ? 1 : 0);
}

main();

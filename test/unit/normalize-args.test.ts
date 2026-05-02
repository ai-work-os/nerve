#!/usr/bin/env npx tsx
/**
 * normalizeArgs — unit tests
 *
 * Tests the positional → named args normalization used by plugin-base
 * to unify channel @mention (positional) and MCP nerve_command (named) paths.
 */

import { normalizeArgs, matchSubscribers, type Subscription } from "../../src/plugins/plugin-base.js";

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

console.log("\n▸ normalizeArgs — no argDef → pass through");
{
  const raw = { "0": "foo", "1": "bar" };
  assertEq(normalizeArgs(raw, undefined), raw, "undefined argDef");
  assertEq(normalizeArgs(raw, {}), raw, "empty argDef");
}

console.log("\n▸ normalizeArgs — named args already present → pass through");
{
  const argDef = { key: "config key", value: "config value" };
  const named = { key: "interval", value: "30" };
  assertEq(normalizeArgs(named, argDef), named, "MCP named args pass through");

  const withExtra = { key: "interval", value: "30", extra: "ignored" };
  assertEq(normalizeArgs(withExtra, argDef), withExtra, "extra args preserved");
}

console.log("\n▸ normalizeArgs — positional → named (single arg)");
{
  const argDef = { name: "task name" };
  assertEq(normalizeArgs({ "0": "写日报" }, argDef), { name: "写日报" }, "single positional → named");
}

console.log("\n▸ normalizeArgs — positional args preserve extra named args");
{
  const argDef = { event: "event type", filter: "optional filter" };
  assertEq(
    normalizeArgs({ "0": "task_fired:daily-audit", name: "duty-agent" }, argDef),
    { name: "duty-agent", event: "task_fired:daily-audit" },
    "extra named subscriber preserved",
  );
}

console.log("\n▸ normalizeArgs — positional → named (two args)");
{
  const argDef = { key: "config key", value: "config value" };
  assertEq(
    normalizeArgs({ "0": "interval", "1": "30" }, argDef),
    { key: "interval", value: "30" },
    "two positional → two named",
  );
}

console.log("\n▸ normalizeArgs — last arg eats remaining positionals");
{
  const argDef = { schedule: "time", message: "content" };
  assertEq(
    normalizeArgs({ "0": "22:00", "1": "@agent", "2": "写日报" }, argDef),
    { schedule: "22:00", message: "@agent 写日报" },
    "last arg joins remaining with space",
  );

  assertEq(
    normalizeArgs({ "0": "22:00", "1": "@agent", "2": "写", "3": "日", "4": "报" }, argDef),
    { schedule: "22:00", message: "@agent 写 日 报" },
    "many remaining positionals joined",
  );
}

console.log("\n▸ normalizeArgs — empty positional → pass through");
{
  const argDef = { name: "task name" };
  assertEq(normalizeArgs({}, argDef), {}, "empty args");
}

console.log("\n▸ normalizeArgs — fewer positionals than declared args");
{
  const argDef = { schedule: "time", message: "content" };
  assertEq(
    normalizeArgs({ "0": "22:00" }, argDef),
    { schedule: "22:00" },
    "only first arg mapped, second missing",
  );
}

console.log("\n▸ normalizeArgs — single declared arg eats all positionals");
{
  const argDef = { name: "task name" };
  assertEq(
    normalizeArgs({ "0": "写", "1": "日", "2": "报" }, argDef),
    { name: "写 日 报" },
    "single arg eats all positionals",
  );
}

// --- matchSubscribers tests ---

console.log("\n▸ matchSubscribers — no filter matches all");
{
  const subs: Subscription[] = [
    { nodeName: "agent-a" },
    { nodeName: "agent-b", filter: "写日报" },
  ];
  assertEq(matchSubscribers(subs, undefined), ["agent-a"], "no tag → only unfiltered match");
}

console.log("\n▸ matchSubscribers — tag matches unfiltered + exact filter");
{
  const subs: Subscription[] = [
    { nodeName: "agent-a" },
    { nodeName: "agent-b", filter: "写日报" },
    { nodeName: "agent-c", filter: "检查服务器" },
  ];
  assertEq(matchSubscribers(subs, "写日报"), ["agent-a", "agent-b"], "tag=写日报 matches a (no filter) + b (exact)");
  assertEq(matchSubscribers(subs, "检查服务器"), ["agent-a", "agent-c"], "tag=检查服务器 matches a + c");
  assertEq(matchSubscribers(subs, "未知"), ["agent-a"], "tag=未知 matches only unfiltered");
}

console.log("\n▸ matchSubscribers — deduplicates node names");
{
  const subs: Subscription[] = [
    { nodeName: "agent-a" },
    { nodeName: "agent-a", filter: "写日报" },
  ];
  assertEq(matchSubscribers(subs, "写日报"), ["agent-a"], "same node deduped");
}

console.log("\n▸ matchSubscribers — empty subs");
{
  assertEq(matchSubscribers([], "写日报"), [], "empty subs → empty");
}

console.log("\n══════════════════════════════════════");
console.log(`  ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\n  Failures:");
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log("══════════════════════════════════════\n");
process.exit(failed > 0 ? 1 : 0);

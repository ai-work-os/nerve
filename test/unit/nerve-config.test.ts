#!/usr/bin/env npx tsx

import { resolveSpawnCwd } from "../../src/nerve-config.js";

let passed = 0;
let failed = 0;

function assertEq(actual: unknown, expected: unknown, name: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const previous = process.env.NERVE_DEFAULT_AGENT_CWD;

console.log("\n▸ nerve config defaults");

process.env.NERVE_DEFAULT_AGENT_CWD = "/tmp/nerve-default-agent-cwd";
assertEq(
  resolveSpawnCwd(undefined),
  "/tmp/nerve-default-agent-cwd",
  "resolveSpawnCwd uses configured default cwd when cwd is omitted",
);

assertEq(
  resolveSpawnCwd("/tmp/explicit-cwd"),
  "/tmp/explicit-cwd",
  "resolveSpawnCwd keeps explicit cwd",
);

if (previous === undefined) delete process.env.NERVE_DEFAULT_AGENT_CWD;
else process.env.NERVE_DEFAULT_AGENT_CWD = previous;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

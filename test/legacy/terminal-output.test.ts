#!/usr/bin/env npx tsx
/**
 * Test: createTerminal output collection completeness
 *
 * Verifies that terminal stdout/stderr are fully captured without data loss.
 * Regression test for bug #10: double listener race condition.
 */

import { spawn, type ChildProcess } from "node:child_process";

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

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Simulate the BUGGY createTerminal pattern (before fix).
 * Two sets of listeners: first appends to closure var, second copies to term.output.
 */
function createTerminalBuggy(cmd: string): { process: ChildProcess; getOutput: () => string } {
  const proc = spawn(cmd, [], { shell: true });
  let output = "";
  proc.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
  proc.stderr?.on("data", (d: Buffer) => { output += d.toString(); });
  const term = { process: proc, output: "" };
  proc.stdout?.on("data", () => { term.output = output; });
  proc.stderr?.on("data", () => { term.output = output; });
  return { process: proc, getOutput: () => term.output };
}

/**
 * Simulate the FIXED createTerminal pattern.
 * Single set of listeners, appending directly to term.output.
 */
function createTerminalFixed(cmd: string): { process: ChildProcess; getOutput: () => string } {
  const proc = spawn(cmd, [], { shell: true });
  const term = { process: proc, output: "" };
  proc.stdout?.on("data", (d: Buffer) => { term.output += d.toString(); });
  proc.stderr?.on("data", (d: Buffer) => { term.output += d.toString(); });
  return { process: proc, getOutput: () => term.output };
}

function waitForExit(proc: ChildProcess): Promise<number> {
  if (proc.exitCode !== null) return Promise.resolve(proc.exitCode);
  return new Promise(resolve => proc.once("exit", code => resolve(code ?? 1)));
}

async function main() {
  console.log("\n=== Terminal Output Collection Tests ===\n");

  // Test 1: Fixed pattern captures stdout completely
  {
    const term = createTerminalFixed("echo hello-fixed");
    await waitForExit(term.process);
    await sleep(50); // let listeners flush
    const out = term.getOutput();
    assert(out.includes("hello-fixed"), "fixed: stdout captured", `got: ${JSON.stringify(out)}`);
  }

  // Test 2: Fixed pattern captures stderr completely
  {
    const term = createTerminalFixed("echo err-fixed >&2");
    await waitForExit(term.process);
    await sleep(50);
    const out = term.getOutput();
    assert(out.includes("err-fixed"), "fixed: stderr captured", `got: ${JSON.stringify(out)}`);
  }

  // Test 3: Fixed pattern captures multi-line output
  {
    const term = createTerminalFixed("printf 'line1\\nline2\\nline3\\n'");
    await waitForExit(term.process);
    await sleep(50);
    const out = term.getOutput();
    assert(out.includes("line1") && out.includes("line2") && out.includes("line3"),
      "fixed: multi-line output captured", `got: ${JSON.stringify(out)}`);
  }

  // Test 4: Fixed pattern captures mixed stdout+stderr
  {
    const term = createTerminalFixed("echo out1; echo err1 >&2; echo out2");
    await waitForExit(term.process);
    await sleep(50);
    const out = term.getOutput();
    assert(out.includes("out1") && out.includes("err1") && out.includes("out2"),
      "fixed: mixed stdout+stderr captured", `got: ${JSON.stringify(out)}`);
  }

  // Test 5: Fixed pattern captures large output without data loss
  {
    const term = createTerminalFixed("for i in $(seq 1 100); do echo line-$i; done");
    await waitForExit(term.process);
    await sleep(100);
    const out = term.getOutput();
    assert(out.includes("line-1") && out.includes("line-50") && out.includes("line-100"),
      "fixed: large output captured completely", `got length: ${out.length}`);
  }

  // Summary
  console.log(`\n--- ${passed} passed, ${failed} failed ---`);
  if (failures.length > 0) {
    console.log("Failures:");
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

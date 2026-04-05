#!/usr/bin/env npx tsx
/**
 * Unit test runner
 *
 * Usage:
 *   npx tsx test/run.ts                         # run all unit tests
 *   npx tsx test/run.ts --filter router          # only router.test.ts
 *   npx tsx test/run.ts --filter "router,node"   # multiple filters
 *   npx tsx test/run.ts --watch                   # watch mode
 *   npx tsx test/run.ts --watch --filter router    # watch + filter
 */

import { readdirSync, watch } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";

const testDir = join(import.meta.dirname, "unit");

// Parse args
let filters: string[] = [];
const filterIdx = process.argv.indexOf("--filter");
if (filterIdx !== -1 && process.argv[filterIdx + 1]) {
  filters = process.argv[filterIdx + 1].split(",").map(f => f.trim());
}
const watchMode = process.argv.includes("--watch");

// Discover test files
let files = readdirSync(testDir)
  .filter(f => f.endsWith(".test.ts"))
  .sort();

if (filters.length > 0) {
  files = files.filter(f => filters.some(flt => f.includes(flt)));
}

function runTests(): number {
  // Re-discover files each run (watch mode may see new files)
  let testFiles = readdirSync(testDir)
    .filter(f => f.endsWith(".test.ts"))
    .sort();

  if (filters.length > 0) {
    testFiles = testFiles.filter(f => filters.some(flt => f.includes(flt)));
  }

  if (testFiles.length === 0) {
    console.log("No test files matched.");
    return 0;
  }

  console.log("═══════════════════════════════════════");
  console.log("  Unit Test Runner");
  console.log("═══════════════════════════════════════");
  console.log(`  Files: ${testFiles.length}`);
  if (filters.length > 0) console.log(`  Filter: ${filters.join(", ")}`);
  console.log("");

  let totalPass = 0;
  let totalFail = 0;
  const failedFiles: string[] = [];

  for (const file of testFiles) {
    const filePath = join(testDir, file);
    const label = basename(file, ".test.ts");
    const result = spawnSync("npx", ["tsx", filePath], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });

    const stdout = result.stdout?.toString() || "";

    // Extract pass/fail counts from output
    const match = stdout.match(/(\d+) passed, (\d+) failed/);
    const p = match ? parseInt(match[1]) : 0;
    const f = match ? parseInt(match[2]) : (result.status !== 0 ? 1 : 0);

    totalPass += p;
    totalFail += f;

    const status = result.status === 0 ? "✓" : "✗";
    console.log(`  ${status} ${label}: ${p} passed, ${f} failed`);

    if (result.status !== 0) {
      failedFiles.push(file);
      const failLines = stdout.split("\n").filter(l => l.includes("✗"));
      for (const l of failLines) console.log(`    ${l.trim()}`);
    }
  }

  console.log("\n══════════════════════════════════════");
  console.log(`  Total: ${totalPass} passed, ${totalFail} failed (${testFiles.length} files)`);
  if (failedFiles.length > 0) {
    console.log(`  Failed: ${failedFiles.join(", ")}`);
  }
  console.log("══════════════════════════════════════\n");

  return totalFail;
}

// --- Main ---

if (files.length === 0 && !watchMode) {
  console.log("No test files matched.");
  process.exit(0);
}

const failures = runTests();

if (watchMode) {
  const srcDir = join(testDir, "../../src");
  let debounceTimer: NodeJS.Timeout | null = null;

  const rerun = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      console.clear();
      runTests();
      console.log("  Watching for changes... (Ctrl+C to exit)\n");
    }, 500);
  };

  // Watch src/ and test/unit/
  for (const dir of [srcDir, testDir]) {
    watch(dir, { recursive: true }, rerun);
  }

  console.log("  Watching for changes... (Ctrl+C to exit)\n");
} else {
  process.exit(failures > 0 ? 1 : 0);
}

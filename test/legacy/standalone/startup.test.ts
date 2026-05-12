#!/usr/bin/env npx tsx

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStartupConfig, startStartupScenes } from "../../../src/startup.js";

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

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  Startup scene config tests");
  console.log("═══════════════════════════════════════════════");

  console.log("\n▸ missing startup.json returns no scenes");
  {
    const dataDir = mkdtempSync(join(tmpdir(), "nerve-startup-test-"));
    try {
      const config = loadStartupConfig(dataDir);
      assert(config.scenes.length === 0, "missing config has empty scenes");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  console.log("\n▸ startup.json scenes are started in order");
  {
    const dataDir = mkdtempSync(join(tmpdir(), "nerve-startup-test-"));
    try {
      writeFileSync(join(dataDir, "startup.json"), JSON.stringify({ scenes: ["work", "daily-duty"] }));
      const started: string[] = [];
      await startStartupScenes({
        dataDir,
        startScene: async (name) => { started.push(name); },
        log: () => {},
      });
      assert(
        JSON.stringify(started) === JSON.stringify(["work", "daily-duty"]),
        "starts configured scenes in order",
        `got ${JSON.stringify(started)}`,
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  console.log("\n▸ startup scene failures are logged and do not block later scenes");
  {
    const dataDir = mkdtempSync(join(tmpdir(), "nerve-startup-test-"));
    try {
      writeFileSync(join(dataDir, "startup.json"), JSON.stringify({ scenes: ["broken", "work"] }));
      const started: string[] = [];
      const logs: string[] = [];
      await startStartupScenes({
        dataDir,
        startScene: async (name) => {
          if (name === "broken") throw new Error("boom");
          started.push(name);
        },
        log: (msg) => logs.push(msg),
      });
      assert(JSON.stringify(started) === JSON.stringify(["work"]), "continues after failed scene");
      assert(logs.some((line) => line.includes("broken") && line.includes("boom")), "logs failed scene");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  console.log("\n▸ invalid startup.json logs and starts no scenes");
  {
    const dataDir = mkdtempSync(join(tmpdir(), "nerve-startup-test-"));
    try {
      writeFileSync(join(dataDir, "startup.json"), "{bad json");
      const logs: string[] = [];
      const config = loadStartupConfig(dataDir, (msg) => logs.push(msg));
      assert(config.scenes.length === 0, "invalid config has empty scenes");
      assert(logs.some((line) => line.includes("startup config invalid")), "invalid config is logged");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} failed, ${passed} passed`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

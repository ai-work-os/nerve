#!/usr/bin/env npx tsx
/**
 * Unit tests for /node/capabilities — requires server.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync } from "node:fs";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const TEST_PORT = 14803;
const TEST_DATA = resolve(ROOT, ".test-data-capabilities");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, name: string, detail?: string): void {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function httpPost(path: string, data: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request({
      hostname: "localhost", port: TEST_PORT, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(`invalid json: ${d}`)); } });
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function run() {
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });

  const server = spawn("npx", ["tsx", "src/cli.ts", "serve", "--port", String(TEST_PORT), "--data", TEST_DATA, "--no-guardian", "--no-recorder"], {
    cwd: ROOT, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NERVE_LOG_LEVEL: "warn" },
  });

  // Wait for server to be ready
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    try { const res = await httpPost("/node/list", {}); if (res.nodes) break; } catch {}
  }

  try {
    console.log("\n▸ /node/capabilities: static metadata");

    const result = await httpPost("/node/capabilities");
    assert(!result.error, "no error", result.error as string);
    const caps = result.capabilities as Record<string, any>;
    assert(!!caps, "has capabilities");

    // ai-ear present with description and commands
    assert(!!caps["ai-ear"], "ai-ear present");
    assert(caps["ai-ear"]?.description === "实时音频采集与转录", "ai-ear description");
    assert(!!caps["ai-ear"]?.commands?.start, "ai-ear has start command");
    assert(!!caps["ai-ear"]?.commands?.stop, "ai-ear has stop command");
    assert(caps["ai-ear"]?.spawned === false, "ai-ear not spawned");

    // guardian present
    assert(!!caps["guardian"], "guardian present");
    assert(!!caps["guardian"]?.description, "guardian has description");
    assert(caps["guardian"]?.spawned === false, "guardian not spawned");

    // AI adapters excluded (only program adapters)
    assert(!caps["claude"], "claude excluded");
    assert(!caps["c1"], "c1 excluded");
    assert(!caps["codex"], "codex excluded");

    // mock adapters excluded
    assert(!caps["mock-program"], "mock-program excluded");

    // All returned entries have required fields
    for (const [name, cap] of Object.entries(caps)) {
      assert(typeof (cap as any).description === "string", `${name} has description field`);
      assert(typeof (cap as any).commands === "object", `${name} has commands field`);
      assert(typeof (cap as any).spawned === "boolean", `${name} has spawned field`);
    }

  } finally {
    server.kill("SIGTERM");
    await sleep(500);
    if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length > 0) console.log("Failures:", failures);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });

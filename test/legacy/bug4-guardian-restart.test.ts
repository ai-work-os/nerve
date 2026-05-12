#!/usr/bin/env npx tsx
/**
 * Bug fix test: guardian stop → re-spawn should succeed
 *
 * Bug: guardian 是 plugin 程序节点，stop 后用 adapter="context-guardian" 再 spawn
 * 报 "unknown adapter: context-guardian"。
 *
 * 方案 A：node.spawn 识别 "context-guardian" adapter，调 startGuardian() 重启。
 *
 * Run: npx tsx test/bug4-guardian-restart.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const TEST_PORT = 14803;
const TEST_DATA = resolve(ROOT, ".test-data-bug4");

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

class WsClient {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  async connect(): Promise<void> {
    this.ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
    return new Promise((resolve, reject) => {
      this.ws.on("open", () => {
        this.ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.id !== undefined && !msg.method) {
            const p = this.pending.get(msg.id);
            if (p) {
              this.pending.delete(msg.id);
              if (msg.error) p.reject(new Error(msg.error.message));
              else p.resolve(msg.result);
            }
          }
        });
        resolve();
      });
      this.ws.on("error", reject);
    });
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, 10000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) { resolve(); return; }
      this.ws.on("close", () => resolve());
      this.ws.close();
    });
  }
}

let serverProc: ChildProcess | null = null;

async function startServer(): Promise<void> {
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });
  mkdirSync(TEST_DATA, { recursive: true });

  serverProc = spawn("npx", ["tsx", "src/index.ts", "--port", String(TEST_PORT), "--data", TEST_DATA, "--no-guardian"], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server start timeout")), 15000);
    serverProc!.stderr!.on("data", (d) => {
      const s = d.toString();
      if (s.includes("ERROR")) process.stderr.write(`[server] ${s}`);
    });
    serverProc!.stdout!.on("data", (d) => {
      if (d.toString().includes("started on port")) { clearTimeout(timeout); resolve(); }
    });
    serverProc!.on("error", (e) => { clearTimeout(timeout); reject(e); });
    serverProc!.on("exit", (code) => {
      if (code !== null && code !== 0) { clearTimeout(timeout); reject(new Error(`server exited with code ${code}`)); }
    });
  });
}

function stopServer(): void {
  if (serverProc) { serverProc.kill("SIGTERM"); serverProc = null; }
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });
}

async function testGuardianRestartAfterStop() {
  console.log("\n▸ Bug fix: guardian stop → re-spawn should succeed");

  const c = new WsClient();
  await c.connect();
  await c.request("node.register", { name: "bug4-tester", capabilities: ["ui"] });

  // Step 1: First spawn with adapter="context-guardian" — this is the bug
  // Currently fails: "unknown adapter: context-guardian"
  let spawn1Ok = false;
  let spawn1NodeId = "";
  let spawn1Error = "";
  try {
    const result = await c.request("node.spawn", { adapter: "context-guardian", name: "test-guardian-1", cwd: ROOT });
    spawn1Ok = !!result.nodeId;
    spawn1NodeId = result.nodeId;
  } catch (err: any) {
    spawn1Error = err.message || String(err);
  }

  assert(spawn1Ok, "guardian-restart: spawn with adapter='context-guardian' succeeds",
    spawn1Ok ? undefined : `spawn failed: ${spawn1Error}`);

  if (!spawn1Ok) {
    // If first spawn fails, no point testing restart — the bug is confirmed
    console.log("  (skipping restart test — first spawn already fails, bug confirmed)");
    await c.disconnect();
    return;
  }

  await sleep(2000);

  // Step 2: Stop
  await c.request("node.stop", { nodeId: spawn1NodeId });
  await sleep(1000);

  // Step 3: Re-spawn — should succeed
  let respawnOk = false;
  let respawnError = "";
  try {
    const result = await c.request("node.spawn", { adapter: "context-guardian", name: "test-guardian-2", cwd: ROOT });
    respawnOk = !!result.nodeId;
    if (result.nodeId) {
      await c.request("node.stop", { nodeId: result.nodeId });
      await sleep(500);
    }
  } catch (err: any) {
    respawnError = err.message || String(err);
  }

  assert(respawnOk, "guardian-restart: re-spawn after stop succeeds",
    respawnOk ? undefined : `re-spawn failed: ${respawnError}`);

  await c.disconnect();
}

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  Bug4: Guardian Restart After Stop");
  console.log("═══════════════════════════════════════");

  try {
    console.log("\nStarting server...");
    await startServer();
    console.log("Server ready.");

    await testGuardianRestartAfterStop();
  } catch (err) {
    console.error("\n💥 Fatal error:", err);
    failed++;
  } finally {
    stopServer();
  }

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

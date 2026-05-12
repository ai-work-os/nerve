#!/usr/bin/env npx tsx
/**
 * Spawn Channel Inherit Tests (TDD — Red phase)
 *
 * Tests for: WS node.spawn auto-inherits caller's channel when caller is in exactly 1 channel.
 * Run: npx tsx test/test-spawn-channel-inherit.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const TEST_PORT = 14803;
const TEST_DATA = resolve(ROOT, ".test-data-spawn-inherit");

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
      }, 15000);
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
  serverProc = spawn("npx", ["tsx", "src/index.ts", "--port", String(TEST_PORT), "--data", TEST_DATA], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server start timeout")), 10000);
    serverProc!.stderr!.on("data", (d) => {
      const s = d.toString();
      if (s.includes("ERROR")) process.stderr.write(`[server] ${s}`);
    });
    serverProc!.stdout!.on("data", (d) => {
      if (d.toString().includes("started on port")) { clearTimeout(timeout); resolve(); }
    });
    serverProc!.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

function stopServer(): void {
  if (serverProc) { serverProc.kill("SIGTERM"); serverProc = null; }
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });
}

// Helper: get channels of a node by name from node.list
async function getNodeChannels(client: WsClient, nodeName: string): Promise<string[]> {
  const list = await client.request("node.list");
  const node = list.nodes?.find((n: any) => n.name === nodeName);
  return node?.channels ?? [];
}

// ============================================================
// TEST 1: caller in 1 channel, no channelId → auto-inherit
// ============================================================
async function testAutoInheritSingleChannel() {
  console.log("\n▸ spawn: caller in 1 channel + no channelId → new agent auto-joins");
  const c = new WsClient();
  await c.connect();

  // Register caller node
  await c.request("node.register", { name: "caller-1ch", capabilities: ["ui"] });

  // Create channel and join
  const ch = await c.request("channel.create", { cwd: ROOT, name: "inherit-test-ch" });
  await c.request("channel.join", { channelId: ch.channelId });

  // Spawn new agent via WS without channelId
  const spawned = await c.request("node.spawn", { adapter: "mock", name: "child-auto-inherit" });
  await sleep(2000);

  // Verify: child should be in the same channel
  const childChannels = await getNodeChannels(c, "child-auto-inherit");
  assert(
    childChannels.includes(ch.channelId),
    "spawned agent auto-joined caller's channel",
    `expected [${ch.channelId}], got [${childChannels}]`,
  );

  // Cleanup
  await c.request("node.stop", { nodeId: spawned.nodeId });
  await sleep(500);
  await c.disconnect();
}

// ============================================================
// TEST 2: caller in 0 channels → no auto-join
// ============================================================
async function testNoInheritZeroChannels() {
  console.log("\n▸ spawn: caller in 0 channels → no auto-join");
  const c = new WsClient();
  await c.connect();

  // Register caller node, do NOT join any channel
  await c.request("node.register", { name: "caller-0ch", capabilities: ["ui"] });

  // Spawn new agent
  const spawned = await c.request("node.spawn", { adapter: "mock", name: "child-no-inherit-0" });
  await sleep(2000);

  // Verify: child should NOT be in any channel
  const childChannels = await getNodeChannels(c, "child-no-inherit-0");
  assert(
    childChannels.length === 0,
    "spawned agent not in any channel when caller has 0 channels",
    `expected [], got [${childChannels}]`,
  );

  await c.request("node.stop", { nodeId: spawned.nodeId });
  await sleep(500);
  await c.disconnect();
}

// ============================================================
// TEST 3: caller in 2+ channels → no auto-join
// ============================================================
async function testNoInheritMultipleChannels() {
  console.log("\n▸ spawn: caller in 2+ channels → no auto-join");
  const c = new WsClient();
  await c.connect();

  // Register caller and join 2 channels
  await c.request("node.register", { name: "caller-2ch", capabilities: ["ui"] });

  const ch1 = await c.request("channel.create", { cwd: ROOT, name: "multi-ch-1" });
  await c.request("channel.join", { channelId: ch1.channelId });

  const ch2 = await c.request("channel.create", { cwd: ROOT, name: "multi-ch-2" });
  await c.request("channel.join", { channelId: ch2.channelId });

  // Spawn new agent without channelId
  const spawned = await c.request("node.spawn", { adapter: "mock", name: "child-no-inherit-multi" });
  await sleep(2000);

  // Verify: child should NOT be in any channel (ambiguous)
  const childChannels = await getNodeChannels(c, "child-no-inherit-multi");
  assert(
    childChannels.length === 0,
    "spawned agent not in any channel when caller has 2+ channels",
    `expected [], got [${childChannels}]`,
  );

  await c.request("node.stop", { nodeId: spawned.nodeId });
  await sleep(500);
  await c.disconnect();
}

// ============================================================
// TEST 4: explicit channelId → uses explicit value (not caller's)
// ============================================================
async function testExplicitChannelId() {
  console.log("\n▸ spawn: explicit channelId B (caller in A) → child in B, not A");
  const c = new WsClient();
  await c.connect();

  // Register caller and join channel A
  await c.request("node.register", { name: "caller-explicit", capabilities: ["ui"] });

  const chA = await c.request("channel.create", { cwd: ROOT, name: "explicit-ch-A" });
  await c.request("channel.join", { channelId: chA.channelId });

  // Create channel B — caller does NOT join it
  const chB = await c.request("channel.create", { cwd: ROOT, name: "explicit-ch-B" });

  // Spawn with explicit channelId = B
  const spawned = await c.request("node.spawn", {
    adapter: "mock",
    name: "child-explicit-ch",
    channelId: chB.channelId,
  });
  await sleep(2000);

  // Verify: child should be in B, NOT in A
  const childChannels = await getNodeChannels(c, "child-explicit-ch");
  assert(
    childChannels.includes(chB.channelId),
    "spawned agent joined explicit channel B",
    `expected B=[${chB.channelId}], got [${childChannels}]`,
  );
  assert(
    !childChannels.includes(chA.channelId),
    "spawned agent NOT in caller's channel A",
    `should not contain A=[${chA.channelId}], got [${childChannels}]`,
  );

  await c.request("node.stop", { nodeId: spawned.nodeId });
  await sleep(500);
  await c.disconnect();
}

// ============================================================
// TEST 5: HTTP spawn (no caller identity) → no channel inherit
// ============================================================
async function testHttpSpawnNoInherit() {
  console.log("\n▸ spawn: HTTP POST /node/spawn → no channel inherit");

  // First, create a WS client in a channel (to ensure channels exist)
  const c = new WsClient();
  await c.connect();
  await c.request("node.register", { name: "ws-bystander", capabilities: ["ui"] });
  const ch = await c.request("channel.create", { cwd: ROOT, name: "http-test-ch" });
  await c.request("channel.join", { channelId: ch.channelId });

  // Spawn via HTTP POST (no caller identity, no channelId)
  const httpResult = await new Promise<any>((resolve, reject) => {
    const body = JSON.stringify({ adapter: "mock", name: "child-http-spawn" });
    const req = httpRequest(
      {
        hostname: "localhost",
        port: TEST_PORT,
        path: "/node/spawn",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  await sleep(2000);

  // Verify: HTTP-spawned child should NOT be in any channel
  const childChannels = await getNodeChannels(c, "child-http-spawn");
  assert(
    childChannels.length === 0,
    "HTTP-spawned agent not in any channel",
    `expected [], got [${childChannels}]`,
  );

  // Cleanup
  if (httpResult?.nodeId) {
    await c.request("node.stop", { nodeId: httpResult.nodeId });
    await sleep(500);
  }
  await c.disconnect();
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  Spawn Channel Inherit Tests");
  console.log("═══════════════════════════════════════");

  try {
    console.log("\nStarting server on port " + TEST_PORT + "...");
    await startServer();
    console.log("Server ready.\n");

    await testAutoInheritSingleChannel();
    await testNoInheritZeroChannels();
    await testNoInheritMultipleChannels();
    await testExplicitChannelId();
    await testHttpSpawnNoInherit();

  } catch (err) {
    console.error("\n💥 Fatal error:", err);
    failed++;
  } finally {
    stopServer();
  }

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

#!/usr/bin/env npx tsx
/**
 * Tests for spawn standalone parameter
 * Run: npx tsx test/test-standalone-spawn.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync } from "node:fs";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_PORT = 14805;
const TEST_DATA = resolve(ROOT, ".test-data-standalone");

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

// ============================================================
// TEST 1: WS spawn with standalone=true skips auto-inherit
// ============================================================
async function testStandaloneWsSkipsAutoInherit() {
  console.log("\n▸ spawn standalone: WS node.spawn with standalone=true skips channel auto-inherit");
  const c = new WsClient();
  await c.connect();
  await c.request("node.register", { name: "standalone-caller", capabilities: ["ui"] });

  const ch = await c.request("channel.create", { cwd: ROOT, name: "standalone-ch" });
  await c.request("channel.join", { channelId: ch.channelId });

  // Spawn with standalone=true → should NOT auto-inherit
  const spawned = await c.request("node.spawn", {
    adapter: "mock",
    name: "standalone-child",
    standalone: true,
  });
  await sleep(2000);

  const list = await c.request("node.list");
  const child = list.nodes?.find((n: any) => n.name === "standalone-child");
  assert(!!child, "standalone-ws: child spawned");
  assert(
    !child?.channels?.length || child.channels.length === 0,
    "standalone-ws: child NOT in any channel",
    `expected 0 channels, got ${JSON.stringify(child?.channels)}`,
  );

  await c.request("node.stop", { nodeId: spawned.nodeId });
  await sleep(500);
  await c.disconnect();
}

// ============================================================
// TEST 2: WS spawn without standalone still auto-inherits
// ============================================================
async function testDefaultStillInherits() {
  console.log("\n▸ spawn standalone: WS node.spawn without standalone still auto-inherits");
  const c = new WsClient();
  await c.connect();
  await c.request("node.register", { name: "default-caller", capabilities: ["ui"] });

  const ch = await c.request("channel.create", { cwd: ROOT, name: "default-ch" });
  await c.request("channel.join", { channelId: ch.channelId });

  const spawned = await c.request("node.spawn", {
    adapter: "mock",
    name: "default-child",
  });
  await sleep(2000);

  const list = await c.request("node.list");
  const child = list.nodes?.find((n: any) => n.name === "default-child");
  assert(!!child, "default: child spawned");
  assert(
    child?.channels?.includes(ch.channelId),
    "default: child auto-inherited channel",
    `expected [${ch.channelId}], got ${JSON.stringify(child?.channels)}`,
  );

  await c.request("node.stop", { nodeId: spawned.nodeId });
  await sleep(500);
  await c.disconnect();
}

// ============================================================
// TEST 3: standalone=false still auto-inherits (explicit false)
// ============================================================
async function testStandaloneFalseInherits() {
  console.log("\n▸ spawn standalone: standalone=false still auto-inherits");
  const c = new WsClient();
  await c.connect();
  await c.request("node.register", { name: "false-caller", capabilities: ["ui"] });

  const ch = await c.request("channel.create", { cwd: ROOT, name: "false-ch" });
  await c.request("channel.join", { channelId: ch.channelId });

  const spawned = await c.request("node.spawn", {
    adapter: "mock",
    name: "false-child",
    standalone: false,
  });
  await sleep(2000);

  const list = await c.request("node.list");
  const child = list.nodes?.find((n: any) => n.name === "false-child");
  assert(!!child, "standalone-false: child spawned");
  assert(
    child?.channels?.includes(ch.channelId),
    "standalone-false: child auto-inherited channel",
    `expected [${ch.channelId}], got ${JSON.stringify(child?.channels)}`,
  );

  await c.request("node.stop", { nodeId: spawned.nodeId });
  await sleep(500);
  await c.disconnect();
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║  Spawn Standalone Tests               ║");
  console.log("╚══════════════════════════════════════╝");

  try {
    console.log("\n⟳ Starting server...");
    await startServer();
    console.log("  Server started on port", TEST_PORT);

    await testStandaloneWsSkipsAutoInherit();
    await testDefaultStillInherits();
    await testStandaloneFalseInherits();

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

#!/usr/bin/env npx tsx
/**
 * Tests for message source/client field
 * Run: npx tsx test/test-message-source.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync } from "node:fs";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const TEST_PORT = 14806;
const TEST_DATA = resolve(ROOT, ".test-data-msg-source");

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
  private notifications: any[] = [];

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
          } else if (msg.method) {
            this.notifications.push(msg);
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

  getNotifications(method?: string): any[] {
    return method ? this.notifications.filter(n => n.method === method) : this.notifications;
  }

  clearNotifications(): void {
    this.notifications = [];
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
// TEST 1: source field stored on register and visible in node.list
// ============================================================
async function testSourceStoredOnRegister() {
  console.log("\n▸ message source: source field stored on register");
  const c = new WsClient();
  await c.connect();
  await c.request("node.register", { name: "tui-client", capabilities: ["ui"], source: "tui" });

  const list = await c.request("node.list");
  const node = list.nodes?.find((n: any) => n.name === "tui-client");
  assert(!!node, "source-register: node found");
  assert(node?.source === "tui", "source-register: source field is 'tui'",
    `got source=${JSON.stringify(node?.source)}`);

  await c.disconnect();
}

// ============================================================
// TEST 2: source field absent when not provided
// ============================================================
async function testSourceAbsentWhenNotProvided() {
  console.log("\n▸ message source: source absent when not provided on register");
  const c = new WsClient();
  await c.connect();
  await c.request("node.register", { name: "no-source-client", capabilities: ["ui"] });

  const list = await c.request("node.list");
  const node = list.nodes?.find((n: any) => n.name === "no-source-client");
  assert(!!node, "source-absent: node found");
  assert(!node?.source, "source-absent: source field is undefined",
    `got source=${JSON.stringify(node?.source)}`);

  await c.disconnect();
}

// ============================================================
// TEST 3: message metadata includes source from sender
// ============================================================
async function testMessageMetadataIncludesSource() {
  console.log("\n▸ message source: message metadata includes sender's source");
  const sender = new WsClient();
  const receiver = new WsClient();
  await sender.connect();
  await receiver.connect();

  await sender.request("node.register", { name: "android-sender", capabilities: ["ui"], source: "android" });
  await receiver.request("node.register", { name: "source-receiver", capabilities: ["ui"] });

  // Create channel and both join
  const ch = await sender.request("channel.create", { cwd: ROOT, name: "source-msg-ch" });
  await sender.request("channel.join", { channelId: ch.channelId });
  await receiver.request("channel.join", { channelId: ch.channelId });
  receiver.clearNotifications();

  // Sender posts a message
  await sender.request("channel.post", { channelId: ch.channelId, content: "hello from android" });
  await sleep(500);

  // Receiver should see the message with source in metadata
  const msgs = receiver.getNotifications("channel.message");
  assert(msgs.length >= 1, "source-msg: receiver got message notification");
  const msg = msgs[0]?.params?.message;
  assert(msg?.metadata?.source === "android", "source-msg: metadata.source is 'android'",
    `got metadata=${JSON.stringify(msg?.metadata)}`);

  await sender.disconnect();
  await receiver.disconnect();
}

// ============================================================
// TEST 4: message from client without source has no source in metadata
// ============================================================
async function testMessageNoSourceWhenNotRegistered() {
  console.log("\n▸ message source: message has no source when sender didn't register source");
  const sender = new WsClient();
  const receiver = new WsClient();
  await sender.connect();
  await receiver.connect();

  await sender.request("node.register", { name: "plain-sender", capabilities: ["ui"] });
  await receiver.request("node.register", { name: "plain-receiver", capabilities: ["ui"] });

  const ch = await sender.request("channel.create", { cwd: ROOT, name: "no-source-msg-ch" });
  await sender.request("channel.join", { channelId: ch.channelId });
  await receiver.request("channel.join", { channelId: ch.channelId });
  receiver.clearNotifications();

  await sender.request("channel.post", { channelId: ch.channelId, content: "hello plain" });
  await sleep(500);

  const msgs = receiver.getNotifications("channel.message");
  assert(msgs.length >= 1, "no-source-msg: receiver got message");
  const msg = msgs[0]?.params?.message;
  assert(!msg?.metadata?.source, "no-source-msg: no source in metadata",
    `got metadata=${JSON.stringify(msg?.metadata)}`);

  await sender.disconnect();
  await receiver.disconnect();
}

// ============================================================
// TEST 5: different sources (android, tui, web) are preserved
// ============================================================
async function testMultipleSources() {
  console.log("\n▸ message source: different source values are preserved");
  const c = new WsClient();
  await c.connect();

  // Register three clients with different sources
  const c1 = new WsClient();
  const c2 = new WsClient();
  const c3 = new WsClient();
  await c1.connect();
  await c2.connect();
  await c3.connect();

  await c.request("node.register", { name: "source-checker", capabilities: ["ui"] });
  await c1.request("node.register", { name: "web-client", capabilities: ["ui"], source: "web" });
  await c2.request("node.register", { name: "tui-client-2", capabilities: ["ui"], source: "tui" });
  await c3.request("node.register", { name: "android-client", capabilities: ["ui"], source: "android" });

  const list = await c.request("node.list");
  const webNode = list.nodes?.find((n: any) => n.name === "web-client");
  const tuiNode = list.nodes?.find((n: any) => n.name === "tui-client-2");
  const androidNode = list.nodes?.find((n: any) => n.name === "android-client");

  assert(webNode?.source === "web", "multi-source: web source correct",
    `got ${webNode?.source}`);
  assert(tuiNode?.source === "tui", "multi-source: tui source correct",
    `got ${tuiNode?.source}`);
  assert(androidNode?.source === "android", "multi-source: android source correct",
    `got ${androidNode?.source}`);

  await c.disconnect();
  await c1.disconnect();
  await c2.disconnect();
  await c3.disconnect();
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║  Message Source Tests                  ║");
  console.log("╚══════════════════════════════════════╝");

  try {
    console.log("\n⟳ Starting server...");
    await startServer();
    console.log("  Server started on port", TEST_PORT);

    await testSourceStoredOnRegister();
    await testSourceAbsentWhenNotProvided();
    await testMessageMetadataIncludesSource();
    await testMessageNoSourceWhenNotRegistered();
    await testMultipleSources();

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

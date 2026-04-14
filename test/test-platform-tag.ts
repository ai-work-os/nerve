#!/usr/bin/env npx tsx
/**
 * Tests for platform field and channel.post platform prefix behavior.
 * Run: npx tsx test/test-platform-tag.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync } from "node:fs";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_PORT = 14807;
const TEST_DATA = resolve(ROOT, ".test-data-platform-tag");

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
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    return method ? this.notifications.filter((n) => n.method === method) : this.notifications;
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

async function testPlatformStoredOnRegister() {
  console.log("\n▸ platform tag: node.register stores platform");
  const c = new WsClient();
  await c.connect();
  await c.request("node.register", { name: "platform-node", capabilities: ["ui"], platform: "android" });

  const list = await c.request("node.list");
  const node = list.nodes?.find((n: any) => n.name === "platform-node");
  assert(!!node, "platform-register: node found");
  assert(node?.platform === "android", "platform-register: platform is 'android'",
    `got platform=${JSON.stringify(node?.platform)}`);

  await c.disconnect();
}

async function testPostPrefixWhenPlatformPresent() {
  console.log("\n▸ platform tag: channel.post prefixes [platform]");
  const sender = new WsClient();
  const receiver = new WsClient();
  await sender.connect();
  await receiver.connect();

  await sender.request("node.register", { name: "android-sender", capabilities: ["ui"], platform: "android" });
  await receiver.request("node.register", { name: "platform-receiver", capabilities: ["ui"] });

  const ch = await sender.request("channel.create", { cwd: ROOT, name: "platform-prefix-ch" });
  await sender.request("channel.join", { channelId: ch.channelId });
  await receiver.request("channel.join", { channelId: ch.channelId });
  receiver.clearNotifications();

  await sender.request("channel.post", { channelId: ch.channelId, content: "hello" });
  await sleep(500);

  const msgs = receiver.getNotifications("channel.message");
  assert(msgs.length >= 1, "platform-prefix: receiver got message");
  const msg = msgs[0]?.params?.message;
  assert(msg?.content === "[android] hello", "platform-prefix: content prefixed",
    `got content=${JSON.stringify(msg?.content)}`);

  await sender.disconnect();
  await receiver.disconnect();
}

async function testPostNoPrefixWhenPlatformAbsent() {
  console.log("\n▸ platform tag: channel.post unchanged without platform");
  const sender = new WsClient();
  const receiver = new WsClient();
  await sender.connect();
  await receiver.connect();

  await sender.request("node.register", { name: "plain-sender", capabilities: ["ui"] });
  await receiver.request("node.register", { name: "plain-receiver", capabilities: ["ui"] });

  const ch = await sender.request("channel.create", { cwd: ROOT, name: "platform-plain-ch" });
  await sender.request("channel.join", { channelId: ch.channelId });
  await receiver.request("channel.join", { channelId: ch.channelId });
  receiver.clearNotifications();

  await sender.request("channel.post", { channelId: ch.channelId, content: "hello plain" });
  await sleep(500);

  const msgs = receiver.getNotifications("channel.message");
  assert(msgs.length >= 1, "platform-no-prefix: receiver got message");
  const msg = msgs[0]?.params?.message;
  assert(msg?.content === "hello plain", "platform-no-prefix: content unchanged",
    `got content=${JSON.stringify(msg?.content)}`);

  await sender.disconnect();
  await receiver.disconnect();
}

async function main() {
  console.log("=== platform tag tests ===");
  try {
    await startServer();
    await testPlatformStoredOnRegister();
    await testPostPrefixWhenPlatformPresent();
    await testPostNoPrefixWhenPlatformAbsent();
  } catch (err) {
    console.error("Fatal:", err);
    failed++;
    failures.push(`fatal: ${String(err)}`);
  } finally {
    stopServer();
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

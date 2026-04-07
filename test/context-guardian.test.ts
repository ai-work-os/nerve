#!/usr/bin/env npx tsx
/**
 * Context Guardian Tests (TDD — Step 6)
 *
 * Tests for the context guardian plugin: threshold detection, dedup, cooldown.
 * Run: npx tsx test/context-guardian.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync } from "node:fs";
import http from "node:http";
import WebSocket from "ws";

// Import pure logic from logic.ts (no side effects — no plugin startup)
import { getThreshold, shouldTrigger, type ThresholdConfig, type NodeInfo } from "../src/plugins/context-guardian/logic.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_PORT = 14802;
const TEST_DATA = resolve(ROOT, ".test-data-guardian");

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

function assertEq(actual: unknown, expected: unknown, name: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, name, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// UNIT TESTS — pure logic, no server needed
// ============================================================

function testShouldTriggerAboveThreshold() {
  console.log("\n▸ shouldTrigger: above threshold + idle → trigger");
  const triggered = new Map<string, string>();
  const node: NodeInfo = {
    name: "agent-a",
    status: "idle",
    transport: "stdio",
    usage: { tokenUsed: 60000, tokenSize: 100000 },
    sessionId: "sess-1",
    channels: ["ch-1"],
  };
  assert(shouldTrigger(node, 0.5, triggered), "60% > 50% threshold triggers");
}

function testShouldTriggerBelowThreshold() {
  console.log("\n▸ shouldTrigger: below threshold → no trigger");
  const triggered = new Map<string, string>();
  const node: NodeInfo = {
    name: "agent-b",
    status: "idle",
    transport: "stdio",
    usage: { tokenUsed: 30000, tokenSize: 100000 },
    sessionId: "sess-2",
    channels: ["ch-1"],
  };
  assert(!shouldTrigger(node, 0.5, triggered), "30% < 50% threshold does not trigger");
}

function testShouldTriggerBusy() {
  console.log("\n▸ shouldTrigger: busy → no trigger");
  const triggered = new Map<string, string>();
  const node: NodeInfo = {
    name: "agent-c",
    status: "busy",
    transport: "stdio",
    usage: { tokenUsed: 80000, tokenSize: 100000 },
    sessionId: "sess-3",
    channels: ["ch-1"],
  };
  assert(!shouldTrigger(node, 0.5, triggered), "busy agent does not trigger even at 80%");
}

function testShouldTriggerSameSessionDedup() {
  console.log("\n▸ shouldTrigger: same session already triggered → no trigger");
  const triggered = new Map<string, string>();
  triggered.set("agent-d", "sess-4");  // Already triggered for this session
  const node: NodeInfo = {
    name: "agent-d",
    status: "idle",
    transport: "stdio",
    usage: { tokenUsed: 60000, tokenSize: 100000 },
    sessionId: "sess-4",
    channels: ["ch-1"],
  };
  assert(!shouldTrigger(node, 0.5, triggered), "same session does not trigger again");
}

function testShouldTriggerNewSession() {
  console.log("\n▸ shouldTrigger: new session after reset → trigger again");
  const triggered = new Map<string, string>();
  triggered.set("agent-e", "sess-old");  // Triggered for old session
  const node: NodeInfo = {
    name: "agent-e",
    status: "idle",
    transport: "stdio",
    usage: { tokenUsed: 60000, tokenSize: 100000 },
    sessionId: "sess-new",  // Different session = new round
    channels: ["ch-1"],
  };
  assert(shouldTrigger(node, 0.5, triggered), "new session allows re-trigger");
}

function testShouldTriggerMultipleAgents() {
  console.log("\n▸ shouldTrigger: multiple agents independent");
  const triggered = new Map<string, string>();
  const agentA: NodeInfo = {
    name: "agent-f",
    status: "idle",
    transport: "stdio",
    usage: { tokenUsed: 60000, tokenSize: 100000 },
    sessionId: "sess-f",
    channels: ["ch-1"],
  };
  const agentB: NodeInfo = {
    name: "agent-g",
    status: "idle",
    transport: "stdio",
    usage: { tokenUsed: 30000, tokenSize: 100000 },
    sessionId: "sess-g",
    channels: ["ch-1"],
  };

  assert(shouldTrigger(agentA, 0.5, triggered), "agent A (60%) triggers");
  assert(!shouldTrigger(agentB, 0.5, triggered), "agent B (30%) does not trigger");

  // Mark A as triggered
  triggered.set("agent-f", "sess-f");
  assert(!shouldTrigger(agentA, 0.5, triggered), "agent A does not re-trigger");
  assert(!shouldTrigger(agentB, 0.5, triggered), "agent B still does not trigger");
}

function testShouldTriggerNoUsage() {
  console.log("\n▸ shouldTrigger: no usage data → no trigger");
  const triggered = new Map<string, string>();
  const node: NodeInfo = {
    name: "agent-h",
    status: "idle",
    transport: "stdio",
    sessionId: "sess-h",
    channels: ["ch-1"],
  };
  assert(!shouldTrigger(node, 0.5, triggered), "no usage data does not trigger");
}

function testShouldTriggerWebsocketNode() {
  console.log("\n▸ shouldTrigger: websocket node → no trigger");
  const triggered = new Map<string, string>();
  const node: NodeInfo = {
    name: "tui",
    status: "idle",
    transport: "websocket",
    usage: { tokenUsed: 90000, tokenSize: 100000 },
    sessionId: "sess-tui",
    channels: ["ch-1"],
  };
  assert(!shouldTrigger(node, 0.5, triggered), "websocket node does not trigger");
}

// ============================================================
// UNIT TESTS — getThreshold dynamic threshold (Task 1)
// ============================================================

const DEFAULT_CONFIG: ThresholdConfig = { large: 0.5, small: 0.8, boundary: 500_000 };

function testGetThresholdLargeModel() {
  console.log("\n▸ getThreshold: 1M model (no uniform) → 0.5");
  assertEq(getThreshold(1_000_000, DEFAULT_CONFIG), 0.5, "1M model returns large threshold 0.5");
}

function testGetThresholdSmallModel() {
  console.log("\n▸ getThreshold: 200K model (no uniform) → 0.8");
  assertEq(getThreshold(200_000, DEFAULT_CONFIG), 0.8, "200K model returns small threshold 0.8");
}

function testGetThresholdUniformOverride() {
  console.log("\n▸ getThreshold: uniform=0.6 → ignores size, returns 0.6");
  assertEq(getThreshold(1_000_000, { ...DEFAULT_CONFIG, uniform: 0.6 }), 0.6, "uniform overrides large model");
  assertEq(getThreshold(200_000, { ...DEFAULT_CONFIG, uniform: 0.6 }), 0.6, "uniform overrides small model");
}

function testGetThresholdAtBoundary() {
  console.log("\n▸ getThreshold: tokenSize exactly at boundary → large threshold");
  assertEq(getThreshold(500_000, DEFAULT_CONFIG), 0.5, "tokenSize == boundary returns large threshold");
}

function testShouldTriggerDynamic1MLargeAt60() {
  console.log("\n▸ shouldTrigger dynamic: 1M model 60% → trigger (>50%)");
  const triggered = new Map<string, string>();
  const node: NodeInfo = {
    name: "agent-1m",
    status: "idle",
    transport: "stdio",
    usage: { tokenUsed: 600_000, tokenSize: 1_000_000 },
    sessionId: "sess-1m",
    channels: ["ch-1"],
  };
  // With dynamic threshold, 1M model → threshold 0.5, 60% > 50% → should trigger
  const threshold = getThreshold(node.usage!.tokenSize, DEFAULT_CONFIG);
  assert(shouldTrigger(node, threshold, triggered), "1M model at 60% triggers with dynamic threshold 0.5");
}

function testShouldTriggerDynamic200KAt60() {
  console.log("\n▸ shouldTrigger dynamic: 200K model 60% → no trigger (<80%)");
  const triggered = new Map<string, string>();
  const node: NodeInfo = {
    name: "agent-200k",
    status: "idle",
    transport: "stdio",
    usage: { tokenUsed: 120_000, tokenSize: 200_000 },
    sessionId: "sess-200k",
    channels: ["ch-1"],
  };
  // With dynamic threshold, 200K model → threshold 0.8, 60% < 80% → should NOT trigger
  const threshold = getThreshold(node.usage!.tokenSize, DEFAULT_CONFIG);
  assert(!shouldTrigger(node, threshold, triggered), "200K model at 60% does not trigger with dynamic threshold 0.8");
}

function testShouldTriggerDynamic200KAt85() {
  console.log("\n▸ shouldTrigger dynamic: 200K model 85% → trigger (>80%)");
  const triggered = new Map<string, string>();
  const node: NodeInfo = {
    name: "agent-200k-high",
    status: "idle",
    transport: "stdio",
    usage: { tokenUsed: 170_000, tokenSize: 200_000 },
    sessionId: "sess-200k-high",
    channels: ["ch-1"],
  };
  // With dynamic threshold, 200K model → threshold 0.8, 85% > 80% → should trigger
  const threshold = getThreshold(node.usage!.tokenSize, DEFAULT_CONFIG);
  assert(shouldTrigger(node, threshold, triggered), "200K model at 85% triggers with dynamic threshold 0.8");
}

function testShouldTriggerDynamic1MAt40() {
  console.log("\n▸ shouldTrigger dynamic: 1M model 40% → no trigger (<50%)");
  const triggered = new Map<string, string>();
  const node: NodeInfo = {
    name: "agent-1m-low",
    status: "idle",
    transport: "stdio",
    usage: { tokenUsed: 400_000, tokenSize: 1_000_000 },
    sessionId: "sess-1m-low",
    channels: ["ch-1"],
  };
  // With dynamic threshold, 1M model → threshold 0.5, 40% < 50% → should NOT trigger
  const threshold = getThreshold(node.usage!.tokenSize, DEFAULT_CONFIG);
  assert(!shouldTrigger(node, threshold, triggered), "1M model at 40% does not trigger with dynamic threshold 0.5");
}

// ============================================================
// INTEGRATION TESTS — with real server
// ============================================================

function httpPost(path: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request({
      hostname: "localhost",
      port: TEST_PORT,
      path,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch { reject(new Error(`invalid json: ${d}`)); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

class WsClient {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private notifications: Array<{ method: string; params: any }> = [];

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
            this.notifications.push({ method: msg.method, params: msg.params });
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

  getNotifications(method?: string): Array<{ method: string; params: any }> {
    if (method) return this.notifications.filter(n => n.method === method);
    return this.notifications;
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

async function testGuardianRegistersAsNode() {
  console.log("\n▸ Guardian: registers as node via WS");
  const c = new WsClient();
  await c.connect();

  // Guardian registers as observer node
  const reg = await c.request("node.register", {
    name: "context-guardian",
    capabilities: ["monitor"],
    permissions: "observer",
  });
  assert(!!reg.nodeId, "guardian registers successfully");
  assertEq(reg.name, "context-guardian", "guardian has correct name");

  // Verify in node list
  const list = await c.request("node.list");
  const guardian = list.nodes?.find((n: any) => n.name === "context-guardian");
  assert(!!guardian, "guardian appears in node list");
  assertEq(guardian.permissions, "observer", "guardian has observer permissions");

  await c.disconnect();
}

async function testGuardianPollsNodeList() {
  console.log("\n▸ Guardian: can poll node.list and see agent usage");

  const c = new WsClient();
  await c.connect();
  await c.request("node.register", { name: "guardian-poll-test", capabilities: ["ui"] });

  // Spawn mock agent
  const agent = await c.request("node.spawn", { adapter: "mock", name: "poll-agent", cwd: ROOT });
  await sleep(3000);

  // Get node list (guardian would do this)
  const list = await c.request("node.list");
  const agentNode = list.nodes?.find((n: any) => n.name === "poll-agent");
  assert(!!agentNode, "agent visible in node list");
  assertEq(agentNode.transport, "stdio", "agent is stdio transport");
  assertEq(agentNode.status, "idle", "agent is idle");
  // Usage is undefined/null for mock (no real ACP usage_update), that's OK
  // Guardian checks for node.usage before acting, so undefined is fine
  assert(agentNode.usage === undefined || agentNode.usage === null || typeof agentNode.usage === "object",
    "usage field is absent or an object (mock has no usage)");

  await c.request("node.stop", { nodeId: agent.nodeId });
  await sleep(500);
  await c.disconnect();
}

async function testGuardianPostsToChannel() {
  console.log("\n▸ Guardian: can post to channel via channel.post");

  const c = new WsClient();
  await c.connect();
  await c.request("node.register", { name: "guardian-post-test", capabilities: ["monitor"], permissions: "observer" });

  // Create channel and join
  const ch = await c.request("channel.create", { cwd: ROOT, name: "guardian-ch" });
  await c.request("channel.join", { channelId: ch.channelId });

  // Post a message (like guardian would)
  const post = await c.request("channel.post", {
    channelId: ch.channelId,
    content: "@some-agent 上下文已用 55%，请执行上下文交接",
  });
  assert(!!post.message, "guardian can post to channel");
  assert(post.message.content.includes("55%"), "message contains usage percentage");

  // Verify in history
  const hist = await c.request("channel.history", { channelId: ch.channelId });
  assert(hist.messages?.length >= 1, "message appears in history");

  await c.disconnect();
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  Context Guardian Tests");
  console.log("═══════════════════════════════════════");

  // Unit tests (no server needed)
  testShouldTriggerAboveThreshold();
  testShouldTriggerBelowThreshold();
  testShouldTriggerBusy();
  testShouldTriggerSameSessionDedup();
  testShouldTriggerNewSession();
  testShouldTriggerMultipleAgents();
  testShouldTriggerNoUsage();
  testShouldTriggerWebsocketNode();

  // Dynamic threshold tests (Task 1 — getThreshold)
  testGetThresholdLargeModel();
  testGetThresholdSmallModel();
  testGetThresholdUniformOverride();
  testGetThresholdAtBoundary();
  testShouldTriggerDynamic1MLargeAt60();
  testShouldTriggerDynamic200KAt60();
  testShouldTriggerDynamic200KAt85();
  testShouldTriggerDynamic1MAt40();

  // Integration tests (need server)
  try {
    console.log("\nStarting server for integration tests...");
    await startServer();
    console.log("Server ready.\n");

    await testGuardianRegistersAsNode();
    await testGuardianPollsNodeList();
    await testGuardianPostsToChannel();

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

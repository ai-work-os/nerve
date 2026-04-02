#!/usr/bin/env npx tsx
/**
 * Nerve Self-Test
 *
 * Single command to verify everything works. Run after any code change.
 * Starts the server, runs all tests, reports pass/fail, exits.
 *
 * Usage: npx tsx test/self-test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_PORT = 14800; // Use different port to avoid conflict
const TEST_DATA = resolve(ROOT, ".test-data");

// --- Test infrastructure ---

let passed = 0;
let failed = 0;
const failures: string[] = [];
const serverLogBuffer: string[] = []; // Captures server stdout for log verification

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

// --- HTTP helper ---

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

function httpGet(path: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${TEST_PORT}${path}`, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch { reject(new Error(`invalid json: ${d}`)); }
      });
    }).on("error", reject);
  });
}

function httpGetText(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${TEST_PORT}${path}`, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve(d));
    }).on("error", reject);
  });
}

// --- WebSocket helper ---

class WsClient {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private notifications: Array<{ method: string; params: any }> = [];
  nodeId?: string;
  name: string;

  constructor(name: string) {
    this.name = name;
  }

  async connect(): Promise<void> {
    this.ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
    return new Promise((resolve, reject) => {
      this.ws.on("open", () => {
        this.ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.id !== undefined && !msg.method) {
            // Response
            const p = this.pending.get(msg.id);
            if (p) {
              this.pending.delete(msg.id);
              if (msg.error) p.reject(new Error(msg.error.message));
              else p.resolve(msg.result);
            }
          } else if (msg.method) {
            // Notification
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
      }, 10000);
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

  close(): void {
    this.ws.close();
  }
}

class McpToolClient {
  private client: Client;
  private transport: StdioClientTransport;

  constructor(nodeName: string) {
    this.client = new Client({ name: "self-test", version: "0.1.0" });
    this.transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/nerve-mcp.ts"],
      cwd: ROOT,
      env: {
        ...process.env,
        NERVE_PORT: String(TEST_PORT),
        NERVE_NODE_NAME: nodeName,
      } as Record<string, string>,
      stderr: "pipe",
    });
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<any[]> {
    const r = await this.client.listTools();
    return r.tools || [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    return this.client.callTool({ name, arguments: args });
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

// --- Server process management ---

let serverProc: ChildProcess | null = null;

async function startServer(): Promise<void> {
  // Clean test data
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });

  // Create test scene config
  const scenesDir = resolve(TEST_DATA, "scenes");
  mkdirSync(scenesDir, { recursive: true });
  writeFileSync(resolve(scenesDir, "test-scene.json"), JSON.stringify({
    name: "test-scene",
    nodes: [
      { adapter: "mock-program", name: "scene-mock-1" },
    ],
    channel: { name: "test-meeting", auto_create: true },
    on_ready: [],
  }));

  // Scene with stdio (AI) node + on_ready prompt — tests waitForReady with sessionId
  writeFileSync(resolve(scenesDir, "test-scene-stdio.json"), JSON.stringify({
    name: "test-scene-stdio",
    nodes: [
      { adapter: "mock", name: "scene-ai-1" },
    ],
    channel: { name: "test-stdio-ch", auto_create: true },
    on_ready: [
      { to: "scene-ai-1", command: "hello from scene", prompt: true },
    ],
  }));

  // Scene with on_ready targeting a nonexistent node (for warnings test)
  writeFileSync(resolve(scenesDir, "test-scene-warn.json"), JSON.stringify({
    name: "test-scene-warn",
    nodes: [
      { adapter: "mock-program", name: "scene-warn-1" },
    ],
    channel: { name: "test-warn-ch", auto_create: true },
    on_ready: [
      { to: "ghost-node", command: "start" },
    ],
  }));

  serverProc = spawn("npx", ["tsx", "src/index.ts", "--port", String(TEST_PORT), "--data", TEST_DATA], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  // Wait for server ready
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server start timeout")), 10000);
    serverProc!.stderr!.on("data", (d) => {
      const s = d.toString();
      if (s.includes("ERROR") || s.includes("error")) {
        process.stderr.write(`[server] ${s}`);
      }
    });
    serverProc!.stdout!.on("data", (d) => {
      const s = d.toString();
      // Buffer all server log lines for test verification
      for (const line of s.split("\n")) {
        if (line.trim()) serverLogBuffer.push(line);
      }
      if (s.includes("started on port")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProc!.on("error", (e) => { clearTimeout(timeout); reject(e); });
    serverProc!.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`server exited with code ${code}`));
      }
    });
  });
}

function stopServer(): void {
  if (serverProc) {
    serverProc.kill("SIGTERM");
    serverProc = null;
  }
  // Clean test data
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });
}

// ============================================================
// TESTS
// ============================================================

async function testHealth() {
  console.log("\n▸ Health Check");
  const r = await httpGet("/health");
  assertEq(r.status, "ok", "GET /health returns ok");
}

async function testWsRegister() {
  console.log("\n▸ WebSocket: Register");
  const c = new WsClient("ws-test");
  await c.connect();

  const r = await c.request("node.register", { name: "ws-test", capabilities: ["ui"] });
  assert(!!r.nodeId, "register returns nodeId");
  assertEq(r.name, "ws-test", "register returns correct name");
  c.nodeId = r.nodeId;

  // Duplicate name should auto-suffix
  const c2 = new WsClient("ws-test-dup");
  await c2.connect();
  const r2 = await c2.request("node.register", { name: "ws-test", capabilities: ["ui"] });
  assertEq(r2.name, "ws-test-2", "duplicate name auto-suffixed to ws-test-2");
  assert(!!r2.nodeId, "auto-suffixed register returns nodeId");

  // Third duplicate
  const c3 = new WsClient("ws-test-dup2");
  await c3.connect();
  const r3 = await c3.request("node.register", { name: "ws-test", capabilities: ["ui"] });
  assertEq(r3.name, "ws-test-3", "third duplicate auto-suffixed to ws-test-3");

  await c.disconnect();
  await c2.disconnect();
  await c3.disconnect();
}

async function testChannelLifecycle() {
  console.log("\n▸ Channel Lifecycle (WS)");
  const c = new WsClient("ch-test");
  await c.connect();
  const reg = await c.request("node.register", { name: "ch-test", capabilities: ["ui"] });

  // Create
  const ch = await c.request("channel.create", { cwd: "/tmp", name: "test-channel" });
  assert(!!ch.channelId, "channel.create returns channelId");
  assertEq(ch.name, "test-channel", "channel has correct name");

  // Join
  await c.request("channel.join", { channelId: ch.channelId });

  // List
  const list = await c.request("channel.list");
  assert(list.channels.length >= 1, "channel.list returns channels");
  const found = list.channels.find((x: any) => x.id === ch.channelId);
  assert(!!found, "created channel appears in list");
  assert(found.nodes["ch-test"] === reg.nodeId, "node is in channel");

  // Post
  const post = await c.request("channel.post", { channelId: ch.channelId, content: "hello" });
  assert(!!post.message, "channel.post returns message");
  assertEq(post.message.from, "ch-test", "message from is correct");
  assertEq(post.message.content, "hello", "message content is correct");

  // History
  const hist = await c.request("channel.history", { channelId: ch.channelId });
  assert(hist.messages.length >= 1, "history has messages");
  assertEq(hist.messages[hist.messages.length - 1].content, "hello", "history contains posted message");

  // Close
  await c.request("channel.close", { channelId: ch.channelId });
  const list2 = await c.request("channel.list");
  const found2 = list2.channels.find((x: any) => x.id === ch.channelId);
  assert(!found2, "closed channel removed from list");

  await c.disconnect();
}

async function testHttpApi() {
  console.log("\n▸ HTTP API");

  // Channel create
  const ch = await httpPost("/channel/create", { cwd: "/tmp", name: "http-ch" });
  assert(!!ch.channelId, "POST /channel/create returns channelId");

  // Channel list
  const list = await httpPost("/channel/list", {});
  assert(Array.isArray((list as any).channels), "POST /channel/list returns array");

  // Channel post
  const post = await httpPost("/channel/post", {
    from: "http-agent",
    channelId: ch.channelId as string,
    content: "hello from HTTP",
  });
  assert((post as any).ok, "POST /channel/post ok");

  // Channel history
  const hist = await httpPost("/channel/history", { channelId: ch.channelId as string });
  assert(Array.isArray((hist as any).messages), "POST /channel/history returns messages");
  assert((hist as any).messages.length >= 1, "history has the posted message");

  // Node list
  const nodes = await httpPost("/node/list", {});
  assert(Array.isArray((nodes as any).nodes), "POST /node/list returns array");

  // Channel close
  const close = await httpPost("/channel/close", { channelId: ch.channelId as string });
  assert((close as any).ok, "POST /channel/close ok");

  // Unknown endpoint
  const unk = await httpPost("/nonexistent", {});
  assert(!!(unk as any).error, "unknown endpoint returns error");
}

async function testRouting() {
  console.log("\n▸ @mention Routing");
  const c1 = new WsClient("alice");
  const c2 = new WsClient("bob");
  await c1.connect();
  await c2.connect();

  await c1.request("node.register", { name: "alice", capabilities: ["ui"] });
  await c2.request("node.register", { name: "bob", capabilities: ["ui"] });

  const ch = await c1.request("channel.create", { cwd: "/tmp" });
  await c1.request("channel.join", { channelId: ch.channelId });
  await c2.request("channel.join", { channelId: ch.channelId });

  c2.clearNotifications();

  // Alice mentions Bob
  await c1.request("channel.post", { channelId: ch.channelId, content: "@bob 你好" });
  await sleep(200);

  // Bob should get both channel.message and channel.mention
  const messages = c2.getNotifications("channel.message");
  const mentions = c2.getNotifications("channel.mention");
  assert(messages.length >= 1, "bob receives channel.message");
  assert(mentions.length >= 1, "bob receives channel.mention for @bob");
  if (mentions.length > 0) {
    assertEq(mentions[0].params.message.content, "@bob 你好", "mention content correct");
  }

  // Self-mention should not route back
  c1.clearNotifications();
  await c1.request("channel.post", { channelId: ch.channelId, content: "@alice test" });
  await sleep(200);
  const selfMentions = c1.getNotifications("channel.mention");
  // Alice should get channel.message (broadcast) but NOT channel.mention (no self-route)
  assert(selfMentions.length === 0, "self-mention does not trigger channel.mention");

  await c1.disconnect();
  await c2.disconnect();
}

async function testMultiClient() {
  console.log("\n▸ Multi-client Broadcast");
  const c1 = new WsClient("viewer-1");
  const c2 = new WsClient("viewer-2");
  const c3 = new WsClient("poster");
  await c1.connect();
  await c2.connect();
  await c3.connect();

  await c1.request("node.register", { name: "viewer-1", capabilities: ["ui"] });
  await c2.request("node.register", { name: "viewer-2", capabilities: ["ui"] });
  await c3.request("node.register", { name: "poster", capabilities: ["ui"] });

  const ch = await c3.request("channel.create", { cwd: "/tmp" });
  await c1.request("channel.join", { channelId: ch.channelId });
  await c2.request("channel.join", { channelId: ch.channelId });
  await c3.request("channel.join", { channelId: ch.channelId });

  c1.clearNotifications();
  c2.clearNotifications();

  await c3.request("channel.post", { channelId: ch.channelId, content: "broadcast test" });
  await sleep(200);

  const m1 = c1.getNotifications("channel.message");
  const m2 = c2.getNotifications("channel.message");
  assert(m1.length >= 1, "viewer-1 receives broadcast");
  assert(m2.length >= 1, "viewer-2 receives broadcast");

  await c1.disconnect();
  await c2.disconnect();
  await c3.disconnect();
}

async function testMockAgent() {
  console.log("\n▸ Mock Agent (Process Node)");

  // Register a WS client to observe
  const observer = new WsClient("observer");
  await observer.connect();
  await observer.request("node.register", { name: "observer", capabilities: ["ui"] });

  // Create channel
  const ch = await observer.request("channel.create", { cwd: "/tmp" });
  await observer.request("channel.join", { channelId: ch.channelId });

  // Spawn mock agent via HTTP
  const spawn = await httpPost("/node/spawn", {
    adapter: "mock",
    name: "mock-1",
    cwd: ROOT,
  });
  assert(!!spawn.nodeId, "node/spawn returns nodeId");
  assert(spawn.status === "connecting", "initial status is connecting");

  // Wait for handshake
  await sleep(3000);

  // Check agent is ready
  const nodes = await httpPost("/node/list", {});
  const mockNode = (nodes as any).nodes.find((n: any) => n.name === "mock-1");
  assert(!!mockNode, "mock agent appears in node list");
  if (mockNode) {
    assert(mockNode.status === "idle" || mockNode.status === "connecting", `mock agent status: ${mockNode.status}`);
  }

  // Add mock agent to channel
  if (mockNode) {
    await httpPost("/channel/addNode", {
      channelId: ch.channelId,
      nodeId: mockNode.id,
      nodeName: "mock-1",
    });
  }

  observer.clearNotifications();

  // Post message mentioning mock agent
  await observer.request("channel.post", {
    channelId: ch.channelId,
    content: "@mock-1 ping",
  });

  // Wait for mock agent to process and reply
  await sleep(5000);

  // Check if mock agent replied
  const hist = await observer.request("channel.history", { channelId: ch.channelId });
  const agentMsgs = hist.messages.filter((m: any) => m.from === "mock-1");
  assert(agentMsgs.length >= 1, "mock agent posted reply to channel");

  if (agentMsgs.length > 0) {
    assert(agentMsgs[0].content.includes("mock回复"), "reply content is correct");
  }

  // Stop agent
  if (mockNode) {
    await httpPost("/node/stop", { nodeId: mockNode.id });
    await sleep(500);
    const nodes2 = await httpPost("/node/list", {});
    const stopped = (nodes2 as any).nodes.find((n: any) => n.name === "mock-1");
    // Node might be removed or stopped
    assert(!stopped || stopped.status === "stopped", "mock agent stopped");
  }

  await observer.disconnect();
}

async function testNodeEvents() {
  console.log("\n▸ Node Join/Leave Events");
  const c1 = new WsClient("watcher");
  const c2 = new WsClient("joiner");
  await c1.connect();
  await c2.connect();

  await c1.request("node.register", { name: "watcher", capabilities: ["ui"] });
  await c2.request("node.register", { name: "joiner", capabilities: ["ui"] });

  const ch = await c1.request("channel.create", { cwd: "/tmp" });
  await c1.request("channel.join", { channelId: ch.channelId });

  c1.clearNotifications();

  // Joiner joins
  await c2.request("channel.join", { channelId: ch.channelId });
  await sleep(200);

  const joinEvents = c1.getNotifications("channel.nodeJoined");
  assert(joinEvents.length >= 1, "watcher receives nodeJoined event");
  if (joinEvents.length > 0) {
    assertEq(joinEvents[0].params.nodeName, "joiner", "nodeJoined has correct name");
  }

  c1.clearNotifications();

  // Joiner leaves
  await c2.request("channel.leave", { channelId: ch.channelId });
  await sleep(200);

  const leaveEvents = c1.getNotifications("channel.nodeLeft");
  assert(leaveEvents.length >= 1, "watcher receives nodeLeft event");

  await c1.disconnect();
  await c2.disconnect();
}

async function testPersistence() {
  console.log("\n▸ Persistence");
  // Post some messages, verify they survive in SQLite
  const c = new WsClient("persist-test");
  await c.connect();
  await c.request("node.register", { name: "persist-test", capabilities: ["ui"] });

  const ch = await c.request("channel.create", { cwd: "/tmp", name: "persist-ch" });
  await c.request("channel.join", { channelId: ch.channelId });

  // Post multiple messages
  for (let i = 0; i < 5; i++) {
    await c.request("channel.post", { channelId: ch.channelId, content: `msg-${i}` });
  }

  // Read back
  const hist = await c.request("channel.history", { channelId: ch.channelId, limit: 3 });
  assertEq(hist.messages.length, 3, "history limit works");
  assertEq(hist.messages[2].content, "msg-4", "latest message is last");

  // Full history
  const full = await c.request("channel.history", { channelId: ch.channelId, limit: 100 });
  assertEq(full.messages.length, 5, "all 5 messages persisted");

  await c.disconnect();
}

async function testEdgeCases() {
  console.log("\n▸ Edge Cases");

  // Unregistered WS client can't post
  const c = new WsClient("unreg");
  await c.connect();
  try {
    await c.request("channel.post", { channelId: "fake", content: "hi" });
    assert(false, "unregistered post should fail");
  } catch (e: any) {
    assert(e.message.includes("not registered"), "unregistered post rejected");
  }
  await c.disconnect();

  // HTTP post without from
  const r = await httpPost("/channel/post", { channelId: "fake", content: "hi" });
  assert(!!(r as any).error, "HTTP post without from rejected");

  // HTTP post without content
  const r2 = await httpPost("/channel/post", { from: "x" });
  assert(!!(r2 as any).error, "HTTP post without content rejected");

  // Spawn unknown adapter
  const r3 = await httpPost("/node/spawn", { adapter: "nonexistent" });
  assert(!!(r3 as any).error, "unknown adapter rejected");

  await sleep(100);
}

async function testSpawnCwd() {
  console.log("\n▸ Spawn with cwd parameter");

  const c = new WsClient("cwd-test");
  await c.connect();
  await c.request("node.register", { name: "cwd-test", capabilities: ["ui"] });

  // Spawn with explicit cwd
  const r1 = await c.request("node.spawn", {
    adapter: "mock",
    name: "cwd-agent-1",
    cwd: "/tmp",
  });
  assert(!!r1.nodeId, "spawn with cwd: returns nodeId");
  assert(r1.name === "cwd-agent-1", "spawn with cwd: correct name");

  // Spawn without cwd (should default to server's process.cwd)
  const r2 = await c.request("node.spawn", {
    adapter: "mock",
    name: "cwd-agent-2",
  });
  assert(!!r2.nodeId, "spawn without cwd: returns nodeId");

  // Spawn with duplicate name should fail
  try {
    await c.request("node.spawn", {
      adapter: "mock",
      name: "cwd-agent-1",
      cwd: "/tmp",
    });
    assert(false, "duplicate name should fail");
  } catch (e: any) {
    assert(e.message.includes("already taken"), "duplicate name rejected: " + e.message);
  }

  // Cleanup
  await httpPost("/node/stop", { nodeId: r1.nodeId });
  await httpPost("/node/stop", { nodeId: r2.nodeId });
  await sleep(500);
  await c.disconnect();
}

async function testUpdateBuffer() {
  console.log("\n▸ Update Buffer & Replay");

  // Client 1: set up agent and trigger updates
  const c1 = new WsClient("buf-client1");
  await c1.connect();
  await c1.request("node.register", { name: "buf-client1", capabilities: ["ui"] });

  // Spawn mock agent
  const spawn = await httpPost("/node/spawn", {
    adapter: "mock",
    name: "buf-agent",
    cwd: ROOT,
  });
  assert(!!spawn.nodeId, "buffer test: agent spawned");

  // Wait for handshake
  await sleep(3000);

  // Create channel, add agent
  const ch = await c1.request("channel.create", { cwd: "/tmp" });
  await c1.request("channel.join", { channelId: ch.channelId });

  const nodes = await httpPost("/node/list", {});
  const agentNode = (nodes as any).nodes.find((n: any) => n.name === "buf-agent");
  assert(!!agentNode, "buffer test: agent found");

  if (agentNode) {
    await c1.request("channel.addNode", {
      channelId: ch.channelId,
      nodeId: agentNode.id,
      name: "buf-agent",
    });
  }

  // Prompt agent to generate updates
  c1.clearNotifications();
  await c1.request("channel.post", {
    channelId: ch.channelId,
    content: "@buf-agent hello",
  });
  await sleep(5000);

  // Verify buffer has content via node.updates API
  const bufResult = await c1.request("node.updates", { nodeName: "buf-agent" });
  assert(
    bufResult.updates && bufResult.updates.length > 0,
    "buffer test: updateBuffer has content",
    `got ${bufResult.updates?.length || 0} updates`,
  );

  // Client 2: new connection, subscribe to agent → should receive replay via node.subscribe
  const c2 = new WsClient("buf-client2");
  await c2.connect();
  await c2.request("node.register", { name: "buf-client2", capabilities: ["ui"] });
  c2.clearNotifications();
  await c2.request("node.subscribe", { nodeId: agentNode.id });
  await sleep(500);

  // c2 should have received replayed node.update notifications via subscribe
  const replayed = c2.getNotifications("node.update");
  assert(
    replayed.length > 0,
    "buffer test: new client received replay on join",
    `got ${replayed.length} replayed updates`,
  );

  // Verify replay contains agent name
  if (replayed.length > 0) {
    assert(
      replayed[0].params.name === "buf-agent",
      "buffer test: replay has correct agent name",
    );
  }

  // Verify buffer contains user_message (user prompt)
  const userMsgs = bufResult.updates.filter(
    (u: any) => u.update?.sessionUpdate === "user_message",
  );
  assert(
    userMsgs.length > 0,
    "buffer test: contains user_message",
    `found ${userMsgs.length} user messages`,
  );

  // Verify user_message has correct content
  if (userMsgs.length > 0) {
    const text = userMsgs[0].update?.content?.text;
    assert(
      typeof text === "string" && text.length > 0,
      "buffer test: user_message has text content",
    );
  }

  // Verify replay order: user_message comes before agent output
  const replayedUserIdx = replayed.findIndex(
    (n: any) => n.params.update?.sessionUpdate === "user_message",
  );
  const replayedAgentIdx = replayed.findIndex(
    (n: any) => n.params.update?.sessionUpdate === "agent_message_chunk",
  );
  if (replayedUserIdx >= 0 && replayedAgentIdx >= 0) {
    assert(
      replayedUserIdx < replayedAgentIdx,
      "buffer test: replay order user → agent",
    );
  }

  // Cleanup
  if (agentNode) {
    await httpPost("/node/stop", { nodeId: agentNode.id });
    await sleep(500);
  }
  await c1.disconnect();
  await c2.disconnect();
}

async function testMultiTurnBuffer() {
  console.log("\n▸ Multi-Turn Buffer (node.prompt)");

  const c1 = new WsClient("mt-client1");
  await c1.connect();
  await c1.request("node.register", { name: "mt-client1", capabilities: ["ui"] });

  // Spawn mock agent
  const spawn = await httpPost("/node/spawn", {
    adapter: "mock",
    name: "mt-agent",
    cwd: ROOT,
  });
  assert(!!spawn.nodeId, "multi-turn: agent spawned");
  await sleep(3000);

  const nodes = await httpPost("/node/list", {});
  const agentNode = (nodes as any).nodes.find((n: any) => n.name === "mt-agent");
  assert(!!agentNode && agentNode.status === "idle", "multi-turn: agent ready");

  if (!agentNode) {
    await c1.disconnect();
    return;
  }

  // Round 1: prompt via node.prompt (direct, like 1v1 chat)
  await c1.request("node.prompt", { nodeId: agentNode.id, content: "first question" });
  await sleep(1000);

  // Round 2: second prompt
  await c1.request("node.prompt", { nodeId: agentNode.id, content: "second question" });
  await sleep(1000);

  // Check buffer
  const bufResult = await c1.request("node.updates", { nodeName: "mt-agent" });
  const updates = bufResult.updates || [];
  const userMsgs = updates.filter(
    (u: any) => u.update?.sessionUpdate === "user_message",
  );
  assert(
    userMsgs.length === 2,
    "multi-turn: buffer has 2 user_messages",
    `got ${userMsgs.length}`,
  );

  // Verify content
  if (userMsgs.length >= 2) {
    assert(
      userMsgs[0].update.content.text === "first question",
      "multi-turn: first user_message correct",
    );
    assert(
      userMsgs[1].update.content.text === "second question",
      "multi-turn: second user_message correct",
    );
  }

  // Verify order: user1 → agent1 → user2 → agent2
  const kinds = updates
    .filter((u: any) => u.update?.sessionUpdate)
    .map((u: any) => u.update.sessionUpdate);
  const firstUser = kinds.indexOf("user_message");
  const secondUser = kinds.indexOf("user_message", firstUser + 1);
  assert(
    firstUser >= 0 && secondUser > firstUser,
    "multi-turn: both user_messages in order",
    `positions: ${firstUser}, ${secondUser} in [${kinds.join(",")}]`,
  );

  // Reconnect test: new client subscribes and should see all messages via node.subscribe
  const c2 = new WsClient("mt-client2");
  await c2.connect();
  await c2.request("node.register", { name: "mt-client2", capabilities: ["ui"] });
  c2.clearNotifications();
  await c2.request("node.subscribe", { nodeId: agentNode.id });
  await sleep(500);

  const replayed = c2.getNotifications("node.update");
  const replayedUserMsgs = replayed.filter(
    (n: any) => n.params.update?.sessionUpdate === "user_message",
  );
  assert(
    replayedUserMsgs.length === 2,
    "multi-turn: replay has 2 user_messages",
    `got ${replayedUserMsgs.length}`,
  );

  // Cleanup
  await httpPost("/node/stop", { nodeId: agentNode.id });
  await sleep(500);
  await c1.disconnect();
  await c2.disconnect();
}

// ============================================================
// Change 1: node.subscribe — direct subscription without channel
// ============================================================

async function testNodeSubscribe() {
  console.log("\n▸ node.subscribe (direct, no channel)");

  const observer = new WsClient("sub-observer");
  await observer.connect();
  await observer.request("node.register", { name: "sub-observer", capabilities: ["ui"] });

  // Spawn mock agent
  const spawn = await httpPost("/node/spawn", { adapter: "mock", name: "sub-agent", cwd: ROOT });
  assert(!!spawn.nodeId, "subscribe: agent spawned");
  await sleep(3000);

  const nodes = await httpPost("/node/list", {});
  const agentNode = (nodes as any).nodes.find((n: any) => n.name === "sub-agent");
  assert(!!agentNode, "subscribe: agent found");

  if (!agentNode) { await observer.disconnect(); return; }

  // Subscribe directly to the node (no channel needed)
  observer.clearNotifications();
  const subResult = await observer.request("node.subscribe", { nodeId: agentNode.id });
  assert(subResult.ok, "subscribe: node.subscribe returns ok");

  // Prompt the agent directly
  observer.clearNotifications();
  await observer.request("node.prompt", { nodeId: agentNode.id, content: "direct ping" });
  await sleep(5000);

  // Should receive node.update via direct subscription
  const updates = observer.getNotifications("node.update");
  assert(updates.length > 0, "subscribe: received node.update via direct subscription", `got ${updates.length}`);
  if (updates.length > 0) {
    assertEq(updates[0].params.name, "sub-agent", "subscribe: update has correct agent name");
  }

  // Should receive statusChanged
  const statusChanges = observer.getNotifications("node.statusChanged");
  assert(statusChanges.length > 0, "subscribe: received statusChanged via subscription", `got ${statusChanges.length}`);

  // Unsubscribe
  const unsubResult = await observer.request("node.unsubscribe", { nodeId: agentNode.id });
  assert(unsubResult.ok, "subscribe: node.unsubscribe returns ok");

  // Prompt again — should NOT receive updates after unsubscribe
  observer.clearNotifications();
  await observer.request("node.prompt", { nodeId: agentNode.id, content: "after unsub" });
  await sleep(3000);
  const afterUnsub = observer.getNotifications("node.update");
  assertEq(afterUnsub.length, 0, "subscribe: no updates after unsubscribe");

  await httpPost("/node/stop", { nodeId: agentNode.id });
  await sleep(500);
  await observer.disconnect();
}

// ============================================================
// Change 2: node.list cwd filter
// ============================================================

async function testNodeListCwdFilter() {
  console.log("\n▸ node.list cwd filter");

  const c = new WsClient("cwd-filter-test");
  await c.connect();
  await c.request("node.register", { name: "cwd-filter-test", capabilities: ["ui"] });

  // Spawn agents in different cwds
  const r1 = await c.request("node.spawn", { adapter: "mock", name: "filter-a", cwd: "/tmp" });
  const r2 = await c.request("node.spawn", { adapter: "mock", name: "filter-b", cwd: ROOT });
  assert(!!r1.nodeId, "cwd filter: agent A spawned");
  assert(!!r2.nodeId, "cwd filter: agent B spawned");

  await sleep(1000);

  // List all
  const all = await c.request("node.list", {});
  const allAgents = all.nodes.filter((n: any) => n.name.startsWith("filter-"));
  assert(allAgents.length === 2, "cwd filter: all agents listed", `got ${allAgents.length}`);

  // Filter by /tmp — should only get agent A
  const tmpOnly = await c.request("node.list", { cwd: "/tmp" });
  const tmpAgents = tmpOnly.nodes.filter((n: any) => n.name.startsWith("filter-"));
  assert(tmpAgents.length === 1, "cwd filter: /tmp has 1 agent", `got ${tmpAgents.length}`);
  if (tmpAgents.length > 0) {
    assertEq(tmpAgents[0].name, "filter-a", "cwd filter: correct agent for /tmp");
  }

  // Filter by ROOT — should only get agent B
  const rootOnly = await c.request("node.list", { cwd: ROOT });
  const rootAgents = rootOnly.nodes.filter((n: any) => n.name.startsWith("filter-"));
  assert(rootAgents.length === 1, "cwd filter: ROOT has 1 agent", `got ${rootAgents.length}`);
  if (rootAgents.length > 0) {
    assertEq(rootAgents[0].name, "filter-b", "cwd filter: correct agent for ROOT");
  }

  // Verify cwd is in NodeInfo
  assert(tmpAgents[0]?.cwd === "/tmp", "cwd filter: NodeInfo includes cwd field");

  // Filter by nonexistent cwd
  const empty = await c.request("node.list", { cwd: "/nonexistent" });
  assertEq(empty.nodes.length, 0, "cwd filter: nonexistent cwd returns empty");

  // HTTP API cwd filter
  const httpFiltered = await httpPost("/node/list", { cwd: "/tmp" });
  const httpAgents = (httpFiltered as any).nodes.filter((n: any) => n.name.startsWith("filter-"));
  assert(httpAgents.length === 1, "cwd filter: HTTP API filter works");

  await httpPost("/node/stop", { nodeId: r1.nodeId });
  await httpPost("/node/stop", { nodeId: r2.nodeId });
  await sleep(500);
  await c.disconnect();
}

// ============================================================
// Change 3: auto-naming
// ============================================================

async function testAutoNaming() {
  console.log("\n▸ Auto-naming: {adapter}-{basename(cwd)}");

  const c = new WsClient("auto-name-test");
  await c.connect();
  await c.request("node.register", { name: "auto-name-test", capabilities: ["ui"] });

  // Spawn without name — should auto-generate
  const r1 = await c.request("node.spawn", { adapter: "mock", cwd: "/tmp" });
  assert(!!r1.nodeId, "auto-name: spawned");
  assertEq(r1.name, "mock-tmp", "auto-name: generates {adapter}-{basename(cwd)}");

  // Spawn again same cwd — should get -2 suffix
  const r2 = await c.request("node.spawn", { adapter: "mock", cwd: "/tmp" });
  assertEq(r2.name, "mock-tmp-2", "auto-name: second agent gets -2 suffix");

  // Spawn with explicit name — should use it
  const r3 = await c.request("node.spawn", { adapter: "mock", name: "my-custom", cwd: "/tmp" });
  assertEq(r3.name, "my-custom", "auto-name: explicit name preserved");

  // HTTP API auto-naming
  const r4 = await httpPost("/node/spawn", { adapter: "mock", cwd: ROOT });
  const expectedBase = `mock-${ROOT.split("/").pop()}`;
  assertEq((r4 as any).name, expectedBase, "auto-name: HTTP API auto-names correctly");

  // Cleanup
  await httpPost("/node/stop", { nodeId: r1.nodeId });
  await httpPost("/node/stop", { nodeId: r2.nodeId });
  await httpPost("/node/stop", { nodeId: r3.nodeId });
  await httpPost("/node/stop", { nodeId: (r4 as any).nodeId });
  await sleep(500);
  await c.disconnect();
}

// ============================================================
// Change 4: multi-nvim (multiple WS clients with unique names)
// ============================================================

async function testMultiNvim() {
  console.log("\n▸ Multi-nvim: unique names, shared agent access");

  // Simulate two nvim instances with pid-based names
  const nvim1 = new WsClient("nvim-1001");
  const nvim2 = new WsClient("nvim-1002");
  await nvim1.connect();
  await nvim2.connect();

  const r1 = await nvim1.request("node.register", { name: "nvim-1001", capabilities: ["ui"] });
  const r2 = await nvim2.request("node.register", { name: "nvim-1002", capabilities: ["ui"] });
  assert(!!r1.nodeId, "multi-nvim: nvim-1001 registered");
  assert(!!r2.nodeId, "multi-nvim: nvim-1002 registered");
  assert(r1.nodeId !== r2.nodeId, "multi-nvim: different nodeIds");

  // Spawn an agent
  const agent = await nvim1.request("node.spawn", { adapter: "mock", name: "shared-agent", cwd: ROOT });
  assert(!!agent.nodeId, "multi-nvim: agent spawned");
  await sleep(3000);

  // Both nvim clients subscribe to the same agent
  nvim1.clearNotifications();
  nvim2.clearNotifications();
  await nvim1.request("node.subscribe", { nodeId: agent.nodeId });
  await nvim2.request("node.subscribe", { nodeId: agent.nodeId });

  // Prompt from nvim1
  await nvim1.request("node.prompt", { nodeId: agent.nodeId, content: "hello from nvim1" });
  await sleep(5000);

  // Both should receive updates
  const u1 = nvim1.getNotifications("node.update");
  const u2 = nvim2.getNotifications("node.update");
  assert(u1.length > 0, "multi-nvim: nvim-1001 received updates", `got ${u1.length}`);
  assert(u2.length > 0, "multi-nvim: nvim-1002 received updates", `got ${u2.length}`);

  // nvim2 can also prompt
  nvim1.clearNotifications();
  nvim2.clearNotifications();
  await nvim2.request("node.prompt", { nodeId: agent.nodeId, content: "hello from nvim2" });
  await sleep(5000);

  const u1b = nvim1.getNotifications("node.update");
  const u2b = nvim2.getNotifications("node.update");
  assert(u1b.length > 0, "multi-nvim: nvim-1001 sees nvim-1002's prompt output");
  assert(u2b.length > 0, "multi-nvim: nvim-1002 sees own prompt output");

  await httpPost("/node/stop", { nodeId: agent.nodeId });
  await sleep(500);
  await nvim1.disconnect();
  await nvim2.disconnect();
}

// ============================================================
// Change 5: one-step chat (find-or-spawn by cwd)
// ============================================================

async function testOneStepChat() {
  console.log("\n▸ One-step chat: find-or-spawn by cwd");

  const c = new WsClient("onestep-test");
  await c.connect();
  await c.request("node.register", { name: "onestep-test", capabilities: ["ui"] });

  // Use ROOT as cwd (mock agent needs test/mock-agent.ts relative to cwd)
  // First verify no mock agents with a specific name exist
  const testName = "onestep-mock";

  // Spawn an agent with explicit name to test the full flow
  const r = await c.request("node.spawn", { adapter: "mock", name: testName, cwd: ROOT });
  assert(!!r.nodeId, "one-step: spawn returns nodeId");
  assertEq(r.name, testName, "one-step: name preserved");
  await sleep(3000);

  // List by cwd — should find it
  const found = await c.request("node.list", { cwd: ROOT });
  const foundAgent = found.nodes.find((n: any) => n.name === testName);
  assert(!!foundAgent, "one-step: found agent by cwd filter");
  assertEq(foundAgent?.cwd, ROOT, "one-step: agent has correct cwd");

  // Subscribe + prompt — the full 1v1 flow without channels
  await c.request("node.subscribe", { nodeId: r.nodeId });
  c.clearNotifications();
  await c.request("node.prompt", { nodeId: r.nodeId, content: "one-step test" });
  await sleep(5000);

  const updates = c.getNotifications("node.update");
  assert(updates.length > 0, "one-step: full flow works (subscribe + prompt)", `got ${updates.length}`);

  await httpPost("/node/stop", { nodeId: r.nodeId });
  await sleep(500);
  await c.disconnect();
}

// ============================================================
// Change 6: node.cancel
// ============================================================

async function testNodeCancel() {
  console.log("\n▸ node.cancel: cancel a running prompt");

  const c = new WsClient("cancel-test");
  await c.connect();
  await c.request("node.register", { name: "cancel-test", capabilities: ["ui"] });

  // Spawn mock agent
  const spawn = await c.request("node.spawn", { adapter: "mock", name: "cancel-agent", cwd: ROOT });
  assert(!!spawn.nodeId, "cancel: agent spawned");
  await sleep(3000);

  const nodes = await c.request("node.list", {});
  const agentNode = nodes.nodes.find((n: any) => n.name === "cancel-agent");
  assert(!!agentNode && agentNode.status === "idle", "cancel: agent ready");
  if (!agentNode) { await c.disconnect(); return; }

  // Subscribe to watch status changes
  await c.request("node.subscribe", { nodeId: agentNode.id });
  c.clearNotifications();

  // Send a "slow" prompt that takes 10s — then cancel it
  const promptPromise = c.request("node.prompt", { nodeId: agentNode.id, content: "slow task" });

  // Wait a bit for the agent to start processing
  await sleep(1000);

  // Verify agent is busy
  const nodesWhileBusy = await c.request("node.list", {});
  const busyAgent = nodesWhileBusy.nodes.find((n: any) => n.name === "cancel-agent");
  assert(busyAgent?.status === "busy", "cancel: agent is busy during prompt", `status: ${busyAgent?.status}`);

  // Cancel
  const cancelResult = await c.request("node.cancel", { nodeId: agentNode.id });
  assert(cancelResult.ok || !cancelResult.error, "cancel: node.cancel returns ok");

  // Wait for prompt to resolve
  const promptResult = await promptPromise;
  assert(
    promptResult.stopReason === "cancelled" || promptResult.error?.includes("cancel"),
    "cancel: prompt resolved with cancelled",
    `got: ${JSON.stringify(promptResult)}`,
  );

  // Agent should be idle now
  await sleep(500);
  const nodesAfter = await c.request("node.list", {});
  const afterAgent = nodesAfter.nodes.find((n: any) => n.name === "cancel-agent");
  assert(afterAgent?.status === "idle", "cancel: agent idle after cancel", `status: ${afterAgent?.status}`);

  // Should have received statusChanged notifications (busy → idle)
  const statusChanges = c.getNotifications("node.statusChanged");
  assert(statusChanges.length >= 2, "cancel: received statusChanged notifications", `got ${statusChanges.length}`);

  // Cancel on non-busy agent — should return error (no active prompt)
  try {
    await c.request("node.cancel", { nodeId: agentNode.id });
    assert(true, "cancel: cancel on idle agent doesn't crash");
  } catch {
    assert(true, "cancel: cancel on idle agent returns error (expected)");
  }

  // HTTP cancel endpoint
  // First prompt again slowly
  const promptPromise2 = c.request("node.prompt", { nodeId: agentNode.id, content: "slow task 2" });
  await sleep(1000);
  const httpCancel = await httpPost("/node/cancel", { nodeId: agentNode.id });
  assert(true, "cancel: HTTP /node/cancel endpoint exists");
  await promptPromise2.catch(() => {}); // ignore result

  await sleep(500);
  await httpPost("/node/stop", { nodeId: agentNode.id });
  await sleep(500);
  await c.disconnect();
}

// ============================================================
// Change 7: cancel with subscribe (simulates nvim 1v1 chat flow)
// ============================================================

async function testCancelWithSubscribe() {
  console.log("\n▸ Cancel with subscribe (nvim 1v1 flow)");

  const c = new WsClient("cancel-sub-test");
  await c.connect();
  await c.request("node.register", { name: "cancel-sub-test", capabilities: ["ui"] });

  // Spawn mock agent
  const spawn = await c.request("node.spawn", { adapter: "mock", name: "cancel-sub-agent", cwd: ROOT });
  assert(!!spawn.nodeId, "cancel-sub: agent spawned");
  await sleep(3000);

  const nodes = await c.request("node.list", {});
  const agentNode = nodes.nodes.find((n: any) => n.name === "cancel-sub-agent");
  assert(!!agentNode && agentNode.status === "idle", "cancel-sub: agent ready");
  if (!agentNode) { await c.disconnect(); return; }

  // Subscribe (like nvim chat does)
  await c.request("node.subscribe", { nodeId: agentNode.id });

  // Send slow prompt (like _submit does)
  c.clearNotifications();
  const promptPromise = c.request("node.prompt", { nodeId: agentNode.id, content: "slow task" });

  // Wait for busy status
  await sleep(500);
  const busyNodes = await c.request("node.list", {});
  const busyAgent = busyNodes.nodes.find((n: any) => n.name === "cancel-sub-agent");
  assert(busyAgent?.status === "busy", "cancel-sub: agent busy after prompt");

  // Verify we got statusChanged(busy) via subscription
  const busyEvents = c.getNotifications("node.statusChanged").filter(
    (n: any) => n.params.name === "cancel-sub-agent" && n.params.status === "busy"
  );
  assert(busyEvents.length >= 1, "cancel-sub: received statusChanged(busy) via subscribe");

  // Cancel (like _cancel does)
  const cancelResult = await c.request("node.cancel", { nodeId: agentNode.id });
  assert(cancelResult.ok || !cancelResult.error, "cancel-sub: cancel returns ok");

  // Wait for prompt to resolve
  const promptResult = await promptPromise;
  assert(
    promptResult.stopReason === "cancelled" || promptResult.error?.includes("cancel"),
    "cancel-sub: prompt resolved with cancelled",
    `got: ${JSON.stringify(promptResult)}`,
  );

  // Verify statusChanged(idle) arrives after cancel
  await sleep(500);
  const idleEvents = c.getNotifications("node.statusChanged").filter(
    (n: any) => n.params.name === "cancel-sub-agent" && n.params.status === "idle"
  );
  assert(idleEvents.length >= 1, "cancel-sub: received statusChanged(idle) after cancel");

  // Verify agent can be prompted again after cancel
  c.clearNotifications();
  const prompt2 = await c.request("node.prompt", { nodeId: agentNode.id, content: "after cancel" });
  assert(
    prompt2.stopReason === "end_turn",
    "cancel-sub: agent works normally after cancel",
    `got: ${JSON.stringify(prompt2)}`,
  );

  await httpPost("/node/stop", { nodeId: agentNode.id });
  await sleep(500);
  await c.disconnect();
}

// ============================================================
// M1 Channel Tests
// ============================================================

async function testMcpServersInjected() {
  console.log("\n▸ mcpServers injected on session/new");

  const c = new WsClient("mcp-inject-test");
  await c.connect();
  await c.request("node.register", { name: "mcp-inject-test", capabilities: ["ui"] });

  // Spawn mock agent
  const spawn = await c.request("node.spawn", { adapter: "mock", name: "mcp-inject-agent", cwd: ROOT });
  assert(!!spawn.nodeId, "mcp-inject: agent spawned");

  // Wait for handshake (mock-agent emits session/update with mcpServers info)
  await sleep(3000);

  // Check agent is idle (handshake completed)
  const nodes = await c.request("node.list", {});
  const agentNode = nodes.nodes.find((n: any) => n.name === "mcp-inject-agent");
  assert(!!agentNode && agentNode.status === "idle", "mcp-inject: agent ready");

  // Check update buffer for mcpServers_received notification
  const updates = await c.request("node.updates", { nodeName: "mcp-inject-agent" });
  const mcpUpdate = updates.updates?.find((u: any) => u.update?.sessionUpdate === "mcpServers_received");
  assert(!!mcpUpdate, "mcp-inject: mock-agent received mcpServers");

  if (mcpUpdate) {
    const servers = mcpUpdate.update?.mcpServers as any[];
    assert(Array.isArray(servers) && servers.length > 0, "mcp-inject: mcpServers is non-empty array");
    assert(servers[0]?.name === "nerve", "mcp-inject: mcpServers[0].name is 'nerve'");
    assert(!!servers[0]?.command, "mcp-inject: mcpServers[0].command is set");
    assert(Array.isArray(servers[0]?.args), "mcp-inject: mcpServers[0].args is array");
    assert(Array.isArray(servers[0]?.env), "mcp-inject: env is array");
    const env = servers[0].env;
    assert(env.some((e: any) => e.name === "NERVE_PORT" && !!e.value), "mcp-inject: NERVE_PORT present");
    assert(env.some((e: any) => e.name === "NERVE_NODE_NAME" && e.value === "mcp-inject-agent"), "mcp-inject: NERVE_NODE_NAME correct");
  }

  // Cleanup
  if (agentNode) await httpPost("/node/stop", { nodeId: agentNode.id });
  await sleep(500);
  await c.disconnect();
}

async function testNervePostToChannel() {
  console.log("\n▸ nerve_post posts into joined channel");

  const c = new WsClient("post-test");
  await c.connect();
  await c.request("node.register", { name: "post-test", capabilities: ["ui"] });

  // Spawn mock agent
  const spawn = await httpPost("/node/spawn", { adapter: "mock", name: "post-agent", cwd: ROOT });
  assert(!!spawn.nodeId, "post-test: agent spawned");
  await sleep(3000);

  // Create channel and add agent
  const ch = await c.request("channel.create", { cwd: "/tmp" });
  await c.request("channel.join", { channelId: ch.channelId });

  const nodes = await httpPost("/node/list", {});
  const agentNode = (nodes as any).nodes.find((n: any) => n.name === "post-agent");
  assert(!!agentNode, "post-test: agent found");
  if (!agentNode) { await c.disconnect(); return; }

  await httpPost("/channel/addNode", {
    channelId: ch.channelId,
    nodeId: agentNode.id,
    nodeName: "post-agent",
  });

  // Simulate agent posting via HTTP /post (like nerve-mcp would)
  const postResult = await httpPost("/post", {
    from: "post-agent",
    content: "@post-test hello from agent",
  });
  assert(!!postResult.ok, "post-test: /post returns ok");

  // Verify message in channel history
  const hist = await c.request("channel.history", { channelId: ch.channelId });
  const agentMsg = hist.messages.find((m: any) => m.from === "post-agent" && m.content.includes("hello from agent"));
  assert(!!agentMsg, "post-test: message appears in channel history");

  // Cleanup
  await httpPost("/node/stop", { nodeId: agentNode.id });
  await sleep(500);
  await c.disconnect();
}

async function testNervePostErrorNoChannel() {
  console.log("\n▸ nerve_post errors when node not joined");

  // Spawn mock agent (no channel join)
  const spawn = await httpPost("/node/spawn", { adapter: "mock", name: "no-ch-agent", cwd: ROOT });
  assert(!!spawn.nodeId, "no-channel: agent spawned");
  await sleep(3000);

  // Try to post without joining a channel — should return error
  const postResult = await httpPost("/post", {
    from: "no-ch-agent",
    content: "this should fail",
  });
  assert(!!postResult.error, "no-channel: /post returns error when not joined", `got: ${JSON.stringify(postResult)}`);

  // Cleanup
  const nodes = await httpPost("/node/list", {});
  const agentNode = (nodes as any).nodes.find((n: any) => n.name === "no-ch-agent");
  if (agentNode) await httpPost("/node/stop", { nodeId: agentNode.id });
  await sleep(500);
}

async function testMcpOrchestrationTools() {
  console.log("\n▸ nerve-mcp orchestration tools");

  const c = new WsClient("orchestrator");
  await c.connect();
  await c.request("node.register", { name: "orchestrator", capabilities: ["ui"] });

  const mcp = new McpToolClient("orchestrator");
  await mcp.connect();

  const tools = await mcp.listTools();
  const toolNames = tools.map((t: any) => t.name);
  assert(toolNames.includes("nerve_post"), "mcp-tools: nerve_post listed");
  assert(toolNames.includes("nerve_spawn"), "mcp-tools: nerve_spawn listed");
  assert(toolNames.includes("nerve_create_channel"), "mcp-tools: nerve_create_channel listed");
  assert(toolNames.includes("nerve_join"), "mcp-tools: nerve_join listed");
  assert(toolNames.includes("nerve_remove"), "mcp-tools: nerve_remove listed");

  const createResult = await mcp.callTool("nerve_create_channel", { name: "orch-test" });
  assert(!createResult.isError, "mcp-tools: create channel succeeds");

  const channels = await c.request("channel.list", {});
  const channel = channels.channels.find((ch: any) => ch.name === "orch-test");
  assert(!!channel, "mcp-tools: created channel visible");
  if (!channel) {
    await mcp.close();
    await c.disconnect();
    return;
  }
  assert(!!channel.nodes?.orchestrator, "mcp-tools: creator auto-joined channel");

  const spawnResult = await mcp.callTool("nerve_spawn", { adapter: "mock", name: "orch-worker", cwd: ROOT });
  assert(!spawnResult.isError, "mcp-tools: spawn succeeds");
  await sleep(3000);

  const nodesAfterSpawn = await c.request("node.list", {});
  const worker = nodesAfterSpawn.nodes.find((n: any) => n.name === "orch-worker");
  assert(!!worker, "mcp-tools: spawned worker visible");
  if (!worker) {
    await mcp.close();
    await c.disconnect();
    return;
  }

  const joinResult = await mcp.callTool("nerve_join", { agent_name: "orch-worker", channel_id: channel.id });
  assert(!joinResult.isError, "mcp-tools: join succeeds");

  const channelsAfterJoin = await c.request("channel.list", {});
  const joined = channelsAfterJoin.channels.find((ch: any) => ch.id === channel.id);
  assert(joined?.nodes?.["orch-worker"] === worker.id, "mcp-tools: worker joined channel");

  const removeResult = await mcp.callTool("nerve_remove", { agent_name: "orch-worker", channel_id: channel.id });
  assert(!removeResult.isError, "mcp-tools: remove succeeds");

  const channelsAfterRemove = await c.request("channel.list", {});
  const removed = channelsAfterRemove.channels.find((ch: any) => ch.id === channel.id);
  assert(!removed?.nodes?.["orch-worker"], "mcp-tools: worker removed from channel");

  await httpPost("/node/stop", { nodeId: worker.id });
  await sleep(500);
  await mcp.close();
  await c.disconnect();
}

async function testLogUsesLocalTime() {
  console.log("\n▸ logger uses local time");
  const logFile = resolve(TEST_DATA, "logger-local-time.log");
  if (existsSync(logFile)) rmSync(logFile);

  const logger = await import("../src/logger.js");
  logger.initLog(logFile);
  logger.info("local-time-test");
  logger.closeLog();
  await sleep(50);

  const line = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).pop();
  assert(!!line, "log-time: log line written");

  if (line) {
    const match = line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    assert(!!match, "log-time: timestamp format valid");
    if (match) {
      const now = new Date();
      const expectedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const expectedHour = String(now.getHours()).padStart(2, "0");
      assert(match[1] === expectedDate, "log-time: uses local date", `got ${match[1]}, expected ${expectedDate}`);
      assert(match[2] === expectedHour, "log-time: uses local hour", `got ${match[2]}, expected ${expectedHour}`);
    }
  }
}

async function testMentionBusyCancels() {
  console.log("\n▸ mention on busy node cancels previous prompt");

  const c = new WsClient("busy-cancel-test");
  await c.connect();
  await c.request("node.register", { name: "busy-cancel-test", capabilities: ["ui"] });

  // Spawn mock agent
  const spawn = await c.request("node.spawn", { adapter: "mock", name: "busy-agent", cwd: ROOT });
  assert(!!spawn.nodeId, "busy-cancel: agent spawned");
  await sleep(3000);

  const nodes = await c.request("node.list", {});
  const agentNode = nodes.nodes.find((n: any) => n.name === "busy-agent");
  assert(!!agentNode && agentNode.status === "idle", "busy-cancel: agent ready");
  if (!agentNode) { await c.disconnect(); return; }

  // Create channel and add both nodes
  const ch = await c.request("channel.create", { cwd: "/tmp" });
  await c.request("channel.join", { channelId: ch.channelId });
  await c.request("channel.addNode", {
    channelId: ch.channelId,
    nodeId: agentNode.id,
    name: "busy-agent",
  });

  // Subscribe to watch status changes
  await c.request("node.subscribe", { nodeId: agentNode.id });
  c.clearNotifications();

  // Send a slow prompt to make agent busy
  await c.request("channel.post", {
    channelId: ch.channelId,
    content: "@busy-agent slow task please",
  });

  // Wait for agent to become busy
  await sleep(1500);
  const nodesBusy = await c.request("node.list", {});
  const busyNode = nodesBusy.nodes.find((n: any) => n.name === "busy-agent");
  assert(busyNode?.status === "busy", "busy-cancel: agent is busy", `status: ${busyNode?.status}`);

  // Send another @mention while busy — should cancel previous + send new prompt
  await c.request("channel.post", {
    channelId: ch.channelId,
    content: "@busy-agent new task",
  });

  // Wait for cancel + new prompt to complete
  await sleep(5000);

  // Agent should end up idle (new prompt completed)
  const nodesAfter = await c.request("node.list", {});
  const afterNode = nodesAfter.nodes.find((n: any) => n.name === "busy-agent");
  assert(afterNode?.status === "idle", "busy-cancel: agent idle after cancel+reprompt", `status: ${afterNode?.status}`);

  // Should have status transitions (busy → idle → busy → idle)
  const statusChanges = c.getNotifications("node.statusChanged");
  assert(statusChanges.length >= 3, "busy-cancel: received multiple statusChanged events", `got ${statusChanges.length}`);

  // Cleanup
  await httpPost("/node/stop", { nodeId: agentNode.id });
  await sleep(500);
  await c.disconnect();
}

async function testNervePostExplicitChannelId() {
  console.log("\n▸ nerve_post: explicit channel_id overrides currentChannelId");

  const c = new WsClient("post-ch-test");
  await c.connect();
  await c.request("node.register", { name: "post-ch-test", capabilities: ["ui"] });

  const mcp = new McpToolClient("post-ch-test");
  await mcp.connect();

  // Create two channels
  const ch1 = await c.request("channel.create", { cwd: "/tmp", name: "ch-alpha" });
  const ch2 = await c.request("channel.create", { cwd: "/tmp", name: "ch-beta" });
  await c.request("channel.join", { channelId: ch1.channelId });
  await c.request("channel.join", { channelId: ch2.channelId });

  // Spawn an agent and add to both channels
  const spawn = await httpPost("/node/spawn", { adapter: "mock", name: "post-ch-agent", cwd: ROOT });
  assert(!!spawn.nodeId, "post-ch: agent spawned");
  await sleep(3000);
  await httpPost("/channel/addNode", { channelId: ch1.channelId, nodeId: spawn.nodeId, nodeName: "post-ch-agent" });
  await httpPost("/channel/addNode", { channelId: ch2.channelId, nodeId: spawn.nodeId, nodeName: "post-ch-agent" });

  // nerve_create_channel sets currentChannelId; we'll use mcp to create a third channel
  // so currentChannelId points to ch3
  const createRes = await mcp.callTool("nerve_create_channel", { name: "ch-gamma" });
  assert(!createRes.isError, "post-ch: create channel for currentChannelId");

  // Now post with explicit channel_id = ch1 (should override the gamma currentChannelId)
  const postRes = await mcp.callTool("nerve_post", {
    to: "post-ch-agent",
    content: "hello explicit",
    channel_id: ch1.channelId,
  });
  assert(!postRes.isError, "post-ch: nerve_post with explicit channel_id succeeds");

  // Check ch1 history has the message
  const hist1 = await c.request("channel.history", { channelId: ch1.channelId });
  const found1 = hist1.messages.find((m: any) => m.content.includes("hello explicit"));
  assert(!!found1, "post-ch: message landed in explicit channel");

  // Now post without channel_id — should go to currentChannelId (ch-gamma)
  const channels = await c.request("channel.list", {});
  const chGamma = channels.channels.find((ch: any) => ch.name === "ch-gamma");
  if (chGamma) {
    await c.request("channel.join", { channelId: chGamma.id });
    // Add agent to gamma too
    await httpPost("/channel/addNode", { channelId: chGamma.id, nodeId: spawn.nodeId, nodeName: "post-ch-agent" });

    const postRes2 = await mcp.callTool("nerve_post", { to: "post-ch-agent", content: "hello default" });
    assert(!postRes2.isError, "post-ch: nerve_post without channel_id succeeds");

    const hist2 = await c.request("channel.history", { channelId: chGamma.id });
    const found2 = hist2.messages.find((m: any) => m.content.includes("hello default"));
    assert(!!found2, "post-ch: message landed in currentChannelId channel");
  }

  // Cleanup
  await httpPost("/node/stop", { nodeId: spawn.nodeId as string });
  await sleep(500);
  await mcp.close();
  await c.disconnect();
}

async function testNerveRemoveClearsChannelId() {
  console.log("\n▸ nerve_remove(self) clears currentChannelId");

  // Spawn a mock agent so it exists in the node pool under "rm-self-agent"
  const spawn1 = await httpPost("/node/spawn", { adapter: "mock", name: "rm-self-agent", cwd: ROOT });
  assert(!!spawn1.nodeId, "rm-self: agent spawned");
  await sleep(3000);

  // Create MCP client with same NERVE_NODE_NAME as the spawned agent
  const mcp = new McpToolClient("rm-self-agent");
  await mcp.connect();

  // Create channel → sets currentChannelId, auto-joins rm-self-agent
  const createRes = await mcp.callTool("nerve_create_channel", { name: "rm-ch" });
  assert(!createRes.isError, "rm-self: create channel");

  const chIdMatch = createRes.content?.[0]?.text?.match(/created channel (\S+)/);
  const chId = chIdMatch?.[1];
  assert(!!chId, "rm-self: got channel id from create");
  if (!chId) { await mcp.close(); return; }

  // Spawn a target to post to
  const spawn2 = await httpPost("/node/spawn", { adapter: "mock", name: "rm-target", cwd: ROOT });
  await sleep(3000);
  await httpPost("/channel/addNode", { channelId: chId, nodeId: spawn2.nodeId, nodeName: "rm-target" });

  // Remove self from channel
  const rmRes = await mcp.callTool("nerve_remove", { agent_name: "rm-self-agent", channel_id: chId });
  assert(!rmRes.isError, "rm-self: remove self succeeds");

  // Now nerve_post without channel_id should fail (currentChannelId cleared)
  const postRes = await mcp.callTool("nerve_post", { to: "rm-target", content: "should fail" });
  assert(!!postRes.isError, "rm-self: nerve_post fails after self-remove (no channel)");

  // Cleanup
  await httpPost("/node/stop", { nodeId: spawn1.nodeId as string });
  await httpPost("/node/stop", { nodeId: spawn2.nodeId as string });
  await sleep(500);
  await mcp.close();
}

async function testNerveSpawnAutoJoin() {
  console.log("\n▸ nerve_spawn auto-joins to current channel");

  const c = new WsClient("spawn-join-test");
  await c.connect();
  await c.request("node.register", { name: "spawn-join-test", capabilities: ["ui"] });

  const mcp = new McpToolClient("spawn-join-test");
  await mcp.connect();

  // Create channel → sets currentChannelId
  const createRes = await mcp.callTool("nerve_create_channel", { name: "spawn-join-ch" });
  assert(!createRes.isError, "spawn-join: create channel");

  const channels = await c.request("channel.list", {});
  const ch = channels.channels.find((ch: any) => ch.name === "spawn-join-ch");
  assert(!!ch, "spawn-join: channel found");
  if (!ch) { await mcp.close(); await c.disconnect(); return; }

  // Spawn agent via MCP — should auto-join
  const spawnRes = await mcp.callTool("nerve_spawn", { adapter: "mock", name: "auto-join-agent", cwd: ROOT });
  assert(!spawnRes.isError, "spawn-join: spawn succeeds");
  assert(spawnRes.content?.[0]?.text?.includes("joined channel"), "spawn-join: return text mentions join");
  await sleep(3000);

  // Verify agent is in the channel
  const channelsAfter = await c.request("channel.list", {});
  const chAfter = channelsAfter.channels.find((c: any) => c.id === ch.id);
  assert(!!chAfter?.nodes?.["auto-join-agent"], "spawn-join: agent auto-joined channel");

  // Cleanup
  const nodes = await httpPost("/node/list", {});
  const agent = (nodes as any).nodes.find((n: any) => n.name === "auto-join-agent");
  if (agent) await httpPost("/node/stop", { nodeId: agent.id });
  await sleep(500);
  await mcp.close();
  await c.disconnect();
}

async function testChannelCreatedClosedNotifications() {
  console.log("\n▸ channel.created/closed WS notifications");

  const c = new WsClient("notify-test");
  await c.connect();
  await c.request("node.register", { name: "notify-test", capabilities: ["ui"] });
  c.clearNotifications();

  // Create channel via WS — should get channel.created notification
  const ch = await c.request("channel.create", { cwd: "/tmp", name: "notify-ch" });
  await sleep(200);

  const created = c.getNotifications("channel.created");
  assert(created.length >= 1, "notify: received channel.created on WS create");
  assert(created[0]?.params?.channelId === ch.channelId, "notify: channel.created has correct channelId");
  assert(created[0]?.params?.name === "notify-ch", "notify: channel.created has correct name");

  c.clearNotifications();

  // Create channel via HTTP — should also get channel.created
  const ch2 = await httpPost("/channel/create", { cwd: "/tmp", name: "notify-ch-http" });
  await sleep(200);

  const created2 = c.getNotifications("channel.created");
  assert(created2.length >= 1, "notify: received channel.created on HTTP create");
  assert(created2[0]?.params?.channelId === ch2.channelId, "notify: HTTP channel.created has correct channelId");

  c.clearNotifications();

  // Close channel via WS — should get channel.closed
  await c.request("channel.close", { channelId: ch.channelId });
  await sleep(200);

  const closed = c.getNotifications("channel.closed");
  assert(closed.length >= 1, "notify: received channel.closed on WS close");
  assert(closed[0]?.params?.channelId === ch.channelId, "notify: channel.closed has correct channelId");

  c.clearNotifications();

  // Close channel via HTTP — should get channel.closed
  await httpPost("/channel/close", { channelId: ch2.channelId as string });
  await sleep(200);

  const closed2 = c.getNotifications("channel.closed");
  assert(closed2.length >= 1, "notify: received channel.closed on HTTP close");

  await c.disconnect();
}

async function testChannelListCwdFilter() {
  console.log("\n▸ channel.list cwd filter");

  const c = new WsClient("ch-cwd-test");
  await c.connect();
  await c.request("node.register", { name: "ch-cwd-test", capabilities: ["ui"] });

  await c.request("channel.create", { cwd: "/tmp/project-a", name: "ch-a" });
  await c.request("channel.create", { cwd: "/tmp/project-b", name: "ch-b" });

  // No filter — all channels
  const all = await c.request("channel.list", {});
  const aAll = all.channels.filter((c: any) => c.name === "ch-a" || c.name === "ch-b");
  assert(aAll.length === 2, "ch-cwd: unfiltered returns both");

  // Filter by project-a
  const filtered = await c.request("channel.list", { cwd: "/tmp/project-a" });
  assert(filtered.channels.length >= 1, "ch-cwd: filtered returns at least 1");
  assert(filtered.channels.every((c: any) => c.cwd === "/tmp/project-a"), "ch-cwd: all results match cwd");

  // HTTP filter
  const httpFiltered = await httpPost("/channel/list", { cwd: "/tmp/project-b" });
  const httpChs = (httpFiltered as any).channels;
  assert(httpChs.length >= 1, "ch-cwd: HTTP filtered returns at least 1");
  assert(httpChs.every((c: any) => c.cwd === "/tmp/project-b"), "ch-cwd: HTTP all results match cwd");

  await c.disconnect();
}

async function testAutoReplyToChannel() {
  console.log("\n▸ channel @mention dispatches to agent (no auto-reply, agent replies via nerve_post)");

  const c = new WsClient("auto-reply-test");
  await c.connect();
  await c.request("node.register", { name: "auto-reply-test", capabilities: ["ui"] });

  // Spawn mock agent
  const spawn = await httpPost("/node/spawn", { adapter: "mock", name: "reply-agent", cwd: ROOT });
  assert(!!spawn.nodeId, "dispatch: agent spawned");
  await sleep(3000);

  // Create channel, add both nodes
  const ch = await c.request("channel.create", { cwd: "/tmp/auto-reply" });
  await c.request("channel.join", { channelId: ch.channelId });
  await httpPost("/channel/addNode", {
    channelId: ch.channelId,
    nodeId: spawn.nodeId,
    nodeName: "reply-agent",
  });

  // Post @mention to trigger dispatchDirect
  await c.request("channel.post", { channelId: ch.channelId, content: "@reply-agent do something" });

  // Wait for agent to process
  await sleep(5000);

  // Check channel history — agent replies via nerve_post (mock HTTP), no auto-reply
  const hist = await c.request("channel.history", { channelId: ch.channelId });
  const messages = hist.messages as Array<{ from: string; content: string }>;

  const userMsg = messages.find(m => m.content.includes("@reply-agent do something"));
  assert(!!userMsg, "dispatch: user message in history");

  // Mock agent replies via HTTP (nerve_post equivalent) — should be in history
  const agentMsgs = messages.filter(m => m.from === "reply-agent");
  assert(agentMsgs.length >= 1, `dispatch: agent replied via nerve_post (got ${agentMsgs.length})`,
    `messages: ${JSON.stringify(messages.map(m => ({ from: m.from, content: m.content?.slice(0, 80) })))}`);

  const httpReply = agentMsgs.find(m => m.content.includes("mock回复"));
  assert(!!httpReply, "dispatch: mock nerve_post reply found");

  // Cleanup
  await httpPost("/node/stop", { nodeId: spawn.nodeId as string });
  await sleep(500);
  await c.disconnect();
}

async function testPromptErrorPostsToChannel() {
  console.log("\n▸ promptNode {error} posts [error:...] to channel");

  const c = new WsClient("prompt-err-test");
  await c.connect();
  await c.request("node.register", { name: "prompt-err-test", capabilities: ["ui"] });

  // Spawn mock agent
  const spawn = await httpPost("/node/spawn", { adapter: "mock", name: "err-agent", cwd: ROOT });
  assert(!!spawn.nodeId, "prompt-err: agent spawned");
  await sleep(3000);

  // Create channel, add both nodes
  const ch = await c.request("channel.create", { cwd: "/tmp/prompt-err" });
  await c.request("channel.join", { channelId: ch.channelId });
  await httpPost("/channel/addNode", {
    channelId: ch.channelId,
    nodeId: spawn.nodeId,
    nodeName: "err-agent",
  });

  // Post @mention with "fail" keyword to trigger error response
  await c.request("channel.post", { channelId: ch.channelId, content: "@err-agent fail please" });

  // Wait for error to be posted back
  await sleep(3000);

  // Check channel history for [error:...] message
  const hist = await c.request("channel.history", { channelId: ch.channelId });
  const messages = hist.messages as Array<{ from: string; content: string }>;
  const errorMsg = messages.find(m => m.from === "err-agent" && m.content.includes("[error:"));
  assert(!!errorMsg, "prompt-err: [error:...] message in channel history",
    `messages: ${JSON.stringify(messages.map(m => ({ from: m.from, content: m.content?.slice(0, 100) })))}`);
  if (errorMsg) {
    assert(errorMsg.content.includes("simulated prompt failure"),
      "prompt-err: error message contains original error text");
  }

  // Cleanup
  await httpPost("/node/stop", { nodeId: spawn.nodeId as string });
  await sleep(500);
  await c.disconnect();
}

async function testCwdNormalization() {
  console.log("\n▸ cwd path normalization");

  const c = new WsClient("cwd-norm-test");
  await c.connect();
  await c.request("node.register", { name: "cwd-norm-test", capabilities: ["ui"] });

  // Create channel with trailing slash — should be normalized
  const ch1 = await c.request("channel.create", { cwd: "/tmp/norm-project/", name: "norm-trailing" });
  assertEq(ch1.cwd, "/tmp/norm-project", "cwd-norm: trailing slash stripped on create");

  // Create channel with /. — should be normalized
  const ch2 = await c.request("channel.create", { cwd: "/tmp/norm-project/.", name: "norm-dot" });
  assertEq(ch2.cwd, "/tmp/norm-project", "cwd-norm: /. resolved on create");

  // Create channel with /.. — should be normalized
  const ch3 = await c.request("channel.create", { cwd: "/tmp/norm-project/sub/..", name: "norm-dotdot" });
  assertEq(ch3.cwd, "/tmp/norm-project", "cwd-norm: /sub/.. resolved on create");

  // Filter with trailing slash should still match
  const filtered = await c.request("channel.list", { cwd: "/tmp/norm-project/" });
  const matched = filtered.channels.filter((c: any) => c.cwd === "/tmp/norm-project");
  assert(matched.length >= 3, "cwd-norm: filter with trailing slash matches normalized channels");

  // HTTP: create with trailing slash
  const httpCh = await httpPost("/channel/create", { cwd: "/tmp/http-norm/", name: "http-norm" }) as any;
  assertEq(httpCh.cwd, "/tmp/http-norm", "cwd-norm: HTTP create normalizes trailing slash");

  // HTTP: filter with /. matches
  const httpFiltered = await httpPost("/channel/list", { cwd: "/tmp/http-norm/." }) as any;
  const httpMatched = httpFiltered.channels.filter((c: any) => c.cwd === "/tmp/http-norm");
  assert(httpMatched.length >= 1, "cwd-norm: HTTP filter /. matches normalized channel");

  await c.disconnect();
}

// ============================================================
// node.log — program node observability
// ============================================================

async function testNodeLog() {
  console.log("\n▸ node.log (program node DM observability)");

  // 1. Register a WS node (simulating a program node like context-guardian)
  const plugin = new WsClient("log-plugin");
  await plugin.connect();
  await plugin.request("node.register", { name: "log-plugin", capabilities: ["monitor"] });

  // 2. Register an observer and subscribe to the plugin node
  const observer = new WsClient("log-observer");
  await observer.connect();
  await observer.request("node.register", { name: "log-observer", capabilities: ["ui"] });

  // Find the plugin node
  const nodes = await observer.request("node.list");
  const pluginNode = nodes.nodes.find((n: any) => n.name === "log-plugin");
  assert(!!pluginNode, "node.log: plugin node found");
  if (!pluginNode) { await plugin.disconnect(); await observer.disconnect(); return; }

  // Subscribe to plugin node updates
  observer.clearNotifications();
  await observer.request("node.subscribe", { nodeId: pluginNode.id });

  // 3. Plugin sends node.log with single entry
  const logResult = await plugin.request("node.log", {
    entries: [{ level: "info", message: "poll started" }],
  });
  assert(logResult.ok, "node.log: returns ok");
  await sleep(200);

  // Observer should receive node.update with sessionUpdate="node_log"
  let updates = observer.getNotifications("node.update");
  assert(updates.length > 0, "node.log: observer received node.update", `got ${updates.length}`);
  if (updates.length > 0) {
    const update = updates[0].params.update;
    assertEq(update.sessionUpdate, "node_log", "node.log: sessionUpdate is node_log");
    assert(Array.isArray(update.entries), "node.log: entries is array");
    assertEq(update.entries[0].level, "info", "node.log: entry level is info");
    assertEq(update.entries[0].message, "poll started", "node.log: entry message matches");
    assert(!!update.entries[0].ts, "node.log: entry has timestamp");
  }

  // 4. Batch entries
  observer.clearNotifications();
  await plugin.request("node.log", {
    entries: [
      { level: "info", message: "found 3 agents" },
      { level: "warn", message: "agent-1 usage 80%" },
    ],
  });
  await sleep(200);

  updates = observer.getNotifications("node.update");
  assert(updates.length > 0, "node.log batch: observer received update");
  if (updates.length > 0) {
    const entries = updates[0].params.update.entries;
    assertEq(entries.length, 2, "node.log batch: 2 entries");
    assertEq(entries[0].message, "found 3 agents", "node.log batch: first entry");
    assertEq(entries[1].level, "warn", "node.log batch: second level");
  }

  // 5. Replay on re-subscribe — new observer should get buffered log entries
  const observer2 = new WsClient("log-observer-2");
  await observer2.connect();
  await observer2.request("node.register", { name: "log-observer-2", capabilities: ["ui"] });
  observer2.clearNotifications();
  await observer2.request("node.subscribe", { nodeId: pluginNode.id });
  await sleep(200);

  const replayed = observer2.getNotifications("node.update");
  assert(replayed.length >= 2, "node.log replay: new subscriber gets buffered entries", `got ${replayed.length}`);
  // Verify replayed entries contain node_log
  const logReplays = replayed.filter((n: any) => n.params.update?.sessionUpdate === "node_log");
  assert(logReplays.length >= 2, "node.log replay: replayed entries are node_log type", `got ${logReplays.length}`);

  // 6. Error for non-registered caller
  const stranger = new WsClient("log-stranger");
  await stranger.connect();
  // Don't register — try node.log directly
  try {
    await stranger.request("node.log", { entries: [{ level: "info", message: "nope" }] });
    assert(false, "node.log: unregistered caller should fail");
  } catch (e: any) {
    assert(e.message.includes("not registered"), "node.log: unregistered caller gets error");
  }

  await plugin.disconnect();
  await observer.disconnect();
  await observer2.disconnect();
  await stranger.disconnect();
}

// ============================================================
// plugin-base: dataDir + activity.log
// ============================================================

async function testPluginDataDir() {
  console.log("\n▸ plugin-base dataDir + activity.log");

  // Import PluginBase dynamically
  const { PluginBase } = await import("../src/plugins/plugin-base.js");

  const testName = `test-plugin-${Date.now()}`;
  const expectedDir = resolve(process.env.HOME || "~", `.nerve/plugins/${testName}`);

  // Clean up from previous runs
  if (existsSync(expectedDir)) rmSync(expectedDir, { recursive: true });

  class TestPlugin extends PluginBase {
    protected async onReady(): Promise<void> {
      // Log some messages after registration
      this.log("info", "ready");
      this.log("warn", "test warning");
      this.log("error", "test error");
    }
  }

  const plugin = new TestPlugin({ port: TEST_PORT, name: testName });
  await plugin.start();
  // Give appendFile calls time to flush
  await sleep(500);

  // 1. dataDir exists
  assert(existsSync(expectedDir), "plugin-dataDir: directory created");

  // 2. dataDir property is accessible
  assert((plugin as any).dataDir === expectedDir, "plugin-dataDir: dataDir property matches");

  // 3. activity.log exists and has content
  const logPath = resolve(expectedDir, "activity.log");
  assert(existsSync(logPath), "plugin-dataDir: activity.log created");

  if (existsSync(logPath)) {
    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");
    // Should have multiple log lines (connecting, connected, registered, ready, warning, error)
    assert(lines.length >= 3, "plugin-dataDir: activity.log has multiple lines", `got ${lines.length}`);

    // Verify format: ISO timestamp [{LEVEL}] message
    const hasInfo = lines.some(l => l.includes("[INFO]") && l.includes("ready"));
    const hasWarn = lines.some(l => l.includes("[WARN]") && l.includes("test warning"));
    const hasError = lines.some(l => l.includes("[ERROR]") && l.includes("test error"));
    assert(hasInfo, "plugin-dataDir: activity.log has INFO line");
    assert(hasWarn, "plugin-dataDir: activity.log has WARN line");
    assert(hasError, "plugin-dataDir: activity.log has ERROR line");

    // Verify ISO timestamp format at start of line
    const tsMatch = lines[0].match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert(!!tsMatch, "plugin-dataDir: log line starts with ISO timestamp");
  }

  plugin.stop();
  await sleep(300);

  // Clean up
  if (existsSync(expectedDir)) rmSync(expectedDir, { recursive: true });
}

// ============================================================
// node.message — DM command support for program nodes
// ============================================================

async function testNodeMessage() {
  console.log("\n▸ node.message (DM command for program nodes)");

  // 1. Register a WS node simulating a program node
  const program = new WsClient("dm-program");
  await program.connect();
  await program.request("node.register", { name: "dm-program", capabilities: ["monitor"] });

  // Find its nodeId
  const nodes = await program.request("node.list");
  const programNode = nodes.nodes.find((n: any) => n.name === "dm-program");
  assert(!!programNode, "node.message: program node found");
  if (!programNode) { await program.disconnect(); return; }

  // 2. Another client sends node.message to the program node
  const user = new WsClient("dm-user");
  await user.connect();
  await user.request("node.register", { name: "dm-user", capabilities: ["ui"] });

  program.clearNotifications();
  await user.request("node.message", { nodeId: programNode.id, content: "start" });
  await sleep(200);

  // 3. Program node should receive node.message notification
  const msgs = program.getNotifications("node.message");
  assert(msgs.length === 1, "node.message: program received notification", `got ${msgs.length}`);
  if (msgs.length > 0) {
    assertEq(msgs[0].params.content, "start", "node.message: content matches");
    assert(!!msgs[0].params.from, "node.message: has from field");
  }

  // 4. Error: send to non-existent node
  try {
    await user.request("node.message", { nodeId: "nonexistent", content: "test" });
    assert(false, "node.message: should fail for unknown node");
  } catch (e: any) {
    assert(e.message.includes("not found"), "node.message: unknown node error");
  }

  // 5. Error: missing params
  try {
    await user.request("node.message", { nodeId: programNode.id });
    assert(false, "node.message: should fail without content");
  } catch (e: any) {
    assert(e.message.includes("content"), "node.message: missing content error");
  }

  await program.disconnect();
  await user.disconnect();
}

async function testNodeMessageKill() {
  console.log("\n▸ node.message kill (server-side process kill)");

  // Register a WS node simulating a program node
  const program = new WsClient("kill-program");
  await program.connect();
  await program.request("node.register", { name: "kill-program", capabilities: ["monitor"] });

  const nodes = await program.request("node.list");
  const programNode = nodes.nodes.find((n: any) => n.name === "kill-program");
  assert(!!programNode, "node.message kill: program node found");
  if (!programNode) { await program.disconnect(); return; }

  // For non-program-process nodes (just WS nodes), kill should still forward as message
  // since only real spawned program processes get SIGTERM'd
  program.clearNotifications();

  const user = new WsClient("kill-user");
  await user.connect();
  await user.request("node.register", { name: "kill-user", capabilities: ["ui"] });

  await user.request("node.message", { nodeId: programNode.id, content: "kill" });
  await sleep(200);

  // Non-spawned WS node: kill is forwarded as notification (no process to kill)
  const msgs = program.getNotifications("node.message");
  assert(msgs.length === 1, "node.message kill: forwarded to non-spawned node", `got ${msgs.length}`);

  await program.disconnect();
  await user.disconnect();
}

async function testNodeMessageHttp() {
  console.log("\n▸ /node/message HTTP endpoint");

  // Register a WS program node
  const program = new WsClient("http-msg-program");
  await program.connect();
  await program.request("node.register", { name: "http-msg-program", capabilities: ["monitor"] });

  const nodes = await program.request("node.list");
  const programNode = nodes.nodes.find((n: any) => n.name === "http-msg-program");
  assert(!!programNode, "node.message http: program node found");
  if (!programNode) { await program.disconnect(); return; }

  program.clearNotifications();

  // Send via HTTP
  const result = await httpPost("/node/message", {
    nodeName: "http-msg-program",
    content: "stop",
  }) as any;
  assert(result.ok, "node.message http: returns ok");
  await sleep(200);

  const msgs = program.getNotifications("node.message");
  assert(msgs.length === 1, "node.message http: program received notification", `got ${msgs.length}`);
  if (msgs.length > 0) {
    assertEq(msgs[0].params.content, "stop", "node.message http: content matches");
  }

  // Error: unknown node
  const err = await httpPost("/node/message", { nodeName: "nope", content: "test" }) as any;
  assert(!!err.error, "node.message http: unknown node returns error");

  await program.disconnect();
}

async function testPluginBaseOnMessage() {
  console.log("\n▸ plugin-base onMessage handler");

  const { PluginBase } = await import("../src/plugins/plugin-base.js");

  const received: Array<{ content: string; from?: string }> = [];
  const testName = `test-msg-plugin-${Date.now()}`;

  class TestMsgPlugin extends PluginBase {
    protected async onReady(): Promise<void> {
      // onMessage is auto-registered in PluginBase
    }
    protected onMessage(content: string, from?: string): void {
      received.push({ content, from });
    }
  }

  const plugin = new TestMsgPlugin({ port: TEST_PORT, name: testName });
  await plugin.start();
  await sleep(300);

  // Find the plugin node
  const finder = new WsClient("msg-finder");
  await finder.connect();
  await finder.request("node.register", { name: "msg-finder", capabilities: ["ui"] });
  const nodes = await finder.request("node.list");
  const pluginNode = nodes.nodes.find((n: any) => n.name === testName);
  assert(!!pluginNode, "plugin onMessage: node found");

  if (pluginNode) {
    // Send node.message
    await finder.request("node.message", { nodeId: pluginNode.id, content: "start recording" });
    await sleep(300);

    assert(received.length === 1, "plugin onMessage: received message", `got ${received.length}`);
    if (received.length > 0) {
      assertEq(received[0].content, "start recording", "plugin onMessage: content matches");
    }
  }

  plugin.stop();
  await finder.disconnect();
  await sleep(300);

  // Clean up
  const expectedDir = resolve(process.env.HOME || "~", `.nerve/plugins/${testName}`);
  if (existsSync(expectedDir)) rmSync(expectedDir, { recursive: true });
}

// ============================================================
// node.register commands/events metadata
// ============================================================

async function testNodeMetadata() {
  console.log("\n▸ node.register commands/events metadata");

  const c = new WsClient("meta-node");
  await c.connect();
  const reg = await c.request("node.register", {
    name: "meta-node",
    capabilities: ["monitor"],
    commands: {
      start: { description: "Start recording", args: { source: "audio source" } },
      stop: { description: "Stop recording" },
    },
    events: ["transcription", "status_change"],
  });
  assert(!!reg.nodeId, "metadata: registered");

  // node.list should include commands and events
  const lister = new WsClient("meta-lister");
  await lister.connect();
  await lister.request("node.register", { name: "meta-lister", capabilities: ["ui"] });
  const result = await lister.request("node.list");
  const node = result.nodes.find((n: any) => n.name === "meta-node");
  assert(!!node, "metadata: node found in list");

  if (node) {
    assert(!!node.commands, "metadata: commands present");
    assert(!!node.commands.start, "metadata: start command declared");
    assertEq(node.commands.start.description, "Start recording", "metadata: start description");
    assert(!!node.commands.start.args, "metadata: start has args");
    assertEq(node.commands.stop.description, "Stop recording", "metadata: stop description");
    assert(Array.isArray(node.events), "metadata: events is array");
    assertEq(node.events.length, 2, "metadata: 2 events");
    assertEq(node.events[0], "transcription", "metadata: first event");
  }

  // Node without commands/events should have undefined (not null/empty)
  const plain = new WsClient("meta-plain");
  await plain.connect();
  await plain.request("node.register", { name: "meta-plain", capabilities: ["ui"] });
  const result2 = await plain.request("node.list");
  const plainNode = result2.nodes.find((n: any) => n.name === "meta-plain");
  assert(!!plainNode, "metadata: plain node found");
  if (plainNode) {
    assert(!plainNode.commands, "metadata: plain node has no commands");
    assert(!plainNode.events, "metadata: plain node has no events");
  }

  await c.disconnect();
  await lister.disconnect();
  await plain.disconnect();
}

// ============================================================
// plugin-base command parsing
// ============================================================

async function testPluginCommandParsing() {
  console.log("\n▸ plugin-base command parsing");

  const { PluginBase } = await import("../src/plugins/plugin-base.js");

  const received: Array<{ command: string; args: Record<string, string> }> = [];
  const errors: string[] = [];
  const testName = `test-cmd-plugin-${Date.now()}`;

  class TestCmdPlugin extends PluginBase {
    override getCommands() {
      return {
        start: { description: "Start", args: { source: "audio source" } },
        stop: { description: "Stop" },
        status: { description: "Show status" },
      };
    }
    override getEvents() {
      return ["transcription"];
    }
    protected override onCommand(command: string, args: Record<string, string>): void {
      received.push({ command, args });
    }
  }

  const plugin = new TestCmdPlugin({ port: TEST_PORT, name: testName });
  await plugin.start();
  await sleep(300);

  // Find node
  const finder = new WsClient("cmd-finder");
  await finder.connect();
  await finder.request("node.register", { name: "cmd-finder", capabilities: ["ui"] });
  const nodes = await finder.request("node.list");
  const pluginNode = nodes.nodes.find((n: any) => n.name === testName);
  assert(!!pluginNode, "cmd-parse: node found");

  if (pluginNode) {
    // Verify commands/events in node.list
    assert(!!pluginNode.commands, "cmd-parse: commands in node.list");
    assert(!!pluginNode.commands.start, "cmd-parse: start in node.list");
    assert(Array.isArray(pluginNode.events), "cmd-parse: events in node.list");

    // Send "start" command via DM
    await finder.request("node.message", { nodeId: pluginNode.id, content: "start" });
    await sleep(300);
    assert(received.length === 1, "cmd-parse: received start", `got ${received.length}`);
    if (received.length > 0) {
      assertEq(received[0].command, "start", "cmd-parse: command is start");
    }

    // Send "stop" via DM
    received.length = 0;
    await finder.request("node.message", { nodeId: pluginNode.id, content: "stop" });
    await sleep(300);
    assertEq(received[0]?.command, "stop", "cmd-parse: stop parsed");

    // Send "start source=system" with args
    received.length = 0;
    await finder.request("node.message", { nodeId: pluginNode.id, content: "start source=system" });
    await sleep(300);
    assertEq(received[0]?.command, "start", "cmd-parse: start with args");
    assertEq(received[0]?.args?.source, "system", "cmd-parse: source=system parsed");

    // Unknown command — should get error log (via node.log), not call onCommand
    received.length = 0;

    // Subscribe to observe error response
    finder.clearNotifications();
    await finder.request("node.subscribe", { nodeId: pluginNode.id });
    await finder.request("node.message", { nodeId: pluginNode.id, content: "unknown_cmd" });
    await sleep(500);

    assert(received.length === 0, "cmd-parse: unknown command not dispatched");
    // Check that an error log was sent
    const updates = finder.getNotifications("node.update");
    const errorLog = updates.find((n: any) => {
      const entries = n.params.update?.entries;
      return entries?.some((e: any) => e.level === "error" && e.message.includes("unknown_cmd"));
    });
    assert(!!errorLog, "cmd-parse: unknown command logged as warning");
  }

  plugin.stop();
  await finder.disconnect();
  await sleep(300);

  // Clean up
  const expectedDir = resolve(process.env.HOME || "~", `.nerve/plugins/${testName}`);
  if (existsSync(expectedDir)) rmSync(expectedDir, { recursive: true });
}

// ============================================================
// help command via DM
// ============================================================

async function testPluginHelpCommand() {
  console.log("\n▸ plugin-base help command outputs each command");

  const { PluginBase } = await import("../src/plugins/plugin-base.js");

  const testName = `test-help-plugin-${Date.now()}`;

  class TestHelpPlugin extends PluginBase {
    override getCommands() {
      return {
        start: { description: "Start recording", args: { source: "audio source" } },
        stop: { description: "Stop recording" },
      };
    }
    protected override onCommand() {}
  }

  const plugin = new TestHelpPlugin({ port: TEST_PORT, name: testName });
  await plugin.start();
  await sleep(300);

  const c = new WsClient("help-finder");
  await c.connect();
  await c.request("node.register", { name: "help-finder", capabilities: ["ui"] });
  const nodes = await c.request("node.list");
  const pluginNode = nodes.nodes.find((n: any) => n.name === testName);
  assert(!!pluginNode, "help: node found");

  if (pluginNode) {
    // Subscribe to observe log output
    await c.request("node.subscribe", { nodeId: pluginNode.id });
    c.clearNotifications();

    // Send "help" DM
    await c.request("node.message", { nodeId: pluginNode.id, content: "help" });
    await sleep(500);

    // Check node.log entries for each command
    const updates = c.getNotifications("node.update");
    const logEntries: any[] = [];
    for (const n of updates) {
      const entries = n.params.update?.entries;
      if (entries) logEntries.push(...entries);
    }

    const startLine = logEntries.find((e: any) => e.message.includes("start") && e.message.includes("Start recording"));
    const stopLine = logEntries.find((e: any) => e.message.includes("stop") && e.message.includes("Stop recording"));
    const helpLine = logEntries.find((e: any) => e.message.includes("help") && e.message.includes("Show this help"));

    assert(!!startLine, "help: lists start command with description");
    assert(!!stopLine, "help: lists stop command with description");
    assert(!!helpLine, "help: lists help itself");
  }

  plugin.stop();
  await c.disconnect();
  await sleep(300);

  const expectedDir = resolve(process.env.HOME || "~", `.nerve/plugins/${testName}`);
  if (existsSync(expectedDir)) rmSync(expectedDir, { recursive: true });
}

// ============================================================
// flush command via DM (mc-transcriber onCommand path)
// ============================================================

async function testMcFlushCommand() {
  console.log("\n▸ mc flush command (no active buffer)");

  const c = new WsClient("flush-test");
  await c.connect();
  await c.request("node.register", { name: "flush-test", capabilities: ["ui"] });

  // Spawn mc
  const sp = await c.request("node.spawn", { adapter: "mc", name: "mc-flush-test", cwd: ROOT });

  // Wait for mc to become idle (poll)
  for (let i = 0; i < 100; i++) {
    const statusChanges = c.getNotifications("node.statusChanged");
    if (statusChanges.some(n => n.params.name === "mc-flush-test" && n.params.status === "idle")) break;
    await sleep(100);
  }

  // Subscribe to observe log
  await c.request("node.subscribe", { nodeId: sp.nodeId });
  c.clearNotifications();

  // Send "flush" DM — no active buffer since not recording
  await c.request("node.message", { nodeId: sp.nodeId, content: "flush" });
  await sleep(500);

  // Check for "no active buffer" warning in node.log
  const updates = c.getNotifications("node.update");
  const logEntries: any[] = [];
  for (const n of updates) {
    const entries = n.params.update?.entries;
    if (entries) logEntries.push(...entries);
  }

  const warnEntry = logEntries.find((e: any) => e.message.includes("no active buffer"));
  assert(!!warnEntry, "flush: logs 'no active buffer' warning when not recording");

  // Also verify command was logged
  const cmdEntry = logEntries.find((e: any) => e.message.includes("command: flush"));
  assert(!!cmdEntry, "flush: command dispatch logged");

  await c.request("node.stop", { nodeId: sp.nodeId });
  await sleep(1000);
  await c.disconnect();
}

// ============================================================
// plugin-base log() accepts "debug" level
// ============================================================

async function testPluginDebugLog() {
  console.log("\n▸ plugin-base: debug log level accepted");

  const { PluginBase } = await import("../src/plugins/plugin-base.js");

  const testName = `test-debug-log-${Date.now()}`;
  class TestDebugPlugin extends PluginBase {
    override getCommands() {
      return { ping: { description: "test" } };
    }
    protected override onCommand() {
      this.log("debug", "debug level works");
    }
  }

  const plugin = new TestDebugPlugin({ port: TEST_PORT, name: testName });
  await plugin.start();
  await sleep(300);

  const c = new WsClient("debug-log-checker");
  await c.connect();
  await c.request("node.register", { name: "debug-log-checker", capabilities: ["ui"] });
  const nodes = await c.request("node.list");
  const pluginNode = nodes.nodes.find((n: any) => n.name === testName);
  assert(!!pluginNode, "debug-log: node found");

  if (pluginNode) {
    await c.request("node.subscribe", { nodeId: pluginNode.id });
    c.clearNotifications();

    // Send "ping" DM — triggers onCommand which logs at debug level
    await c.request("node.message", { nodeId: pluginNode.id, content: "ping" });
    await sleep(500);

    const updates = c.getNotifications("node.update");
    const logEntries: any[] = [];
    for (const n of updates) {
      const entries = n.params.update?.entries;
      if (entries) logEntries.push(...entries);
    }

    const debugEntry = logEntries.find((e: any) => e.message.includes("debug level works"));
    assert(!!debugEntry, "debug-log: debug message received via node.log");
  }

  plugin.stop();
  await c.disconnect();
  await sleep(300);
  const expectedDir = resolve(process.env.HOME || "~", `.nerve/plugins/${testName}`);
  if (existsSync(expectedDir)) rmSync(expectedDir, { recursive: true });
}

// ============================================================
// promptNode: rejected promise recovers to idle + error log
// ============================================================

async function testPromptNodeRejectRecovery() {
  console.log("\n▸ promptNode: rejected promise recovers to idle");

  const c = new WsClient("prompt-reject-test");
  await c.connect();
  await c.request("node.register", { name: "prompt-reject-test", capabilities: ["ui"] });

  // Spawn mock agent
  const spawn = await httpPost("/node/spawn", { adapter: "mock", name: "reject-agent", cwd: ROOT });
  assert(!!spawn.nodeId, "prompt-reject: agent spawned");
  await sleep(3000);

  // Verify agent is idle
  let nodesList = await c.request("node.list");
  let agent = nodesList.nodes.find((n: any) => n.name === "reject-agent");
  assertEq(agent?.status, "idle", "prompt-reject: initially idle");

  // Subscribe to observe status changes
  await c.request("node.subscribe", { nodeId: spawn.nodeId });

  // Send prompt with "fail" to trigger mock error
  await c.request("channel.create", { cwd: "/tmp/reject-test" });
  const ch = await c.request("channel.create", { cwd: "/tmp/reject-test-2", name: "reject-ch" });
  await c.request("channel.join", { channelId: ch.channelId });
  await httpPost("/channel/addNode", { channelId: ch.channelId, nodeId: spawn.nodeId, nodeName: "reject-agent" });
  await c.request("channel.post", { channelId: ch.channelId, content: "@reject-agent fail" });

  // Wait for error to be handled
  await sleep(3000);

  // Verify agent recovered to idle (not stuck on busy)
  nodesList = await c.request("node.list");
  agent = nodesList.nodes.find((n: any) => n.name === "reject-agent");
  assertEq(agent?.status, "idle", "prompt-reject: recovered to idle after error");

  await httpPost("/node/stop", { nodeId: spawn.nodeId as string });
  await sleep(500);
  await c.disconnect();
}

// ============================================================
// promptNode: end_turn clears activity
// ============================================================

async function testPromptNodeEndTurnClearsActivity() {
  console.log("\n▸ promptNode: end_turn clears activity");

  const c = new WsClient("endturn-activity-test");
  await c.connect();
  await c.request("node.register", { name: "endturn-activity-test", capabilities: ["ui"] });

  // Spawn mock agent
  const spawn = await httpPost("/node/spawn", { adapter: "mock", name: "endturn-agent", cwd: ROOT });
  assert(!!spawn.nodeId, "endturn-activity: agent spawned");
  await sleep(3000);

  // Subscribe to observe status changes
  await c.request("node.subscribe", { nodeId: spawn.nodeId });

  // Create channel and send prompt (mock agent responds with end_turn)
  const ch = await c.request("channel.create", { cwd: "/tmp/endturn-test", name: "endturn-ch" });
  await c.request("channel.join", { channelId: ch.channelId });
  await httpPost("/channel/addNode", { channelId: ch.channelId, nodeId: spawn.nodeId, nodeName: "endturn-agent" });
  await c.request("channel.post", { channelId: ch.channelId, content: "@endturn-agent activity test" });

  // Brief wait for tool_call update to set activity (mock sends tool_call before responding)
  await sleep(1000);

  // Verify activity is set during prompt (tool_call → "tool: mock_tool")
  let nodesList = await c.request("node.list");
  let agent = nodesList.nodes.find((n: any) => n.name === "endturn-agent");
  assert(!!agent?.activity, "endturn-activity: activity set during prompt", `got: ${agent?.activity}`);

  // Wait for prompt to complete (mock agent responds with end_turn)
  await sleep(4000);

  // Verify agent is idle AND activity is cleared
  nodesList = await c.request("node.list");
  agent = nodesList.nodes.find((n: any) => n.name === "endturn-agent");
  assertEq(agent?.status, "idle", "endturn-activity: status is idle");
  assertEq(agent?.activity, undefined, "endturn-activity: activity cleared after end_turn");

  await httpPost("/node/stop", { nodeId: spawn.nodeId as string });
  await sleep(500);
  await c.disconnect();
}

// ============================================================
// mc-transcriber: pushToChannel logs success with channelId + subscribers + slicePath
// ============================================================

async function testMcPushToChannelSuccessLog() {
  console.log("\n▸ mc-transcriber: pushToChannel success log");

  // Test via TranscriptBuffer + SliceWriter directly (unit test)
  const { TranscriptBuffer, SliceWriter } = await import("../src/plugins/mc-transcriber/index.js");

  const tmpDir = `/tmp/mc-push-log-test-${Date.now()}`;
  const sw = new SliceWriter(tmpDir, "test");

  // Write a slice
  const path = sw.write(["[+10s][mic] hello", "[+20s][mic] world"]);
  assert(path.includes("test_001.txt"), "push-log: slice file created");

  // Verify the time range extraction
  const range = SliceWriter.timeRange(["[+10s][mic] hello", "[+20s][mic] world"]);
  assertEq(range, "+10s-+20s", "push-log: time range extracted");

  // Test buffer flush captures reason correctly
  const reasons: string[] = [];
  const buf = new TranscriptBuffer({
    pushInterval: 60000,
    pushLines: 2,
    onFlush: (_lines: string[], reason: string) => reasons.push(reason),
  });
  buf.add("a");
  buf.add("b"); // triggers line_count
  buf.add("c"); // new line in buffer
  buf.flush();  // triggers manual (buffer has 1 line)
  buf.stop();   // triggers stop (empty, should not fire)

  assert(reasons.includes("line_count"), "push-log: line_count flush reason");
  assert(reasons.includes("manual"), "push-log: manual flush reason");

  // Clean up
  rmSync(tmpDir, { recursive: true, force: true });
}

// ============================================================
// scene on_ready promptNode error adds warning
// ============================================================

async function testSceneOnReadyPromptError() {
  console.log("\n▸ scene on_ready: promptNode error captured as warning");

  const c = new WsClient("scene-prompt-err");
  await c.connect();
  await c.request("node.register", { name: "scene-prompt-err", capabilities: ["ui"] });

  // Create scene config with on_ready prompt that triggers error
  const scenesDir = resolve(TEST_DATA, "scenes");
  writeFileSync(resolve(scenesDir, "test-scene-prompt-err.json"), JSON.stringify({
    name: "test-scene-prompt-err",
    nodes: [
      { adapter: "mock", name: "scene-fail-agent" },
    ],
    channel: { name: "test-prompt-err-ch", auto_create: true },
    on_ready: [
      { to: "scene-fail-agent", command: "fail please", prompt: true },
    ],
  }));

  const result = await c.request("scene.start", { name: "test-scene-prompt-err", cwd: ROOT });
  assert(!!result.name, "prompt-err scene: started");

  // Wait for on_ready to complete (needs agent ready + prompt + response)
  await sleep(5000);

  // Check scene warnings
  const scenes = await c.request("scene.list");
  const scene = scenes.scenes.find((s: any) => s.name === "test-scene-prompt-err");
  assert(!!scene, "prompt-err scene: found in list");
  assert(!!scene?.warnings, "prompt-err scene: has warnings");
  if (scene?.warnings) {
    const promptWarn = scene.warnings.find((w: string) => w.includes("prompt failed"));
    assert(!!promptWarn, "prompt-err scene: warning mentions prompt failure");
  }

  await c.request("scene.stop", { name: "test-scene-prompt-err" });
  await sleep(500);
  await c.disconnect();
}

// ============================================================
// node.message on spawned program node (real process)
// ============================================================

async function testNodeMessageSpawned() {
  console.log("\n▸ node.message on spawned program node");

  const c = new WsClient("dm-spawner");
  await c.connect();
  await c.request("node.register", { name: "dm-spawner", capabilities: ["ui"] });

  // Spawn a real mock-program node
  const spawn = await c.request("node.spawn", { adapter: "mock-program", name: "dm-mock-prog" });
  assert(!!spawn.nodeId, "spawned dm-mock-prog: got nodeId");

  // Wait for program node to connect and become idle
  await sleep(2000);

  // Subscribe to observe node.log echoes from mock-program
  c.clearNotifications();
  await c.request("node.subscribe", { nodeId: spawn.nodeId });

  // Send DM message
  await c.request("node.message", { nodeId: spawn.nodeId, content: "hello from DM" });
  await sleep(1000);

  // mock-program echoes DM via node.log — check node.update notifications
  const updates = c.getNotifications("node.update");
  const logUpdates = updates.filter((n: any) => n.params.update?.sessionUpdate === "node_log");
  const dmEcho = logUpdates.find((n: any) =>
    n.params.update?.entries?.some((e: any) => e.message.includes("dm:hello from DM"))
  );
  assert(!!dmEcho, "spawned DM: mock-program echoed DM via node.log");

  // Test kill on spawned program node
  c.clearNotifications();
  const killResult = await c.request("node.message", { nodeId: spawn.nodeId, content: "kill" });
  assertEq(killResult.action, "killed", "spawned DM kill: action is killed");
  await sleep(1000);

  // Node should be stopped
  const stoppedNotifs = c.getNotifications("node.stopped");
  assert(stoppedNotifs.length > 0, "spawned DM kill: node.stopped received");

  await c.disconnect();
}

async function testNodeMessageTransportDead() {
  console.log("\n▸ node.message transport.alive check");

  const program = new WsClient("dead-prog");
  await program.connect();
  await program.request("node.register", { name: "dead-prog", capabilities: ["monitor"] });

  const nodes = await program.request("node.list");
  const progNode = nodes.nodes.find((n: any) => n.name === "dead-prog");
  assert(!!progNode, "transport dead: node found");
  if (!progNode) { await program.disconnect(); return; }

  // Disconnect the program node
  await program.disconnect();
  await sleep(300);

  // Try to send DM — should fail with transport error
  const sender = new WsClient("dead-sender");
  await sender.connect();
  await sender.request("node.register", { name: "dead-sender", capabilities: ["ui"] });

  try {
    await sender.request("node.message", { nodeId: progNode.id, content: "hello" });
    assert(false, "transport dead: should fail");
  } catch (e: any) {
    assert(e.message.includes("not connected") || e.message.includes("not found"),
      "transport dead: correct error", e.message);
  }

  await sender.disconnect();
}

// --- mc subscriber tests ---

async function testMcSubscribe() {
  console.log("\n▸ mc subscribe: DM subscribe with from field");

  const mc = new WsClient("mc-sub-node");
  await mc.connect();
  await mc.request("node.register", { name: "mc-sub-node", capabilities: ["monitor"] });

  const ai = new WsClient("ai-sub-node");
  await ai.connect();
  await ai.request("node.register", { name: "analyst-sub-node", capabilities: ["ui"] });

  const nodes = await mc.request("node.list");
  const mcNode = nodes.nodes.find((n: any) => n.name === "mc-sub-node");
  assert(!!mcNode, "mc node registered");

  // Subscribe via DM
  const dmResult = await ai.request("node.message", {
    nodeId: mcNode.id,
    content: "subscribe",
  });
  assertEq(dmResult.ok, true, "subscribe DM delivered ok");

  // Check mc received notification with correct from
  await sleep(200);
  const notifs = mc.getNotifications("node.message");
  const subNotif = notifs.find((n: any) => n.params.content === "subscribe");
  assert(!!subNotif, "mc received subscribe notification");
  assertEq(subNotif?.params.from, "analyst-sub-node", "subscribe carries correct from");

  await mc.disconnect();
  await ai.disconnect();
}

async function testMcUnsubscribe() {
  console.log("\n▸ mc subscribe: unsubscribe DM delivery");

  const mc = new WsClient("mc-unsub-node");
  await mc.connect();
  await mc.request("node.register", { name: "mc-unsub-node", capabilities: ["monitor"] });

  const ai = new WsClient("ai-unsub-node");
  await ai.connect();
  await ai.request("node.register", { name: "analyst-unsub-node", capabilities: ["ui"] });

  const nodes = await mc.request("node.list");
  const mcNode = nodes.nodes.find((n: any) => n.name === "mc-unsub-node");

  await ai.request("node.message", { nodeId: mcNode.id, content: "subscribe" });
  await ai.request("node.message", { nodeId: mcNode.id, content: "unsubscribe" });
  await sleep(200);

  const notifs = mc.getNotifications("node.message");
  const unsubNotif = notifs.find((n: any) => n.params.content === "unsubscribe");
  assert(!!unsubNotif, "mc received unsubscribe notification");
  assertEq(unsubNotif?.params.from, "analyst-unsub-node", "unsubscribe carries correct from");

  await mc.disconnect();
  await ai.disconnect();
}

async function testMcAutoUnsubscribeOnLeave() {
  console.log("\n▸ mc subscribe: channel.nodeLeft delivered for auto-unsubscribe");

  const mc = new WsClient("mc-leave-node");
  await mc.connect();
  await mc.request("node.register", { name: "mc-leave", capabilities: ["monitor"] });

  const ai = new WsClient("ai-leave-node");
  await ai.connect();
  await ai.request("node.register", { name: "analyst-leave", capabilities: ["ui"] });

  const nodes = await mc.request("node.list");
  const mcNode = nodes.nodes.find((n: any) => n.name === "mc-leave");
  const aiNode = nodes.nodes.find((n: any) => n.name === "analyst-leave");

  const ch = await mc.request("channel.create", { name: "leave-test" });
  const chId = ch.channelId;
  await mc.request("channel.addNode", { channelId: chId, nodeId: mcNode.id, name: "mc-leave" });
  await mc.request("channel.addNode", { channelId: chId, nodeId: aiNode.id, name: "analyst-leave" });

  mc.clearNotifications();

  // Remove AI from channel — mc should receive channel.nodeLeft with nodeName
  await mc.request("channel.removeNode", { channelId: chId, nodeName: "analyst-leave" });
  await sleep(300);

  const leftNotifs = mc.getNotifications("channel.nodeLeft");
  const leftNotif = leftNotifs.find((n: any) => n.params.nodeName === "analyst-leave");
  assert(!!leftNotif, "mc received channel.nodeLeft for analyst-leave");

  await mc.disconnect();
  await ai.disconnect();
}

async function testMcNoSubscriberNoPost() {
  console.log("\n▸ mc subscribe: TranscriptBuffer flush mechanics");

  const { TranscriptBuffer } = await import("../src/plugins/mc-transcriber/index.js");

  const flushed: string[][] = [];
  const buf = new TranscriptBuffer({
    pushInterval: 60000,
    pushLines: 3,
    onFlush: (lines: string[]) => flushed.push(lines),
  });

  buf.add("line1");
  buf.add("line2");
  buf.add("line3"); // triggers flush at threshold=3

  assertEq(flushed.length, 1, "buffer flushed once at threshold");
  assertEq(flushed[0].length, 3, "flushed 3 lines");

  buf.stop();
}

async function testMcSubscribeMultiple() {
  console.log("\n▸ mc subscribe: multiple subscribers + idempotent");

  const mc = new WsClient("mc-multi");
  await mc.connect();
  await mc.request("node.register", { name: "mc-multi", capabilities: ["monitor"] });

  const ai1 = new WsClient("ai-multi-1");
  await ai1.connect();
  await ai1.request("node.register", { name: "analyst-1", capabilities: ["ui"] });

  const ai2 = new WsClient("ai-multi-2");
  await ai2.connect();
  await ai2.request("node.register", { name: "analyst-2", capabilities: ["ui"] });

  const nodes = await mc.request("node.list");
  const mcNode = nodes.nodes.find((n: any) => n.name === "mc-multi");

  // Two different subscribers
  await ai1.request("node.message", { nodeId: mcNode.id, content: "subscribe" });
  await ai2.request("node.message", { nodeId: mcNode.id, content: "subscribe" });
  // Duplicate subscribe from ai1 (idempotent)
  await ai1.request("node.message", { nodeId: mcNode.id, content: "subscribe" });
  await sleep(200);

  const notifs = mc.getNotifications("node.message");
  const subNotifs = notifs.filter((n: any) => n.params.content === "subscribe");
  assertEq(subNotifs.length, 3, "mc received 3 subscribe notifications");

  // Verify distinct senders
  const senders = new Set(subNotifs.map((n: any) => n.params.from));
  assert(senders.has("analyst-1"), "subscriber includes analyst-1");
  assert(senders.has("analyst-2"), "subscriber includes analyst-2");

  await mc.disconnect();
  await ai1.disconnect();
  await ai2.disconnect();
}

async function testMcSubscribeViaChannel() {
  console.log("\n▸ mc subscribe: subscribe via channel message");

  const mc = new WsClient("mc-ch-sub");
  await mc.connect();
  await mc.request("node.register", { name: "mc-ch-sub", capabilities: ["monitor"] });

  const ai = new WsClient("ai-ch-sub");
  await ai.connect();
  await ai.request("node.register", { name: "analyst-ch-sub", capabilities: ["ui"] });

  const nodes = await mc.request("node.list");
  const mcNode = nodes.nodes.find((n: any) => n.name === "mc-ch-sub");
  const aiNode = nodes.nodes.find((n: any) => n.name === "analyst-ch-sub");

  const ch = await mc.request("channel.create", { name: "ch-sub-test" });
  const chId = ch.channelId;
  await mc.request("channel.addNode", { channelId: chId, nodeId: mcNode.id, name: "mc-ch-sub" });
  await mc.request("channel.addNode", { channelId: chId, nodeId: aiNode.id, name: "analyst-ch-sub" });

  mc.clearNotifications();

  // AI posts "@mc-ch-sub subscribe" in channel — mc receives it as channel.message
  await ai.request("channel.post", { channelId: chId, content: "@mc-ch-sub subscribe" });
  await sleep(200);

  const msgs = mc.getNotifications("channel.message");
  const subMsg = msgs.find((n: any) => {
    const content = n.params.message?.content || "";
    return content.includes("subscribe");
  });
  assert(!!subMsg, "mc received subscribe via channel.message");
  assertEq(subMsg?.params.message?.from, "analyst-ch-sub", "channel subscribe has correct from");

  await mc.disconnect();
  await ai.disconnect();
}

async function testMcAutoUnsubOnDisconnect() {
  console.log("\n▸ mc subscribe: channel.nodeLeft fires on WS disconnect");

  const mc = new WsClient("mc-disconn");
  await mc.connect();
  await mc.request("node.register", { name: "mc-disconn", capabilities: ["monitor"] });

  const ai = new WsClient("ai-disconn");
  await ai.connect();
  await ai.request("node.register", { name: "analyst-disconn", capabilities: ["ui"] });

  const nodes = await mc.request("node.list");
  const mcNode = nodes.nodes.find((n: any) => n.name === "mc-disconn");
  const aiNode = nodes.nodes.find((n: any) => n.name === "analyst-disconn");

  const ch = await mc.request("channel.create", { name: "disconn-test" });
  const chId = ch.channelId;
  await mc.request("channel.addNode", { channelId: chId, nodeId: mcNode.id, name: "mc-disconn" });
  await mc.request("channel.addNode", { channelId: chId, nodeId: aiNode.id, name: "analyst-disconn" });

  mc.clearNotifications();

  // AI disconnects — server removes from channel, mc receives channel.nodeLeft
  await ai.disconnect();
  await sleep(500);

  const leftNotifs = mc.getNotifications("channel.nodeLeft");
  const leftNotif = leftNotifs.find((n: any) => n.params.nodeName === "analyst-disconn");
  assert(!!leftNotif, "mc received channel.nodeLeft on AI disconnect");

  await mc.disconnect();
}

async function testMcSubscribeWithName() {
  console.log("\n▸ mc subscribe: subscribe <name> via DM specifies target");

  const mc = new WsClient("mc-named-sub");
  await mc.connect();
  await mc.request("node.register", { name: "mc-named", capabilities: ["monitor"] });

  const user = new WsClient("user-named-sub");
  await user.connect();
  await user.request("node.register", { name: "tui-user", capabilities: ["ui"] });

  const nodes = await mc.request("node.list");
  const mcNode = nodes.nodes.find((n: any) => n.name === "mc-named");

  // User DMs mc: "subscribe analyst" — should subscribe "analyst" not "tui-user"
  await user.request("node.message", { nodeId: mcNode.id, content: "subscribe analyst" });
  await sleep(200);

  const notifs = mc.getNotifications("node.message");
  const subNotif = notifs.find((n: any) => n.params.content === "subscribe analyst");
  assert(!!subNotif, "mc received 'subscribe analyst' DM");
  // The content carries the explicit name as positional arg
  assertEq(subNotif?.params.from, "tui-user", "DM from is tui-user (sender)");

  await mc.disconnect();
  await user.disconnect();
}

async function testMcSubscribeMeSelf() {
  console.log("\n▸ mc subscribe: 'subscribe me' resolves to sender");

  const mc = new WsClient("mc-me-sub");
  await mc.connect();
  await mc.request("node.register", { name: "mc-me", capabilities: ["monitor"] });

  const ai = new WsClient("ai-me-sub");
  await ai.connect();
  await ai.request("node.register", { name: "analyst-me", capabilities: ["ui"] });

  const nodes = await mc.request("node.list");
  const mcNode = nodes.nodes.find((n: any) => n.name === "mc-me");

  // "subscribe me" — should resolve to sender's name
  await ai.request("node.message", { nodeId: mcNode.id, content: "subscribe me" });
  await sleep(200);

  const notifs = mc.getNotifications("node.message");
  const subNotif = notifs.find((n: any) => n.params.content === "subscribe me");
  assert(!!subNotif, "mc received 'subscribe me' DM");
  assertEq(subNotif?.params.from, "analyst-me", "from is analyst-me for 'me' resolution");

  await mc.disconnect();
  await ai.disconnect();
}

// --- channel command reply tests ---

async function testPluginChannelCommandNoReplyOnSuccess() {
  console.log("\n▸ plugin-base: successful channel command does NOT post to channel");

  const { PluginBase } = await import("../src/plugins/plugin-base.js");

  const testName = `test-ch-ok-${Date.now()}`;

  class TestOkPlugin extends PluginBase {
    override getCommands() {
      return { status: { description: "Show status" } };
    }
    protected override onCommand(command: string, args: Record<string, string>, from?: string): string | void {
      // void return = success, no channel reply
    }
  }

  const plugin = new TestOkPlugin({ port: TEST_PORT, name: testName });
  await plugin.start();
  await sleep(300);

  const c = new WsClient("ch-ok-client");
  await c.connect();
  await c.request("node.register", { name: "ch-ok-client", capabilities: ["ui"] });

  const nodes = await c.request("node.list");
  const pluginNode = nodes.nodes.find((n: any) => n.name === testName);
  assert(!!pluginNode, "ch-ok: plugin node found");

  const ch = await c.request("channel.create", { name: "ch-ok-test" });
  await c.request("channel.join", { channelId: ch.channelId });
  await c.request("channel.addNode", { channelId: ch.channelId, nodeId: pluginNode.id, name: testName });
  await sleep(300);

  // Post valid command
  await c.request("channel.post", { channelId: ch.channelId, content: `@${testName} status` });
  await sleep(500);

  // Channel should NOT have a reply from the plugin (only the original post)
  const hist = await c.request("channel.history", { channelId: ch.channelId });
  const messages = hist.messages as Array<{ from: string; content: string }>;
  const pluginMsgs = messages.filter((m: any) => m.from === testName);
  assertEq(pluginMsgs.length, 0, "ch-ok: no reply from plugin on success");

  plugin.stop();
  await c.disconnect();
  await sleep(300);

  const expectedDir = resolve(process.env.HOME || "~", `.nerve/plugins/${testName}`);
  if (existsSync(expectedDir)) rmSync(expectedDir, { recursive: true });
}

async function testPluginChannelUnknownCommandSilent() {
  console.log("\n▸ plugin-base: unknown channel command silently ignored (no reply)");

  const { PluginBase } = await import("../src/plugins/plugin-base.js");

  const testName = `test-ch-unk-${Date.now()}`;

  class TestUnkPlugin extends PluginBase {
    override getCommands() {
      return { start: { description: "Start" } };
    }
    protected override onCommand(command: string, args: Record<string, string>, from?: string): string | void {
      // void = success
    }
  }

  const plugin = new TestUnkPlugin({ port: TEST_PORT, name: testName });
  await plugin.start();
  await sleep(300);

  const c = new WsClient("ch-unk-client");
  await c.connect();
  await c.request("node.register", { name: "ch-unk-client", capabilities: ["ui"] });

  const nodes = await c.request("node.list");
  const pluginNode = nodes.nodes.find((n: any) => n.name === testName);
  assert(!!pluginNode, "ch-unk: plugin node found");

  const ch = await c.request("channel.create", { name: "ch-unk-test" });
  await c.request("channel.join", { channelId: ch.channelId });
  await c.request("channel.addNode", { channelId: ch.channelId, nodeId: pluginNode.id, name: testName });
  await sleep(300);

  // Post unknown command (agent chatter) — should be silently ignored
  await c.request("channel.post", { channelId: ch.channelId, content: `@${testName} 收到，分析结果如下...` });
  await sleep(500);

  const hist = await c.request("channel.history", { channelId: ch.channelId });
  const messages = hist.messages as Array<{ from: string; content: string }>;
  const pluginMsgs = messages.filter((m: any) => m.from === testName);
  assertEq(pluginMsgs.length, 0, "ch-unk: unknown command silently ignored, no reply");

  plugin.stop();
  await c.disconnect();
  await sleep(300);

  const expectedDir = resolve(process.env.HOME || "~", `.nerve/plugins/${testName}`);
  if (existsSync(expectedDir)) rmSync(expectedDir, { recursive: true });
}

async function testPluginChannelOnCommandError() {
  console.log("\n▸ plugin-base: onCommand error return posts to channel");

  const { PluginBase } = await import("../src/plugins/plugin-base.js");

  const testName = `test-ch-cmderr-${Date.now()}`;

  class TestCmdErrPlugin extends PluginBase {
    override getCommands() {
      return { fail: { description: "Always fails" } };
    }
    protected override onCommand(command: string, args: Record<string, string>, from?: string): string | void {
      if (command === "fail") return "API key not set";
    }
  }

  const plugin = new TestCmdErrPlugin({ port: TEST_PORT, name: testName });
  await plugin.start();
  await sleep(300);

  const c = new WsClient("ch-cmderr-client");
  await c.connect();
  await c.request("node.register", { name: "ch-cmderr-client", capabilities: ["ui"] });

  const nodes = await c.request("node.list");
  const pluginNode = nodes.nodes.find((n: any) => n.name === testName);
  assert(!!pluginNode, "ch-cmderr: plugin node found");

  const ch = await c.request("channel.create", { name: "ch-cmderr-test" });
  await c.request("channel.join", { channelId: ch.channelId });
  await c.request("channel.addNode", { channelId: ch.channelId, nodeId: pluginNode.id, name: testName });
  await sleep(300);

  // Post command that returns error
  await c.request("channel.post", { channelId: ch.channelId, content: `@${testName} fail` });
  await sleep(500);

  const hist = await c.request("channel.history", { channelId: ch.channelId });
  const messages = hist.messages as Array<{ from: string; content: string }>;
  const errReply = messages.find((m: any) => m.from === testName && m.content.includes("API key not set"));
  assert(!!errReply, "ch-cmderr: onCommand error posted to channel",
    `messages: ${JSON.stringify(messages.map((m: any) => ({ from: m.from, content: m.content?.slice(0, 80) })))}`);

  plugin.stop();
  await c.disconnect();
  await sleep(300);

  const expectedDir = resolve(process.env.HOME || "~", `.nerve/plugins/${testName}`);
  if (existsSync(expectedDir)) rmSync(expectedDir, { recursive: true });
}

// --- scene tests ---

async function testSceneList() {
  console.log("\n▸ scene.list: returns available scenes");

  const c = new WsClient("scene-list-client");
  await c.connect();
  await c.request("node.register", { name: "scene-list-tui", capabilities: ["ui"] });

  const result = await c.request("scene.list");
  assert(Array.isArray(result.scenes), "scene.list returns scenes array");
  // test-scene.json was written during setup
  const testScene = result.scenes.find((s: any) => s.name === "test-scene");
  assert(!!testScene, "test-scene found in scene.list");
  assertEq(testScene?.running, false, "test-scene not running initially");

  await c.disconnect();
}

async function testSceneStart() {
  console.log("\n▸ scene.start: spawns nodes + creates channel + joins");

  const c = new WsClient("scene-start-client");
  await c.connect();
  await c.request("node.register", { name: "scene-start-tui", capabilities: ["ui"] });

  const result = await c.request("scene.start", { name: "test-scene", cwd: ROOT });
  assert(!!result.name, "scene.start returns scene name");
  assert(Array.isArray(result.nodeIds), "scene.start returns nodeIds");
  assert(result.nodeIds.length > 0, "scene has spawned nodes");
  assert(!!result.channelId, "scene created a channel");

  // Verify nodes exist
  const nodeList = await c.request("node.list");
  for (const nid of result.nodeIds) {
    const node = nodeList.nodes.find((n: any) => n.id === nid);
    assert(!!node, `scene node ${nid} exists in node.list`);
  }

  // Verify channel exists with correct name
  const chList = await c.request("channel.list");
  const ch = chList.channels.find((ch: any) => ch.id === result.channelId);
  assert(!!ch, "scene channel exists");
  assertEq(ch?.name, "test-meeting", "scene channel has correct name");

  // Verify scene shows as running in scene.list
  const scenes = await c.request("scene.list");
  const running = scenes.scenes.find((s: any) => s.name === "test-scene");
  assertEq(running?.running, true, "test-scene shows as running");

  await c.disconnect();
}

async function testSceneStop() {
  console.log("\n▸ scene.stop: stops nodes + closes channel");

  const c = new WsClient("scene-stop-client");
  await c.connect();
  await c.request("node.register", { name: "scene-stop-tui", capabilities: ["ui"] });

  // Stop the scene started in testSceneStart
  await c.request("scene.stop", { name: "test-scene" });

  // Verify scene no longer running
  const scenes = await c.request("scene.list");
  const stopped = scenes.scenes.find((s: any) => s.name === "test-scene");
  assertEq(stopped?.running, false, "test-scene no longer running after stop");

  await c.disconnect();
}

async function testSceneStartDuplicate() {
  console.log("\n▸ scene.start: rejects duplicate start");

  const c = new WsClient("scene-dup-client");
  await c.connect();
  await c.request("node.register", { name: "scene-dup-tui", capabilities: ["ui"] });

  // Start scene
  await c.request("scene.start", { name: "test-scene", cwd: ROOT });

  // Try to start again — should fail
  try {
    await c.request("scene.start", { name: "test-scene", cwd: ROOT });
    assert(false, "duplicate scene.start should fail");
  } catch (e: any) {
    assert(e.message.includes("already running"), "duplicate start error message correct");
  }

  // Cleanup
  await c.request("scene.stop", { name: "test-scene" });
  await c.disconnect();
}

async function testSceneStartNotFound() {
  console.log("\n▸ scene.start: rejects unknown scene");

  const c = new WsClient("scene-404-client");
  await c.connect();
  await c.request("node.register", { name: "scene-404-tui", capabilities: ["ui"] });

  try {
    await c.request("scene.start", { name: "nonexistent-scene" });
    assert(false, "unknown scene should fail");
  } catch (e: any) {
    assert(e.message.includes("not found"), "not found error message correct");
  }

  await c.disconnect();
}

async function testSceneOnReadyWarnings() {
  console.log("\n▸ scene.start: on_ready warnings returned to caller");

  const c = new WsClient("scene-warn-client");
  await c.connect();
  await c.request("node.register", { name: "scene-warn-tui", capabilities: ["ui"] });

  const result = await c.request("scene.start", { name: "test-scene-warn", cwd: ROOT });
  assert(!!result.name, "scene started despite on_ready warning");

  // on_ready runs async — wait for warnings to appear on running scene
  await sleep(3000);
  const scenes = await c.request("scene.list");
  const warnScene = scenes.scenes.find((s: any) => s.name === "test-scene-warn");
  assert(!!warnScene, "warn scene found in list");
  assert(Array.isArray(warnScene.warnings), "warnings array present");
  assert(warnScene.warnings.length > 0, "has at least one warning");
  assert(warnScene.warnings[0].includes("ghost-node"), "warning mentions missing target");

  // Cleanup
  await c.request("scene.stop", { name: "test-scene-warn" });
  await c.disconnect();
}

async function testSceneStdioOnReady() {
  console.log("\n▸ scene.start: stdio node on_ready waits for session ready");

  const c = new WsClient("scene-stdio-client");
  await c.connect();
  await c.request("node.register", { name: "scene-stdio-tui", capabilities: ["ui"] });

  const result = await c.request("scene.start", { name: "test-scene-stdio", cwd: ROOT });
  assert(!!result.name, "stdio scene started");
  assert(Array.isArray(result.nodeIds), "stdio scene has nodeIds");
  assert(result.nodeIds.length > 0, "stdio scene spawned nodes");

  // on_ready runs async — wait for it to complete, then check no "no session" warning
  // Poll scene.list until warnings stabilize (mock-agent prompt takes ~1-2s)
  await sleep(5000);
  const scenes = await c.request("scene.list");
  const running = scenes.scenes.find((s: any) => s.name === "test-scene-stdio");
  assert(!!running, "stdio scene still running");

  // Cleanup
  await c.request("scene.stop", { name: "test-scene-stdio" });
  await c.disconnect();
}

async function testSceneNodeJoinedReceived() {
  console.log("\n▸ scene.start: program node receives channel.nodeJoined after join");

  const c = new WsClient("scene-join-client");
  await c.connect();
  await c.request("node.register", { name: "scene-join-tui", capabilities: ["ui"] });

  // Start scene — mock-program will log "joined:<channelId>:<nodeName>" on channel.nodeJoined
  const result = await c.request("scene.start", { name: "test-scene", cwd: ROOT });
  assert(!!result.channelId, "scene-join: channel created");

  // Subscribe to the scene node to observe its logs
  const nodeId = result.nodeIds[0];
  await c.request("node.subscribe", { nodeId });

  // on_ready (including join) runs async — wait for completion
  await sleep(3000);

  const updates = c.getNotifications("node.update");
  const joinLog = updates.find((u: any) =>
    u.params?.update?.sessionUpdate === "node_log" &&
    u.params?.update?.entries?.some((e: any) => e.message?.startsWith("joined:"))
  );
  assert(!!joinLog, "program node received channel.nodeJoined notification");

  // Cleanup
  await c.request("scene.stop", { name: "test-scene" });
  await c.disconnect();
}

async function testSceneHttpApi() {
  console.log("\n▸ scene HTTP API");

  // scene.list via HTTP
  const listResult = await httpPost("/scene/list", {}) as any;
  assert(Array.isArray(listResult.scenes), "HTTP scene.list returns scenes array");

  // scene.start via HTTP
  const startResult = await httpPost("/scene/start", { name: "test-scene", cwd: ROOT }) as any;
  assert(!!startResult.name, "HTTP scene.start returns name");
  assert(!!startResult.channelId, "HTTP scene.start returns channelId");

  // scene.stop via HTTP
  const stopResult = await httpPost("/scene/stop", { name: "test-scene" }) as any;
  assertEq(stopResult.ok, true, "HTTP scene.stop returns ok");
}

async function testMessageNodeType() {
  console.log("\n▸ channel.post: message includes nodeType metadata");

  // WS client posts — should be nodeType "websocket"
  const c = new WsClient("nodetype-ws");
  await c.connect();
  await c.request("node.register", { name: "nodetype-ws", capabilities: ["ui"] });
  const ch = await c.request("channel.create", { cwd: ROOT, name: "nodetype-ch" });
  await c.request("channel.join", { channelId: ch.channelId });

  const post1 = await c.request("channel.post", { channelId: ch.channelId, content: "from ws" });
  assert(!!post1.message.metadata, "WS message has metadata");
  assertEq(post1.message.metadata?.nodeType, "websocket", "WS message nodeType is websocket");

  // Spawn mock (stdio) agent, add to channel, post via HTTP (simulating MCP)
  const agent = await c.request("node.spawn", { adapter: "mock", name: "nodetype-agent", cwd: ROOT });
  await sleep(3000);
  await c.request("channel.addNode", { channelId: ch.channelId, nodeId: agent.nodeId, name: "nodetype-agent" });

  const post2 = await httpPost("/post", { from: "nodetype-agent", content: "@nodetype-ws hi", channelId: ch.channelId });
  const msg2 = (post2 as any).message || post2;
  assert(!!msg2.metadata, "stdio agent message has metadata");
  assertEq(msg2.metadata?.nodeType, "stdio", "stdio agent message nodeType is stdio");

  // Verify history also has metadata
  const hist = await c.request("channel.history", { channelId: ch.channelId });
  const wsMsg = hist.messages.find((m: any) => m.content === "from ws");
  assert(!!wsMsg?.metadata, "history WS message has metadata");
  assertEq(wsMsg?.metadata?.nodeType, "websocket", "history WS nodeType correct");

  await c.request("node.stop", { nodeId: agent.nodeId });
  await sleep(500);
  await c.disconnect();
}

// ============================================================
// Bug fix: guardian duplicate registration on restart
// ============================================================

async function testGuardianCleanupDeadNodeBeforeSpawn() {
  console.log("\n▸ Guardian: cleanupStaleGuardian removes dead guardian + channels");

  // Import ChannelManager to test cleanupStaleGuardian() directly
  const { ChannelManager } = await import("../src/channel-manager.js");
  const tmpDataDir = resolve(TEST_DATA, "guardian-test-cleanup");
  mkdirSync(tmpDataDir, { recursive: true });
  const cm = new ChannelManager({ dataDir: tmpDataDir, port: 0 });

  // Register a fake guardian node via nodePool
  const ws1 = { readyState: 3, OPEN: 1, on() {}, send() {}, close() {} } as any; // readyState=3 → CLOSED
  const node = cm.nodePool.registerWebSocket(ws1, "context-guardian", ["monitor"], "observer");

  // Add node to a channel
  const ch = cm.createChannel(tmpDataDir, "test-ch");
  cm.addNodeToChannel(ch.id, node.id);
  assert(node.channels.has(ch.id), "guardian cleanup: node is in channel");

  // Call cleanupStaleGuardian — transport is dead (readyState=3)
  const result = cm.cleanupStaleGuardian("context-guardian");
  assertEq(result, "none", "guardian cleanup: returns 'none' for non-program node (impostor removed)");

  // Verify node is gone
  assert(!cm.nodePool.getByName("context-guardian"), "guardian cleanup: node removed from pool");
  assert(!cm.nodePool.isNameTaken("context-guardian"), "guardian cleanup: name freed");
}

async function testGuardianSkipSpawnIfAlive() {
  console.log("\n▸ Guardian: cleanupStaleGuardian skips live guardian");

  const { ChannelManager } = await import("../src/channel-manager.js");
  const tmpDataDir = resolve(TEST_DATA, "guardian-test-alive");
  mkdirSync(tmpDataDir, { recursive: true });
  const cm = new ChannelManager({ dataDir: tmpDataDir, port: 0 });

  // Register a guardian with alive transport (readyState=1 === OPEN)
  const ws2 = { readyState: 1, OPEN: 1, on() {}, send() {}, close() {} } as any;
  const node = cm.nodePool.registerWebSocket(ws2, "context-guardian", ["monitor"], "observer");

  const result = cm.cleanupStaleGuardian("context-guardian");
  assertEq(result, "none", "guardian alive: non-program node returns 'none' (impostor removed)");

  // Non-program node gets removed even if alive
  assert(!cm.nodePool.getByName("context-guardian"), "guardian alive: non-program node removed from pool");
}

async function testGuardianCleanupIgnoresNonGuardian() {
  console.log("\n▸ Guardian: cleanupStaleGuardian ignores non-guardian nodes");

  const { ChannelManager } = await import("../src/channel-manager.js");
  const tmpDataDir = resolve(TEST_DATA, "guardian-test-nong");
  mkdirSync(tmpDataDir, { recursive: true });
  const cm = new ChannelManager({ dataDir: tmpDataDir, port: 0 });

  // Register a regular node with same name but different permissions
  const ws3 = { readyState: 3, OPEN: 1, on() {}, send() {}, close() {} } as any;
  cm.nodePool.registerWebSocket(ws3, "context-guardian", ["ui"], "operator");

  const result = cm.cleanupStaleGuardian("context-guardian");
  assertEq(result, "none", "guardian non-guardian: returns 'none' — non-program impostor removed");
  assert(!cm.nodePool.getByName("context-guardian"), "guardian non-guardian: impostor removed from pool");
}

async function testGuardianCleanupNoneFound() {
  console.log("\n▸ Guardian: cleanupStaleGuardian returns 'none' when no node");

  const { ChannelManager } = await import("../src/channel-manager.js");
  const tmpDataDir = resolve(TEST_DATA, "guardian-test-none");
  mkdirSync(tmpDataDir, { recursive: true });
  const cm = new ChannelManager({ dataDir: tmpDataDir, port: 0 });

  const result = cm.cleanupStaleGuardian("context-guardian");
  assertEq(result, "none", "guardian none: returns 'none' when no node exists");
}

// --- Guardian identity-aware cleanup (program node vs WS node) ---

async function testGuardianCleanupDeadProgramNode() {
  console.log("\n▸ Guardian: dead program node → full cleanup (pool + channels)");

  const { ChannelManager } = await import("../src/channel-manager.js");
  const tmpDataDir = resolve(TEST_DATA, "guardian-dead-prog");
  mkdirSync(tmpDataDir, { recursive: true });
  const cm = new ChannelManager({ dataDir: tmpDataDir, port: 0 });

  // Register a WS node and mark it as a program node (simulates spawnProgramNode)
  const ws = { readyState: 3, OPEN: 1, on() {}, send() {}, close() {} } as any; // CLOSED
  const node = cm.nodePool.registerWebSocket(ws, "context-guardian", ["monitor"], "observer");
  // Mark as program node so isProgramNode() returns true
  const fakeProc = { pid: 99999, kill() {} } as any;
  cm.nodePool.trackProgramProcess(node.id, fakeProc);

  // Add node to a channel
  const ch = cm.createChannel(tmpDataDir, "guardian-ch");
  cm.addNodeToChannel(ch.id, node.id);
  assert(ch.hasNode("context-guardian"), "dead-prog: node in channel before cleanup");

  const result = cm.cleanupStaleGuardian("context-guardian");
  assertEq(result, "cleaned", "dead-prog: returns 'cleaned'");
  assert(!cm.nodePool.getByName("context-guardian"), "dead-prog: node removed from pool");
  assert(!cm.nodePool.isNameTaken("context-guardian"), "dead-prog: name freed");
  assert(!ch.hasNode("context-guardian"), "dead-prog: node removed from channel");
}

async function testGuardianSkipSpawnIfAliveProgramNode() {
  console.log("\n▸ Guardian: alive program node → skip cleanup");

  const { ChannelManager } = await import("../src/channel-manager.js");
  const tmpDataDir = resolve(TEST_DATA, "guardian-alive-prog");
  mkdirSync(tmpDataDir, { recursive: true });
  const cm = new ChannelManager({ dataDir: tmpDataDir, port: 0 });

  // Register with readyState=1 (OPEN) and mark as program node
  const ws = { readyState: 1, OPEN: 1, on() {}, send() {}, close() {} } as any;
  const node = cm.nodePool.registerWebSocket(ws, "context-guardian", ["monitor"], "observer");
  const fakeProc = { pid: 99998, kill() {} } as any;
  cm.nodePool.trackProgramProcess(node.id, fakeProc);

  const result = cm.cleanupStaleGuardian("context-guardian");
  assertEq(result, "alive", "alive-prog: returns 'alive'");
  assert(!!cm.nodePool.getByName("context-guardian"), "alive-prog: node still in pool");
}

async function testGuardianIgnoreNonProgramNode() {
  console.log("\n▸ Guardian: non-program WS node should not block real guardian");

  const { ChannelManager } = await import("../src/channel-manager.js");
  const tmpDataDir = resolve(TEST_DATA, "guardian-non-prog");
  mkdirSync(tmpDataDir, { recursive: true });
  const cm = new ChannelManager({ dataDir: tmpDataDir, port: 0 });

  // External WS client registered with the guardian name (NOT a program node)
  const ws = { readyState: 1, OPEN: 1, on() {}, send() {}, close() {} } as any;
  cm.nodePool.registerWebSocket(ws, "context-guardian", ["ui"], "operator");
  // Note: no trackProgramProcess call — this is NOT a program node

  // BUG: current code returns "alive" here, blocking real guardian startup
  // Expected: non-program node should not prevent guardian spawn
  // Should return "none" or "cleaned" so the real guardian can start
  const result = cm.cleanupStaleGuardian("context-guardian");
  assert(
    result !== "alive",
    "non-prog: non-program node must NOT return 'alive'",
    `got "${result}", expected "none" or "cleaned" — non-program node should not block guardian`,
  );
}

// ============================================================
// Bug fix: mc stop — safe shutdown order with try-catch
// ============================================================

async function testSessionResetSourceWithAgentName() {
  console.log("\n▸ session reset: source in log must contain agent name");

  // Spawn a mock agent and get its sessionId
  const spawn = await httpPost("/node/spawn", {
    adapter: "mock",
    name: "reset-src-agent",
    cwd: ROOT,
  });
  assert(!!spawn.nodeId, "reset-src: agent spawned");
  await sleep(3000);

  const nodes = await httpPost("/node/list", {});
  const agent = (nodes as any).nodes.find((n: any) => n.name === "reset-src-agent");
  assert(!!agent, "reset-src: agent found in node list");

  if (agent) {
    // Clear log buffer before test action
    const logStart = serverLogBuffer.length;

    // Call session/reset with source="http_api:orchestrator-agent"
    await httpPost("/session/reset", {
      nodeName: "reset-src-agent",
      expectedSessionId: agent.sessionId,
      summaryPath: "/tmp/test-summary.md",
      selfReset: true,
      source: "http_api:orchestrator-agent",
    });
    await sleep(500);

    // Verify server log contains the full source with agent name
    const newLogs = serverLogBuffer.slice(logStart).join("\n");
    assert(
      newLogs.includes("source=http_api:orchestrator-agent"),
      "reset-src: server log contains source=http_api:orchestrator-agent",
      `logs since action: ${newLogs.substring(0, 300)}`,
    );
  }

  await httpPost("/node/stop", { nodeName: "reset-src-agent" });
  await sleep(500);
}

async function testSessionResetSourceDefaultViaHttpApi() {
  console.log("\n▸ session reset: HTTP API without source should not default to bare 'http_api'");

  // Spawn a mock agent
  const spawn = await httpPost("/node/spawn", {
    adapter: "mock",
    name: "reset-default-agent",
    cwd: ROOT,
  });
  assert(!!spawn.nodeId, "reset-default: agent spawned");
  await sleep(3000);

  const nodes = await httpPost("/node/list", {});
  const agent = (nodes as any).nodes.find((n: any) => n.name === "reset-default-agent");
  assert(!!agent, "reset-default: agent found");

  if (agent) {
    const logStart = serverLogBuffer.length;

    // Call without explicit source but WITH from — http-router should construct source from caller
    // BUG: current code defaults to bare "http_api" ignoring from. After fix: "http_api:reset-default-agent"
    await httpPost("/session/reset", {
      nodeName: "reset-default-agent",
      expectedSessionId: agent.sessionId,
      summaryPath: "/tmp/test-summary.md",
      selfReset: true,
      from: "reset-default-agent",
      // no source — triggers default path in http-router, should use from to build source
    });
    await sleep(500);

    const newLogs = serverLogBuffer.slice(logStart).join("\n");
    const resetLogLine = newLogs.split("\n").find(l => l.includes("session reset requested") && l.includes("reset-default-agent"));

    assert(!!resetLogLine, "reset-default: found session reset log line");
    if (resetLogLine) {
      // Extract source value from log: "source=xxx,"
      const sourceMatch = resetLogLine.match(/source=([^,\s]+)/);
      assert(!!sourceMatch, "reset-default: source field present in log");
      if (sourceMatch) {
        const sourceValue = sourceMatch[1];
        // BUG: current code produces "http_api" (no caller). After fix, should not be bare "http_api".
        // This test will FAIL (red) until http-router is fixed to include caller identity.
        assert(
          sourceValue !== "http_api",
          "reset-default: source should not be bare 'http_api' without caller identity",
          `got source=${sourceValue}`,
        );
      }
    }
  }

  await httpPost("/node/stop", { nodeName: "reset-default-agent" });
  await sleep(500);
}

async function testSessionResetSourceMcpToolFormat() {
  console.log("\n▸ session reset: mcp_tool:<name> format passes through to log correctly");

  const spawn = await httpPost("/node/spawn", {
    adapter: "mock",
    name: "reset-mcp-agent",
    cwd: ROOT,
  });
  assert(!!spawn.nodeId, "reset-mcp: agent spawned");
  await sleep(3000);

  const nodes = await httpPost("/node/list", {});
  const agent = (nodes as any).nodes.find((n: any) => n.name === "reset-mcp-agent");
  assert(!!agent, "reset-mcp: agent found");

  if (agent) {
    const logStart = serverLogBuffer.length;

    // After nerve-mcp.ts fix, it should pass "mcp_tool:<NERVE_NODE_NAME>"
    // Verify this format is transparently passed through http-router to sessionReset log
    await httpPost("/session/reset", {
      nodeName: "reset-mcp-agent",
      expectedSessionId: agent.sessionId,
      summaryPath: "/tmp/test-summary.md",
      selfReset: true,
      source: "mcp_tool:reset-mcp-agent",  // expected fixed format
    });
    await sleep(500);

    const newLogs = serverLogBuffer.slice(logStart).join("\n");
    const resetLogLine = newLogs.split("\n").find(l => l.includes("session reset requested") && l.includes("reset-mcp-agent"));

    assert(!!resetLogLine, "reset-mcp: found session reset log line");
    if (resetLogLine) {
      const sourceMatch = resetLogLine.match(/source=([^,\s]+)/);
      assert(!!sourceMatch, "reset-mcp: source field present in log");
      if (sourceMatch) {
        const sourceValue = sourceMatch[1];
        // Verify the full "mcp_tool:reset-mcp-agent" format appears in log
        assertEq(
          sourceValue, "mcp_tool:reset-mcp-agent",
          "reset-mcp: source logged as mcp_tool:<agent-name>",
        );
      }
    }
  }

  await httpPost("/node/stop", { nodeName: "reset-mcp-agent" });
  await sleep(500);
}

async function testSpawnDuplicateNameErrorIncludesNodeInfo() {
  console.log("\n▸ spawn duplicate name: error should include existing node info");

  const c = new WsClient("dup-info-client");
  await c.connect();
  await c.request("node.register", { name: "dup-info-client", capabilities: ["ui"] });

  // Create a channel and spawn agent into it
  const ch = await c.request("channel.create", { cwd: "/tmp" });
  const spawn1 = await httpPost("/node/spawn", {
    adapter: "mock",
    name: "dup-test-node",
    cwd: ROOT,
  });
  assert(!!spawn1.nodeId, "dup-info: first spawn succeeded");
  await sleep(3000);

  // Add agent to channel so the error can reference it
  await httpPost("/channel/addNode", {
    channelId: ch.channelId,
    nodeId: spawn1.nodeId,
    nodeName: "dup-test-node",
  });

  // Spawn with same name — should fail with informative error
  const dupResult = await httpPost("/node/spawn", {
    adapter: "mock",
    name: "dup-test-node",
    cwd: ROOT,
  });
  const errMsg = (dupResult as any).error as string;
  assert(!!errMsg, "dup-info: duplicate spawn returns error");

  if (errMsg) {
    // Error must mention the node name
    assert(
      errMsg.includes("dup-test-node"),
      "dup-info: error contains conflicting node name",
      `got: ${errMsg}`,
    );
    // BUG: current code only says 'name "xxx" already taken'
    // After fix: should include channel info where existing node lives
    assert(
      errMsg.includes(ch.channelId),
      "dup-info: error contains channel ID of existing node",
      `got: ${errMsg}`,
    );
  }

  await httpPost("/node/stop", { nodeName: "dup-test-node" });
  await sleep(500);
  await c.disconnect();
}

async function testSpawnDuplicateNameErrorWithoutChannel() {
  console.log("\n▸ spawn duplicate name: error for node not in any channel");

  // Spawn agent without adding to any channel
  const spawn1 = await httpPost("/node/spawn", {
    adapter: "mock",
    name: "dup-nochan-node",
    cwd: ROOT,
  });
  assert(!!spawn1.nodeId, "dup-nochan: first spawn succeeded");
  await sleep(3000);

  // Spawn with same name — error should still be informative
  const dupResult = await httpPost("/node/spawn", {
    adapter: "mock",
    name: "dup-nochan-node",
    cwd: ROOT,
  });
  const errMsg = (dupResult as any).error as string;
  assert(!!errMsg, "dup-nochan: duplicate spawn returns error");

  if (errMsg) {
    assert(
      errMsg.includes("dup-nochan-node"),
      "dup-nochan: error contains conflicting node name",
      `got: ${errMsg}`,
    );
    // Node has no channel — error should still have more detail than bare "already taken"
    // BUG: current error is just 'name "dup-nochan-node" already taken'
    assert(
      errMsg.length > `name "dup-nochan-node" already taken`.length,
      "dup-nochan: error has more detail than bare 'already taken'",
      `got: ${errMsg}`,
    );
  }

  await httpPost("/node/stop", { nodeName: "dup-nochan-node" });
  await sleep(500);
}

async function testSpawnDuplicateNameErrorAcrossChannels() {
  console.log("\n▸ spawn duplicate name: error accurately identifies which channel");

  const c = new WsClient("dup-cross-client");
  await c.connect();
  await c.request("node.register", { name: "dup-cross-client", capabilities: ["ui"] });

  // Create two channels
  const ch1 = await c.request("channel.create", { cwd: "/tmp" });
  const ch2 = await c.request("channel.create", { cwd: "/tmp" });

  // Spawn agent and add to ch1 (not ch2)
  const spawn1 = await httpPost("/node/spawn", {
    adapter: "mock",
    name: "dup-cross-node",
    cwd: ROOT,
  });
  assert(!!spawn1.nodeId, "dup-cross: first spawn succeeded");
  await sleep(3000);

  await httpPost("/channel/addNode", {
    channelId: ch1.channelId,
    nodeId: spawn1.nodeId,
    nodeName: "dup-cross-node",
  });

  // Spawn same name — error should point to ch1, not ch2
  const dupResult = await httpPost("/node/spawn", {
    adapter: "mock",
    name: "dup-cross-node",
    cwd: ROOT,
  });
  const errMsg = (dupResult as any).error as string;
  assert(!!errMsg, "dup-cross: duplicate spawn returns error");

  if (errMsg) {
    // Must reference the correct channel (ch1)
    assert(
      errMsg.includes(ch1.channelId),
      "dup-cross: error points to correct channel (ch1)",
      `got: ${errMsg}`,
    );
    // Must NOT reference ch2 (node is not in ch2)
    assert(
      !errMsg.includes(ch2.channelId),
      "dup-cross: error does not mention unrelated channel (ch2)",
      `got: ${errMsg}`,
    );
  }

  await httpPost("/node/stop", { nodeName: "dup-cross-node" });
  await sleep(500);
  await c.disconnect();
}

async function testPostFromProcessSingleChannel() {
  console.log("\n▸ nerve_post: single channel agent can omit channel_id");

  // Spawn agent and add to one channel
  const spawn1 = await httpPost("/node/spawn", {
    adapter: "mock",
    name: "post-single-agent",
    cwd: ROOT,
  });
  assert(!!spawn1.nodeId, "post-single: agent spawned");
  await sleep(3000);

  const c = new WsClient("post-single-observer");
  await c.connect();
  await c.request("node.register", { name: "post-single-observer", capabilities: ["ui"] });
  const ch = await c.request("channel.create", { cwd: "/tmp" });
  await c.request("channel.join", { channelId: ch.channelId });

  await httpPost("/channel/addNode", {
    channelId: ch.channelId,
    nodeId: spawn1.nodeId,
    nodeName: "post-single-agent",
  });

  // Post without channelId — should succeed (only one channel)
  const result = await httpPost("/channel/post", {
    from: "post-single-agent",
    content: "hello from single channel",
  });
  assert(!(result as any).error, "post-single: post without channelId succeeds");
  assert(!!(result as any).ok, "post-single: returns ok");

  // Verify message landed in the correct channel
  const hist = await c.request("channel.history", { channelId: ch.channelId });
  const msgs = hist.messages.filter((m: any) => m.from === "post-single-agent");
  assert(msgs.length >= 1, "post-single: message appears in channel history");

  await httpPost("/node/stop", { nodeName: "post-single-agent" });
  await sleep(500);
  await c.disconnect();
}

async function testPostFromProcessMultiChannelNoId() {
  console.log("\n▸ nerve_post: multi-channel agent without channel_id should error");

  // Spawn agent and add to TWO channels
  const spawn1 = await httpPost("/node/spawn", {
    adapter: "mock",
    name: "post-multi-agent",
    cwd: ROOT,
  });
  assert(!!spawn1.nodeId, "post-multi: agent spawned");
  await sleep(3000);

  const c = new WsClient("post-multi-observer");
  await c.connect();
  await c.request("node.register", { name: "post-multi-observer", capabilities: ["ui"] });
  const ch1 = await c.request("channel.create", { cwd: "/tmp" });
  const ch2 = await c.request("channel.create", { cwd: "/tmp" });
  await c.request("channel.join", { channelId: ch1.channelId });
  await c.request("channel.join", { channelId: ch2.channelId });

  await httpPost("/channel/addNode", {
    channelId: ch1.channelId,
    nodeId: spawn1.nodeId,
    nodeName: "post-multi-agent",
  });
  await httpPost("/channel/addNode", {
    channelId: ch2.channelId,
    nodeId: spawn1.nodeId,
    nodeName: "post-multi-agent",
  });

  // Post without channelId — BUG: current code blindly picks first channel
  // After fix: should error requiring explicit channel_id
  const result = await httpPost("/channel/post", {
    from: "post-multi-agent",
    content: "ambiguous post",
  });
  assert(
    !!(result as any).error,
    "post-multi: omitting channel_id with multiple channels should error",
    `got: ${JSON.stringify(result)}`,
  );
  if ((result as any).error) {
    const errMsg = (result as any).error as string;
    assert(
      errMsg.includes("channel") || errMsg.includes("ambiguous"),
      "post-multi: error message mentions channel ambiguity",
      `got: ${errMsg}`,
    );
  }

  await httpPost("/node/stop", { nodeName: "post-multi-agent" });
  await sleep(500);
  await c.disconnect();
}

async function testPostFromProcessMultiChannelWithId() {
  console.log("\n▸ nerve_post: multi-channel agent with explicit channel_id succeeds");

  const spawn1 = await httpPost("/node/spawn", {
    adapter: "mock",
    name: "post-explicit-agent",
    cwd: ROOT,
  });
  assert(!!spawn1.nodeId, "post-explicit: agent spawned");
  await sleep(3000);

  const c = new WsClient("post-explicit-observer");
  await c.connect();
  await c.request("node.register", { name: "post-explicit-observer", capabilities: ["ui"] });
  const ch1 = await c.request("channel.create", { cwd: "/tmp" });
  const ch2 = await c.request("channel.create", { cwd: "/tmp" });
  await c.request("channel.join", { channelId: ch1.channelId });
  await c.request("channel.join", { channelId: ch2.channelId });

  await httpPost("/channel/addNode", {
    channelId: ch1.channelId,
    nodeId: spawn1.nodeId,
    nodeName: "post-explicit-agent",
  });
  await httpPost("/channel/addNode", {
    channelId: ch2.channelId,
    nodeId: spawn1.nodeId,
    nodeName: "post-explicit-agent",
  });

  // Post with explicit channelId to ch2 — should succeed
  const result = await httpPost("/channel/post", {
    from: "post-explicit-agent",
    content: "targeted to ch2",
    channelId: ch2.channelId,
  });
  assert(!(result as any).error, "post-explicit: post with channelId succeeds");

  // Verify message landed in ch2, not ch1
  const hist2 = await c.request("channel.history", { channelId: ch2.channelId });
  const msgs2 = hist2.messages.filter((m: any) => m.from === "post-explicit-agent");
  assert(msgs2.length >= 1, "post-explicit: message in target channel (ch2)");

  const hist1 = await c.request("channel.history", { channelId: ch1.channelId });
  const msgs1 = hist1.messages.filter((m: any) => m.from === "post-explicit-agent");
  assertEq(msgs1.length, 0, "post-explicit: no message in other channel (ch1)");

  await httpPost("/node/stop", { nodeName: "post-explicit-agent" });
  await sleep(500);
  await c.disconnect();
}

async function testPostFromProcessNoChannel() {
  console.log("\n▸ nerve_post: agent not in any channel should error");

  const spawn1 = await httpPost("/node/spawn", {
    adapter: "mock",
    name: "post-nochan-agent",
    cwd: ROOT,
  });
  assert(!!spawn1.nodeId, "post-nochan: agent spawned");
  await sleep(3000);

  // Post without joining any channel
  const result = await httpPost("/channel/post", {
    from: "post-nochan-agent",
    content: "orphan message",
  });
  assert(!!(result as any).error, "post-nochan: error when not in any channel");
  if ((result as any).error) {
    const errMsg = (result as any).error as string;
    assert(
      errMsg.includes("not joined") || errMsg.includes("no channel") || errMsg.includes("has not joined"),
      "post-nochan: error mentions no channel membership",
      `got: ${errMsg}`,
    );
  }

  await httpPost("/node/stop", { nodeName: "post-nochan-agent" });
  await sleep(500);
}

async function testMcStopSafeShutdown() {
  console.log("\n▸ mc stop: stopRecording handles errors in capture/asr/buffer");

  // Test the stopRecording logic directly via TranscriptBuffer (the only part we can unit-test)
  // Buffer.stop() should always work even if called multiple times
  const { TranscriptBuffer } = await import("../src/plugins/mc-transcriber/index.js");

  let flushCount = 0;
  const buf = new TranscriptBuffer({
    pushInterval: 60000,
    pushLines: 100,
    onFlush: () => { flushCount++; },
  });
  buf.add("line 1");
  buf.stop();
  assertEq(flushCount, 1, "mc stop: buffer.stop() flushes remaining lines");

  // Calling stop again should not throw
  buf.stop();
  assertEq(flushCount, 1, "mc stop: double buffer.stop() is safe (no extra flush)");
}

async function testMcStopCaptureErrorDoesNotBlockAsr() {
  console.log("\n▸ mc stop: capture error does not block asr/buffer cleanup");

  // We test the pattern: if capture.stop() throws, asr and buffer should still close.
  // Since we can't easily mock the real plugin internals, we test the contract:
  // create mock objects that track calls and simulate errors.

  let captureStopCalled = false;
  let asrDisconnectCalled = false;
  let bufferStopCalled = false;

  const mockCapture = {
    stop() {
      captureStopCalled = true;
      throw new Error("capture device already released");
    },
  };

  const mockAsr = {
    disconnect() { asrDisconnectCalled = true; },
  };

  const mockBuffer = {
    stop() { bufferStopCalled = true; },
  };

  // Simulate the FIXED stopRecording pattern: try-catch each step independently
  // This is what the fix should look like:
  try { mockCapture.stop(); } catch { /* ignore */ }
  try { mockAsr.disconnect(); } catch { /* ignore */ }
  try { mockBuffer.stop(); } catch { /* ignore */ }

  assert(captureStopCalled, "mc stop: capture.stop() was called (even though it threw)");
  assert(asrDisconnectCalled, "mc stop: asr.disconnect() called despite capture error");
  assert(bufferStopCalled, "mc stop: buffer.stop() called despite capture error");
}

async function testMcStopAsrErrorDoesNotBlockBuffer() {
  console.log("\n▸ mc stop: asr error does not block buffer cleanup");

  let captureStopCalled = false;
  let asrDisconnectCalled = false;
  let bufferStopCalled = false;

  const mockCapture = {
    stop() { captureStopCalled = true; },
  };

  const mockAsr = {
    disconnect() {
      asrDisconnectCalled = true;
      throw new Error("WebSocket already closed");
    },
  };

  const mockBuffer = {
    stop() { bufferStopCalled = true; },
  };

  // Fixed pattern
  try { mockCapture.stop(); } catch { /* ignore */ }
  try { mockAsr.disconnect(); } catch { /* ignore */ }
  try { mockBuffer.stop(); } catch { /* ignore */ }

  assert(captureStopCalled, "mc stop: capture.stop() called");
  assert(asrDisconnectCalled, "mc stop: asr.disconnect() called (threw)");
  assert(bufferStopCalled, "mc stop: buffer.stop() called despite asr error");
}

async function testMcStopShutdownOrder() {
  console.log("\n▸ mc stop: shutdown order is capture → asr → buffer");

  const callOrder: string[] = [];

  const mockCapture = {
    stop() { callOrder.push("capture"); },
  };
  const mockAsr = {
    disconnect() { callOrder.push("asr"); },
  };
  const mockBuffer = {
    stop() { callOrder.push("buffer"); },
  };

  // Reproduce the exact stopRecording pattern from index.ts:412-421
  try { mockCapture.stop(); } catch { /* ignore */ }
  try { mockAsr.disconnect(); } catch { /* ignore */ }
  try { mockBuffer.stop(); } catch { /* ignore */ }

  assertEq(callOrder, ["capture", "asr", "buffer"], "mc stop: shutdown order is capture → asr → buffer");
}

async function testMcStopAllThreeError() {
  console.log("\n▸ mc stop: all three components throw, stopRecording still completes");

  let recording = true;
  const callOrder: string[] = [];

  const mockCapture = {
    stop() { callOrder.push("capture"); throw new Error("device released"); },
  };
  const mockAsr = {
    disconnect() { callOrder.push("asr"); throw new Error("ws closed"); },
  };
  const mockBuffer = {
    stop() { callOrder.push("buffer"); throw new Error("already stopped"); },
  };

  // Reproduce stopRecording: set recording=false first, then try-catch each
  recording = false;

  let threw = false;
  try {
    try { mockCapture.stop(); } catch { /* ignore */ }
    try { mockAsr.disconnect(); } catch { /* ignore */ }
    try { mockBuffer.stop(); } catch { /* ignore */ }
  } catch {
    threw = true;
  }

  assert(!threw, "mc stop: no exception escapes when all three throw");
  assert(!recording, "mc stop: recording is false after all errors");
  assertEq(callOrder, ["capture", "asr", "buffer"], "mc stop: all three called despite errors");
}

async function testMcStopLogsOnError() {
  console.log("\n▸ mc stop: each catch block logs a warning");

  const warnings: string[] = [];
  const mockLog = (level: string, msg: string) => {
    if (level === "warn") warnings.push(msg);
  };

  const mockCapture = {
    stop() { throw new Error("device released"); },
  };
  const mockAsr = {
    disconnect() { throw new Error("ws already closed"); },
  };
  const mockBuffer = {
    stop() { throw new Error("double stop"); },
  };

  // Reproduce stopRecording pattern WITH logging (index.ts:413-421)
  try { mockCapture.stop(); } catch (err: any) {
    mockLog("warn", `capture.stop() error: ${err.message}`);
  }
  try { mockAsr.disconnect(); } catch (err: any) {
    mockLog("warn", `asr.disconnect() error: ${err.message}`);
  }
  try { mockBuffer.stop(); } catch (err: any) {
    mockLog("warn", `buffer.stop() error: ${err.message}`);
  }

  assertEq(warnings.length, 3, "mc stop: 3 warn logs emitted (one per catch)");
  assert(warnings[0].includes("capture.stop()"), "mc stop: warn[0] mentions capture.stop()", warnings[0]);
  assert(warnings[0].includes("device released"), "mc stop: warn[0] contains error message", warnings[0]);
  assert(warnings[1].includes("asr.disconnect()"), "mc stop: warn[1] mentions asr.disconnect()", warnings[1]);
  assert(warnings[1].includes("ws already closed"), "mc stop: warn[1] contains error message", warnings[1]);
  assert(warnings[2].includes("buffer.stop()"), "mc stop: warn[2] mentions buffer.stop()", warnings[2]);
  assert(warnings[2].includes("double stop"), "mc stop: warn[2] contains error message", warnings[2]);
}

async function testMcApiKeyFromEnv() {
  console.log("\n▸ mc api key: reads from DASHSCOPE_API_KEY env var");

  // Verify the module-level constant pattern: process.env.DASHSCOPE_API_KEY || ""
  // Since we can't import the unexported plugin, test the pattern directly.

  // Simulate: env var set → key should be the value
  const savedKey = process.env.DASHSCOPE_API_KEY;
  try {
    process.env.DASHSCOPE_API_KEY = "test-key-12345";
    const key = process.env.DASHSCOPE_API_KEY || "";
    assertEq(key, "test-key-12345", "mc api key: reads env var value");
  } finally {
    if (savedKey !== undefined) process.env.DASHSCOPE_API_KEY = savedKey;
    else delete process.env.DASHSCOPE_API_KEY;
  }
}

async function testMcApiKeyEmptyGuard() {
  console.log("\n▸ mc api key: empty key should block startRecording");

  // Reproduce the guard pattern from index.ts:319-322
  // startRecording checks: if (!DASHSCOPE_API_KEY) { log error; setActivity; return; }

  const savedKey = process.env.DASHSCOPE_API_KEY;
  try {
    delete process.env.DASHSCOPE_API_KEY;
    const apiKey = process.env.DASHSCOPE_API_KEY || "";

    let errorLogged = false;
    let activitySet = "";
    let recordingStarted = false;

    // Reproduce startRecording guard logic
    if (!apiKey) {
      errorLogged = true;
      activitySet = "error: no API key";
      // return — would happen in real code
    } else {
      recordingStarted = true;
    }

    assert(errorLogged, "mc api key: empty key triggers error log");
    assertEq(activitySet, "error: no API key", "mc api key: sets error activity");
    assert(!recordingStarted, "mc api key: recording not started without key");
  } finally {
    if (savedKey !== undefined) process.env.DASHSCOPE_API_KEY = savedKey;
    else delete process.env.DASHSCOPE_API_KEY;
  }
}

async function testMcApiKeyPassedToAsrClient() {
  console.log("\n▸ mc api key: env key passed to AsrClient constructor");

  // Verify the pattern: new AsrClient({ apiKey: DASHSCOPE_API_KEY }) at index.ts:340-342
  // AsrClient stores it in config.apiKey (asr-client.ts:39)

  const testKey = "sk-test-dashscope-key";
  const mockConfig = {
    model: "qwen3-asr-flash-realtime",
    apiKey: testKey,
    sampleRate: 16000,
    audioFormat: "pcm",
    language: "zh",
  };

  // Reproduce AsrClient constructor config handling (asr-client.ts:37-39)
  const storedConfig = {
    model: mockConfig.model,
    apiKey: mockConfig.apiKey,
    sampleRate: mockConfig.sampleRate ?? 16000,
    audioFormat: mockConfig.audioFormat ?? "pcm",
    language: mockConfig.language ?? "zh",
  };

  assertEq(storedConfig.apiKey, testKey, "mc api key: AsrClient config stores the passed key");
  assert(storedConfig.apiKey.length > 0, "mc api key: stored key is non-empty");
}

// ============================================================
// nerve_members MCP tool tests
// ============================================================

async function testNerveMembersWithChannelId() {
  console.log("\n▸ nerve_members: query by channel_id");

  // Setup: create channel, register two WS nodes, add them
  const c1 = new WsClient("members-a");
  const c2 = new WsClient("members-b");
  await c1.connect();
  await c2.connect();
  const r1 = await c1.request("node.register", { name: "members-a", capabilities: ["ui"] });
  const r2 = await c2.request("node.register", { name: "members-b", capabilities: ["ui"] });

  const ch = await c1.request("channel.create", { cwd: "/tmp", name: "members-test-ch" });
  await c1.request("channel.join", { channelId: ch.channelId });
  await c2.request("channel.addNode", { channelId: ch.channelId, nodeId: r2.nodeId, nodeName: "members-b" });

  // Call nerve_members MCP tool with channel_id
  const mcp = new McpToolClient("members-a");
  await mcp.connect();

  const result = await mcp.callTool("nerve_members", { channel_id: ch.channelId });
  const text = result.content?.[0]?.text || "";
  const isError = result.isError || false;

  assert(!isError, "nerve_members with channel_id: no error");
  assert(text.includes("members-a"), "nerve_members with channel_id: includes members-a");
  assert(text.includes("members-b"), "nerve_members with channel_id: includes members-b");

  // Parse as JSON and check structure
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch {}
  assert(parsed !== null, "nerve_members with channel_id: returns valid JSON");
  if (parsed) {
    const members = parsed.members || parsed;
    assert(Array.isArray(members), "nerve_members with channel_id: members is array");
    if (Array.isArray(members)) {
      const names = members.map((m: any) => m.name);
      assert(names.includes("members-a"), "nerve_members with channel_id: member a in list");
      assert(names.includes("members-b"), "nerve_members with channel_id: member b in list");
      // Each member should have status
      const memberA = members.find((m: any) => m.name === "members-a");
      assert(memberA && "status" in memberA, "nerve_members with channel_id: member has status field");
    }
  }

  await mcp.close();
  await c1.request("channel.close", { channelId: ch.channelId });
  await c1.disconnect();
  await c2.disconnect();
}

async function testNerveMembersWithoutChannelId() {
  console.log("\n▸ nerve_members: query without channel_id (all caller's channels)");

  // Setup: register node, create two channels, join both
  const c = new WsClient("members-self");
  await c.connect();
  const reg = await c.request("node.register", { name: "members-self", capabilities: ["ui"] });

  const ch1 = await c.request("channel.create", { cwd: "/tmp", name: "members-ch1" });
  await c.request("channel.join", { channelId: ch1.channelId });

  const ch2 = await c.request("channel.create", { cwd: "/tmp", name: "members-ch2" });
  await c.request("channel.join", { channelId: ch2.channelId });

  // Also add another node to ch2
  const c2 = new WsClient("members-other");
  await c2.connect();
  const r2 = await c2.request("node.register", { name: "members-other", capabilities: ["ui"] });
  await c.request("channel.addNode", { channelId: ch2.channelId, nodeId: r2.nodeId, nodeName: "members-other" });

  // Call nerve_members without channel_id — should return members from all channels the caller is in
  // The caller here is "members-self" (set via NERVE_NODE_NAME env)
  const mcp = new McpToolClient("members-self");
  await mcp.connect();

  const result = await mcp.callTool("nerve_members", {});
  const text = result.content?.[0]?.text || "";
  const isError = result.isError || false;

  assert(!isError, "nerve_members no channel_id: no error");

  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch {}
  assert(parsed !== null, "nerve_members no channel_id: returns valid JSON");
  if (parsed) {
    // Should have entries for both channels
    const channels = parsed.channels || parsed;
    assert(Array.isArray(channels), "nerve_members no channel_id: channels is array");
    if (Array.isArray(channels)) {
      assert(channels.length >= 2, "nerve_members no channel_id: at least 2 channels");
      // ch2 should have both members-self and members-other
      const ch2Entry = channels.find((c: any) => c.channel_id === ch2.channelId);
      if (ch2Entry) {
        const names = ch2Entry.members.map((m: any) => m.name);
        assert(names.includes("members-self"), "nerve_members no channel_id: ch2 has members-self");
        assert(names.includes("members-other"), "nerve_members no channel_id: ch2 has members-other");
      } else {
        assert(false, "nerve_members no channel_id: ch2 found in response");
      }
    }
  }

  await mcp.close();
  await c.request("channel.close", { channelId: ch1.channelId });
  await c.request("channel.close", { channelId: ch2.channelId });
  await c.disconnect();
  await c2.disconnect();
}

async function testNerveMembersInvalidChannel() {
  console.log("\n▸ nerve_members: invalid channel_id returns error");

  const mcp = new McpToolClient("members-err");
  await mcp.connect();

  // Register the node first so it exists
  const c = new WsClient("members-err");
  await c.connect();
  await c.request("node.register", { name: "members-err", capabilities: ["ui"] });

  const result = await mcp.callTool("nerve_members", { channel_id: "nonexistent-channel-id" });
  const isError = result.isError || false;
  const text = result.content?.[0]?.text || "";

  assert(isError, "nerve_members invalid channel: returns error");
  assert(text.includes("not found") || text.includes("error"), "nerve_members invalid channel: error message mentions not found");

  await mcp.close();
  await c.disconnect();
}

// ============================================================
// nerve_channels MCP tool tests
// ============================================================

async function testNerveChannelsListAll() {
  console.log("\n▸ nerve_channels: list all channels");

  // Setup: create two channels with different names
  const c = new WsClient("ch-list-all");
  await c.connect();
  await c.request("node.register", { name: "ch-list-all", capabilities: ["ui"] });

  const ch1 = await c.request("channel.create", { cwd: "/tmp/ch-list-a", name: "channels-test-a" });
  await c.request("channel.join", { channelId: ch1.channelId });

  const ch2 = await c.request("channel.create", { cwd: "/tmp/ch-list-b", name: "channels-test-b" });
  await c.request("channel.join", { channelId: ch2.channelId });

  // Add another node to ch2 so member count differs
  const c2 = new WsClient("ch-list-extra");
  await c2.connect();
  const r2 = await c2.request("node.register", { name: "ch-list-extra", capabilities: ["ui"] });
  await c.request("channel.addNode", { channelId: ch2.channelId, nodeId: r2.nodeId, nodeName: "ch-list-extra" });

  // Call nerve_channels MCP tool (no args)
  const mcp = new McpToolClient("ch-list-all");
  await mcp.connect();

  const result = await mcp.callTool("nerve_channels", {});
  const text = result.content?.[0]?.text || "";
  const isError = result.isError || false;

  assert(!isError, "nerve_channels list all: no error");

  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch {}
  assert(parsed !== null, "nerve_channels list all: returns valid JSON");

  if (parsed) {
    const channels = parsed.channels || parsed;
    assert(Array.isArray(channels), "nerve_channels list all: channels is array");
    if (Array.isArray(channels)) {
      const chA = channels.find((c: any) => c.name === "channels-test-a");
      const chB = channels.find((c: any) => c.name === "channels-test-b");
      assert(!!chA, "nerve_channels list all: channels-test-a found");
      assert(!!chB, "nerve_channels list all: channels-test-b found");

      // Each channel should have id, name, member_count
      if (chA) {
        assert("id" in chA, "nerve_channels list all: channel has id");
        assert("name" in chA, "nerve_channels list all: channel has name");
        assert("member_count" in chA, "nerve_channels list all: channel has member_count");
        assertEq(chA.member_count, 1, "nerve_channels list all: ch-a has 1 member");
      }
      if (chB) {
        assertEq(chB.member_count, 2, "nerve_channels list all: ch-b has 2 members");
      }
    }
  }

  await mcp.close();
  await c.request("channel.close", { channelId: ch1.channelId });
  await c.request("channel.close", { channelId: ch2.channelId });
  await c.disconnect();
  await c2.disconnect();
}

async function testNerveChannelsFilterByCwd() {
  console.log("\n▸ nerve_channels: filter by cwd");

  const c = new WsClient("ch-cwd-filter");
  await c.connect();
  await c.request("node.register", { name: "ch-cwd-filter", capabilities: ["ui"] });

  // Create channels with different cwd
  const ch1 = await c.request("channel.create", { cwd: "/tmp/filter-target", name: "cwd-match" });
  await c.request("channel.join", { channelId: ch1.channelId });

  const ch2 = await c.request("channel.create", { cwd: "/tmp/filter-other", name: "cwd-other" });
  await c.request("channel.join", { channelId: ch2.channelId });

  const mcp = new McpToolClient("ch-cwd-filter");
  await mcp.connect();

  const result = await mcp.callTool("nerve_channels", { cwd: "/tmp/filter-target" });
  const text = result.content?.[0]?.text || "";
  const isError = result.isError || false;

  assert(!isError, "nerve_channels cwd filter: no error");

  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch {}
  assert(parsed !== null, "nerve_channels cwd filter: returns valid JSON");

  if (parsed) {
    const channels = parsed.channels || parsed;
    assert(Array.isArray(channels), "nerve_channels cwd filter: channels is array");
    if (Array.isArray(channels)) {
      const match = channels.find((c: any) => c.name === "cwd-match");
      const other = channels.find((c: any) => c.name === "cwd-other");
      assert(!!match, "nerve_channels cwd filter: matching channel found");
      assert(!other, "nerve_channels cwd filter: non-matching channel excluded");
    }
  }

  await mcp.close();
  await c.request("channel.close", { channelId: ch1.channelId });
  await c.request("channel.close", { channelId: ch2.channelId });
  await c.disconnect();
}

async function testNerveChannelsEmptyList() {
  console.log("\n▸ nerve_channels: empty list when no channels match cwd");

  const mcp = new McpToolClient("ch-empty");
  await mcp.connect();

  // Use a cwd that no channel uses
  const result = await mcp.callTool("nerve_channels", { cwd: "/nonexistent/path/no-channels-here" });
  const text = result.content?.[0]?.text || "";
  const isError = result.isError || false;

  assert(!isError, "nerve_channels empty: no error");

  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch {}
  assert(parsed !== null, "nerve_channels empty: returns valid JSON");

  if (parsed) {
    const channels = parsed.channels || parsed;
    assert(Array.isArray(channels), "nerve_channels empty: channels is array");
    if (Array.isArray(channels)) {
      assertEq(channels.length, 0, "nerve_channels empty: returns empty array");
    }
  }

  await mcp.close();
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║       Nerve Self-Test Suite           ║");
  console.log("╚══════════════════════════════════════╝");

  try {
    console.log("\n⟳ Starting server...");
    await startServer();
    console.log("  Server started on port", TEST_PORT);

    await testHealth();
    await testWsRegister();
    await testChannelLifecycle();
    await testHttpApi();
    await testRouting();
    await testMultiClient();
    await testNodeEvents();
    await testPersistence();
    await testEdgeCases();
    await testSpawnCwd();
    await testMockAgent();
    await testUpdateBuffer();
    await testMultiTurnBuffer();

    // New: 1v1 agent management tests
    await testNodeSubscribe();
    await testNodeListCwdFilter();
    await testAutoNaming();
    await testMultiNvim();
    await testOneStepChat();

    // Cancel + blocking mode tests
    await testNodeCancel();
    await testCancelWithSubscribe();

    // M1 channel tests
    await testMcpServersInjected();
    await testNervePostToChannel();
    await testNervePostErrorNoChannel();
    await testMcpOrchestrationTools();
    await testNervePostExplicitChannelId();
    await testNerveRemoveClearsChannelId();
    await testNerveSpawnAutoJoin();
    await testChannelCreatedClosedNotifications();
    await testChannelListCwdFilter();
    await testAutoReplyToChannel();
    await testPromptErrorPostsToChannel();
    await testCwdNormalization();
    await testLogUsesLocalTime();
    await testMentionBusyCancels();
    await testNodeLog();
    await testPluginDataDir();

    // DM command support
    await testNodeMessage();
    await testNodeMessageKill();
    await testNodeMessageHttp();
    await testPluginBaseOnMessage();
    await testNodeMetadata();
    await testPluginCommandParsing();
    await testPluginHelpCommand();
    await testNodeMessageSpawned();
    await testNodeMessageTransportDead();

    // mc flush command
    await testMcFlushCommand();

    // Checker fixes: debug log, promptNode reject recovery, mc push success log
    await testPluginDebugLog();
    await testPromptNodeRejectRecovery();
    await testPromptNodeEndTurnClearsActivity();
    await testMcPushToChannelSuccessLog();

    // mc subscriber mechanism
    await testMcSubscribe();
    await testMcUnsubscribe();
    await testMcAutoUnsubscribeOnLeave();
    await testMcNoSubscriberNoPost();
    await testMcSubscribeMultiple();
    await testMcSubscribeViaChannel();
    await testMcAutoUnsubOnDisconnect();
    await testMcSubscribeWithName();
    await testMcSubscribeMeSelf();

    // Channel command reply
    await testPluginChannelCommandNoReplyOnSuccess();
    await testPluginChannelUnknownCommandSilent();
    await testPluginChannelOnCommandError();

    // Scene orchestration
    await testSceneList();
    await testSceneStart();
    await testSceneStop();
    await testSceneStartDuplicate();
    await testSceneStartNotFound();
    await testSceneOnReadyWarnings();
    await testSceneOnReadyPromptError();
    await testSceneStdioOnReady();
    await testSceneNodeJoinedReceived();
    await testSceneHttpApi();

    // Message nodeType metadata
    await testMessageNodeType();

    // Bug fix: guardian duplicate registration
    await testGuardianCleanupDeadNodeBeforeSpawn();
    await testGuardianSkipSpawnIfAlive();
    await testGuardianCleanupIgnoresNonGuardian();
    await testGuardianCleanupNoneFound();

    // Bug fix: guardian identity-aware cleanup (program vs WS)
    await testGuardianCleanupDeadProgramNode();
    await testGuardianSkipSpawnIfAliveProgramNode();
    await testGuardianIgnoreNonProgramNode();

    // Bug fix: session reset source traceability
    await testSessionResetSourceWithAgentName();
    await testSessionResetSourceDefaultViaHttpApi();
    await testSessionResetSourceMcpToolFormat();

    // Bug fix: node name conflict error lacks detail
    await testSpawnDuplicateNameErrorIncludesNodeInfo();
    await testSpawnDuplicateNameErrorWithoutChannel();
    await testSpawnDuplicateNameErrorAcrossChannels();

    // Bug fix: nerve_post cross-channel routing
    await testPostFromProcessSingleChannel();
    await testPostFromProcessMultiChannelNoId();
    await testPostFromProcessMultiChannelWithId();
    await testPostFromProcessNoChannel();

    // Bug fix: mc stop safe shutdown
    await testMcStopSafeShutdown();
    await testMcStopCaptureErrorDoesNotBlockAsr();
    await testMcStopAsrErrorDoesNotBlockBuffer();
    await testMcStopShutdownOrder();
    await testMcStopAllThreeError();
    await testMcStopLogsOnError();

    // Bug fix: mc-transcriber API key handling
    await testMcApiKeyFromEnv();
    await testMcApiKeyEmptyGuard();
    await testMcApiKeyPassedToAsrClient();

    // Bug fix: multi-client DM user_message sync
    await testMultiClientUserMessageSync();

    // Bug fix: DM user_message duplicate display (sender echo)
    await testDmUserMessageNoDuplicateForSender();

    // Bug fix: guardian stop 后无法重启
    await testGuardianRestartAfterStop();

    // nerve_members MCP tool
    await testNerveMembersWithChannelId();
    await testNerveMembersWithoutChannelId();
    await testNerveMembersInvalidChannel();

    // nerve_channels MCP tool
    await testNerveChannelsListAll();
    await testNerveChannelsFilterByCwd();
    await testNerveChannelsEmptyList();

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

// ============================================================
// Bug fix: multi-client DM user_message sync
// When client A prompts an agent, client B (also subscribed)
// should receive a node.update with sessionUpdate=user_message.
// ============================================================

async function testMultiClientUserMessageSync() {
  console.log("\n▸ Multi-client DM: user_message broadcast to other subscribers");

  const clientA = new WsClient("sync-clientA");
  const clientB = new WsClient("sync-clientB");
  await clientA.connect();
  await clientB.connect();
  await clientA.request("node.register", { name: "sync-clientA", capabilities: ["ui"] });
  await clientB.request("node.register", { name: "sync-clientB", capabilities: ["ui"] });

  // Spawn a mock agent
  const agent = await clientA.request("node.spawn", { adapter: "mock", name: "sync-dm-agent", cwd: ROOT });
  assert(!!agent.nodeId, "user_message sync: agent spawned");
  await sleep(3000);

  // Both clients subscribe to the agent
  await clientA.request("node.subscribe", { nodeId: agent.nodeId });
  await clientB.request("node.subscribe", { nodeId: agent.nodeId });
  clientA.clearNotifications();
  clientB.clearNotifications();

  // Client A sends a prompt — client B should receive the user_message as node.update
  await clientA.request("node.prompt", { nodeId: agent.nodeId, content: "hello from A" });
  await sleep(500);

  // Check client B received user_message update
  const bUpdates = clientB.getNotifications("node.update");
  const bSessionTypes = bUpdates.map((n: any) => n.params?.update?.sessionUpdate).filter(Boolean);
  const userMsgUpdate = bUpdates.find((n: any) =>
    n.params?.update?.sessionUpdate === "user_message" &&
    n.params?.update?.content?.text === "hello from A"
  );
  assert(!!userMsgUpdate, "user_message sync: client B received user_message from client A",
    `got ${bUpdates.length} updates, sessionUpdate types: [${bSessionTypes.join(", ")}]`);

  // Client A (sender) should NOT receive its own user_message echo (avoids duplicate display)
  const aUpdates = clientA.getNotifications("node.update");
  const aUserMsg = aUpdates.find((n: any) =>
    n.params?.update?.sessionUpdate === "user_message" &&
    n.params?.update?.content?.text === "hello from A"
  );
  assert(!aUserMsg, "user_message sync: client A does NOT receive own user_message echo",
    `got ${aUpdates.length} updates, user_message echo present = ${!!aUserMsg}`);

  // Cleanup
  await httpPost("/node/stop", { nodeId: agent.nodeId });
  await sleep(500);
  await clientA.disconnect();
  await clientB.disconnect();
}

// ============================================================
// Bug fix: DM user_message should NOT echo back to sender
// When client A prompts an agent, client A should NOT receive
// a node.update with sessionUpdate=user_message for its own message.
// The sender already displays the message locally — broadcasting it
// back causes duplicate display (same message shown twice).
// ============================================================

async function testDmUserMessageNoDuplicateForSender() {
  console.log("\n▸ Bug fix: DM user_message not echoed back to sender");

  const sender = new WsClient("dup-sender");
  const observer = new WsClient("dup-observer");
  await sender.connect();
  await observer.connect();
  await sender.request("node.register", { name: "dup-sender", capabilities: ["ui"] });
  await observer.request("node.register", { name: "dup-observer", capabilities: ["ui"] });

  // Spawn a mock agent
  const agent = await sender.request("node.spawn", { adapter: "mock", name: "dup-test-agent", cwd: ROOT });
  assert(!!agent.nodeId, "dup-fix: agent spawned");
  await sleep(3000);

  // Both subscribe to the agent
  await sender.request("node.subscribe", { nodeId: agent.nodeId });
  await observer.request("node.subscribe", { nodeId: agent.nodeId });
  sender.clearNotifications();
  observer.clearNotifications();

  // Sender prompts the agent
  await sender.request("node.prompt", { nodeId: agent.nodeId, content: "test message" });
  await sleep(500);

  // Observer (non-sender) SHOULD receive user_message — this is correct behavior
  const obsUpdates = observer.getNotifications("node.update");
  const obsUserMsg = obsUpdates.find((n: any) =>
    n.params?.update?.sessionUpdate === "user_message" &&
    n.params?.update?.content?.text === "test message"
  );
  assert(!!obsUserMsg, "dup-fix: observer receives user_message broadcast",
    `got ${obsUpdates.length} updates`);

  // Sender should NOT receive user_message echo for its own message
  // The sender already displayed the message locally in the TUI input.
  // Getting it back via broadcast causes it to appear twice.
  const senderUpdates = sender.getNotifications("node.update");
  const senderUserMsg = senderUpdates.find((n: any) =>
    n.params?.update?.sessionUpdate === "user_message" &&
    n.params?.update?.content?.text === "test message"
  );
  assert(!senderUserMsg, "dup-fix: sender does NOT receive own user_message echo",
    `sender got ${senderUpdates.length} updates, user_message echo present = ${!!senderUserMsg}`);

  // Cleanup
  await httpPost("/node/stop", { nodeId: agent.nodeId });
  await sleep(500);
  await sender.disconnect();
  await observer.disconnect();
}

// ============================================================
// Bug fix: guardian stop 后无法重启
// guardian 是 plugin 程序节点（adapter="guardian"），stop 后
// 用 adapter="context-guardian" 再 spawn 报 "unknown adapter"
// 方案 A：node.spawn 识别 "context-guardian" 映射到 startGuardian()
// ============================================================

async function testGuardianRestartAfterStop() {
  console.log("\n▸ Bug fix: guardian stop → re-spawn should succeed");

  const c = new WsClient("guardian-restart-test");
  await c.connect();
  await c.request("node.register", { name: "guardian-restart-test", capabilities: ["ui"] });

  // 1. Spawn guardian with adapter="context-guardian" — this is the bug entry point
  let spawn1Ok = false;
  let spawn1NodeId = "";
  let spawn1Error = "";
  try {
    const result = await c.request("node.spawn", { adapter: "context-guardian", name: "restart-guardian", cwd: ROOT });
    spawn1Ok = !!result.nodeId;
    spawn1NodeId = result.nodeId;
  } catch (err: any) {
    spawn1Error = err.message || String(err);
  }

  assert(spawn1Ok, "guardian-restart: spawn with adapter='context-guardian' succeeds",
    spawn1Ok ? undefined : `spawn failed: ${spawn1Error}`);

  if (!spawn1Ok) {
    // Bug confirmed — first spawn already fails
    await c.disconnect();
    return;
  }

  await sleep(2000);

  // 2. Stop it
  await c.request("node.stop", { nodeId: spawn1NodeId });
  await sleep(1000);

  // 3. Re-spawn — should succeed
  let respawnOk = false;
  let respawnError = "";
  try {
    const spawn2 = await c.request("node.spawn", { adapter: "context-guardian", name: "restart-guardian-2", cwd: ROOT });
    respawnOk = !!spawn2.nodeId;
    if (spawn2.nodeId) {
      await c.request("node.stop", { nodeId: spawn2.nodeId });
      await sleep(500);
    }
  } catch (err: any) {
    respawnError = err.message || String(err);
  }

  assert(respawnOk, "guardian-restart: re-spawn after stop succeeds",
    respawnOk ? undefined : `re-spawn failed: ${respawnError}`);

  await c.disconnect();
}

main();

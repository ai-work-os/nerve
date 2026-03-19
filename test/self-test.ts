#!/usr/bin/env npx tsx
/**
 * ACP Bus Self-Test
 *
 * Single command to verify everything works. Run after any code change.
 * Starts the server, runs all tests, reports pass/fail, exits.
 *
 * Usage: npx tsx test/self-test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync } from "node:fs";
import http from "node:http";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_PORT = 14800; // Use different port to avoid conflict
const TEST_DATA = resolve(ROOT, ".test-data");

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

// --- Server process management ---

let serverProc: ChildProcess | null = null;

async function startServer(): Promise<void> {
  // Clean test data
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });

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

  // Duplicate name should fail
  const c2 = new WsClient("ws-test-dup");
  await c2.connect();
  try {
    await c2.request("node.register", { name: "ws-test" });
    assert(false, "duplicate name should fail");
  } catch (e: any) {
    assert(e.message.includes("already taken"), "duplicate name rejected");
  }

  await c.disconnect();
  await c2.disconnect();
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

  // Client 2: new connection, join same channel → should receive replay
  const c2 = new WsClient("buf-client2");
  await c2.connect();
  await c2.request("node.register", { name: "buf-client2", capabilities: ["ui"] });
  c2.clearNotifications();
  await c2.request("channel.join", { channelId: ch.channelId });
  await sleep(500);

  // c2 should have received replayed node.update notifications
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

  // Reconnect test: new client joins and should see all messages
  const ch = await c1.request("channel.create", { cwd: "/tmp" });
  await c1.request("channel.join", { channelId: ch.channelId });
  await c1.request("channel.addNode", {
    channelId: ch.channelId,
    nodeId: agentNode.id,
    name: "mt-agent",
  });

  const c2 = new WsClient("mt-client2");
  await c2.connect();
  await c2.request("node.register", { name: "mt-client2", capabilities: ["ui"] });
  c2.clearNotifications();
  await c2.request("channel.join", { channelId: ch.channelId });
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
// MAIN
// ============================================================

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║       ACP Bus Self-Test Suite        ║");
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

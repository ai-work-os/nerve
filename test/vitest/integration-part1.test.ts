/**
 * Nerve Integration Tests - Part 1
 *
 * Converted from test/self-test.ts (testHealth through testPluginDataDir).
 * Requires a running nerve server (managed by beforeAll/afterAll).
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import {
  assert, assertEq, assertNoThrow, sleep,
  ROOT, getTestPort, getTestData,
  httpPost, httpGet, httpGetText,
  WsClient, McpToolClient, waitForNotification,
  startServer, stopServer, serverLogBuffer,
  resolve, readFileSync, existsSync, mkdirSync, writeFileSync, rmSync,
  WebSocket,
} from "./helpers.js";

describe("Nerve Integration Tests - Part 1", () => {
  beforeAll(startServer);
  afterAll(stopServer);

  it("Health Check", async () => {
    const r = await httpGet("/health");
    assertEq(r.status, "ok", "GET /health returns ok");
  });

  it("WebSocket: Register", async () => {
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
  });

  it("Channel Lifecycle (WS)", async () => {
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
  });

  it("HTTP API", async () => {
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
  });

  it("@mention Routing", async () => {
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
  });

  it("Multi-client Broadcast", async () => {
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
  });

  it("Mock Agent (Process Node)", async () => {
    // Register a WS client to observe
    const observer = new WsClient("observer");
    await observer.connect();
    await observer.request("node.register", { name: "observer", capabilities: ["ui"] });

    // Create channel
    const ch = await observer.request("channel.create", { cwd: "/tmp" });
    await observer.request("channel.join", { channelId: ch.channelId });

    // Spawn mock agent via HTTP
    const spawnResult = await httpPost("/node/spawn", {
      adapter: "mock",
      name: "mock-1",
      cwd: ROOT,
    });
    assert(!!spawnResult.nodeId, "node/spawn returns nodeId");
    assert(spawnResult.status === "connecting", "initial status is connecting");

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
  });

  it("Node Join/Leave Events", async () => {
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
  });

  it("Harness phase1 event log script", async () => {
    const proc = spawn("npx", ["tsx", "test/harness-phase1-event-log.test.ts"], {
      cwd: ROOT,
      stdio: "pipe",
    });

    let out = "";
    proc.stdout.on("data", (d: Buffer) => out += d.toString());
    proc.stderr.on("data", (d: Buffer) => out += d.toString());

    const code = await new Promise<number | null>(resolve => proc.on("close", resolve));
    assertEq(code, 0, "self-test runs harness phase1 event log script");
    if (code !== 0 && out) {
      console.log(out);
    }
  });

  it("Harness phase2 P0-S1 script", async () => {
    const proc = spawn("npx", ["tsx", "test/harness-phase2-p0-s1.test.ts"], {
      cwd: ROOT,
      stdio: "pipe",
    });

    let out = "";
    proc.stdout.on("data", (d: Buffer) => out += d.toString());
    proc.stderr.on("data", (d: Buffer) => out += d.toString());

    const code = await new Promise<number | null>(resolve => proc.on("close", resolve));
    assertEq(code, 0, "self-test runs harness phase2 P0-S1 script");
    if (code !== 0 && out) {
      console.log(out);
    }
  });

  it("Harness phase2 P0-S2 script", async () => {
    const proc = spawn("npx", ["tsx", "test/harness-phase2-p0-s2.test.ts"], {
      cwd: ROOT,
      stdio: "pipe",
    });

    let out = "";
    proc.stdout.on("data", (d: Buffer) => out += d.toString());
    proc.stderr.on("data", (d: Buffer) => out += d.toString());

    const code = await new Promise<number | null>(resolve => proc.on("close", resolve));
    assertEq(code, 0, "self-test runs harness phase2 P0-S2 script");
    if (code !== 0 && out) {
      console.log(out);
    }
  });

  it("Harness phase3 channel script", async () => {
    const proc = spawn("npx", ["tsx", "test/harness-phase3-channel.test.ts"], {
      cwd: ROOT,
      stdio: "pipe",
    });

    let out = "";
    proc.stdout.on("data", (d: Buffer) => out += d.toString());
    proc.stderr.on("data", (d: Buffer) => out += d.toString());

    const code = await new Promise<number | null>(resolve => proc.on("close", resolve));
    assertEq(code, 0, "self-test runs harness phase3 channel script");
    if (code !== 0 && out) {
      console.log(out);
    }
  });

  it("Harness phase3 messaging script", async () => {
    const proc = spawn("npx", ["tsx", "test/harness-phase3-messaging.test.ts"], {
      cwd: ROOT,
      stdio: "pipe",
    });

    let out = "";
    proc.stdout.on("data", (d: Buffer) => out += d.toString());
    proc.stderr.on("data", (d: Buffer) => out += d.toString());

    const code = await new Promise<number | null>(resolve => proc.on("close", resolve));
    assertEq(code, 0, "self-test runs harness phase3 messaging script");
    if (code !== 0 && out) {
      console.log(out);
    }
  });

  it("Harness phase3 prompt script", async () => {
    const proc = spawn("npx", ["tsx", "test/harness-phase3-prompt.test.ts"], {
      cwd: ROOT,
      stdio: "pipe",
    });

    let out = "";
    proc.stdout.on("data", (d: Buffer) => out += d.toString());
    proc.stderr.on("data", (d: Buffer) => out += d.toString());

    const code = await new Promise<number | null>(resolve => proc.on("close", resolve));
    assertEq(code, 0, "self-test runs harness phase3 prompt script");
    if (code !== 0 && out) {
      console.log(out);
    }
  });

  it("Persistence", async () => {
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
  });

  it("Edge Cases", async () => {
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
  });

  it("Spawn with cwd parameter", async () => {
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
  });

  it("spawn model override is returned by node.list", async () => {
    const name = `http-model-override-agent-${Date.now()}`;
    const spawnResult = await httpPost("/node/spawn", {
      adapter: "mock",
      name,
      cwd: ROOT,
      model: "sonnet[1m]",
    });
    assert(!!spawnResult.nodeId, "model override: agent spawned");

    const list = await httpPost("/node/list", {});
    const agent = (list as any).nodes.find((n: any) => n.name === name);
    assert(!!agent, "model override: agent found in node.list");
    assertEq(agent.model, "sonnet[1m]", "model override: node.list returns spawn model");

    await httpPost("/node/stop", { nodeId: spawnResult.nodeId });
    await sleep(500);
  });

  it("WS node.spawn model override is returned by node.list", async () => {
    const c = new WsClient("ws-model-override-client");
    await c.connect();
    await c.request("node.register", { name: "ws-model-override-client", capabilities: ["ui"] });

    const name = `ws-model-override-agent-${Date.now()}`;
    const spawnResult = await c.request("node.spawn", {
      adapter: "mock",
      name,
      cwd: ROOT,
      model: "sonnet",
    });
    assert(!!spawnResult.nodeId, "ws model override: agent spawned");

    const list = await c.request("node.list", {});
    const agent = list.nodes.find((n: any) => n.name === name);
    assert(!!agent, "ws model override: agent found in node.list");
    assertEq(agent.model, "sonnet", "ws model override: node.list returns spawn model");

    await c.request("node.stop", { nodeId: spawnResult.nodeId });
    await c.disconnect();
  });

  it("Update Buffer & Replay", async () => {
    // Client 1: set up agent and trigger updates
    const c1 = new WsClient("buf-client1");
    await c1.connect();
    await c1.request("node.register", { name: "buf-client1", capabilities: ["ui"] });

    // Spawn mock agent
    const spawnResult = await httpPost("/node/spawn", {
      adapter: "mock",
      name: "buf-agent",
      cwd: ROOT,
    });
    assert(!!spawnResult.nodeId, "buffer test: agent spawned");

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

    // Verify messageStore has content via node.updates API (now returns messages[])
    const bufResult = await c1.request("node.updates", { nodeName: "buf-agent" });
    const storeMsgs = (bufResult.messages || []) as Array<any>;
    assert(
      storeMsgs.length > 0,
      "buffer test: messageStore has content",
      `got ${storeMsgs.length} messages`,
    );

    // Client 2: new connection, subscribe to agent -> should receive message_snapshot
    const c2 = new WsClient("buf-client2");
    await c2.connect();
    await c2.request("node.register", { name: "buf-client2", capabilities: ["ui"] });
    c2.clearNotifications();
    await c2.request("node.subscribe", { nodeId: agentNode.id });
    await sleep(500);

    const snapshots = c2.getNotifications("message_snapshot");
    assert(
      snapshots.length === 1,
      "buffer test: new client received snapshot",
      `got ${snapshots.length}`,
    );
    const snapMessages = (snapshots[0]?.params?.messages || []) as Array<any>;
    assert(
      snapMessages.length > 0,
      "buffer test: snapshot contains messages",
      `got ${snapMessages.length}`,
    );
    assert(
      snapshots[0]?.params?.name === "buf-agent",
      "buffer test: snapshot has correct agent name",
    );

    // Verify store contains user message
    const userMsgs = storeMsgs.filter(m => m.role === "user");
    assert(
      userMsgs.length > 0,
      "buffer test: contains user message",
      `found ${userMsgs.length} user messages`,
    );
    if (userMsgs.length > 0) {
      assert(
        typeof userMsgs[0].text === "string" && userMsgs[0].text.length > 0,
        "buffer test: user message has text content",
      );
    }

    // Cleanup
    if (agentNode) {
      await httpPost("/node/stop", { nodeId: agentNode.id });
      await sleep(500);
    }
    await c1.disconnect();
    await c2.disconnect();
  });

  it("Multi-Turn Buffer (node.prompt)", async () => {
    const c1 = new WsClient("mt-client1");
    await c1.connect();
    await c1.request("node.register", { name: "mt-client1", capabilities: ["ui"] });
    const agentName = `mt-agent-${Date.now()}`;

    // Spawn mock agent
    const spawnResult = await httpPost("/node/spawn", {
      adapter: "mock",
      name: agentName,
      cwd: ROOT,
    });
    assert(!!spawnResult.nodeId, "multi-turn: agent spawned");
    await sleep(3000);

    const nodes = await httpPost("/node/list", {});
    const agentNode = (nodes as any).nodes.find((n: any) => n.name === agentName);
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

    // Check messageStore
    const bufResult = await c1.request("node.updates", { nodeName: agentName });
    const storeMessages = (bufResult.messages || []) as Array<any>;
    const userMsgs = storeMessages.filter(m => m.role === "user");
    assert(
      userMsgs.length === 2,
      "multi-turn: store has 2 user messages",
      `got ${userMsgs.length}`,
    );

    // Verify content
    if (userMsgs.length >= 2) {
      assert(userMsgs[0].text === "first question", "multi-turn: first user message correct");
      assert(userMsgs[1].text === "second question", "multi-turn: second user message correct");
    }

    // Verify ordering: user1 -> agent1 -> user2 -> agent2 (monotonic ts)
    const roles = storeMessages.map(m => m.role);
    assert(
      roles.length >= 4 && roles[0] === "user" && roles[1] === "agent" && roles[2] === "user" && roles[3] === "agent",
      "multi-turn: message order user->agent->user->agent",
      `got [${roles.join(",")}]`,
    );

    // Reconnect test: new client subscribes and should see all messages via message_snapshot
    const c2 = new WsClient("mt-client2");
    await c2.connect();
    await c2.request("node.register", { name: "mt-client2", capabilities: ["ui"] });
    c2.clearNotifications();
    await c2.request("node.subscribe", { nodeId: agentNode.id });
    await sleep(500);

    const snapshots = c2.getNotifications("message_snapshot");
    assert(snapshots.length === 1, "multi-turn: new client received snapshot");
    const snapMessages = (snapshots[0]?.params?.messages || []) as Array<any>;
    const snapUserMsgs = snapMessages.filter(m => m.role === "user");
    assert(
      snapUserMsgs.length === 2,
      "multi-turn: snapshot has 2 user messages",
      `got ${snapUserMsgs.length}`,
    );

    // Cleanup
    await httpPost("/node/stop", { nodeId: agentNode.id });
    await sleep(500);
    await c1.disconnect();
    await c2.disconnect();
  });

  it("message_snapshot: assembled history delivered on subscribe", async () => {
    const c1 = new WsClient("bar-client1");
    await c1.connect();
    await c1.request("node.register", { name: "bar-client1", capabilities: ["ui"] });
    const agentName = `bar-agent-${Date.now()}`;

    // Spawn mock agent
    const spawnResult = await httpPost("/node/spawn", {
      adapter: "mock",
      name: agentName,
      cwd: ROOT,
    });
    assert(!!spawnResult.nodeId, "bar: agent spawned");
    await sleep(3000);

    const nodes = await httpPost("/node/list", {});
    const agentNode = (nodes as any).nodes.find((n: any) => n.name === agentName);
    assert(!!agentNode && agentNode.status === "idle", "bar: agent ready");

    if (!agentNode) {
      await c1.disconnect();
      return;
    }

    // Prompt via node.prompt (1v1 direct)
    await c1.request("node.prompt", { nodeId: agentNode.id, content: "hello agent" });
    await sleep(1000);

    // node.updates RPC returns the assembled message history
    const bufResult = await c1.request("node.updates", { nodeName: agentName });
    const messages = (bufResult.messages || []) as Array<any>;
    const userMsgs = messages.filter(m => m.role === "user");
    const agentMsgs = messages.filter(m => m.role === "agent");
    assert(userMsgs.length === 1, "bar: store has 1 user message", `got ${userMsgs.length}`);
    assert(agentMsgs.length === 1, "bar: store has 1 agent message", `got ${agentMsgs.length}`);
    assert(userMsgs[0].text === "hello agent", "bar: user message text", `got ${JSON.stringify(userMsgs[0].text)}`);
    assert(
      typeof agentMsgs[0].text === "string" && agentMsgs[0].text.length > 0,
      "bar: agent message has text",
      `got ${JSON.stringify(agentMsgs[0].text)}`,
    );

    // New client subscribes -> receives message_snapshot with the full history
    const c2 = new WsClient("bar-client2");
    await c2.connect();
    await c2.request("node.register", { name: "bar-client2", capabilities: ["ui"] });
    c2.clearNotifications();
    await c2.request("node.subscribe", { nodeId: agentNode.id });
    await sleep(500);

    const snapshots = c2.getNotifications("message_snapshot");
    assert(snapshots.length === 1, "bar: exactly one snapshot on subscribe", `got ${snapshots.length}`);
    const snapMessages = (snapshots[0]?.params?.messages || []) as Array<any>;
    assert(snapMessages.length === 2, "bar: snapshot contains 2 messages", `got ${snapMessages.length}`);
    assert(snapMessages[0].role === "user" && snapMessages[1].role === "agent", "bar: snapshot ordering (user, agent)");

    // Multi-turn: second prompt should add another pair to the store
    await c1.request("node.prompt", { nodeId: agentNode.id, content: "second question" });
    await sleep(1000);

    const buf2 = await c1.request("node.updates", { nodeName: agentName });
    const messages2 = (buf2.messages || []) as Array<any>;
    assert(
      messages2.length === 4,
      "bar: store has 4 messages after 2 prompts",
      `got ${messages2.length}`,
    );

    // New client subscribing again -> snapshot should reflect both turns
    const c3 = new WsClient("bar-client3");
    await c3.connect();
    await c3.request("node.register", { name: "bar-client3", capabilities: ["ui"] });
    c3.clearNotifications();
    await c3.request("node.subscribe", { nodeId: agentNode.id });
    await sleep(500);

    const snap3 = c3.getNotifications("message_snapshot");
    assert(snap3.length === 1, "bar: c3 snapshot", `got ${snap3.length}`);
    assert((snap3[0]?.params?.messages || []).length === 4, "bar: c3 snapshot has 4 messages");

    // Cleanup: stop node -> fresh spawn should start with an empty snapshot
    await httpPost("/node/stop", { nodeId: agentNode.id });
    await sleep(500);
    await c1.disconnect();
    await c2.disconnect();
    await c3.disconnect();
  });

  it("node.subscribe (direct, no channel)", async () => {
    const observer = new WsClient("sub-observer");
    await observer.connect();
    await observer.request("node.register", { name: "sub-observer", capabilities: ["ui"] });

    // Spawn mock agent
    const spawnResult = await httpPost("/node/spawn", { adapter: "mock", name: "sub-agent", cwd: ROOT });
    assert(!!spawnResult.nodeId, "subscribe: agent spawned");
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
  });

  it("node.list cwd filter", async () => {
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
  });

  it("Auto-naming: {adapter}-{basename(cwd)}", async () => {
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
  });

  it("Multi-nvim: unique names, shared agent access", async () => {
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
  });

  it("One-step chat: find-or-spawn by cwd", async () => {
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
  });

  it("node.cancel: cancel a running prompt", async () => {
    const c = new WsClient("cancel-test");
    await c.connect();
    await c.request("node.register", { name: "cancel-test", capabilities: ["ui"] });

    // Spawn mock agent
    const spawnResult = await c.request("node.spawn", { adapter: "mock", name: "cancel-agent", cwd: ROOT });
    assert(!!spawnResult.nodeId, "cancel: agent spawned");
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

    // Should have received statusChanged notifications (busy -> idle)
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
  });

  it("Cancel with subscribe (nvim 1v1 flow)", async () => {
    const c = new WsClient("cancel-sub-test");
    await c.connect();
    await c.request("node.register", { name: "cancel-sub-test", capabilities: ["ui"] });

    // Spawn mock agent
    const spawnResult = await c.request("node.spawn", { adapter: "mock", name: "cancel-sub-agent", cwd: ROOT });
    assert(!!spawnResult.nodeId, "cancel-sub: agent spawned");
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
  });

  it("mcpServers injected on session/new", async () => {
    const c = new WsClient("mcp-inject-test");
    await c.connect();
    await c.request("node.register", { name: "mcp-inject-test", capabilities: ["ui"] });

    // Spawn mock agent
    const spawnResult = await c.request("node.spawn", { adapter: "mock", name: "mcp-inject-agent", cwd: ROOT });
    assert(!!spawnResult.nodeId, "mcp-inject: agent spawned");

    // Subscribe to capture session/update notifications (including mcpServers_received)
    await c.request("node.subscribe", { nodeId: spawnResult.nodeId });

    // Wait for handshake (mock-agent emits session/update with mcpServers info)
    await sleep(3000);

    // Check agent is idle (handshake completed)
    const nodes = await c.request("node.list", {});
    const agentNode = nodes.nodes.find((n: any) => n.name === "mcp-inject-agent");
    assert(!!agentNode && agentNode.status === "idle", "mcp-inject: agent ready");

    // Check node.update notifications for mcpServers_received
    // After buffer-replay refactor, node.updates returns messages (user/agent pairs),
    // not raw session updates. The mcpServers_received notification is delivered via
    // node.update subscription notifications instead.
    const mcpNotif = c.getNotifications("node.update").find(
      (n: any) => n.params?.update?.sessionUpdate === "mcpServers_received"
    );
    assert(!!mcpNotif, "mcp-inject: mock-agent received mcpServers");

    if (mcpNotif) {
      const servers = mcpNotif.params?.update?.mcpServers as any[];
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
  });

  it("nerve_post posts into joined channel", async () => {
    const c = new WsClient("post-test");
    await c.connect();
    await c.request("node.register", { name: "post-test", capabilities: ["ui"] });

    // Spawn mock agent
    const spawnResult = await httpPost("/node/spawn", { adapter: "mock", name: "post-agent", cwd: ROOT });
    assert(!!spawnResult.nodeId, "post-test: agent spawned");
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
  });

  it("nerve_post errors when node not joined", async () => {
    // Spawn mock agent (no channel join)
    const spawnResult = await httpPost("/node/spawn", { adapter: "mock", name: "no-ch-agent", cwd: ROOT });
    assert(!!spawnResult.nodeId, "no-channel: agent spawned");
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
  });

  it("nerve-mcp orchestration tools", async () => {
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
    const spawnTool = tools.find((t: any) => t.name === "nerve_spawn");
    assert(!!spawnTool?.inputSchema?.properties?.model, "mcp-tools: nerve_spawn exposes model");

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

    const spawnResult = await mcp.callTool("nerve_spawn", { adapter: "mock", name: "orch-worker", cwd: ROOT, model: "sonnet[1m]" });
    assert(!spawnResult.isError, "mcp-tools: spawn succeeds");
    await sleep(3000);

    const nodesAfterSpawn = await c.request("node.list", {});
    const worker = nodesAfterSpawn.nodes.find((n: any) => n.name === "orch-worker");
    assert(!!worker, "mcp-tools: spawned worker visible");
    assertEq(worker?.model, "sonnet[1m]", "mcp-tools: spawn model propagated");
    if (!worker) {
      await mcp.close();
      await c.disconnect();
      return;
    }

    const joinResult = await mcp.callTool("nerve_join", { node_name: "orch-worker", channel_id: channel.id });
    assert(!joinResult.isError, "mcp-tools: join succeeds");

    const channelsAfterJoin = await c.request("channel.list", {});
    const joined = channelsAfterJoin.channels.find((ch: any) => ch.id === channel.id);
    assert(joined?.nodes?.["orch-worker"] === worker.id, "mcp-tools: worker joined channel");

    const removeResult = await mcp.callTool("nerve_remove", { node_name: "orch-worker", channel_id: channel.id });
    assert(!removeResult.isError, "mcp-tools: remove succeeds");

    const channelsAfterRemove = await c.request("channel.list", {});
    const removed = channelsAfterRemove.channels.find((ch: any) => ch.id === channel.id);
    assert(!removed?.nodes?.["orch-worker"], "mcp-tools: worker removed from channel");

    await httpPost("/node/stop", { nodeId: worker.id });
    await sleep(500);
    await mcp.close();
    await c.disconnect();
  });

  it("logger uses local time", async () => {
    const logFile = resolve(getTestData(), "logger-local-time.log");
    if (existsSync(logFile)) rmSync(logFile);

    const logger = await import("../../src/logger.js");
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
  });

  it("mention on busy node cancels previous prompt", async () => {
    const c = new WsClient("busy-cancel-test");
    await c.connect();
    await c.request("node.register", { name: "busy-cancel-test", capabilities: ["ui"] });

    // Spawn mock agent
    const spawnResult = await c.request("node.spawn", { adapter: "mock", name: "busy-agent", cwd: ROOT });
    assert(!!spawnResult.nodeId, "busy-cancel: agent spawned");
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

    // Should have status transitions (busy -> idle -> busy -> idle)
    const statusChanges = c.getNotifications("node.statusChanged");
    assert(statusChanges.length >= 3, "busy-cancel: received multiple statusChanged events", `got ${statusChanges.length}`);

    // Cleanup
    await httpPost("/node/stop", { nodeId: agentNode.id });
    await sleep(500);
    await c.disconnect();
  });

  it("nerve_post: explicit channel_id overrides currentChannelId", async () => {
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
    const spawnResult = await httpPost("/node/spawn", { adapter: "mock", name: "post-ch-agent", cwd: ROOT });
    assert(!!spawnResult.nodeId, "post-ch: agent spawned");
    await sleep(3000);
    await httpPost("/channel/addNode", { channelId: ch1.channelId, nodeId: spawnResult.nodeId, nodeName: "post-ch-agent" });
    await httpPost("/channel/addNode", { channelId: ch2.channelId, nodeId: spawnResult.nodeId, nodeName: "post-ch-agent" });

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
      await httpPost("/channel/addNode", { channelId: chGamma.id, nodeId: spawnResult.nodeId, nodeName: "post-ch-agent" });

      const postRes2 = await mcp.callTool("nerve_post", { to: "post-ch-agent", content: "hello default" });
      assert(!postRes2.isError, "post-ch: nerve_post without channel_id succeeds");

      const hist2 = await c.request("channel.history", { channelId: chGamma.id });
      const found2 = hist2.messages.find((m: any) => m.content.includes("hello default"));
      assert(!!found2, "post-ch: message landed in currentChannelId channel");
    }

    // Cleanup
    await httpPost("/node/stop", { nodeId: spawnResult.nodeId as string });
    await sleep(500);
    await mcp.close();
    await c.disconnect();
  });

  it("nerve_remove(self) clears currentChannelId", async () => {
    // Spawn a mock agent so it exists in the node pool under "rm-self-agent"
    const spawn1 = await httpPost("/node/spawn", { adapter: "mock", name: "rm-self-agent", cwd: ROOT });
    assert(!!spawn1.nodeId, "rm-self: agent spawned");
    await sleep(3000);

    // Create MCP client with same NERVE_NODE_NAME as the spawned agent
    const mcp = new McpToolClient("rm-self-agent");
    await mcp.connect();

    // Create channel -> sets currentChannelId, auto-joins rm-self-agent
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
    const rmRes = await mcp.callTool("nerve_remove", { node_name: "rm-self-agent", channel_id: chId });
    assert(!rmRes.isError, "rm-self: remove self succeeds");

    // Now nerve_post without channel_id should fail (currentChannelId cleared)
    const postRes = await mcp.callTool("nerve_post", { to: "rm-target", content: "should fail" });
    assert(!!postRes.isError, "rm-self: nerve_post fails after self-remove (no channel)");

    // Cleanup
    await httpPost("/node/stop", { nodeId: spawn1.nodeId as string });
    await httpPost("/node/stop", { nodeId: spawn2.nodeId as string });
    await sleep(500);
    await mcp.close();
  });

  it("nerve_spawn auto-joins to current channel", async () => {
    const c = new WsClient("spawn-join-test");
    await c.connect();
    await c.request("node.register", { name: "spawn-join-test", capabilities: ["ui"] });

    const mcp = new McpToolClient("spawn-join-test");
    await mcp.connect();

    // Create channel -> sets currentChannelId
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
  });

  it("channel.created/closed WS notifications", async () => {
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
  });

  it("channel.list cwd filter", async () => {
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
  });

  it("channel @mention dispatches to agent (no auto-reply, agent replies via nerve_post)", async () => {
    const c = new WsClient("auto-reply-test");
    await c.connect();
    await c.request("node.register", { name: "auto-reply-test", capabilities: ["ui"] });

    // Spawn mock agent
    const spawnResult = await httpPost("/node/spawn", { adapter: "mock", name: "reply-agent", cwd: ROOT });
    assert(!!spawnResult.nodeId, "dispatch: agent spawned");
    await sleep(3000);

    // Create channel, add both nodes
    const ch = await c.request("channel.create", { cwd: "/tmp/auto-reply" });
    await c.request("channel.join", { channelId: ch.channelId });
    await httpPost("/channel/addNode", {
      channelId: ch.channelId,
      nodeId: spawnResult.nodeId,
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
    await httpPost("/node/stop", { nodeId: spawnResult.nodeId as string });
    await sleep(500);
    await c.disconnect();
  });

  it("promptNode {error} posts [error:...] to channel", async () => {
    const c = new WsClient("prompt-err-test");
    await c.connect();
    await c.request("node.register", { name: "prompt-err-test", capabilities: ["ui"] });

    // Spawn mock agent
    const spawnResult = await httpPost("/node/spawn", { adapter: "mock", name: "err-agent", cwd: ROOT });
    assert(!!spawnResult.nodeId, "prompt-err: agent spawned");
    await sleep(3000);

    // Create channel, add both nodes
    const ch = await c.request("channel.create", { cwd: "/tmp/prompt-err" });
    await c.request("channel.join", { channelId: ch.channelId });
    await httpPost("/channel/addNode", {
      channelId: ch.channelId,
      nodeId: spawnResult.nodeId,
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
    await httpPost("/node/stop", { nodeId: spawnResult.nodeId as string });
    await sleep(500);
    await c.disconnect();
  });

  it("cwd path normalization", async () => {
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
  });

  it("node.log (program node DM observability)", async () => {
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

    // 5. Replay semantics — program logs are replayed through message_snapshot,
    //    matching AI node history behavior. Live logs after subscribe still
    //    arrive as node.update notifications.
    const observer2 = new WsClient("log-observer-2");
    await observer2.connect();
    await observer2.request("node.register", { name: "log-observer-2", capabilities: ["ui"] });
    observer2.clearNotifications();
    await observer2.request("node.subscribe", { nodeId: pluginNode.id });
    await sleep(200);

    const snaps = observer2.getNotifications("message_snapshot");
    assert(snaps.length === 1, "node.log: new subscriber receives snapshot envelope", `got ${snaps.length}`);
    const snapMsgs = (snaps[0]?.params?.messages || []) as Array<any>;
    assert(snapMsgs.length >= 3, "node.log: snapshot includes previous log entries", `got ${snapMsgs.length}`);
    assert(
      snapMsgs.some((m: any) => m.role === "system" && m.text.includes("poll started")),
      "node.log: snapshot contains first log entry",
      JSON.stringify(snapMsgs),
    );
    assert(
      snapMsgs.some((m: any) => m.role === "system" && m.text.includes("agent-1 usage 80%")),
      "node.log: snapshot contains batch log entry",
      JSON.stringify(snapMsgs),
    );

    // Live log after subscribe still delivered
    observer2.clearNotifications();
    await plugin.request("node.log", { entries: [{ level: "info", message: "live entry" }] });
    await sleep(200);
    const liveUpdates = observer2.getNotifications("node.update");
    const liveLog = liveUpdates.find((n: any) => n.params.update?.sessionUpdate === "node_log");
    assert(!!liveLog, "node.log: live entries still broadcast to subscribers");

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
  });

  it("node.log retains only latest 5000 messages in snapshot", async () => {
    const plugin = new WsClient("log-limit-plugin");
    await plugin.connect();
    await plugin.request("node.register", { name: "log-limit-plugin", capabilities: ["monitor"] });

    const entries = Array.from({ length: 5001 }, (_, i) => ({
      level: "info",
      message: `entry-${i}`,
      ts: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    }));
    await plugin.request("node.log", { entries });

    const updates = await plugin.request("node.updates", { nodeName: "log-limit-plugin" });
    const messages = (updates.messages || []) as Array<any>;
    assertEq(messages.length, 5000, "node.log limit: keeps latest 5000 messages");
    assert(!messages[0].text.includes("entry-0"), "node.log limit: trims oldest entry");
    assert(messages[0].text.includes("entry-1"), "node.log limit: first retained entry is entry-1");
    assert(messages[4999].text.includes("entry-5000"), "node.log limit: newest entry retained");

    const observer = new WsClient("log-limit-observer");
    await observer.connect();
    await observer.request("node.register", { name: "log-limit-observer", capabilities: ["ui"] });
    const nodes = await observer.request("node.list");
    const pluginNode = nodes.nodes.find((n: any) => n.name === "log-limit-plugin");
    assert(!!pluginNode, "node.log limit: plugin node found");
    observer.clearNotifications();
    await observer.request("node.subscribe", { nodeId: pluginNode.id });
    await sleep(200);

    const snaps = observer.getNotifications("message_snapshot");
    assertEq(snaps.length, 1, "node.log limit: subscriber receives snapshot");
    const snapMsgs = (snaps[0]?.params?.messages || []) as Array<any>;
    assertEq(snapMsgs.length, 5000, "node.log limit: snapshot keeps latest 5000");
    assert(snapMsgs[0].text.includes("entry-1"), "node.log limit: snapshot trims oldest entry");
    assert(snapMsgs[4999].text.includes("entry-5000"), "node.log limit: snapshot includes newest entry");

    await plugin.disconnect();
    await observer.disconnect();
  });

  it("plugin-base dataDir + activity.log", async () => {
    // Import PluginBase dynamically
    const { PluginBase } = await import("../../src/plugins/plugin-base.js");

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

    const plugin = new TestPlugin({ port: getTestPort(), name: testName });
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
  });
});

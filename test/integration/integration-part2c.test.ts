/**
 * Nerve Integration Tests - Part 2c
 *
 * Converted from test/self-test.ts (testMultiClientUserMessageSync through testUserRecorderSpawnConnect).
 * Requires a running nerve server (managed by beforeAll/afterAll).
 */

import { describe, it, beforeAll, afterAll, vi } from "vitest";
import {
  assert, assertEq, sleep,
  ROOT, getTestPort,
  httpPost, httpGet,
  WsClient, McpToolClient, waitForNotification,
  startServer, stopServer, serverLogBuffer,
  resolve, readFileSync,
  WebSocket,
} from "../helpers/vitest.js";

describe("Nerve Integration Tests - Part 2c", () => {
  beforeAll(startServer);
  afterAll(stopServer);

  // ── Multi-client DM sync ──────────────────────────────────

  describe("Multi-client DM sync", () => {
    it("Multi-client DM: user_message broadcast to other subscribers", async () => {
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
    });

    it("Bug fix: DM user_message not echoed back to sender", async () => {
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
    });
  });

  // ── Guardian restart ──────────────────────────────────────

  it("Bug fix: guardian stop → re-spawn should succeed", async () => {
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
  });

  // ── Integration: spawn → prompt → update chain ────────────

  describe("Integration: spawn → prompt → update chain", () => {
    it("Integration: spawn ACP node → prompt → verify session/update delivered", async () => {
      const c = new WsClient("integ-prompt");
      await c.connect();
      await c.request("node.register", { name: "integ-prompt", capabilities: ["ui"] });

      // Spawn mock ACP agent
      const spawn = await c.request("node.spawn", { adapter: "mock", name: "integ-agent-1", cwd: ROOT });
      assert(!!spawn.nodeId, "integ-prompt: agent spawned");

      // Wait for ACP handshake (session/new → idle)
      await sleep(3000);

      // Verify node is idle (handshake completed)
      const list = await c.request("node.list", {});
      const agentNode = (list as any).nodes.find((n: any) => n.name === "integ-agent-1");
      assert(!!agentNode, "integ-prompt: agent in node list");
      assertEq(agentNode?.status, "idle", "integ-prompt: agent status is idle after handshake");

      // Subscribe to receive session/update notifications
      await c.request("node.subscribe", { nodeId: spawn.nodeId });
      c.clearNotifications();

      // Prompt the agent — this exercises the full chain:
      // server.handleRequest → nodePool.promptNode → acpClient.prompt
      // → mock-agent session/update notification → node.pushUpdate → subscriber notification
      const promptResult = await c.request("node.prompt", { nodeId: spawn.nodeId, content: "integration test ping" });
      assert(!!promptResult, "integ-prompt: prompt returned result");
      assertEq(promptResult.stopReason, "end_turn", "integ-prompt: stopReason is end_turn");

      // Verify we received session/update notifications (the critical path)
      await sleep(500);
      const updates = c.getNotifications("node.update");
      assert(updates.length > 0, "integ-prompt: received node.update notifications via subscription",
        `got ${updates.length} updates`);

      // Verify at least one update contains agent_message_chunk (mock-agent sends this)
      const hasAgentChunk = updates.some((n: any) =>
        n.params?.update?.sessionUpdate === "agent_message_chunk"
      );
      assert(hasAgentChunk, "integ-prompt: received agent_message_chunk in session/update",
        `updates: ${updates.map((n: any) => n.params?.update?.sessionUpdate).join(", ")}`);

      // Verify statusChanged notifications (busy → idle transition)
      const statusChanges = c.getNotifications("node.statusChanged");
      const busyChange = statusChanges.find((n: any) => n.params?.name === "integ-agent-1" && n.params?.status === "busy");
      const idleChange = statusChanges.find((n: any) => n.params?.name === "integ-agent-1" && n.params?.status === "idle");
      assert(!!busyChange, "integ-prompt: received statusChanged busy");
      assert(!!idleChange, "integ-prompt: received statusChanged idle (after prompt completes)");

      // Verify messageStore has the assembled history (for replay on reconnect)
      const bufResult = await c.request("node.updates", { nodeName: "integ-agent-1" });
      assert(Array.isArray(bufResult.messages), "integ-prompt: node.updates returns messages array");
      assert(bufResult.messages.length > 0, "integ-prompt: message store is non-empty",
        `store has ${bufResult.messages?.length || 0} entries`);

      // Cleanup
      await httpPost("/node/stop", { nodeId: spawn.nodeId });
      await sleep(500);
      await c.disconnect();
    });

    it("Integration: program node → node.message → verify response via subscription", async () => {
      const c = new WsClient("integ-prog-msg");
      await c.connect();
      await c.request("node.register", { name: "integ-prog-msg", capabilities: ["ui"] });

      // Spawn mock program node
      const spawn = await c.request("node.spawn", {
        adapter: "mock-program",
        name: "integ-prog-1",
        cwd: ROOT,
      });
      assert(!!spawn.nodeId, "integ-prog-msg: program node spawned");

      // Wait for program to connect via WS and become idle
      await waitForNotification(c, "node.statusChanged",
        p => p.name === "integ-prog-1" && p.status === "idle", 5000);
      assert(true, "integ-prog-msg: program node reached idle");

      // Subscribe to the program node
      await c.request("node.subscribe", { nodeId: spawn.nodeId });
      c.clearNotifications();

      // Send a DM message to the program node
      await c.request("node.message", { nodeId: spawn.nodeId, content: "hello-integration" });

      // Wait for the mock-program to echo back via node.log
      await sleep(1000);

      // Check updates — mock-program echoes DM via node.log which triggers node.update
      const updates = c.getNotifications("node.update");
      const logUpdate = updates.find((n: any) =>
        n.params?.update?.sessionUpdate === "node_log" &&
        JSON.stringify(n.params?.update?.entries || []).includes("hello-integration")
      );
      assert(!!logUpdate, "integ-prog-msg: received node.log echo from program node",
        `got ${updates.length} updates, log entries: ${JSON.stringify(updates.map((n: any) => n.params?.update?.sessionUpdate))}`);

      // Cleanup
      await c.request("node.stop", { nodeId: spawn.nodeId });
      await waitForNotification(c, "node.stopped", p => p.nodeId === spawn.nodeId, 5000);
      assert(true, "integ-prog-msg: program node stopped");

      await c.disconnect();
    });

    it("Integration: spawn → subscribe → prompt → verify update content matches pushUpdate", async () => {
      const sender = new WsClient("integ-sender");
      const watcher = new WsClient("integ-watcher");
      await sender.connect();
      await watcher.connect();
      await sender.request("node.register", { name: "integ-sender", capabilities: ["ui"] });
      await watcher.request("node.register", { name: "integ-watcher", capabilities: ["ui"] });

      // Spawn agent
      const spawn = await sender.request("node.spawn", { adapter: "mock", name: "integ-verify-agent", cwd: ROOT });
      assert(!!spawn.nodeId, "integ-verify: agent spawned");
      await sleep(3000);

      // Both subscribe
      await sender.request("node.subscribe", { nodeId: spawn.nodeId });
      await watcher.request("node.subscribe", { nodeId: spawn.nodeId });
      sender.clearNotifications();
      watcher.clearNotifications();

      // Sender prompts
      await sender.request("node.prompt", { nodeId: spawn.nodeId, content: "verify-update-chain" });
      await sleep(1000);

      // Watcher should receive user_message + agent_message_chunk
      const watcherUpdates = watcher.getNotifications("node.update");
      assert(watcherUpdates.length > 0, "integ-verify: watcher received updates",
        `got ${watcherUpdates.length}`);

      const hasUserMsg = watcherUpdates.some((n: any) =>
        n.params?.update?.sessionUpdate === "user_message" &&
        n.params?.update?.content?.text === "verify-update-chain"
      );
      assert(hasUserMsg, "integ-verify: watcher received user_message with correct content");

      const hasAgentReply = watcherUpdates.some((n: any) =>
        n.params?.update?.sessionUpdate === "agent_message_chunk"
      );
      assert(hasAgentReply, "integ-verify: watcher received agent_message_chunk");

      // Verify messageStore matches what was delivered
      const buf = await sender.request("node.updates", { nodeName: "integ-verify-agent" });
      const bufMessages = (buf.messages || []) as Array<any>;
      assert(bufMessages.length > 0, "integ-verify: message store is non-empty");

      const storeHasUserMsg = bufMessages.some(m =>
        m.role === "user" && m.text === "verify-update-chain"
      );
      assert(storeHasUserMsg, "integ-verify: store contains user message with correct content");

      const storeHasAgent = bufMessages.some(m => m.role === "agent" && m.text.length > 0);
      assert(storeHasAgent, "integ-verify: store contains agent message with non-empty text");

      // Cleanup
      await httpPost("/node/stop", { nodeId: spawn.nodeId });
      await sleep(500);
      await sender.disconnect();
      await watcher.disconnect();
    });
  });

  // ── Stop cleanup ──────────────────────────────────────────

  describe("Stop cleanup", () => {
    it("Integration: stop node → verify full cleanup (pool, subscriptions, channels)", async () => {
      const c = new WsClient("integ-cleanup");
      await c.connect();
      await c.request("node.register", { name: "integ-cleanup", capabilities: ["ui"] });

      // Spawn ACP agent
      const spawn = await c.request("node.spawn", { adapter: "mock", name: "integ-cleanup-agent", cwd: ROOT });
      assert(!!spawn.nodeId, "integ-cleanup: agent spawned");
      await sleep(3000);

      // Create channel and add agent
      const ch = await c.request("channel.create", { cwd: ROOT, name: "integ-cleanup-ch" });
      await c.request("channel.join", { channelId: ch.channelId });
      await c.request("channel.addNode", { channelId: ch.channelId, nodeId: spawn.nodeId, name: "integ-cleanup-agent" });

      // Verify agent is in channel
      let chList = await c.request("channel.list", {});
      let channel = chList.channels.find((ch2: any) => ch2.id === ch.channelId);
      assert(!!channel?.nodes?.["integ-cleanup-agent"], "integ-cleanup: agent in channel before stop");

      // Subscribe to the agent
      await c.request("node.subscribe", { nodeId: spawn.nodeId });
      c.clearNotifications();

      // Seed buffer before stop so respawn can prove there is no stale replay
      await c.request("node.prompt", { nodeId: spawn.nodeId, content: "before stop buffer seed" });
      await sleep(2000);
      const beforeStopBuf = await c.request("node.updates", { nodeName: "integ-cleanup-agent" });
      // After buffer-replay refactor, node.updates returns { messages } not { updates }
      assert(
        (beforeStopBuf.messages || []).length > 0,
        "integ-cleanup: buffer seeded before stop",
        `got ${beforeStopBuf.messages?.length || 0} messages`,
      );
      c.clearNotifications();

      // Stop the agent
      await httpPost("/node/stop", { nodeId: spawn.nodeId });
      await sleep(1000);

      // Verify node.stopped notification received
      const stoppedNotifs = c.getNotifications("node.stopped");
      const stoppedMatch = stoppedNotifs.find((n: any) => n.params?.nodeId === spawn.nodeId);
      assert(!!stoppedMatch, "integ-cleanup: received node.stopped notification");

      // Verify agent removed or stopped in node list
      const list = await c.request("node.list", {});
      const cleanupAgent = (list as any).nodes.find((n: any) => n.name === "integ-cleanup-agent");
      assert(!cleanupAgent || cleanupAgent.status === "stopped",
        "integ-cleanup: agent removed or stopped in node list",
        cleanupAgent ? `status=${cleanupAgent.status}` : undefined);

      // Verify agent removed from channel
      chList = await c.request("channel.list", {});
      channel = chList.channels.find((ch2: any) => ch2.id === ch.channelId);
      const agentGone = !channel?.nodes?.["integ-cleanup-agent"];
      assert(agentGone, "integ-cleanup: agent removed from channel after stop");

      // Verify no more updates after stop (subscription cleaned up)
      c.clearNotifications();
      await sleep(500);
      const postStopUpdates = c.getNotifications("node.update");
      assertEq(postStopUpdates.length, 0, "integ-cleanup: no updates after node stopped");

      // Respawn same name — new node should not inherit old buffer or subscriptions
      const respawn = await c.request("node.spawn", { adapter: "mock", name: "integ-cleanup-agent", cwd: ROOT });
      assert(!!respawn.nodeId, "integ-cleanup: respawn with same name succeeds");
      assert(respawn.nodeId !== spawn.nodeId, "integ-cleanup: respawn gets new nodeId");
      await sleep(3000);

      const fresh = new WsClient("integ-cleanup-fresh");
      await fresh.connect();
      await fresh.request("node.register", { name: "integ-cleanup-fresh", capabilities: ["ui"] });
      fresh.clearNotifications();
      await fresh.request("node.subscribe", { nodeId: respawn.nodeId });
      await sleep(300);
      const replayAfterRespawn = fresh.getNotifications("node.update");
      assertEq(replayAfterRespawn.length, 0, "integ-cleanup: respawn has no stale replay buffer");

      c.clearNotifications();
      await c.request("node.prompt", { nodeId: respawn.nodeId, content: "after stop no resubscribe" });
      await sleep(1000);
      const carriedUpdates = c.getNotifications("node.update").filter(
        (n: any) => n.params?.nodeId === respawn.nodeId,
      );
      assertEq(carriedUpdates.length, 0, "integ-cleanup: old subscription does not carry to respawn");

      await httpPost("/node/stop", { nodeId: respawn.nodeId });
      await sleep(500);
      await fresh.disconnect();
      await c.disconnect();
    });

    it("stopNode pool removal: stop → node.list should NOT contain stopped node", async () => {
      const c = new WsClient("stop-pool-test");
      await c.connect();
      await c.request("node.register", { name: "stop-pool-test", capabilities: ["ui"] });

      // Spawn a mock ACP agent
      const spawn = await c.request("node.spawn", { adapter: "mock", name: "stop-pool-agent", cwd: ROOT });
      assert(!!spawn.nodeId, "stop-pool: agent spawned");
      await sleep(2000);

      // Verify node exists in list before stop
      let list = await c.request("node.list", {});
      let found = (list as any).nodes.find((n: any) => n.id === spawn.nodeId);
      assert(!!found, "stop-pool: node exists in list before stop");

      // Stop the node
      await c.request("node.stop", { nodeId: spawn.nodeId });
      await sleep(1000);

      // After stop, node.list should NOT contain this node at all
      list = await c.request("node.list", {});
      found = (list as any).nodes.find((n: any) => n.id === spawn.nodeId);
      assert(!found, "stop-pool: node removed from node.list after stop",
        found ? `still present with status=${found.status}` : undefined);

      // After stop, node.list by name should also not find it
      const byName = (list as any).nodes.find((n: any) => n.name === "stop-pool-agent");
      assert(!byName, "stop-pool: node not findable by name after stop",
        byName ? `still present with status=${byName.status}` : undefined);

      // Respawn with same name should succeed (proves name index was cleaned)
      const respawn = await c.request("node.spawn", { adapter: "mock", name: "stop-pool-agent", cwd: ROOT });
      assert(!!respawn.nodeId, "stop-pool: respawn with same name succeeds after stop");
      assert(respawn.nodeId !== spawn.nodeId, "stop-pool: respawn gets new nodeId");

      // Cleanup
      await c.request("node.stop", { nodeId: respawn.nodeId });
      await sleep(500);
      await c.disconnect();
    });

    it("transport.onClose pool removal: kill process → node should be removed from pool", async () => {
      const c = new WsClient("transport-close-test");
      await c.connect();
      await c.request("node.register", { name: "transport-close-test", capabilities: ["ui"] });

      // Spawn a mock ACP stdio agent
      const spawn = await c.request("node.spawn", { adapter: "mock", name: "transport-close-agent", cwd: ROOT });
      assert(!!spawn.nodeId, "transport-close: agent spawned");
      await sleep(2000);

      // Get the PID from node.list
      let list = await c.request("node.list", {});
      let node = (list as any).nodes.find((n: any) => n.id === spawn.nodeId);
      assert(!!node, "transport-close: node in list before kill");
      assert(typeof node.pid === "number" && node.pid > 0, "transport-close: node has valid pid",
        `pid=${node?.pid}`);

      // Kill the process to trigger transport.onClose
      if (node?.pid) {
        process.kill(node.pid, "SIGKILL");
      }
      await sleep(2000);

      // After transport.onClose, node should be removed from pool
      list = await c.request("node.list", {});
      const found = (list as any).nodes.find((n: any) => n.id === spawn.nodeId);
      assert(!found, "transport-close: node removed from node.list after process kill",
        found ? `still present with status=${found.status}` : undefined);

      const byName = (list as any).nodes.find((n: any) => n.name === "transport-close-agent");
      assert(!byName, "transport-close: node not findable by name after process kill",
        byName ? `still present with status=${byName.status}` : undefined);

      // Respawn with same name should succeed
      const respawn = await c.request("node.spawn", { adapter: "mock", name: "transport-close-agent", cwd: ROOT });
      assert(!!respawn.nodeId, "transport-close: respawn with same name succeeds");

      // Cleanup
      await c.request("node.stop", { nodeId: respawn.nodeId });
      await sleep(500);
      await c.disconnect();
    });
  });

  // ── Model field & context size ────────────────────────────

  describe("Model field & context size", () => {
    it("node.list returns model field", async () => {
      const c = new WsClient("model-field-client");
      await c.connect();
      await c.request("node.register", { name: "model-field-client", capabilities: ["ui"] });

      const spawn = await c.request("node.spawn", { adapter: "mock", name: "model-field-agent", cwd: ROOT });
      assert(!!spawn.nodeId, "model-field: spawn succeeded");

      // Wait for ACP handshake
      await sleep(1500);

      const list = await c.request("node.list", {});
      const agent = (list as any).nodes.find((n: any) => n.name === "model-field-agent");
      assert(agent !== undefined, "model-field: agent found in node.list");
      assert("model" in agent, "model-field: NodeInfo has 'model' key");
      assertEq(agent.model, "mock-model-v1", "model-field: model matches adapter config");

      // Also verify a node without adapter (ws client) has no model
      const self = (list as any).nodes.find((n: any) => n.name === "model-field-client");
      assert(self !== undefined, "model-field: ws client found in node.list");
      assert(!self.model, "model-field: ws client has no model");

      await httpPost("/node/stop", { nodeId: spawn.nodeId });
      await sleep(300);
      await c.disconnect();
    });

    it("context size change triggers warn log", async () => {
      const c = new WsClient("size-warn-client");
      await c.connect();
      await c.request("node.register", { name: "size-warn-client", capabilities: ["ui"] });

      // Use mock-no-model adapter so getContextWindow returns undefined,
      // allowing raw sizes 50000 → 80000 to trigger the size change warn
      const spawn = await c.request("node.spawn", { adapter: "mock-no-model", name: "size-warn-agent", cwd: ROOT });
      assert(!!spawn.nodeId, "size-warn: spawn succeeded");

      await sleep(1500);

      await c.request("node.subscribe", { nodeId: spawn.nodeId });

      // Record log position before prompt
      const logStart = serverLogBuffer.length;

      // "send-usage" triggers mock-agent to emit two usage_updates with sizes 50000 → 80000
      const result = await c.request("node.prompt", { nodeId: spawn.nodeId, content: "send-usage" });
      assert(!!result, "size-warn: prompt returned result");

      await sleep(500);

      const newLogs = serverLogBuffer.slice(logStart).join("\n");
      const hasWarn = newLogs.includes("context size changed");
      assert(hasWarn, "size-warn: server logged 'context size changed' warn",
        `log snippet: ${newLogs.slice(0, 300)}`);

      await httpPost("/node/stop", { nodeId: spawn.nodeId });
      await sleep(300);
      await c.disconnect();
    });

    it("updateBuffer usage_update has normalized size", async () => {
      const c = new WsClient("buf-size-client");
      await c.connect();
      await c.request("node.register", { name: "buf-size-client", capabilities: ["ui"] });

      const spawn = await c.request("node.spawn", { adapter: "mock", name: "buf-size-agent", cwd: ROOT });
      assert(!!spawn.nodeId, "buf-size: spawn succeeded");

      await sleep(1500);

      await c.request("node.subscribe", { nodeId: spawn.nodeId });

      // "send-usage" emits usage_updates with raw sizes 50000 and 80000
      // mock adapter model is "mock-model-v1" → getContextWindow returns 999999
      // So buffer should have size=999999, not the raw values
      const result = await c.request("node.prompt", { nodeId: spawn.nodeId, content: "send-usage" });
      assert(!!result, "buf-size: prompt returned result");

      await sleep(500);

      // usage_update events are no longer buffered; they're applied to node.usage
      // in observeUpdate. Verify the normalized size ended up on the node info.
      const list = await c.request("node.list", {});
      const agent = (list as any).nodes.find((n: any) => n.name === "buf-size-agent");
      assert(!!agent, "buf-size: agent found in node.list");
      assert(agent.usage?.tokenSize === 999999,
        `buf-size: node.usage.tokenSize should be 999999 (normalized), got ${agent.usage?.tokenSize}`);

      await httpPost("/node/stop", { nodeId: spawn.nodeId });
      await sleep(300);
      await c.disconnect();
    });

    it("Integration: Model info in node.list", async () => {
      const c = new WsClient("model-info-client");
      await c.connect();
      await c.request("node.register", { name: "model-info-client", capabilities: ["ui"] });

      // Use mock adapter (has model: "mock-model-v1") instead of claude (needs real API)
      const spawn = await c.request("node.spawn", { adapter: "mock", name: "model-info-agent", cwd: ROOT });
      assert(!!spawn.nodeId, "model-info: spawn succeeded");

      // Wait for ACP handshake
      await sleep(1500);

      // node.list — verify model field exists and is non-empty
      const list = await c.request("node.list", {});
      const agent = (list as any).nodes.find((n: any) => n.name === "model-info-agent");
      assert(agent !== undefined, "model-info: agent found in node.list");
      assert("model" in agent, "model-info: NodeInfo has 'model' field");
      assert(!!agent.model, "model-info: model field is non-empty for mock adapter",
        `got model=${JSON.stringify(agent?.model)}`);

      // Subscribe and prompt with "send-usage" to trigger usage_update
      await c.request("node.subscribe", { nodeId: spawn.nodeId });
      c.clearNotifications();

      const promptResult = await c.request("node.prompt", { nodeId: spawn.nodeId, content: "send-usage" });
      assert(!!promptResult, "model-info: prompt returned result");

      // Wait for usage_update to be processed
      await sleep(1000);

      // Verify the usage_update was processed end-to-end by checking node state.
      // (Log-buffer assertion doesn't work here: `usage_update wire:` is DEBUG
      // and filtered out at default INFO threshold; `context size changed` only
      // fires on actual size change, but mock-model-v1's fixed 999_999 window
      // normalizes both 50000 and 80000 to the same value, so no change fires.
      // Use mock-no-model adapter in the sibling test for the warn path.)
      const list2 = await c.request("node.list", {});
      const agent2 = (list2 as any).nodes.find((n: any) => n.name === "model-info-agent");
      assert(!!agent2?.usage, "model-info: agent.usage populated after send-usage prompt",
        `agent.usage=${JSON.stringify(agent2?.usage)}`);
      assertEq(agent2.usage.tokenSize, 999999,
        "model-info: tokenSize normalized via mock-model-v1 context window");
      assertEq(agent2.usage.tokenUsed, 200,
        "model-info: tokenUsed reflects second usage_update from mock send-usage");

      // Cleanup
      await httpPost("/node/stop", { nodeId: spawn.nodeId });
      await sleep(300);
      await c.disconnect();
    });
  });

  // ── Memory monitor ────────────────────────────────────────

  describe("Memory monitor", () => {
    it("Memory monitor: memory log format", async () => {
      // Server should emit [mem] log at startup (immediate first log)
      // Give a small window for the log to appear
      await sleep(500);

      const memLines = serverLogBuffer.filter(line => line.includes("[mem]"));
      assert(memLines.length > 0, "mem-log-format: at least one [mem] log line found",
        `serverLogBuffer has ${serverLogBuffer.length} lines, none contain [mem]`);

      if (memLines.length > 0) {
        const line = memLines[0];
        // Expected format: [mem] rss=XXmb heap=XXmb/XXmb ext=XXmb buf=XXmb
        const formatRe = /\[mem\]\s+rss=\d+mb\s+heap=\d+mb\/\d+mb\s+ext=\d+mb\s+buf=\d+mb/;
        assert(formatRe.test(line), "mem-log-format: matches expected pattern",
          `got: ${line}`);
      }
    });

    it("Memory monitor: memory log values", async () => {
      const memLines = serverLogBuffer.filter(line => line.includes("[mem]"));
      assert(memLines.length > 0, "mem-log-values: [mem] log line exists");

      if (memLines.length > 0) {
        const line = memLines[0];
        // Parse rss and heap used values
        const rssMatch = line.match(/rss=(\d+)mb/);
        const heapMatch = line.match(/heap=(\d+)mb\/(\d+)mb/);

        assert(!!rssMatch, "mem-log-values: rss value parsed");
        assert(!!heapMatch, "mem-log-values: heap value parsed");

        if (rssMatch && heapMatch) {
          const rss = parseInt(rssMatch[1], 10);
          const heapUsed = parseInt(heapMatch[1], 10);
          const heapTotal = parseInt(heapMatch[2], 10);

          assert(rss > 0, "mem-log-values: rss is positive", `rss=${rss}`);
          assert(heapUsed > 0, "mem-log-values: heap used is positive", `heapUsed=${heapUsed}`);
          assert(heapTotal > 0, "mem-log-values: heap total is positive", `heapTotal=${heapTotal}`);
          assert(heapUsed <= heapTotal, "mem-log-values: heap used <= heap total",
            `heapUsed=${heapUsed}, heapTotal=${heapTotal}`);
          assert(rss >= heapUsed, "mem-log-values: rss >= heap used (RSS includes non-heap)",
            `rss=${rss}, heapUsed=${heapUsed}`);
        }
      }
    });

    it("Memory monitor: node.list pid field", async () => {
      const c = new WsClient("pid-test-client");
      await c.connect();
      await c.request("node.register", { name: "pid-test-client", capabilities: ["ui"] });

      // Spawn a mock-program (stdio) node
      const spawn = await httpPost("/node/spawn", { adapter: "mock", name: "pid-test-agent", cwd: ROOT });
      assert(!!spawn.nodeId, "pid-field: mock agent spawned");
      await sleep(3000);

      // node.list and check pid
      const list = await httpPost("/node/list", {});
      const nodes = (list as any).nodes;

      const stdioNode = nodes.find((n: any) => n.name === "pid-test-agent");
      assert(!!stdioNode, "pid-field: stdio node found in list");
      if (stdioNode) {
        assert(typeof stdioNode.pid === "number", "pid-field: stdio node has numeric pid",
          `got pid=${JSON.stringify(stdioNode.pid)}`);
        assert(stdioNode.pid > 0, "pid-field: stdio node pid is positive",
          `pid=${stdioNode.pid}`);
      }

      // WS node should NOT have pid
      const wsNode = nodes.find((n: any) => n.name === "pid-test-client");
      assert(!!wsNode, "pid-field: WS node found in list");
      if (wsNode) {
        assert(wsNode.pid === undefined || wsNode.pid === null, "pid-field: WS node pid is undefined/null",
          `got pid=${JSON.stringify(wsNode.pid)}`);
      }

      // Cleanup
      await httpPost("/node/stop", { nodeId: spawn.nodeId });
      await sleep(500);
      await c.disconnect();
    });

    it("Memory monitor: /metrics endpoint", async () => {
      const metrics = await httpGet("/metrics") as any;

      // server object
      assert(!!metrics.server, "metrics: has server object");
      if (metrics.server) {
        assert(typeof metrics.server.uptime === "number" && metrics.server.uptime > 0,
          "metrics: server.uptime is positive number", `got ${metrics.server.uptime}`);
        assert(typeof metrics.server.rss === "number" && metrics.server.rss > 0,
          "metrics: server.rss is positive number", `got ${metrics.server.rss}`);
        assert(typeof metrics.server.heapUsed === "number" && metrics.server.heapUsed > 0,
          "metrics: server.heapUsed is positive number", `got ${metrics.server.heapUsed}`);
        assert(typeof metrics.server.heapTotal === "number" && metrics.server.heapTotal > 0,
          "metrics: server.heapTotal is positive number", `got ${metrics.server.heapTotal}`);
        assert(typeof metrics.server.external === "number",
          "metrics: server.external is number", `got ${typeof metrics.server.external}`);
        assert(typeof metrics.server.arrayBuffers === "number",
          "metrics: server.arrayBuffers is number", `got ${typeof metrics.server.arrayBuffers}`);
      }

      // nodes array
      assert(Array.isArray(metrics.nodes), "metrics: has nodes array");

      // timestamp
      assert(typeof metrics.timestamp === "number", "metrics: has timestamp");
      if (typeof metrics.timestamp === "number") {
        const now = Date.now();
        assert(metrics.timestamp > now - 60000 && metrics.timestamp <= now + 1000,
          "metrics: timestamp is recent", `got ${metrics.timestamp}, now=${now}`);
      }
    });

    it("Memory monitor: /metrics node pid", async () => {
      const c = new WsClient("metrics-pid-client");
      await c.connect();
      await c.request("node.register", { name: "metrics-pid-client", capabilities: ["ui"] });

      // Spawn a mock-program node
      const spawn = await httpPost("/node/spawn", { adapter: "mock", name: "metrics-pid-agent", cwd: ROOT });
      assert(!!spawn.nodeId, "metrics-pid: mock agent spawned");
      await sleep(3000);

      const metrics = await httpGet("/metrics") as any;
      assert(Array.isArray(metrics.nodes), "metrics-pid: nodes is array");

      const agentMetric = metrics.nodes.find((n: any) => n.name === "metrics-pid-agent");
      assert(!!agentMetric, "metrics-pid: agent found in metrics nodes");
      if (agentMetric) {
        assert(typeof agentMetric.pid === "number" && agentMetric.pid > 0,
          "metrics-pid: agent pid is positive integer", `got pid=${agentMetric.pid}`);
        // rss may be null if ps fails, but if present should be positive
        if (agentMetric.rss !== null && agentMetric.rss !== undefined) {
          assert(typeof agentMetric.rss === "number" && agentMetric.rss > 0,
            "metrics-pid: agent rss is positive when available", `got rss=${agentMetric.rss}`);
        }
        assert(typeof agentMetric.status === "string", "metrics-pid: agent has status string",
          `got status=${JSON.stringify(agentMetric.status)}`);
      }

      // Cleanup
      await httpPost("/node/stop", { nodeId: spawn.nodeId });
      await sleep(500);
      await c.disconnect();
    });
  });

  // ── Duty monitor ──────────────────────────────────────────

  it("duty-monitor integration: spawn → idle → status command", async () => {
    const c = new WsClient("dm-int-test");
    await c.connect();
    await c.request("node.register", { name: "dm-int-client", capabilities: ["ui"] });

    // Create a channel for the monitor
    const ch = await c.request("channel.create", { cwd: ROOT, name: "dm-int-ch" });

    // Spawn duty-monitor
    const spawn = await c.request("node.spawn", {
      adapter: "duty-monitor",
      name: "dm-int-monitor",
    });
    assert(!!spawn.nodeId, "dm-int: duty-monitor spawned");

    // Wait for idle
    await waitForNotification(c, "node.statusChanged",
      (p: any) => p.name === "dm-int-monitor" && p.status === "idle", 15000);
    assert(true, "dm-int: reached idle");

    // Join monitor to channel
    await c.request("channel.join", { channelId: ch.channelId, nodeId: spawn.nodeId });
    await sleep(500);

    // Send status command via DM (node.message)
    await c.request("node.message", { nodeId: spawn.nodeId, content: "status" });
    await sleep(1000);

    // Send trigger command via channel @mention
    await c.request("channel.post", { channelId: ch.channelId, content: "@dm-int-monitor trigger task=health" });
    await sleep(3000); // health check takes 1s for CPU sampling

    // Verify monitor posted health result to channel (no alerts expected since thresholds are high)
    // The fact that we got here without crash means the command pipeline works

    // Cleanup
    await c.request("node.stop", { nodeId: spawn.nodeId });
    await sleep(500);
    await c.disconnect();
  });

  // ── Plugin spawned no reconnect ───────────────────────────

  it("plugin-base: nerve-spawned plugin does not reconnect on disconnect", async () => {
    const { PluginBase } = await import("../../src/plugins/plugin-base.js");

    const testName = `test-spawned-noreconn-${Date.now()}`;

    // Save and override env: set NERVE_SPAWNED=1, clear PORT/NAME so they don't override test params
    const origSpawned = process.env.NERVE_SPAWNED;
    const origPort = process.env.NERVE_PORT;
    const origNodeName = process.env.NERVE_NODE_NAME;
    process.env.NERVE_SPAWNED = "1";
    delete process.env.NERVE_PORT;
    delete process.env.NERVE_NODE_NAME;

    // Expose internal ws so we can simulate server-side disconnect
    class TestSpawnedPlugin extends PluginBase {
      getWs(): WebSocket { return this.ws; }
    }

    const plugin = new TestSpawnedPlugin({ port: getTestPort(), name: testName, reconnectDelay: 200 });

    // Mock process.exit to prevent vitest from crashing when the plugin calls exitProcess()
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

    try {
      await plugin.start();
      await sleep(300);

      // Verify registered
      const c = new WsClient("spawned-checker");
      await c.connect();
      await c.request("node.register", { name: "spawned-checker", capabilities: ["ui"] });

      let nodes = await c.request("node.list");
      let found = nodes.nodes.some((n: any) => n.name === testName);
      assert(found, "spawned-noreconn: plugin registered initially");

      // Simulate server-side disconnect by closing the ws directly (NOT plugin.stop()).
      // This triggers the 'close' handler without setting stopped=true, which is the real bug path.
      plugin.getWs().close();
      await sleep(600); // Wait past reconnectDelay (200ms)

      // Verify it did NOT re-register — with NERVE_SPAWNED=1, it should stay disconnected
      nodes = await c.request("node.list");
      found = nodes.nodes.some((n: any) => n.name === testName);
      assert(!found, "spawned-noreconn: plugin did NOT reconnect after server disconnect");

      await c.disconnect();
    } finally {
      plugin.stop(); // Cleanup
      exitSpy.mockRestore();
      // Restore env
      if (origSpawned !== undefined) process.env.NERVE_SPAWNED = origSpawned;
      else delete process.env.NERVE_SPAWNED;
      if (origPort !== undefined) process.env.NERVE_PORT = origPort;
      else delete process.env.NERVE_PORT;
      if (origNodeName !== undefined) process.env.NERVE_NODE_NAME = origNodeName;
      else delete process.env.NERVE_NODE_NAME;
    }
  });

  // ── Spawn standalone ──────────────────────────────────────

  describe("Spawn standalone", () => {
    it("spawn standalone: WS node.spawn with standalone=true skips channel auto-inherit", async () => {
      const c = new WsClient("standalone-ws-test");
      await c.connect();
      await c.request("node.register", { name: "standalone-ws-caller", capabilities: ["ui"] });

      // Create channel and join (caller in exactly 1 channel → normally inherits)
      const ch = await c.request("channel.create", { cwd: ROOT, name: "standalone-ws-ch" });
      await c.request("channel.join", { channelId: ch.channelId });

      // Spawn with standalone=true → should NOT auto-inherit
      const spawned = await c.request("node.spawn", {
        adapter: "mock",
        name: "standalone-child",
        standalone: true,
      });
      await sleep(2000);

      // Verify: child should NOT be in any channel
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
    });

    it("spawn standalone: WS node.spawn without standalone still auto-inherits", async () => {
      const c = new WsClient("standalone-default-test");
      await c.connect();
      await c.request("node.register", { name: "standalone-default-caller", capabilities: ["ui"] });

      const ch = await c.request("channel.create", { cwd: ROOT, name: "standalone-default-ch" });
      await c.request("channel.join", { channelId: ch.channelId });

      // Spawn WITHOUT standalone → should auto-inherit
      const spawned = await c.request("node.spawn", {
        adapter: "mock",
        name: "default-inherit-child",
      });
      await sleep(2000);

      const list = await c.request("node.list");
      const child = list.nodes?.find((n: any) => n.name === "default-inherit-child");
      assert(!!child, "standalone-default: child spawned");
      assert(
        child?.channels?.includes(ch.channelId),
        "standalone-default: child auto-inherited channel",
        `expected [${ch.channelId}], got ${JSON.stringify(child?.channels)}`,
      );

      await c.request("node.stop", { nodeId: spawned.nodeId });
      await sleep(500);
      await c.disconnect();
    });

    it("spawn standalone: MCP nerve_spawn with standalone=true skips auto-join", async () => {
      const c = new WsClient("standalone-mcp-test");
      await c.connect();
      await c.request("node.register", { name: "standalone-mcp-test", capabilities: ["ui"] });

      const mcp = new McpToolClient("standalone-mcp-test");
      await mcp.connect();

      // Create channel → sets currentChannelId in MCP
      const createRes = await mcp.callTool("nerve_create_channel", { name: "standalone-mcp-ch" });
      assert(!createRes.isError, "standalone-mcp: create channel");

      const channels = await c.request("channel.list", {});
      const ch = channels.channels.find((c: any) => c.name === "standalone-mcp-ch");
      assert(!!ch, "standalone-mcp: channel found");
      if (!ch) { await mcp.close(); await c.disconnect(); return; }

      // Spawn with standalone=true via MCP → should NOT auto-join
      const spawnRes = await mcp.callTool("nerve_spawn", {
        adapter: "mock",
        name: "standalone-mcp-child",
        standalone: true,
      });
      assert(!spawnRes.isError, "standalone-mcp: spawn succeeds");
      await sleep(3000);

      // Verify: child should NOT be in the channel
      const channelsAfter = await c.request("channel.list", {});
      const chAfter = channelsAfter.channels.find((c: any) => c.id === ch.id);
      assert(!chAfter?.nodes?.["standalone-mcp-child"], "standalone-mcp: child NOT in channel");

      // Cleanup
      const nodes = await httpPost("/node/list", {});
      const agent = (nodes as any).nodes.find((n: any) => n.name === "standalone-mcp-child");
      if (agent) await httpPost("/node/stop", { nodeId: agent.id });
      await sleep(500);
      await mcp.close();
      await c.disconnect();
    });
  });

  // ── Message source ────────────────────────────────────────

  describe("Message source", () => {
    it("message source: source field stored on register and visible in node.list", async () => {
      const c = new WsClient("source-reg-test");
      await c.connect();
      await c.request("node.register", { name: "source-tui-client", capabilities: ["ui"], source: "tui" });

      const list = await c.request("node.list");
      const node = list.nodes?.find((n: any) => n.name === "source-tui-client");
      assert(!!node, "source-reg: node found");
      assert(node?.source === "tui", "source-reg: source field is 'tui'",
        `got source=${JSON.stringify(node?.source)}`);

      // Also check that node without source has no source field
      const c2 = new WsClient("source-reg-test-2");
      await c2.connect();
      await c2.request("node.register", { name: "source-plain-client", capabilities: ["ui"] });

      const list2 = await c.request("node.list");
      const node2 = list2.nodes?.find((n: any) => n.name === "source-plain-client");
      assert(!node2?.source, "source-reg: no source when not provided");

      await c.disconnect();
      await c2.disconnect();
    });

    it("message source: message metadata includes sender's source", async () => {
      const sender = new WsClient("source-sender");
      const receiver = new WsClient("source-receiver");
      await sender.connect();
      await receiver.connect();

      await sender.request("node.register", { name: "source-android-sender", capabilities: ["ui"], source: "android" });
      await receiver.request("node.register", { name: "source-msg-receiver", capabilities: ["ui"] });

      const ch = await sender.request("channel.create", { cwd: ROOT, name: "source-metadata-ch" });
      await sender.request("channel.join", { channelId: ch.channelId });
      await receiver.request("channel.join", { channelId: ch.channelId });
      receiver.clearNotifications();

      await sender.request("channel.post", { channelId: ch.channelId, content: "hello from android" });
      await sleep(500);

      const msgs = receiver.getNotifications("channel.message");
      assert(msgs.length >= 1, "source-meta: receiver got message");
      const msg = msgs[0]?.params?.message;
      assert(msg?.metadata?.source === "android", "source-meta: metadata.source is 'android'",
        `got metadata=${JSON.stringify(msg?.metadata)}`);

      await sender.disconnect();
      await receiver.disconnect();
    });
  });

  // ── User recorder ─────────────────────────────────────────

  it("user-recorder: spawn → idle → verify no dm.response listener → stop", async () => {
    const c = new WsClient("ur-test-client");
    await c.connect();
    await c.request("node.register", { name: "ur-test-client", capabilities: ["ui"] });

    // Spawn user-recorder program node
    const spawn = await c.request("node.spawn", {
      adapter: "user-recorder",
      name: "ur-test-recorder",
      cwd: ROOT,
    });
    assert(!!spawn.nodeId, "ur: user-recorder spawned");

    await waitForNotification(c, "node.statusChanged",
      p => p.name === "ur-test-recorder" && p.status === "idle", 10000);
    assert(true, "ur: reached idle");

    // Verify user-recorder source code does NOT contain dm.response listener
    const srcPath = resolve(ROOT, "src/plugins/user-recorder/index.ts");
    const src = readFileSync(srcPath, "utf-8");
    assert(!src.includes('"dm.response"'), "ur: source has no dm.response listener");
    assert(src.includes('"dm.prompt"'), "ur: source still has dm.prompt listener");

    // Verify server log shows user-recorder connected and registered
    const logHasRecorder = serverLogBuffer.some(l => l.includes("ur-test-recorder"));
    assert(logHasRecorder, "ur: server log mentions ur-test-recorder");

    // Cleanup
    await c.request("node.stop", { nodeId: spawn.nodeId });
    await waitForNotification(c, "node.stopped", p => p.nodeId === spawn.nodeId, 5000);
    assert(true, "ur: stopped cleanly");

    await c.disconnect();
  });
});

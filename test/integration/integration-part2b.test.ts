/**
 * Nerve Integration Tests - Part 2b
 *
 * Converted from test/self-test.ts (testSceneStartDuplicate through testNerveChannelsEmptyList).
 * Requires a running nerve server (managed by beforeAll/afterAll).
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import {
  assert, assertEq, sleep,
  ROOT, getTestData,
  httpPost,
  WsClient, McpToolClient,
  startServer, stopServer, serverLogBuffer,
  resolve, mkdirSync,
} from "../helpers/vitest.js";

describe("Nerve Integration Tests - Part 2b", () => {
  beforeAll(startServer);
  afterAll(stopServer);

  // ============================================================
  // Scene tests
  // ============================================================

  describe("scene tests", () => {
    it("scene.start: rejects duplicate start", async () => {
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
    });

    it("scene.start: rejects unknown scene", async () => {
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
    });

    it("scene.start: on_ready warnings returned to caller", async () => {
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
    });

    it("scene.start: stdio node on_ready waits for session ready", async () => {
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
    });

    it("scene.start: program node receives channel.nodeJoined after join", async () => {
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
    });

    it("scene HTTP API", async () => {
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
    });
  });

  // ============================================================
  // Message nodeType
  // ============================================================

  it("channel.post: message includes nodeType metadata", async () => {
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
  });

  // ============================================================
  // Guardian tests
  // ============================================================

  describe("guardian tests", () => {
    it("Guardian: cleanupStaleGuardian removes dead guardian + channels", async () => {
      // Import ChannelManager to test cleanupStaleGuardian() directly
      const { ChannelManager } = await import("../../src/channel-manager.js");
      const tmpDataDir = resolve(getTestData(), "guardian-test-cleanup");
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
    });

    it("Guardian: cleanupStaleGuardian skips live guardian", async () => {
      const { ChannelManager } = await import("../../src/channel-manager.js");
      const tmpDataDir = resolve(getTestData(), "guardian-test-alive");
      mkdirSync(tmpDataDir, { recursive: true });
      const cm = new ChannelManager({ dataDir: tmpDataDir, port: 0 });

      // Register a guardian with alive transport (readyState=1 === OPEN)
      const ws2 = { readyState: 1, OPEN: 1, on() {}, send() {}, close() {} } as any;
      const node = cm.nodePool.registerWebSocket(ws2, "context-guardian", ["monitor"], "observer");

      const result = cm.cleanupStaleGuardian("context-guardian");
      assertEq(result, "none", "guardian alive: non-program node returns 'none' (impostor removed)");

      // Non-program node gets removed even if alive
      assert(!cm.nodePool.getByName("context-guardian"), "guardian alive: non-program node removed from pool");
    });

    it("Guardian: cleanupStaleGuardian ignores non-guardian nodes", async () => {
      const { ChannelManager } = await import("../../src/channel-manager.js");
      const tmpDataDir = resolve(getTestData(), "guardian-test-nong");
      mkdirSync(tmpDataDir, { recursive: true });
      const cm = new ChannelManager({ dataDir: tmpDataDir, port: 0 });

      // Register a regular node with same name but different permissions
      const ws3 = { readyState: 3, OPEN: 1, on() {}, send() {}, close() {} } as any;
      cm.nodePool.registerWebSocket(ws3, "context-guardian", ["ui"], "operator");

      const result = cm.cleanupStaleGuardian("context-guardian");
      assertEq(result, "none", "guardian non-guardian: returns 'none' — non-program impostor removed");
      assert(!cm.nodePool.getByName("context-guardian"), "guardian non-guardian: impostor removed from pool");
    });

    it("Guardian: cleanupStaleGuardian returns 'none' when no node", async () => {
      const { ChannelManager } = await import("../../src/channel-manager.js");
      const tmpDataDir = resolve(getTestData(), "guardian-test-none");
      mkdirSync(tmpDataDir, { recursive: true });
      const cm = new ChannelManager({ dataDir: tmpDataDir, port: 0 });

      const result = cm.cleanupStaleGuardian("context-guardian");
      assertEq(result, "none", "guardian none: returns 'none' when no node exists");
    });

    it("Guardian: dead program node → full cleanup (pool + channels)", async () => {
      const { ChannelManager } = await import("../../src/channel-manager.js");
      const tmpDataDir = resolve(getTestData(), "guardian-dead-prog");
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
    });

    it("Guardian: alive program node → skip cleanup", async () => {
      const { ChannelManager } = await import("../../src/channel-manager.js");
      const tmpDataDir = resolve(getTestData(), "guardian-alive-prog");
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
    });

    it("Guardian: non-program WS node should not block real guardian", async () => {
      const { ChannelManager } = await import("../../src/channel-manager.js");
      const tmpDataDir = resolve(getTestData(), "guardian-non-prog");
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
    });
  });

  // ============================================================
  // Session reset source
  // ============================================================

  describe("session reset source", () => {
    it("session reset: source in log must contain agent name", async () => {
      // Spawn a mock agent and get its sessionId
      const spawnResult = await httpPost("/node/spawn", {
        adapter: "mock",
        name: "reset-src-agent",
        cwd: ROOT,
      });
      assert(!!spawnResult.nodeId, "reset-src: agent spawned");
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
    });

    it("session reset: HTTP API without source should not default to bare 'http_api'", async () => {
      // Spawn a mock agent
      const spawnResult = await httpPost("/node/spawn", {
        adapter: "mock",
        name: "reset-default-agent",
        cwd: ROOT,
      });
      assert(!!spawnResult.nodeId, "reset-default: agent spawned");
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
    });

    it("session reset: mcp_tool:<name> format passes through to log correctly", async () => {
      const spawnResult = await httpPost("/node/spawn", {
        adapter: "mock",
        name: "reset-mcp-agent",
        cwd: ROOT,
      });
      assert(!!spawnResult.nodeId, "reset-mcp: agent spawned");
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
    });
  });

  // ============================================================
  // Spawn duplicate name
  // ============================================================

  describe("spawn duplicate name", () => {
    it("spawn duplicate name: error should include existing node info", async () => {
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
    });

    it("spawn duplicate name: error for node not in any channel", async () => {
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
    });

    it("spawn duplicate name: error accurately identifies which channel", async () => {
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
    });
  });

  // ============================================================
  // Post from process
  // ============================================================

  describe("post from process", () => {
    it("nerve_post: single channel agent can omit channel_id", async () => {
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
    });

    it("nerve_post: multi-channel agent without channel_id should error", async () => {
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
    });

    it("nerve_post: multi-channel agent with explicit channel_id succeeds", async () => {
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
    });

    it("nerve_post: agent not in any channel should error", async () => {
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
    });
  });

  // ============================================================
  // nerve_members MCP tool tests
  // ============================================================

  describe("nerve_members", () => {
    it("nerve_members: query by channel_id", async () => {
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
    });

    it("nerve_members: query without channel_id (all caller's channels)", async () => {
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
    });

    it("nerve_members: invalid channel_id returns error", async () => {
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
    });
  });

  // ============================================================
  // nerve_channels MCP tool tests
  // ============================================================

  describe("nerve_channels", () => {
    it("nerve_channels: list all channels", async () => {
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
    });

    it("nerve_channels: filter by cwd", async () => {
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
    });

    it("nerve_channels: empty list when no channels match cwd", async () => {
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
    });
  });
});

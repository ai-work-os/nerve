/**
 * Nerve Integration Tests - Part 2a
 *
 * Converted from test/self-test.ts (testNodeMessage through testSceneStop).
 * Requires a running nerve server (managed by beforeAll/afterAll).
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import {
  assert, assertEq, sleep,
  ROOT, getTestPort, getTestData,
  httpPost, httpGet,
  WsClient, waitForNotification,
  startServer, stopServer, serverLogBuffer,
  resolve, existsSync, rmSync, writeFileSync,
} from "../helpers/vitest.js";

describe("Nerve Integration Tests - Part 2a", () => {
  beforeAll(startServer);
  afterAll(stopServer);

  // ============================================================
  // node.message tests
  // ============================================================

  describe("node.message", () => {
    it("DM command for program nodes", async () => {
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
    });

    it("kill (server-side process kill)", async () => {
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
    });

    it("/node/message HTTP endpoint", async () => {
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
    });

    it("on spawned program node", async () => {
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
    });

    it("transport.alive check", async () => {
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
    });
  });

  // ============================================================
  // plugin-base tests
  // ============================================================

  describe("plugin-base", () => {
    it("onMessage handler", async () => {
      const { PluginBase } = await import("../../src/plugins/plugin-base.js");

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

      const plugin = new TestMsgPlugin({ port: getTestPort(), name: testName });
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
    });

    it("node.register commands/events metadata", async () => {
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
    });

    it("command parsing", async () => {
      const { PluginBase } = await import("../../src/plugins/plugin-base.js");

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

      const plugin = new TestCmdPlugin({ port: getTestPort(), name: testName });
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
    });

    it("help command outputs each command", async () => {
      const { PluginBase } = await import("../../src/plugins/plugin-base.js");

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

      const plugin = new TestHelpPlugin({ port: getTestPort(), name: testName });
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
    });

    it("debug log level accepted", async () => {
      const { PluginBase } = await import("../../src/plugins/plugin-base.js");

      const testName = `test-debug-log-${Date.now()}`;
      class TestDebugPlugin extends PluginBase {
        override getCommands() {
          return { ping: { description: "test" } };
        }
        protected override onCommand() {
          this.log("debug", "debug level works");
        }
      }

      const plugin = new TestDebugPlugin({ port: getTestPort(), name: testName });
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
    });

    it("successful channel command does NOT post to channel", async () => {
      const { PluginBase } = await import("../../src/plugins/plugin-base.js");

      const testName = `test-ch-ok-${Date.now()}`;

      class TestOkPlugin extends PluginBase {
        override getCommands() {
          return { status: { description: "Show status" } };
        }
        protected override onCommand(command: string, args: Record<string, string>, from?: string): string | void {
          // void return = success, no channel reply
        }
      }

      const plugin = new TestOkPlugin({ port: getTestPort(), name: testName });
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
    });

    it("unknown channel command silently ignored (no reply)", async () => {
      const { PluginBase } = await import("../../src/plugins/plugin-base.js");

      const testName = `test-ch-unk-${Date.now()}`;

      class TestUnkPlugin extends PluginBase {
        override getCommands() {
          return { start: { description: "Start" } };
        }
        protected override onCommand(command: string, args: Record<string, string>, from?: string): string | void {
          // void = success
        }
      }

      const plugin = new TestUnkPlugin({ port: getTestPort(), name: testName });
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
    });

    it("onCommand error return posts to channel", async () => {
      const { PluginBase } = await import("../../src/plugins/plugin-base.js");

      const testName = `test-ch-cmderr-${Date.now()}`;

      class TestCmdErrPlugin extends PluginBase {
        override getCommands() {
          return { fail: { description: "Always fails" } };
        }
        protected override onCommand(command: string, args: Record<string, string>, from?: string): string | void {
          if (command === "fail") return "API key not set";
        }
      }

      const plugin = new TestCmdErrPlugin({ port: getTestPort(), name: testName });
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
    });
  });

  // ============================================================
  // ai-ear tests
  // ============================================================

  describe("ai-ear", () => {
    it("flush command (no active buffer)", async () => {
      const c = new WsClient("flush-test");
      await c.connect();
      await c.request("node.register", { name: "flush-test", capabilities: ["ui"] });

      // Spawn ai-ear
      const sp = await c.request("node.spawn", { adapter: "ai-ear", name: "mc-flush-test", cwd: ROOT });

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
    });

    it("pushToChannel success log", async () => {
      // Test via TranscriptBuffer + SliceWriter directly (unit test)
      const { TranscriptBuffer, SliceWriter } = await import("../../src/plugins/ai-ear/index.js");

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
    });

    it("TranscriptBuffer flush mechanics", async () => {
      const { TranscriptBuffer } = await import("../../src/plugins/ai-ear/index.js");

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
    });
  });

  // ============================================================
  // mc subscribe tests
  // ============================================================

  describe("mc subscribe", () => {
    it("DM subscribe with from field", async () => {
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
    });

    it("unsubscribe DM delivery", async () => {
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
    });

    it("channel.nodeLeft delivered for auto-unsubscribe", async () => {
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
    });

    it("multiple subscribers + idempotent", async () => {
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
    });

    it("subscribe via channel message", async () => {
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
    });

    it("channel.nodeLeft fires on WS disconnect", async () => {
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
    });

    it("subscribe <name> via DM specifies target", async () => {
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
    });

    it("'subscribe me' resolves to sender", async () => {
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
    });
  });

  // ============================================================
  // promptNode tests
  // ============================================================

  describe("promptNode", () => {
    it("rejected promise recovers to idle", async () => {
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
    });

    it("end_turn clears activity", async () => {
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

      // Verify activity is set during prompt (tool_call -> "tool: mock_tool")
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
    });
  });

  // ============================================================
  // scene tests
  // ============================================================

  describe("scene", () => {
    it("on_ready: promptNode error captured as warning", async () => {
      const c = new WsClient("scene-prompt-err");
      await c.connect();
      await c.request("node.register", { name: "scene-prompt-err", capabilities: ["ui"] });

      // Create scene config with on_ready prompt that triggers error
      const scenesDir = resolve(getTestData(), "scenes");
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
    });

    it("scene.list: returns available scenes", async () => {
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
    });

    it("scene.start: spawns nodes + creates channel + joins", async () => {
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
    });

    it("scene.stop: stops nodes + closes channel", async () => {
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
    });
  });
});

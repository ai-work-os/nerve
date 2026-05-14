/**
 * DM history HTTP endpoint tests.
 *
 * Verifies /node/dm-history reads from dm_messages and supports
 * limit + before pagination. Used by `nerve dm read` CLI.
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import {
  assert, assertEq, sleep,
  ROOT,
  httpPost,
  WsClient,
  startServer, stopServer,
} from "../helpers/vitest.js";

describe("DM History HTTP endpoint (/node/dm-history)", () => {
  beforeAll(startServer);
  afterAll(stopServer);

  it("returns empty messages for a node with no DMs", async () => {
    // spawn an idle mock agent — no prompts yet
    const spawn = await httpPost("/node/spawn", { adapter: "mock", name: "dm-hist-empty", cwd: ROOT }) as any;
    assert(!!spawn.nodeId, "spawn: returns nodeId");
    await sleep(500);

    const r = await httpPost("/node/dm-history", { nodeName: "dm-hist-empty" }) as any;
    assert(!r.error, `dm-history empty: no error, got ${r.error}`);
    assert(Array.isArray(r.messages), "dm-history empty: messages is array");
    assertEq((r.messages as any[]).length, 0, "dm-history empty: messages is empty");

    await httpPost("/node/stop", { nodeId: spawn.nodeId });
  });

  it("returns DM messages in chronological order after prompting", async () => {
    const client = new WsClient("dm-hist-client");
    await client.connect();
    await client.request("node.register", { name: "dm-hist-client", capabilities: ["ui"] });

    const agent = await client.request("node.spawn", { adapter: "mock", name: "dm-hist-agent", cwd: ROOT });
    assert(!!agent.nodeId, "dm-hist: spawn returns nodeId");
    await sleep(3000);

    await client.request("node.subscribe", { nodeId: agent.nodeId });

    // Send 2 prompts — each persists user_message + assistant reply
    await client.request("node.prompt", { nodeId: agent.nodeId, content: "first prompt" });
    await sleep(500);
    await client.request("node.prompt", { nodeId: agent.nodeId, content: "second prompt" });
    await sleep(500);

    const r = await httpPost("/node/dm-history", { nodeName: "dm-hist-agent" }) as any;
    assert(!r.error, `dm-history: no error, got ${r.error}`);
    const messages = r.messages as any[];
    assert(Array.isArray(messages), "dm-history: messages is array");
    assert(messages.length >= 2, `dm-history: at least 2 messages, got ${messages.length}`);

    // Should contain both prompts as user messages
    const userTexts = messages.filter(m => m.role === "user").map(m => m.text);
    assert(userTexts.includes("first prompt"), "dm-history: first prompt persisted");
    assert(userTexts.includes("second prompt"), "dm-history: second prompt persisted");

    // Chronological: timestamps strictly ascending
    const ts = messages.map(m => m.ts);
    for (let i = 1; i < ts.length; i++) {
      assert(ts[i] >= ts[i - 1], `dm-history: ts[${i}]=${ts[i]} >= ts[${i-1}]=${ts[i-1]}`);
    }

    // Each message has expected shape
    for (const m of messages) {
      assert(typeof m.id === "string", "dm-history: message.id is string");
      assert(typeof m.nodeId === "string", "dm-history: message.nodeId is string");
      assert(typeof m.role === "string", "dm-history: message.role is string");
      assert(typeof m.text === "string", "dm-history: message.text is string");
      assert(typeof m.ts === "number", "dm-history: message.ts is number");
    }

    await httpPost("/node/stop", { nodeId: agent.nodeId });
    await client.disconnect();
  });

  it("respects limit parameter", async () => {
    const client = new WsClient("dm-hist-limit");
    await client.connect();
    await client.request("node.register", { name: "dm-hist-limit", capabilities: ["ui"] });

    const agent = await client.request("node.spawn", { adapter: "mock", name: "dm-hist-limit-agent", cwd: ROOT });
    await sleep(3000);
    await client.request("node.subscribe", { nodeId: agent.nodeId });

    // Send 3 prompts → at least 3 user messages + 3 replies persisted
    for (let i = 0; i < 3; i++) {
      await client.request("node.prompt", { nodeId: agent.nodeId, content: `prompt ${i}` });
      await sleep(300);
    }

    const all = await httpPost("/node/dm-history", { nodeName: "dm-hist-limit-agent" }) as any;
    const allLen = (all.messages as any[]).length;
    assert(allLen >= 3, `dm-history limit: precondition got ${allLen} messages`);

    const limited = await httpPost("/node/dm-history", { nodeName: "dm-hist-limit-agent", limit: 2 }) as any;
    assertEq((limited.messages as any[]).length, Math.min(2, allLen), "dm-history limit: limit=2 returns 2");

    await httpPost("/node/stop", { nodeId: agent.nodeId });
    await client.disconnect();
  });

  it("accepts nodeId as alternative to nodeName", async () => {
    const spawn = await httpPost("/node/spawn", { adapter: "mock", name: "dm-hist-byid", cwd: ROOT }) as any;
    await sleep(500);

    const r = await httpPost("/node/dm-history", { nodeId: spawn.nodeId }) as any;
    assert(!r.error, `dm-history by id: no error, got ${r.error}`);
    assert(Array.isArray(r.messages), "dm-history by id: messages is array");

    await httpPost("/node/stop", { nodeId: spawn.nodeId });
  });

  it("returns error for unknown node", async () => {
    const r = await httpPost("/node/dm-history", { nodeName: "nope-does-not-exist" }) as any;
    assert(!!r.error, "dm-history unknown: returns error");
  });

  it("returns error when neither nodeId nor nodeName supplied", async () => {
    const r = await httpPost("/node/dm-history", {}) as any;
    assert(!!r.error, "dm-history missing args: returns error");
  });
});

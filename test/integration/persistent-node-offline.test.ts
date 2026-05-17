/**
 * Persistent node offline/online lifecycle.
 *
 * A "persistent" node (registered with persistent:true, e.g. mac-clipboard)
 * stays in the channel member list when its WS disconnects — it goes
 * "offline" instead of being removed — and is rebound to the same nodeId
 * (status back to "idle") when it reconnects with the same name.
 *
 * Regression: a non-persistent WS client is still removed from its channel
 * on disconnect (existing behavior unchanged).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  WsClient, sleep, startServer, stopServer, waitForNotification,
} from "../helpers/vitest.js";

async function findNode(inspector: WsClient, name: string): Promise<any | undefined> {
  const r = await inspector.request("node.list", {});
  return r.nodes?.find((n: any) => n.name === name);
}

describe("persistent node offline/online", () => {
  beforeAll(startServer);
  afterAll(stopServer);

  it("persistent node stays in channel as offline after WS close", async () => {
    const inspector = new WsClient("inspector-1");
    await inspector.connect();
    await inspector.request("node.register", { name: "inspector-1", capabilities: ["ui"] });

    const ch = await inspector.request("channel.create", { cwd: "/tmp", name: "persist-room-1" });

    const persistent = new WsClient("persist-client-1");
    await persistent.connect();
    await persistent.request("node.register", { name: "persist-client-1", capabilities: ["monitor"], persistent: true });
    await persistent.request("channel.join", { channelId: ch.channelId });

    // Confirm it's a member and online
    let node = await findNode(inspector, "persist-client-1");
    expect(node, "persistent node should be registered").toBeDefined();
    expect(node.channels).toContain(ch.channelId);
    expect(node.status).toBe("idle");

    // Close the WS
    persistent.close();
    await sleep(300);

    // Node still in pool, still channel member, status offline
    node = await findNode(inspector, "persist-client-1");
    expect(node, "persistent node should NOT be removed on WS close").toBeDefined();
    expect(node.status).toBe("offline");
    expect(node.channels, "persistent node should remain a channel member").toContain(ch.channelId);

    await inspector.disconnect();
  }, 30000);

  it("broadcasts node.statusChanged(offline) when persistent node disconnects", async () => {
    const inspector = new WsClient("inspector-2");
    await inspector.connect();
    await inspector.request("node.register", { name: "inspector-2", capabilities: ["ui"] });
    const ch = await inspector.request("channel.create", { cwd: "/tmp", name: "persist-room-2" });

    const persistent = new WsClient("persist-client-2");
    await persistent.connect();
    await persistent.request("node.register", { name: "persist-client-2", capabilities: ["monitor"], persistent: true });
    await persistent.request("channel.join", { channelId: ch.channelId });

    inspector.clearNotifications();
    persistent.close();

    const evt = await waitForNotification(inspector, "node.statusChanged",
      (p) => p.name === "persist-client-2" && p.status === "offline");
    expect(evt.status).toBe("offline");

    await inspector.disconnect();
  }, 30000);

  it("rebinds persistent node to the same nodeId on reconnect (back online)", async () => {
    const inspector = new WsClient("inspector-3");
    await inspector.connect();
    await inspector.request("node.register", { name: "inspector-3", capabilities: ["ui"] });
    const ch = await inspector.request("channel.create", { cwd: "/tmp", name: "persist-room-3" });

    const first = new WsClient("persist-client-3");
    await first.connect();
    const reg1 = await first.request("node.register", { name: "persist-client-3", capabilities: ["monitor"], persistent: true });
    await first.request("channel.join", { channelId: ch.channelId });
    const originalNodeId = reg1.nodeId;

    // Disconnect → offline
    first.close();
    await sleep(300);
    let node = await findNode(inspector, "persist-client-3");
    expect(node.status).toBe("offline");

    // Reconnect with same name + persistent
    inspector.clearNotifications();
    const second = new WsClient("persist-client-3");
    await second.connect();
    const reg2 = await second.request("node.register", { name: "persist-client-3", capabilities: ["monitor"], persistent: true });

    // Same nodeId — rebind, not a new node
    expect(reg2.nodeId, "reconnect should reuse the original nodeId").toBe(originalNodeId);

    // Status back to idle, still a channel member
    await sleep(200);
    node = await findNode(inspector, "persist-client-3");
    expect(node.status).toBe("idle");
    expect(node.channels, "channel membership preserved across reconnect").toContain(ch.channelId);

    // statusChanged broadcast on reconnect
    const evt = await waitForNotification(inspector, "node.statusChanged",
      (p) => p.name === "persist-client-3" && p.status === "idle");
    expect(evt.status).toBe("idle");

    second.close();
    await inspector.disconnect();
  }, 30000);

  it("regression: non-persistent node is removed from channel on WS close", async () => {
    const inspector = new WsClient("inspector-4");
    await inspector.connect();
    await inspector.request("node.register", { name: "inspector-4", capabilities: ["ui"] });
    const ch = await inspector.request("channel.create", { cwd: "/tmp", name: "persist-room-4" });

    const normal = new WsClient("normal-client-4");
    await normal.connect();
    await normal.request("node.register", { name: "normal-client-4", capabilities: ["ui"] });
    await normal.request("channel.join", { channelId: ch.channelId });

    let node = await findNode(inspector, "normal-client-4");
    expect(node, "non-persistent node registered").toBeDefined();
    expect(node.channels).toContain(ch.channelId);

    normal.close();
    await sleep(300);

    node = await findNode(inspector, "normal-client-4");
    expect(node, "non-persistent node should be removed on WS close").toBeUndefined();

    await inspector.disconnect();
  }, 30000);

  it("survives multiple offline→online cycles with a stable nodeId", async () => {
    const inspector = new WsClient("inspector-5");
    await inspector.connect();
    await inspector.request("node.register", { name: "inspector-5", capabilities: ["ui"] });
    const ch = await inspector.request("channel.create", { cwd: "/tmp", name: "persist-room-5" });

    const first = new WsClient("persist-client-5");
    await first.connect();
    const reg1 = await first.request("node.register", { name: "persist-client-5", capabilities: ["monitor"], persistent: true });
    await first.request("channel.join", { channelId: ch.channelId });
    const originalNodeId = reg1.nodeId;

    // Cycle 1: disconnect → offline
    first.close();
    await sleep(300);
    let node = await findNode(inspector, "persist-client-5");
    expect(node.status, "cycle 1: offline after first close").toBe("offline");
    expect(node.id).toBe(originalNodeId);

    // Cycle 1: reconnect → idle
    const second = new WsClient("persist-client-5");
    await second.connect();
    const reg2 = await second.request("node.register", { name: "persist-client-5", capabilities: ["monitor"], persistent: true });
    expect(reg2.nodeId, "cycle 1: same nodeId on reconnect").toBe(originalNodeId);
    await sleep(200);
    node = await findNode(inspector, "persist-client-5");
    expect(node.status, "cycle 1: idle after reconnect").toBe("idle");

    // Cycle 2: disconnect again → offline again
    second.close();
    await sleep(300);
    node = await findNode(inspector, "persist-client-5");
    expect(node, "cycle 2: node still present after second close").toBeDefined();
    expect(node.status, "cycle 2: offline after second close").toBe("offline");
    expect(node.id, "nodeId stable across cycles").toBe(originalNodeId);
    expect(node.channels, "cycle 2: still a channel member").toContain(ch.channelId);

    await inspector.disconnect();
  }, 30000);

  it("rebinds on register-before-close race without spawning a ghost node", async () => {
    const inspector = new WsClient("inspector-6");
    await inspector.connect();
    await inspector.request("node.register", { name: "inspector-6", capabilities: ["ui"] });
    const ch = await inspector.request("channel.create", { cwd: "/tmp", name: "persist-room-6" });

    const ws1 = new WsClient("persist-client-6");
    await ws1.connect();
    const reg1 = await ws1.request("node.register", { name: "persist-client-6", capabilities: ["monitor"], persistent: true });
    await ws1.request("channel.join", { channelId: ch.channelId });
    const originalNodeId = reg1.nodeId;

    // ws1 is still OPEN (not closed) — simulate a transient reconnect where the
    // new register arrives before the old socket's close is processed.
    const ws2 = new WsClient("persist-client-6");
    await ws2.connect();
    const reg2 = await ws2.request("node.register", { name: "persist-client-6", capabilities: ["monitor"], persistent: true });

    // Must rebind to the SAME node — no auto-suffix, no ghost "persist-client-6-2".
    expect(reg2.nodeId, "register-before-close should rebind to the original nodeId").toBe(originalNodeId);
    expect(reg2.name, "no auto-suffix on persistent rebind").toBe("persist-client-6");

    let allMatching = (await inspector.request("node.list", {})).nodes
      .filter((n: any) => n.name.startsWith("persist-client-6"));
    expect(allMatching.length, "exactly one node, no ghost").toBe(1);

    // Now close the stale ws1 — the node must stay ONLINE (not flipped offline
    // by the stale close, since it already rebound to ws2).
    ws1.close();
    await sleep(400);

    const node = await findNode(inspector, "persist-client-6");
    expect(node, "node still present").toBeDefined();
    expect(node.status, "stale close must not knock the node offline").toBe("idle");
    expect(node.id).toBe(originalNodeId);
    expect(node.channels).toContain(ch.channelId);

    ws2.close();
    await inspector.disconnect();
  }, 30000);
});

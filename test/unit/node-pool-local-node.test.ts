/**
 * NodePool.registerLocalNode — registers an in-process node with a synthetic
 * "local" transport. Use for modules that live inside the nerve process but
 * should appear in node.list (e.g. service-supervisor exposing its state).
 *
 * No WS, no stdio. The node is discoverable via node.list, can carry a
 * health contract, and supports `touch()` to update lastActiveAt.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePool } from "../../src/node/node-pool.js";
import { Store } from "../../src/storage/store.js";

describe("NodePool.registerLocalNode", () => {
  let dir: string;
  let store: Store;
  let pool: NodePool;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "np-local-"));
    store = new Store(":memory:");
    pool = new NodePool(store, () => { /* events: noop */ });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("注册后能在 listAll 里看到，transport 类型是 'local'", () => {
    const node = pool.registerLocalNode("service-supervisor", {
      health: { liveness: "connection", maxIdleMs: 120_000 },
    });
    expect(node.name).toBe("service-supervisor");
    expect(node.transport.type).toBe("local");
    expect(pool.listAll().find(n => n.name === "service-supervisor")).toBeDefined();
  });

  it("toInfo() 暴露 health 契约 + transport='local'", () => {
    const node = pool.registerLocalNode("service-supervisor", {
      health: { liveness: "connection", maxIdleMs: 120_000 },
    });
    const info = node.toInfo();
    expect(info.transport).toBe("local");
    expect(info.health).toEqual({ liveness: "connection", maxIdleMs: 120_000 });
    expect(info.pid).toBeUndefined();
  });

  it("默认 status='idle'（没有连接概念）", () => {
    const node = pool.registerLocalNode("svc", {});
    expect(node.status).toBe("idle");
  });

  it("touch() 更新 lastActiveAt", () => {
    const node = pool.registerLocalNode("svc", {});
    const before = node.lastActiveAt;
    // 等待 1ms 让时间戳能往前走
    const target = before + 1;
    while (Date.now() <= target) { /* spin */ }
    node.touch();
    expect(node.lastActiveAt).toBeGreaterThan(before);
  });

  it("supervised 字段可写可读，进入 toInfo()", () => {
    const node = pool.registerLocalNode("svc", {});
    node.supervised = [
      { name: "mac-clipboard", pid: 1234, state: "running", restarts: 0, restartHistory: [] },
    ];
    const info = node.toInfo();
    expect(info.supervised).toHaveLength(1);
    expect(info.supervised![0].name).toBe("mac-clipboard");
  });

  it("名字冲突时抛错（保持 name 唯一）", () => {
    pool.registerLocalNode("svc", {});
    expect(() => pool.registerLocalNode("svc", {})).toThrow(/already taken|already registered/i);
  });

  it("removeLocalNode 之后再注册同名 OK", () => {
    const a = pool.registerLocalNode("svc", {});
    pool.removeLocalNode(a.id);
    expect(() => pool.registerLocalNode("svc", {})).not.toThrow();
  });
});

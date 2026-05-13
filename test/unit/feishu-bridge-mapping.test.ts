/**
 * MappingStore — feishu_chat_id ↔ nerve channel/agent，JSON 文件持久化。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MappingStore } from "../../src/plugins/feishu-bridge/mapping.js";

describe("feishu-bridge MappingStore", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "feishu-map-"));
    path = join(dir, "mapping.json");
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("初始为空", () => {
    const m = new MappingStore(path);
    expect(m.all()).toEqual([]);
    expect(m.get("oc_abc")).toBeUndefined();
  });

  it("写入后能读回（内存）", async () => {
    const m = new MappingStore(path);
    await m.set({
      feishuChatId: "oc_abc",
      channelId: "ch_1",
      agentName: "codex-feishu-oc_abc12",
      createdAt: "2026-05-13T10:00:00+08:00",
    });
    const got = m.get("oc_abc");
    expect(got).toBeDefined();
    expect(got!.channelId).toBe("ch_1");
    expect(got!.agentName).toBe("codex-feishu-oc_abc12");
  });

  it("set 后立即写盘", async () => {
    const m = new MappingStore(path);
    await m.set({
      feishuChatId: "oc_x",
      channelId: "ch_x",
      agentName: "codex-x",
      createdAt: "2026-05-13T10:00:00+08:00",
    });
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw).toHaveLength(1);
    expect(raw[0].feishuChatId).toBe("oc_x");
  });

  it("新实例可从磁盘恢复", async () => {
    const m1 = new MappingStore(path);
    await m1.set({
      feishuChatId: "oc_a", channelId: "ch_a", agentName: "a",
      createdAt: "2026-05-13T10:00:00+08:00",
    });
    await m1.set({
      feishuChatId: "oc_b", channelId: "ch_b", agentName: "b",
      createdAt: "2026-05-13T10:01:00+08:00",
    });
    const m2 = new MappingStore(path);
    expect(m2.all()).toHaveLength(2);
    expect(m2.get("oc_a")!.channelId).toBe("ch_a");
    expect(m2.get("oc_b")!.channelId).toBe("ch_b");
  });

  it("相同 feishuChatId 第二次 set 覆盖", async () => {
    const m = new MappingStore(path);
    await m.set({
      feishuChatId: "oc_a", channelId: "ch_old", agentName: "old",
      createdAt: "2026-05-13T10:00:00+08:00",
    });
    await m.set({
      feishuChatId: "oc_a", channelId: "ch_new", agentName: "new",
      createdAt: "2026-05-13T11:00:00+08:00",
    });
    expect(m.all()).toHaveLength(1);
    expect(m.get("oc_a")!.channelId).toBe("ch_new");
  });

  it("文件路径上层目录不存在时自动建", async () => {
    const deep = join(dir, "a", "b", "c", "mapping.json");
    const m = new MappingStore(deep);
    await m.set({
      feishuChatId: "oc_x", channelId: "ch", agentName: "n",
      createdAt: "2026-05-13T10:00:00+08:00",
    });
    expect(existsSync(deep)).toBe(true);
  });

  it("文件 JSON 坏掉：日志告警 + 备份 + 内存空表（不静默丢数据）", () => {
    writeFileSync(path, "not valid json {{");
    const logs: string[] = [];
    const m = new MappingStore(path, (msg) => logs.push(msg));
    expect(m.all()).toEqual([]);
    expect(logs.some(l => /corrupt/i.test(l))).toBe(true);
    // 应该看到一个 .corrupt.* 备份文件
    const files = readdirSync(dir);
    expect(files.some(f => f.includes(".corrupt."))).toBe(true);
  });
});

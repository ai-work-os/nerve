/**
 * Feishu config loader — 读 ~/.nerve/feishu.json，校验必填字段。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/plugins/feishu-bridge/config.js";

describe("feishu-bridge config", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "feishu-cfg-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("加载合法配置文件", () => {
    const path = join(dir, "feishu.json");
    writeFileSync(path, JSON.stringify({ app_id: "cli_abc", app_secret: "sec123" }));
    const cfg = loadConfig(path);
    expect(cfg.app_id).toBe("cli_abc");
    expect(cfg.app_secret).toBe("sec123");
  });

  it("文件不存在抛错", () => {
    expect(() => loadConfig(join(dir, "missing.json"))).toThrow(/not found|ENOENT|找不到/i);
  });

  it("缺 app_id 抛错", () => {
    const path = join(dir, "feishu.json");
    writeFileSync(path, JSON.stringify({ app_secret: "sec123" }));
    expect(() => loadConfig(path)).toThrow(/app_id/);
  });

  it("缺 app_secret 抛错", () => {
    const path = join(dir, "feishu.json");
    writeFileSync(path, JSON.stringify({ app_id: "cli_abc" }));
    expect(() => loadConfig(path)).toThrow(/app_secret/);
  });

  it("空字段也视为缺失", () => {
    const path = join(dir, "feishu.json");
    writeFileSync(path, JSON.stringify({ app_id: "", app_secret: "" }));
    expect(() => loadConfig(path)).toThrow(/app_id|app_secret/);
  });

  it("非法 JSON 抛错", () => {
    const path = join(dir, "feishu.json");
    writeFileSync(path, "not json {{{");
    expect(() => loadConfig(path)).toThrow();
  });

  it("可选字段传递", () => {
    const path = join(dir, "feishu.json");
    writeFileSync(path, JSON.stringify({
      app_id: "cli_abc", app_secret: "sec",
      encrypt_key: "ek", verification_token: "vt",
    }));
    const cfg = loadConfig(path);
    expect(cfg.encrypt_key).toBe("ek");
    expect(cfg.verification_token).toBe("vt");
  });
});

/**
 * service-config — 读 ~/.nerve/services.json，校验服务配置。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadServiceConfig, defaultServiceConfigPath } from "../../src/service/service-config.js";

describe("service-config", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "service-cfg-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("文件不存在 → 返回空 services（不抛错）", () => {
    const cfg = loadServiceConfig(join(dir, "missing.json"));
    expect(cfg).toEqual({ services: [] });
  });

  it("合法文件解析正确", () => {
    const path = join(dir, "services.json");
    writeFileSync(path, JSON.stringify({
      services: [{ name: "mac-clipboard", cmd: "node", args: ["index.js"], cwd: "/tmp" }],
    }));
    const cfg = loadServiceConfig(path);
    expect(cfg.services).toHaveLength(1);
    expect(cfg.services[0].name).toBe("mac-clipboard");
    expect(cfg.services[0].cmd).toBe("node");
    expect(cfg.services[0].args).toEqual(["index.js"]);
    expect(cfg.services[0].cwd).toBe("/tmp");
  });

  it("缺省 args=[] 被填上", () => {
    const path = join(dir, "services.json");
    writeFileSync(path, JSON.stringify({
      services: [{ name: "svc", cmd: "mybin" }],
    }));
    const cfg = loadServiceConfig(path);
    expect(cfg.services[0].args).toEqual([]);
  });

  it("缺省 restart='always' 被填上", () => {
    const path = join(dir, "services.json");
    writeFileSync(path, JSON.stringify({
      services: [{ name: "svc", cmd: "mybin" }],
    }));
    const cfg = loadServiceConfig(path);
    expect(cfg.services[0].restart).toBe("always");
  });

  it("显式 restart='never' 被保留", () => {
    const path = join(dir, "services.json");
    writeFileSync(path, JSON.stringify({
      services: [{ name: "svc", cmd: "mybin", restart: "never" }],
    }));
    const cfg = loadServiceConfig(path);
    expect(cfg.services[0].restart).toBe("never");
  });

  it("忽略未知字段", () => {
    const path = join(dir, "services.json");
    writeFileSync(path, JSON.stringify({
      services: [{ name: "svc", cmd: "mybin", unknownField: 42 }],
    }));
    const cfg = loadServiceConfig(path);
    expect((cfg.services[0] as any).unknownField).toBeUndefined();
  });

  it("JSON 非法 → 抛错", () => {
    const path = join(dir, "services.json");
    writeFileSync(path, "not json {{{");
    expect(() => loadServiceConfig(path)).toThrow();
  });

  it("service 缺 name → 抛错，错误信息包含问题条目信息", () => {
    const path = join(dir, "services.json");
    writeFileSync(path, JSON.stringify({ services: [{ cmd: "mybin" }] }));
    expect(() => loadServiceConfig(path)).toThrow(/name/i);
  });

  it("service name 为空字符串 → 抛错", () => {
    const path = join(dir, "services.json");
    writeFileSync(path, JSON.stringify({ services: [{ name: "", cmd: "mybin" }] }));
    expect(() => loadServiceConfig(path)).toThrow(/name/i);
  });

  it("service 缺 cmd → 抛错，错误信息包含问题条目信息", () => {
    const path = join(dir, "services.json");
    writeFileSync(path, JSON.stringify({ services: [{ name: "svc" }] }));
    expect(() => loadServiceConfig(path)).toThrow(/cmd/i);
  });

  it("service cmd 为空字符串 → 抛错", () => {
    const path = join(dir, "services.json");
    writeFileSync(path, JSON.stringify({ services: [{ name: "svc", cmd: "" }] }));
    expect(() => loadServiceConfig(path)).toThrow(/cmd/i);
  });

  it("defaultServiceConfigPath 返回 ~/.nerve/services.json", () => {
    const p = defaultServiceConfigPath();
    expect(p).toMatch(/\.nerve\/services\.json$/);
    expect(p).toMatch(/^\/Users\/|^\/home\//); // absolute path under home
  });

  it("env 字段被保留", () => {
    const path = join(dir, "services.json");
    writeFileSync(path, JSON.stringify({
      services: [{ name: "svc", cmd: "mybin", env: { FOO: "bar" } }],
    }));
    const cfg = loadServiceConfig(path);
    expect(cfg.services[0].env).toEqual({ FOO: "bar" });
  });
});

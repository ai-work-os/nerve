/**
 * system-watchdog 集成测试。
 * 起 nerve、起 watchdog 子进程、起 mock plugin（声明 maxIdleMs=2s），
 * 等 3s 后 watchdog scan 应检测到 idle 并写文件 + 推 #ops 频道。
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert, sleep,
  WsClient, startServer, stopServer, getTestPort,
} from "../helpers/vitest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("system-watchdog integration", () => {
  let tmpDir: string;
  let alertFile: string;
  let watchdog: ChildProcess | null = null;

  beforeAll(async () => {
    await startServer();
    tmpDir = mkdtempSync(join(tmpdir(), "watchdog-int-"));
    alertFile = join(tmpDir, "system-alerts.md");
  });

  afterAll(async () => {
    if (watchdog && !watchdog.killed) watchdog.kill("SIGTERM");
    await sleep(200);
    rmSync(tmpDir, { recursive: true, force: true });
    await stopServer();
  });

  it("启动 watchdog → 检测 idle plugin → 写文件 + 推 #ops", async () => {
    const port = getTestPort();

    // 1. 创建 #ops 频道
    const ctrl = new WsClient("ctrl");
    await ctrl.connect();
    await ctrl.request("node.register", { name: "ctrl", capabilities: ["ui"] });
    const opsCh = await ctrl.request("channel.create", { cwd: "/tmp", name: "ops" });
    await ctrl.request("channel.join", { channelId: opsCh.channelId });

    // 2. 起一个 mock plugin 声明 maxIdleMs=2s（用 WsClient 模拟，liveness=none 因为不是 stdio）
    const mock = new WsClient("mock-stale");
    await mock.connect();
    const reg = await mock.request("node.register", {
      name: "mock-stale",
      capabilities: ["monitor"],
      health: { liveness: "none", maxIdleMs: 2_000 },
    });
    assert(!!reg.nodeId, "mock plugin registered");

    // 3. 等 3s 让 lastActiveAt 超过 2s
    await sleep(3_000);

    // 4. 启动 watchdog 子进程
    const watchdogScript = resolve(__dirname, "../../src/plugins/system-watchdog/index.ts");
    watchdog = spawn("npx", ["tsx", watchdogScript, "--port", String(port)], {
      env: {
        ...process.env,
        WATCHDOG_INTERVAL_MS: "1000",
        WATCHDOG_ALERT_FILE: alertFile,
        WATCHDOG_OPS_CHANNEL: "ops",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    watchdog.stderr?.on("data", (d) => { stderr += d.toString(); });
    let stdout = "";
    watchdog.stdout?.on("data", (d) => { stdout += d.toString(); });

    // 5. 等 watchdog 启动 + 跑两轮 scan
    await sleep(6_000);

    // 6. 断言：alert 文件存在且包含 mock-stale idle
    assert(existsSync(alertFile),
      `alert file should exist at ${alertFile}\nstdout: ${stdout.slice(-800)}\nstderr: ${stderr.slice(-400)}`);
    const fileContent = readFileSync(alertFile, "utf-8");
    assert(fileContent.includes("mock-stale"), `alert file mentions mock-stale (got: ${fileContent})`);
    assert(fileContent.includes("idle"), "alert file mentions idle metric");

    // 7. 断言：#ops 频道收到 watchdog 推送
    const hist = await ctrl.request("channel.history", { channelId: opsCh.channelId, limit: 20 });
    const watchdogMsgs = (hist.messages as Array<{from: string; content: string}>)
      .filter(m => m.from === "system-watchdog");
    assert(watchdogMsgs.length >= 1, `should have watchdog message in #ops (got ${hist.messages.length} total)`);
    assert(watchdogMsgs[0].content.includes("mock-stale"), "watchdog message mentions mock-stale");

    await mock.disconnect();
    await ctrl.disconnect();
  }, 30_000);
});

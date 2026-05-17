/**
 * 集成测试：screenshot 插件 new_screenshot 事件
 *
 * 覆盖：
 * 1. screenshot 插件注册后，events 里有 new_screenshot
 * 2. 订阅 new_screenshot 后，上传截图 → 订阅者收到 @mention + blob= 的频道消息
 * 3. 回归：没有订阅者时，上传截图，#screenshots 仍有原始平铺 post（blob= 链路未断）
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sleep, WsClient, startServer, stopServer, getTestPort, findFreePort, waitForNotification,
} from "../helpers/vitest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_SCRIPT = resolve(__dirname, "../../src/plugins/screenshot/index.ts");

/** Boot a screenshot plugin subprocess; resolve once it logs "screenshot plugin ready". */
function startScreenshotPlugin(port: number, httpPort: number): Promise<{ proc: ChildProcess; httpPort: number }> {
  const proc = spawn("npx", ["tsx", SCREENSHOT_SCRIPT, "--port", String(port)], {
    env: {
      ...process.env,
      SCREENSHOT_HTTP_PORT: String(httpPort),
      SCREENSHOT_CHANNEL: "screenshots",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error("screenshot plugin start timeout")), 20000);
    let out = "";
    const onData = (d: Buffer) => {
      out += d.toString();
      if (out.includes("screenshot plugin ready")) {
        clearTimeout(timeout);
        resolveReady({ proc, httpPort });
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (e) => { clearTimeout(timeout); rejectReady(e); });
    proc.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        rejectReady(new Error(`screenshot plugin exited early (code ${code}): ${out}`));
      }
    });
  });
}

async function stopProc(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.killed) return;
  await new Promise<void>((res) => {
    proc.on("exit", () => res());
    proc.kill("SIGTERM");
    setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); res(); }, 2000);
  });
}

/** Upload a small PNG to the screenshot HTTP server */
async function uploadScreenshot(httpPort: number): Promise<{ blobId: string }> {
  const res = await fetch(`http://127.0.0.1:${httpPort}/screenshot/upload`, {
    method: "POST",
    headers: {
      "Content-Type": "image/png",
      "X-Source": "test-phone",
      "X-Analyze": "false",
      "X-Taken-At": String(Date.now()),
    },
    body: Buffer.from("PNG-FAKE-DATA"),
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return res.json() as Promise<{ blobId: string }>;
}

describe("screenshot new_screenshot event", () => {
  let screenshotProc: ChildProcess | null = null;
  let screenshotHttpPort = 0;

  beforeAll(async () => {
    await startServer();
    const port = getTestPort();
    screenshotHttpPort = await findFreePort();
    const result = await startScreenshotPlugin(port, screenshotHttpPort);
    screenshotProc = result.proc;
    screenshotHttpPort = result.httpPort;
  }, 40_000);

  afterAll(async () => {
    await stopProc(screenshotProc);
    await sleep(200);
    stopServer();
  });

  it("1. screenshot 节点注册后 events 列表包含 new_screenshot", async () => {
    const client = new WsClient("event-checker");
    await client.connect();
    await client.request("node.register", { name: "event-checker", capabilities: ["ui"] });

    const list = await client.request("node.list");
    const screenshotNode = (list.nodes ?? []).find((n: any) => n.name === "screenshot");
    expect(screenshotNode, "screenshot node exists in node.list").toBeTruthy();
    expect(screenshotNode.events, "screenshot node exposes events").toContain("new_screenshot");

    await client.disconnect();
  });

  it("2. 订阅 new_screenshot 后，上传截图 → 订阅者收到 @mention + blob= 的频道消息", async () => {
    const subscriber = new WsClient("triage-agent");
    await subscriber.connect();
    await subscriber.request("node.register", { name: "triage-agent", capabilities: ["agent"] });

    // 找到 #screenshots 频道并加入
    const chList = await subscriber.request("channel.list");
    const ch = (chList.channels ?? []).find((c: any) => c.name === "screenshots");
    expect(ch, "#screenshots channel exists").toBeTruthy();
    await subscriber.request("channel.join", { channelId: ch.id });
    await sleep(100);
    subscriber.clearNotifications();

    // 通过频道 @mention 向 screenshot 插件发 subscribe 命令
    // PluginBase.handleChannelMessage 会把 "@screenshot subscribe new_screenshot" 解析成 subscribe 命令
    await subscriber.request("channel.post", {
      channelId: ch.id,
      content: "@screenshot subscribe new_screenshot",
    });
    await sleep(500);

    // 上传截图
    const { blobId } = await uploadScreenshot(screenshotHttpPort);
    expect(blobId, "upload returns a blobId").toBeTruthy();

    // 等待 channel.message 通知 @triage-agent
    const notification = await waitForNotification(
      subscriber,
      "channel.message",
      (params) => {
        const content = params?.message?.content ?? params?.content ?? "";
        return content.includes("@triage-agent") && content.includes("blob=");
      },
      8000,
    );
    expect(notification, "received @mention notification").toBeTruthy();
    const content = notification?.message?.content ?? notification?.content ?? "";
    expect(content).toMatch(/@triage-agent/);
    expect(content).toMatch(/blob=/);

    await subscriber.disconnect();
  }, 30_000);

  it("3. 回归：没有订阅者时，上传截图，#screenshots 仍有原始平铺 post", async () => {
    const observer = new WsClient("flat-observer");
    await observer.connect();
    await observer.request("node.register", { name: "flat-observer", capabilities: ["ui"] });

    const chList = await observer.request("channel.list");
    const ch = (chList.channels ?? []).find((c: any) => c.name === "screenshots");
    expect(ch, "#screenshots channel exists").toBeTruthy();
    await observer.request("channel.join", { channelId: ch.id });
    await sleep(100);
    observer.clearNotifications();

    // 上传截图（无订阅者）
    const { blobId } = await uploadScreenshot(screenshotHttpPort);
    expect(blobId, "upload returns a blobId").toBeTruthy();

    // 等待平铺 post（📷 screenshot | blob=...）
    const flatPost = await waitForNotification(
      observer,
      "channel.message",
      (params) => {
        const content = params?.message?.content ?? params?.content ?? "";
        // Mac-clipboard 依赖的平铺 post，不是 @mention
        return content.includes("blob=") && !content.startsWith("@");
      },
      8000,
    );
    expect(flatPost, "flat post received without @mention").toBeTruthy();
    const content = flatPost?.message?.content ?? flatPost?.content ?? "";
    expect(content).toMatch(/blob=/);

    await observer.disconnect();
  }, 30_000);
});

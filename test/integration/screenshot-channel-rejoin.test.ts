/**
 * screenshot 插件频道重入集成测试。
 *
 * 回归测试：channel.list 返回的频道对象用 `id` 字段，channel.create 返回 `channelId`。
 * ensureChannel 第一次跑（频道不存在）走 create 路径正常；nerve 重启后频道已存在，
 * 必须从 channel.list 的 `id` 字段解析。曾经的 bug 是 `found.channelId`（undefined），
 * 导致 channel.join 收到 undefined → 插件无法重入自己的频道 → 截图不再被广播。
 *
 * 本测试启动真实 nerve，把真实 screenshot 插件子进程跑两次（同一个 nerve），
 * 断言：第二次实例成功重入已存在的 #screenshots 频道，且频道没有被重复创建。
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sleep, WsClient, startServer, stopServer, getTestPort, findFreePort,
} from "../helpers/vitest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_SCRIPT = resolve(__dirname, "../../src/plugins/screenshot/index.ts");

/** Boot a screenshot plugin subprocess; resolve once it logs "screenshot plugin ready". */
function startScreenshotPlugin(port: number, httpPort: number): Promise<ChildProcess> {
  const proc = spawn("npx", ["tsx", SCREENSHOT_SCRIPT, "--port", String(port)], {
    env: {
      ...process.env,
      SCREENSHOT_HTTP_PORT: String(httpPort),
      SCREENSHOT_CHANNEL: "screenshots",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error("screenshot plugin start timeout")), 15000);
    let out = "";
    const onData = (d: Buffer) => {
      out += d.toString();
      // ready once it has both joined the channel and (tried to) start http
      if (out.includes("screenshot plugin ready")) {
        clearTimeout(timeout);
        resolveReady(proc);
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

describe("screenshot channel rejoin", () => {
  let proc1: ChildProcess | null = null;
  let proc2: ChildProcess | null = null;

  beforeAll(async () => {
    await startServer();
  });

  afterAll(async () => {
    await stopProc(proc1);
    await stopProc(proc2);
    await sleep(200);
    stopServer();
  });

  it("第二个 screenshot 实例重入已存在频道，不重复创建", async () => {
    const port = getTestPort();

    // --- First instance: creates #screenshots (channel does not exist yet) ---
    const httpPort1 = await findFreePort();
    proc1 = await startScreenshotPlugin(port, httpPort1);

    // Observer checks the channel exists exactly once after the first run.
    const observer = new WsClient("rejoin-observer");
    await observer.connect();
    await observer.request("node.register", { name: "rejoin-observer", capabilities: ["ui"] });

    const list1 = await observer.request("channel.list");
    const screenshots1 = (list1.channels ?? []).filter((c: any) => c.name === "screenshots");
    expect(screenshots1.length, "first run creates exactly one #screenshots channel").toBe(1);
    const channelId = screenshots1[0].id;
    expect(channelId, "channel.list entry exposes an id").toBeTruthy();

    // --- Stop the first instance (simulates the Mac/nerve restart scenario) ---
    await stopProc(proc1);
    proc1 = null;
    await sleep(500);

    // The #screenshots channel still exists on the (still-running) nerve.
    const listMid = await observer.request("channel.list");
    const screenshotsMid = (listMid.channels ?? []).filter((c: any) => c.name === "screenshots");
    expect(screenshotsMid.length, "#screenshots persists after first instance stops").toBe(1);

    // --- Second instance: #screenshots already exists → must rejoin, not recreate ---
    const httpPort2 = await findFreePort();
    proc2 = await startScreenshotPlugin(port, httpPort2);
    await sleep(500);

    const list2 = await observer.request("channel.list");
    const screenshots2 = (list2.channels ?? []).filter((c: any) => c.name === "screenshots");

    // (b) Exactly ONE #screenshots channel — no duplicate created by the second instance.
    expect(screenshots2.length, "second run rejoins, does not duplicate #screenshots").toBe(1);
    // Same channel id as the first run.
    expect(screenshots2[0].id, "second instance rejoins the same channel id").toBe(channelId);

    // (a) The second instance resolved a non-undefined channelId and joined as a member.
    const members = Object.keys(screenshots2[0].nodes ?? {});
    expect(members, "second screenshot instance is a member of #screenshots").toContain("screenshot");

    await observer.disconnect();
  }, 60_000);
});

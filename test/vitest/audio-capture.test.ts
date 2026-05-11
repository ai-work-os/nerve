/**
 * AudioCapture.stopAndWait — waits for the spawned child to actually exit,
 * escalating SIGTERM → SIGKILL after timeout. Prevents AudioCapture leakage
 * during MacMicSource restartCapture cycles (sleep-wake watchdog 风暴时
 * 旧子进程没死就 spawn 新的，多路 mic 互抢导致 ASR 退化).
 */
import { describe, it, expect } from "vitest";
import { AudioCapture } from "../../src/plugins/ai-ear/audio-capture.js";

/** Build an AudioCapture wrapping a node script for testing without the real Swift binary. */
function fakeCapture(script: string): AudioCapture {
  return new AudioCapture("mic", {
    binaryPath: process.execPath,
    binaryArgs: ["-e", script],
  });
}

describe("AudioCapture.stopAndWait", () => {
  it("SIGTERM 后等到子进程真退出", async () => {
    const cap = fakeCapture(
      "process.stdout.write('x'); setInterval(()=>process.stdout.write('y'), 100);"
    );
    await cap.start();
    expect(cap.running).toBe(true);
    await cap.stopAndWait(2000);
    expect(cap.running).toBe(false);
  });

  it("子进程忽略 SIGTERM 时 SIGKILL 收尾", async () => {
    const cap = fakeCapture(
      "process.on('SIGTERM', () => {}); " +
      "process.stdout.write('ready\\n'); " +
      "setInterval(()=>process.stdout.write('y'), 100);"
    );
    // wait for child node to register SIGTERM handler ("ready" line on stdout)
    const ready = new Promise<void>((resolve) => {
      const onData = (chunk: Buffer) => {
        if (chunk.toString().includes("ready")) { cap.off("data", onData); resolve(); }
      };
      cap.on("data", onData);
    });
    await cap.start();
    await ready;
    expect(cap.running).toBe(true);
    const t0 = Date.now();
    await cap.stopAndWait(200);
    const elapsed = Date.now() - t0;
    expect(cap.running).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(2000);
  });

  it("已经退出的进程 stopAndWait 立即返回", async () => {
    const cap = fakeCapture("setTimeout(()=>process.exit(0), 50);");
    await cap.start();
    await new Promise(r => setTimeout(r, 150));
    expect(cap.running).toBe(false);
    const t0 = Date.now();
    await cap.stopAndWait(2000);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("未 start 的实例 stopAndWait 立即返回", async () => {
    const cap = fakeCapture("setInterval(()=>{}, 100);");
    const t0 = Date.now();
    await cap.stopAndWait(2000);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("stopAndWait 完成后 running=false（保证后续可 spawn 新 capture）", async () => {
    const cap = fakeCapture("setInterval(()=>process.stdout.write('y'), 100);");
    await cap.start();
    await cap.stopAndWait(2000);
    expect(cap.running).toBe(false);
  });
});

/**
 * service-supervisor — 进程监督器单元测试。
 * 用依赖注入的 fake spawn + vitest fake timers，不 spawn 真实进程。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ServiceSupervisor } from "../../src/service/service-supervisor.js";
import type { ServiceSpec } from "../../src/service/service-config.js";

// ---- fake spawn infrastructure ----

interface FakeChild {
  pid: number;
  emitter: EventEmitter;
  killed: boolean;
  killSignals: string[];
  kill(signal?: string): void;
  on(event: string, cb: (...args: any[]) => void): FakeChild;
}

function makeFakeChild(pid: number): FakeChild {
  const emitter = new EventEmitter();
  const child: FakeChild = {
    pid,
    emitter,
    killed: false,
    killSignals: [],
    kill(signal = "SIGTERM") {
      this.killed = true;
      this.killSignals.push(signal);
    },
    on(event: string, cb: (...args: any[]) => void) {
      emitter.on(event, cb);
      return this;
    },
  };
  return child;
}

function makeSpawnFn() {
  const spawned: FakeChild[] = [];
  let pidCounter = 1000;

  const spawnFn = vi.fn((_spec: ServiceSpec): FakeChild => {
    const child = makeFakeChild(pidCounter++);
    spawned.push(child);
    return child;
  });

  return { spawnFn, spawned };
}

// ---- tests ----

describe("ServiceSupervisor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const specA: ServiceSpec = { name: "svc-a", cmd: "node", args: ["a.js"], restart: "always" };
  const specB: ServiceSpec = { name: "svc-b", cmd: "python", args: ["b.py"], restart: "always" };

  it("start() 对每个 spec 都 spawn 了", () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const supervisor = new ServiceSupervisor({ specs: [specA, specB], spawn: spawnFn as any });
    supervisor.start();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(spawned).toHaveLength(2);
  });

  it("子进程 exit 后，经过 backoff 延迟会被重新 spawn", () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const supervisor = new ServiceSupervisor({
      specs: [specA],
      spawn: spawnFn as any,
      backoffMs: [1000, 3000],
      stableMs: 60000,
    });
    supervisor.start();
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // Exit immediately (not stable)
    spawned[0].emitter.emit("exit", 1);

    // Not yet restarted
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // Advance 999ms — still not restarted
    vi.advanceTimersByTime(999);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // Advance 1ms more — backoff[0]=1000ms elapsed
    vi.advanceTimersByTime(1);
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it("连续快速崩溃 → backoff 递增（第1次1s、第2次3s）", () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const supervisor = new ServiceSupervisor({
      specs: [specA],
      spawn: spawnFn as any,
      backoffMs: [1000, 3000, 10000],
      stableMs: 60000,
    });
    supervisor.start();
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // First crash
    spawned[0].emitter.emit("exit", 1);
    vi.advanceTimersByTime(1000);
    expect(spawnFn).toHaveBeenCalledTimes(2);

    // Second crash immediately
    spawned[1].emitter.emit("exit", 1);
    // After 1000ms, still not restarted (second backoff is 3000ms)
    vi.advanceTimersByTime(1000);
    expect(spawnFn).toHaveBeenCalledTimes(2);

    // Advance 2000 more ms (total 3000ms for second backoff)
    vi.advanceTimersByTime(2000);
    expect(spawnFn).toHaveBeenCalledTimes(3);
  });

  it("存活超过 stableMs 后再崩溃 → backoff 重置回第一档", () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const supervisor = new ServiceSupervisor({
      specs: [specA],
      spawn: spawnFn as any,
      backoffMs: [1000, 3000, 10000],
      stableMs: 5000,
    });
    supervisor.start();

    // First crash — advance to second backoff tier
    spawned[0].emitter.emit("exit", 1);
    vi.advanceTimersByTime(1000);
    expect(spawnFn).toHaveBeenCalledTimes(2);

    // Second crash immediately
    spawned[1].emitter.emit("exit", 1);
    vi.advanceTimersByTime(3000);
    expect(spawnFn).toHaveBeenCalledTimes(3);

    // Third run is stable for stableMs (5000ms)
    vi.advanceTimersByTime(5000);
    // Now crash — backoff should reset to [0] = 1000ms
    spawned[2].emitter.emit("exit", 0);
    vi.advanceTimersByTime(999);
    expect(spawnFn).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1);
    expect(spawnFn).toHaveBeenCalledTimes(4);
  });

  it("restart: 'never' 的 spec 崩溃后不重启", () => {
    const specNever: ServiceSpec = { name: "one-shot", cmd: "run-once", restart: "never" };
    const { spawnFn, spawned } = makeSpawnFn();
    const supervisor = new ServiceSupervisor({
      specs: [specNever],
      spawn: spawnFn as any,
    });
    supervisor.start();
    spawned[0].emitter.emit("exit", 0);

    vi.advanceTimersByTime(60000);
    expect(spawnFn).toHaveBeenCalledTimes(1); // never restarted
  });

  it("stop() 后 kill 了子进程、且后续不再重启", () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const supervisor = new ServiceSupervisor({
      specs: [specA],
      spawn: spawnFn as any,
      backoffMs: [1000],
    });
    supervisor.start();

    supervisor.stop();
    expect(spawned[0].killSignals).toContain("SIGTERM");

    // Simulate exit after stop
    spawned[0].emitter.emit("exit", 0);
    vi.advanceTimersByTime(60000);
    expect(spawnFn).toHaveBeenCalledTimes(1); // no restart
  });

  it("error 事件也触发重启", () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const supervisor = new ServiceSupervisor({
      specs: [specA],
      spawn: spawnFn as any,
      backoffMs: [1000],
    });
    supervisor.start();

    spawned[0].emitter.emit("error", new Error("ENOENT: no such file"));
    vi.advanceTimersByTime(1000);
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it("stop() 清掉待重启定时器（error 事件后不再重启）", () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const supervisor = new ServiceSupervisor({
      specs: [specA],
      spawn: spawnFn as any,
      backoffMs: [1000],
    });
    supervisor.start();

    // Trigger pending restart timer
    spawned[0].emitter.emit("exit", 1);
    // Stop before timer fires
    supervisor.stop();

    vi.advanceTimersByTime(60000);
    expect(spawnFn).toHaveBeenCalledTimes(1); // timer was cleared
  });

  it("status() 反映运行状态", () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const supervisor = new ServiceSupervisor({
      specs: [specA, specB],
      spawn: spawnFn as any,
      backoffMs: [1000],
    });
    supervisor.start();

    const st = supervisor.status();
    expect(st).toHaveLength(2);
    expect(st[0].name).toBe("svc-a");
    expect(st[0].state).toBe("running");
    expect(st[0].pid).toBe(spawned[0].pid);
    expect(st[0].restarts).toBe(0);

    // Crash svc-a
    spawned[0].emitter.emit("exit", 1);
    const st2 = supervisor.status();
    expect(st2[0].state).toBe("restarting");
    expect(st2[0].restarts).toBe(1);

    // After restart
    vi.advanceTimersByTime(1000);
    const st3 = supervisor.status();
    expect(st3[0].state).toBe("running");
    expect(st3[0].pid).toBe(spawned[2].pid); // spawned[2] is svc-a's second instance (spawned[1] is svc-b)
  });

  it("stop() 后 status() 全部为 stopped", () => {
    const { spawnFn } = makeSpawnFn();
    const supervisor = new ServiceSupervisor({
      specs: [specA],
      spawn: spawnFn as any,
    });
    supervisor.start();
    supervisor.stop();

    const st = supervisor.status();
    expect(st[0].state).toBe("stopped");
  });

  it("日志：spawn 时调用 log.info", () => {
    const { spawnFn } = makeSpawnFn();
    const infoLog = vi.fn();
    const supervisor = new ServiceSupervisor({
      specs: [specA],
      spawn: spawnFn as any,
      log: { info: infoLog, warn: vi.fn() },
    });
    supervisor.start();
    expect(infoLog).toHaveBeenCalled();
    const calls = infoLog.mock.calls.map((c: any[]) => c[0] as string);
    expect(calls.some(m => m.includes("svc-a"))).toBe(true);
  });

  it("日志：exit 时调用 log.warn（带 code + delay 信息）", () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const warnLog = vi.fn();
    const supervisor = new ServiceSupervisor({
      specs: [specA],
      spawn: spawnFn as any,
      backoffMs: [1000],
      log: { info: vi.fn(), warn: warnLog },
    });
    supervisor.start();
    spawned[0].emitter.emit("exit", 42);
    expect(warnLog).toHaveBeenCalled();
    const msgs = warnLog.mock.calls.map((c: any[]) => c[0] as string).join(" ");
    expect(msgs).toMatch(/42/); // exit code
  });

  it("日志：restart=never 跳过时记录 warn/info", () => {
    const specNever: ServiceSpec = { name: "one-shot", cmd: "run-once", restart: "never" };
    const { spawnFn, spawned } = makeSpawnFn();
    const infoLog = vi.fn();
    const warnLog = vi.fn();
    const supervisor = new ServiceSupervisor({
      specs: [specNever],
      spawn: spawnFn as any,
      log: { info: infoLog, warn: warnLog },
    });
    supervisor.start();
    spawned[0].emitter.emit("exit", 0);
    const allMsgs = [
      ...infoLog.mock.calls.map((c: any[]) => c[0]),
      ...warnLog.mock.calls.map((c: any[]) => c[0]),
    ].join(" ");
    expect(allMsgs).toMatch(/never|no restart|skip/i);
  });
});

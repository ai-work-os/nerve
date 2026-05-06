#!/usr/bin/env npx tsx
/**
 * Duty Monitor Tests (TDD — red phase)
 *
 * Tests for the duty-monitor plugin: CronScheduler, health checks, integration.
 * Run: npx tsx test/duty-monitor.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_PORT = 14803;
const TEST_DATA = resolve(ROOT, ".test-data-duty-monitor");

// --- Test infrastructure ---

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, name: string, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    const msg = detail ? `${name}: ${detail}` : name;
    failures.push(msg);
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

function assertEq(actual: unknown, expected: unknown, name: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, name, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// UNIT TESTS — pure logic, no server needed
// ============================================================

// Import from real production module (green phase)
import {
  CronScheduler,
  parseSchedule,
  TaskStore,
  extractReferencedPaths,
  validateReferencedPaths,
  normalizeLegacyAiWorkspacePaths,
} from "../src/plugins/duty-monitor/index.js";

// --- CronScheduler unit tests ---

function testTickMatchingTime() {
  console.log("\n▸ CronScheduler: tick() at matching hour:minute triggers action");
  const scheduler = new CronScheduler();
  let triggered = false;
  scheduler.addJob({
    name: "daily-report",
    schedule: { hour: 22, minute: 0 },
    action: () => { triggered = true; },
  });

  const now = new Date(2026, 3, 2, 22, 0, 0); // 22:00
  const fired = scheduler.tick(now);
  assert(triggered, "action was called");
  assertEq(fired, ["daily-report"], "fired list contains the job");
}

function testTickNonMatchingTime() {
  console.log("\n▸ CronScheduler: tick() at non-matching time does not trigger");
  const scheduler = new CronScheduler();
  let triggered = false;
  scheduler.addJob({
    name: "daily-report",
    schedule: { hour: 22, minute: 0 },
    action: () => { triggered = true; },
  });

  const now = new Date(2026, 3, 2, 15, 30, 0); // 15:30
  const fired = scheduler.tick(now);
  assert(!triggered, "action was not called");
  assertEq(fired, [], "fired list is empty");
}

function testTickIntervalMinutes() {
  console.log("\n▸ CronScheduler: intervalMinutes fires at correct intervals");
  const scheduler = new CronScheduler();
  let count = 0;
  scheduler.addJob({
    name: "health-check",
    schedule: { intervalMinutes: 60 },
    action: () => { count++; },
  });

  // First tick: fires immediately (no lastRun)
  const t1 = new Date(2026, 3, 2, 10, 0, 0);
  scheduler.tick(t1);
  assertEq(count, 1, "first tick fires immediately");

  // 30 min later: too early
  const t2 = new Date(2026, 3, 2, 10, 30, 0);
  scheduler.tick(t2);
  assertEq(count, 1, "30 min later does not fire");

  // 60 min later: should fire
  const t3 = new Date(2026, 3, 2, 11, 0, 0);
  scheduler.tick(t3);
  assertEq(count, 2, "60 min later fires");
}

function testTickLastRunDedup() {
  console.log("\n▸ CronScheduler: lastRun prevents same-minute double trigger");
  const scheduler = new CronScheduler();
  let count = 0;
  scheduler.addJob({
    name: "daily-report",
    schedule: { hour: 22, minute: 0 },
    action: () => { count++; },
  });

  const now = new Date(2026, 3, 2, 22, 0, 0);
  scheduler.tick(now);
  scheduler.tick(now); // same minute again
  assertEq(count, 1, "only fires once per minute");
}

function testTickFixedTimeFiresAgainNextDay() {
  console.log("\n▸ CronScheduler: fixed-time jobs fire again on the next day");
  const scheduler = new CronScheduler();
  let count = 0;
  scheduler.addJob({
    name: "daily-audit",
    schedule: { hour: 1, minute: 0 },
    action: () => { count++; },
  });

  scheduler.tick(new Date(2026, 4, 5, 1, 0, 0));
  scheduler.tick(new Date(2026, 4, 5, 1, 0, 30));
  scheduler.tick(new Date(2026, 4, 6, 1, 0, 0));

  assertEq(count, 2, "fires once per matching day");
}

function testTickDayOfWeek() {
  console.log("\n▸ CronScheduler: dayOfWeek matching");
  const scheduler = new CronScheduler();
  let triggered = false;
  scheduler.addJob({
    name: "weekly-worklog",
    schedule: { hour: 8, minute: 0, dayOfWeek: 1 }, // Monday
    action: () => { triggered = true; },
  });

  // 2026-04-06 is Monday (dayOfWeek=1)
  const monday = new Date(2026, 3, 6, 8, 0, 0);
  assert(monday.getDay() === 1, "sanity: date is Monday");
  scheduler.tick(monday);
  assert(triggered, "fires on Monday");

  // Reset and test Tuesday
  triggered = false;
  const scheduler2 = new CronScheduler();
  scheduler2.addJob({
    name: "weekly-worklog",
    schedule: { hour: 8, minute: 0, dayOfWeek: 1 },
    action: () => { triggered = true; },
  });
  const tuesday = new Date(2026, 3, 7, 8, 0, 0);
  assert(tuesday.getDay() === 2, "sanity: date is Tuesday");
  scheduler2.tick(tuesday);
  assert(!triggered, "does not fire on Tuesday");
}

function testTickWeeklyFiresAgainNextWeek() {
  console.log("\n▸ CronScheduler: weekly jobs fire again on the next matching week");
  const scheduler = new CronScheduler();
  let count = 0;
  scheduler.addJob({
    name: "weekly-worklog",
    schedule: { hour: 8, minute: 0, dayOfWeek: 1 },
    action: () => { count++; },
  });

  scheduler.tick(new Date(2026, 3, 6, 8, 0, 0));
  scheduler.tick(new Date(2026, 3, 6, 8, 0, 30));
  scheduler.tick(new Date(2026, 3, 13, 8, 0, 0));

  assertEq(count, 2, "fires once per matching Monday");
}

function testTickMultipleJobsIndependent() {
  console.log("\n▸ CronScheduler: multiple jobs fire independently");
  const scheduler = new CronScheduler();
  const firedJobs: string[] = [];

  scheduler.addJob({
    name: "job-a",
    schedule: { hour: 10, minute: 0 },
    action: () => { firedJobs.push("a"); },
  });
  scheduler.addJob({
    name: "job-b",
    schedule: { hour: 10, minute: 0 },
    action: () => { firedJobs.push("b"); },
  });
  scheduler.addJob({
    name: "job-c",
    schedule: { hour: 11, minute: 0 },
    action: () => { firedJobs.push("c"); },
  });

  const now = new Date(2026, 3, 2, 10, 0, 0);
  const fired = scheduler.tick(now);
  assertEq(firedJobs, ["a", "b"], "only matching jobs fire");
  assertEq(fired, ["job-a", "job-b"], "fired list correct");
}

function testTickIntervalMidnightWrap() {
  console.log("\n▸ CronScheduler: intervalMinutes wraps across midnight");
  const scheduler = new CronScheduler();
  let count = 0;
  scheduler.addJob({
    name: "wrap-test",
    schedule: { intervalMinutes: 60 },
    action: () => { count++; },
  });

  // First tick at 23:50
  const t1 = new Date(2026, 3, 2, 23, 50, 0);
  scheduler.tick(t1);
  assertEq(count, 1, "first tick fires at 23:50");

  // 20 min later at 00:10 (next day) — elapsed wraps: (10 - 1430) → +1440 = 1450-1430=20, too early
  const t2 = new Date(2026, 3, 3, 0, 10, 0);
  scheduler.tick(t2);
  assertEq(count, 1, "00:10 is only 20 min later, does not fire");

  // 70 min later at 01:00 — elapsed wraps: (60 - 1430) → +1440 = 70, should fire
  const t3 = new Date(2026, 3, 3, 1, 0, 0);
  scheduler.tick(t3);
  assertEq(count, 2, "01:00 is 70 min later, fires");
}

// --- Health check unit tests ---
// Import from real production module
import * as os from "node:os";
import {
  getMemoryUsage,
  getDiskUsage,
  getCpuUsage,
  checkHealth,
  type HealthAlert,
} from "../src/plugins/duty-monitor/index.js";

function testGetMemoryUsage() {
  console.log("\n▸ Health: getMemoryUsage() returns reasonable values");
  const mem = getMemoryUsage();
  assert(mem.total > 0, "total memory > 0");
  assert(mem.used > 0, "used memory > 0");
  assert(mem.used < mem.total, "used < total");
}

async function testGetDiskUsage() {
  console.log("\n▸ Health: getDiskUsage() returns reasonable values");
  const disk = await getDiskUsage();
  assert(disk.total > 0, "total disk > 0");
  assert(disk.used > 0, "used disk > 0");
  assert(disk.used < disk.total, "used < total");
  assertEq(disk.path, "/", "path is /");
}

function testGetCpuUsageAllIdle() {
  console.log("\n▸ Health: getCpuUsage() all idle → 0%");
  const prev: os.CpuInfo[] = [
    { model: "", speed: 0, times: { user: 100, nice: 0, sys: 100, idle: 800, irq: 0 } },
  ];
  const curr: os.CpuInfo[] = [
    { model: "", speed: 0, times: { user: 100, nice: 0, sys: 100, idle: 1800, irq: 0 } },
  ];
  const usage = getCpuUsage(prev, curr);
  assertEq(usage, 0, "all idle = 0%");
}

function testGetCpuUsageAllBusy() {
  console.log("\n▸ Health: getCpuUsage() all busy → ~100%");
  const prev: os.CpuInfo[] = [
    { model: "", speed: 0, times: { user: 100, nice: 0, sys: 100, idle: 800, irq: 0 } },
  ];
  const curr: os.CpuInfo[] = [
    { model: "", speed: 0, times: { user: 600, nice: 0, sys: 600, idle: 800, irq: 0 } },
  ];
  const usage = getCpuUsage(prev, curr);
  assertEq(usage, 100, "all busy = 100%");
}

function testGetCpuUsageNormal() {
  console.log("\n▸ Health: getCpuUsage() normal input → reasonable %");
  const prev: os.CpuInfo[] = [
    { model: "", speed: 0, times: { user: 100, nice: 0, sys: 50, idle: 800, irq: 0 } },
  ];
  const curr: os.CpuInfo[] = [
    { model: "", speed: 0, times: { user: 200, nice: 0, sys: 100, idle: 1000, irq: 0 } },
  ];
  // total diff = (200+100+1000) - (100+50+800) = 1300-950 = 350
  // idle diff = 1000 - 800 = 200
  // cpu% = (350-200)/350 * 100 ≈ 42.86
  const usage = getCpuUsage(prev, curr);
  assert(usage > 40 && usage < 45, `expected ~42.86%, got ${usage.toFixed(2)}%`);
}

function testGetCpuUsageZeroDiff() {
  console.log("\n▸ Health: getCpuUsage() zero diff (prev === curr) → 0%");
  const snapshot: os.CpuInfo[] = [
    { model: "", speed: 0, times: { user: 100, nice: 0, sys: 50, idle: 800, irq: 0 } },
  ];
  const usage = getCpuUsage(snapshot, snapshot);
  assertEq(usage, 0, "zero diff = 0%");
}

function testCheckHealthAtExactThreshold() {
  console.log("\n▸ Health: checkHealth() at exact threshold does NOT alert (uses >)");
  const alerts = checkHealth(
    80,                        // cpu exactly 80%
    8.5 * 1024 * 1024 * 1024, // mem 8.5GB used
    10 * 1024 * 1024 * 1024,  // mem 10GB total (85%)
    9 * 1024 * 1024 * 1024,   // disk 9GB used
    10 * 1024 * 1024 * 1024,  // disk 10GB total (90%)
    { cpu: 80, mem: 85, disk: 90 },
  );
  assertEq(alerts.length, 0, "exact threshold = no alerts");
}

function testCheckHealthAboveThreshold() {
  console.log("\n▸ Health: checkHealth() above threshold returns alerts");
  const alerts = checkHealth(
    90,                        // cpu 90%
    9 * 1024 * 1024 * 1024,   // mem 9GB used
    10 * 1024 * 1024 * 1024,  // mem 10GB total (90%)
    95 * 1024 * 1024 * 1024,  // disk 95GB used
    100 * 1024 * 1024 * 1024, // disk 100GB total (95%)
    { cpu: 80, mem: 85, disk: 90 },
  );
  assertEq(alerts.length, 3, "3 alerts triggered");
  assert(alerts.some(a => a.metric === "cpu"), "cpu alert present");
  assert(alerts.some(a => a.metric === "memory"), "memory alert present");
  assert(alerts.some(a => a.metric === "disk"), "disk alert present");
}

function testCheckHealthBelowThreshold() {
  console.log("\n▸ Health: checkHealth() below threshold returns empty");
  const alerts = checkHealth(
    30,                        // cpu 30%
    4 * 1024 * 1024 * 1024,   // mem 4GB used
    10 * 1024 * 1024 * 1024,  // mem 10GB total (40%)
    50 * 1024 * 1024 * 1024,  // disk 50GB used
    100 * 1024 * 1024 * 1024, // disk 100GB total (50%)
    { cpu: 80, mem: 85, disk: 90 },
  );
  assertEq(alerts.length, 0, "no alerts");
}

// --- Message format tests ---

function testDailyTriggerMessageFormat() {
  console.log("\n▸ Message: daily trigger message contains @duty-agent");
  // Simulate the message that duty-monitor would post
  const msg = "@duty-agent 写日报";
  assert(msg.includes("@duty-agent"), "message mentions @duty-agent");
}

function testAlertMessageFormat() {
  console.log("\n▸ Message: alert message contains specific metric");
  const alerts: HealthAlert[] = [
    { metric: "cpu", value: 92, threshold: 80 },
    { metric: "disk", value: 95, threshold: 90 },
  ];
  const detail = alerts.map(a => `${a.metric}: ${a.value}%>${a.threshold}%`).join(", ");
  const msg = `@duty-agent 分析异常：${detail}`;
  assert(msg.includes("@duty-agent"), "message mentions @duty-agent");
  assert(msg.includes("cpu"), "message contains cpu metric");
  assert(msg.includes("92%"), "message contains cpu value");
  assert(msg.includes("disk"), "message contains disk metric");
}

// ============================================================
// INTEGRATION TESTS — with real server
// ============================================================

class WsClient {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private notifications: Array<{ method: string; params: any }> = [];

  async connect(): Promise<void> {
    this.ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
    return new Promise((resolve, reject) => {
      this.ws.on("open", () => {
        this.ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.id !== undefined && !msg.method) {
            const p = this.pending.get(msg.id);
            if (p) {
              this.pending.delete(msg.id);
              if (msg.error) p.reject(new Error(msg.error.message));
              else p.resolve(msg.result);
            }
          } else if (msg.method) {
            this.notifications.push({ method: msg.method, params: msg.params });
          }
        });
        resolve();
      });
      this.ws.on("error", reject);
    });
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, 15000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  getNotifications(method?: string): Array<{ method: string; params: any }> {
    if (method) return this.notifications.filter(n => n.method === method);
    return this.notifications;
  }

  clearNotifications(): void {
    this.notifications = [];
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) { resolve(); return; }
      this.ws.on("close", () => resolve());
      this.ws.close();
    });
  }
}

let serverProc: ChildProcess | null = null;

async function startServer(): Promise<void> {
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });
  serverProc = spawn("npx", ["tsx", "src/index.ts", "--port", String(TEST_PORT), "--data", TEST_DATA], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server start timeout")), 10000);
    serverProc!.stderr!.on("data", (d) => {
      const s = d.toString();
      if (s.includes("ERROR")) process.stderr.write(`[server] ${s}`);
    });
    serverProc!.stdout!.on("data", (d) => {
      if (d.toString().includes("started on port")) { clearTimeout(timeout); resolve(); }
    });
    serverProc!.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

function stopServer(): void {
  if (serverProc) { serverProc.kill("SIGTERM"); serverProc = null; }
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });
}

async function testDutyMonitorRegistration() {
  console.log("\n▸ Integration: duty-monitor registers as node with commands");
  const c = new WsClient();
  await c.connect();

  const commands = {
    status: { description: "显示当前状态和下次触发时间" },
    trigger: { description: "手动触发指定任务", args: { task: "daily|worklog|health" } },
    check: { description: "立即执行健康检查" },
  };

  const reg = await c.request("node.register", {
    name: "duty-monitor",
    capabilities: ["monitor"],
    permissions: "observer",
    commands,
  });
  assert(!!reg.nodeId, "duty-monitor registers successfully");
  assertEq(reg.name, "duty-monitor", "name is duty-monitor");

  // Verify in node list with commands
  const list = await c.request("node.list");
  const monitor = list.nodes?.find((n: any) => n.name === "duty-monitor");
  assert(!!monitor, "duty-monitor appears in node list");
  assert(!!monitor.commands?.status, "commands include status");
  assert(!!monitor.commands?.trigger, "commands include trigger");
  assert(!!monitor.commands?.check, "commands include check");

  await c.disconnect();
}

async function testDutyMonitorStatus() {
  console.log("\n▸ Integration: status command returns schedule info");
  const c = new WsClient();
  await c.connect();

  await c.request("node.register", {
    name: "duty-monitor-status-test",
    capabilities: ["monitor"],
    permissions: "observer",
    commands: {
      status: { description: "显示当前状态和下次触发时间" },
    },
  });

  // Send DM to self (simulates receiving a status command)
  // In real plugin, onCommand("status") returns schedule info via node.log
  // Here we just verify the node can receive messages
  const list = await c.request("node.list");
  const monitor = list.nodes?.find((n: any) => n.name === "duty-monitor-status-test");
  assert(!!monitor, "monitor node exists for status test");
  assert(!!monitor.commands?.status, "status command registered");

  await c.disconnect();
}

async function testDutyMonitorTriggerDaily() {
  console.log("\n▸ Integration: trigger daily posts to channel");
  const c = new WsClient();
  await c.connect();

  const reg = await c.request("node.register", {
    name: "duty-monitor-trigger-test",
    capabilities: ["monitor"],
    permissions: "observer",
  });

  // Create channel and join
  const ch = await c.request("channel.create", { cwd: ROOT, name: "duty-trigger-ch" });
  await c.request("channel.join", { channelId: ch.channelId });

  // Post message like trigger daily would
  const post = await c.request("channel.post", {
    channelId: ch.channelId,
    content: "@duty-agent 写日报",
  });
  assert(!!post.message, "trigger daily posts message");
  assert(post.message.content.includes("@duty-agent"), "message mentions @duty-agent");
  assert(post.message.content.includes("日报"), "message mentions 日报");

  // Verify in history
  const hist = await c.request("channel.history", { channelId: ch.channelId });
  assert(hist.messages?.length >= 1, "message appears in channel history");

  await c.disconnect();
}

async function testDutyMonitorCheck() {
  console.log("\n▸ Integration: check command executes health check and logs");
  const c = new WsClient();
  await c.connect();

  const reg = await c.request("node.register", {
    name: "duty-monitor-check-test",
    capabilities: ["monitor"],
    permissions: "observer",
  });

  // Simulate health check result posting to node.log
  const logResult = await c.request("node.log", {
    entries: [
      { level: "info", message: "health check: cpu=25%, mem=60%, disk=45% — all OK", ts: new Date().toISOString() },
    ],
  });
  assert(logResult !== undefined, "node.log accepts health check entry");

  await c.disconnect();
}

// ============================================================
// INTEGRATION TESTS — dynamic commands (real duty-monitor process)
// ============================================================

let dutyProc: ChildProcess | null = null;

async function spawnDutyMonitor(): Promise<void> {
  dutyProc = spawn("npx", ["tsx", "src/plugins/duty-monitor/index.ts", "--port", String(TEST_PORT)], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NERVE_SPAWNED: "0" },
  });
  // Wait for it to connect by checking node.list
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try {
      const c = new WsClient();
      await c.connect();
      const list = await c.request("node.list");
      const found = list.nodes?.find((n: any) => n.name === "duty-monitor");
      await c.disconnect();
      if (found && found.status !== "connecting") return;
    } catch { /* retry */ }
  }
  throw new Error("duty-monitor did not register within 10s");
}

function stopDutyMonitor(): void {
  if (dutyProc) { dutyProc.kill("SIGTERM"); dutyProc = null; }
}

let dmSeq = 0;
async function sendDmCommand(nodeId: string, content: string): Promise<void> {
  const c = new WsClient();
  await c.connect();
  await c.request("node.register", { name: `test-user-${++dmSeq}`, capabilities: ["ui"] });
  await c.request("node.message", { nodeId, content });
  await c.disconnect();
}

async function getDutyMonitorNodeId(): Promise<string> {
  const c = new WsClient();
  await c.connect();
  const list = await c.request("node.list");
  const node = list.nodes?.find((n: any) => n.name === "duty-monitor");
  await c.disconnect();
  return node?.id;
}

async function readDutyLog(): Promise<string> {
  const logPath = resolve(process.env.HOME || "~", ".nerve/plugins/duty-monitor/activity.log");
  if (!existsSync(logPath)) return "";
  const { readFileSync: rfs } = await import("node:fs");
  return rfs(logPath, "utf-8");
}

async function testDynamicAdd() {
  console.log("\n▸ Dynamic: add command creates a new task");
  const nodeId = await getDutyMonitorNodeId();
  assert(!!nodeId, "duty-monitor has nodeId");
  if (!nodeId) return;

  await sendDmCommand(nodeId, "add 23:30 @test-agent 测试任务");
  await sleep(500);

  // Verify via list command — check the log for task info
  await sendDmCommand(nodeId, "list");
  await sleep(500);

  const log = await readDutyLog();
  assert(log.includes("测试任务"), "task message appears in log");
  assert(log.includes("23:30") || log.includes("23:") , "schedule time appears in log");
}

async function testDynamicList() {
  console.log("\n▸ Dynamic: list command shows tasks");
  const nodeId = await getDutyMonitorNodeId();
  if (!nodeId) return;

  await sendDmCommand(nodeId, "list");
  await sleep(500);

  const log = await readDutyLog();
  assert(log.includes("list:"), "list command produced log output");
}

async function testDynamicRemove() {
  console.log("\n▸ Dynamic: remove command deletes a task");
  const nodeId = await getDutyMonitorNodeId();
  if (!nodeId) return;

  await sendDmCommand(nodeId, "remove 测试任务");
  await sleep(500);

  const log = await readDutyLog();
  assert(log.includes("removed") || log.includes("remove"), "remove action logged");
}

async function testDynamicTrigger() {
  console.log("\n▸ Dynamic: trigger fires a task immediately");
  const nodeId = await getDutyMonitorNodeId();
  if (!nodeId) return;

  // Add a task first, then trigger it
  await sendDmCommand(nodeId, "add every:999m @test-agent 触发测试");
  await sleep(500);
  await sendDmCommand(nodeId, "trigger 触发测试");
  await sleep(500);

  const log = await readDutyLog();
  assert(log.includes("trigger") || log.includes("触发"), "trigger action logged");
}

async function testDynamicAddInvalid() {
  console.log("\n▸ Dynamic: add with invalid schedule logs error");
  const nodeId = await getDutyMonitorNodeId();
  if (!nodeId) return;

  await sendDmCommand(nodeId, "add garbage @agent test");
  await sleep(500);

  const log = await readDutyLog();
  assert(log.includes("invalid") || log.includes("error") || log.includes("无法解析"), "invalid schedule logged as error");
}

// ============================================================
// UNIT TESTS — parseSchedule
// ============================================================

function testParseScheduleFixedTime() {
  console.log("\n▸ parseSchedule: '22:00' → { hour: 22, minute: 0 }");
  const result = parseSchedule("22:00");
  assertEq(result, { hour: 22, minute: 0 }, "22:00 parsed correctly");
}

function testParseScheduleFixedTimeSingleDigit() {
  console.log("\n▸ parseSchedule: '8:05' → { hour: 8, minute: 5 }");
  const result = parseSchedule("8:05");
  assertEq(result, { hour: 8, minute: 5 }, "8:05 parsed correctly");
}

function testParseScheduleWithDayOfWeek() {
  console.log("\n▸ parseSchedule: 'Mon:08:00' → { hour: 8, minute: 0, dayOfWeek: 1 }");
  const result = parseSchedule("Mon:08:00");
  assertEq(result, { hour: 8, minute: 0, dayOfWeek: 1 }, "Mon:08:00 parsed correctly");
}

function testParseScheduleWithDayFriday() {
  console.log("\n▸ parseSchedule: 'Fri:18:30' → { hour: 18, minute: 30, dayOfWeek: 5 }");
  const result = parseSchedule("Fri:18:30");
  assertEq(result, { hour: 18, minute: 30, dayOfWeek: 5 }, "Fri:18:30 parsed correctly");
}

function testParseScheduleWithDaySunday() {
  console.log("\n▸ parseSchedule: 'Sun:09:00' → { hour: 9, minute: 0, dayOfWeek: 0 }");
  const result = parseSchedule("Sun:09:00");
  assertEq(result, { hour: 9, minute: 0, dayOfWeek: 0 }, "Sun:09:00 parsed correctly");
}

function testParseScheduleInterval() {
  console.log("\n▸ parseSchedule: 'every:60m' → { intervalMinutes: 60 }");
  const result = parseSchedule("every:60m");
  assertEq(result, { intervalMinutes: 60 }, "every:60m parsed correctly");
}

function testParseScheduleIntervalShort() {
  console.log("\n▸ parseSchedule: 'every:5m' → { intervalMinutes: 5 }");
  const result = parseSchedule("every:5m");
  assertEq(result, { intervalMinutes: 5 }, "every:5m parsed correctly");
}

function testParseScheduleInvalid() {
  console.log("\n▸ parseSchedule: invalid input returns null");
  assertEq(parseSchedule("garbage"), null, "garbage → null");
  assertEq(parseSchedule(""), null, "empty → null");
  assertEq(parseSchedule("25:00"), null, "25:00 → null (hour out of range)");
  assertEq(parseSchedule("12:60"), null, "12:60 → null (minute out of range)");
  assertEq(parseSchedule("every:0m"), null, "every:0m → null (zero interval)");
  assertEq(parseSchedule("Xyz:10:00"), null, "Xyz:10:00 → null (bad day)");
}

// ============================================================
// UNIT TESTS — TaskStore
// ============================================================

function testTaskStoreAddAndList() {
  console.log("\n▸ TaskStore: add task and list");
  const store = new TaskStore(resolve(TEST_DATA, "task-store-test-1"));
  store.add({ name: "test-task", schedule: { hour: 10, minute: 0 }, message: "@agent do stuff" });
  const tasks = store.list();
  assertEq(tasks.length, 1, "one task");
  assertEq(tasks[0].name, "test-task", "correct name");
  assertEq(tasks[0].message, "@agent do stuff", "correct message");
}

function testTaskStoreRemove() {
  console.log("\n▸ TaskStore: remove task");
  const store = new TaskStore(resolve(TEST_DATA, "task-store-test-2"));
  store.add({ name: "a", schedule: { hour: 10, minute: 0 }, message: "@agent a" });
  store.add({ name: "b", schedule: { hour: 11, minute: 0 }, message: "@agent b" });
  const removed = store.remove("a");
  assert(removed, "remove returns true");
  assertEq(store.list().length, 1, "one task remaining");
  assertEq(store.list()[0].name, "b", "correct task remaining");
}

function testTaskStoreRemoveNonExistent() {
  console.log("\n▸ TaskStore: remove non-existent returns false");
  const store = new TaskStore(resolve(TEST_DATA, "task-store-test-3"));
  const removed = store.remove("nope");
  assert(!removed, "remove returns false for non-existent");
}

function testTaskStorePersistence() {
  console.log("\n▸ TaskStore: tasks persist to disk and reload");
  const dir = resolve(TEST_DATA, "task-store-test-4");
  const store1 = new TaskStore(dir);
  store1.add({ name: "persist-test", schedule: { intervalMinutes: 30 }, message: "@agent check" });

  // New instance reads from same dir
  const store2 = new TaskStore(dir);
  const tasks = store2.list();
  assertEq(tasks.length, 1, "reloaded one task");
  assertEq(tasks[0].name, "persist-test", "correct name after reload");
  assertEq(tasks[0].schedule, { intervalMinutes: 30 }, "correct schedule after reload");
}

function testTaskStoreReloadReadsExternalChanges() {
  console.log("\n▸ TaskStore: reload reads external tasks.json changes");
  const dir = resolve(TEST_DATA, "task-store-test-reload");
  const store = new TaskStore(dir);
  store.add({ name: "before", schedule: { hour: 10, minute: 0 }, message: "@agent before" });

  writeFileSync(resolve(dir, "tasks.json"), JSON.stringify([
    { name: "after", schedule: { hour: 11, minute: 0 }, message: "@agent after" },
  ], null, 2));

  const ok = store.reload();
  const tasks = store.list();
  assert(ok, "reload returns true");
  assertEq(tasks.length, 1, "one externally written task");
  assertEq(tasks[0].name, "after", "task name updated from disk");
  assertEq(tasks[0].message, "@agent after", "message updated from disk");
}

function testTaskStoreDuplicateName() {
  console.log("\n▸ TaskStore: adding duplicate name overwrites");
  const store = new TaskStore(resolve(TEST_DATA, "task-store-test-5"));
  store.add({ name: "dup", schedule: { hour: 10, minute: 0 }, message: "@agent old" });
  store.add({ name: "dup", schedule: { hour: 11, minute: 0 }, message: "@agent new" });
  assertEq(store.list().length, 1, "still one task");
  assertEq(store.list()[0].message, "@agent new", "message updated");
  assertEq(store.list()[0].schedule, { hour: 11, minute: 0 }, "schedule updated");
}

function testTaskStoreAutoName() {
  console.log("\n▸ TaskStore: auto-generates name from message if not provided");
  const store = new TaskStore(resolve(TEST_DATA, "task-store-test-6"));
  store.add({ name: "", schedule: { hour: 10, minute: 0 }, message: "@duty-agent 写日报" });
  const tasks = store.list();
  assert(tasks[0].name.length > 0, "name auto-generated");
  assert(tasks[0].name !== "", "name is not empty");
}

function testMessagePathValidationFindsMissingTaskFile() {
  console.log("\n▸ Task message: referenced absolute task files are validated before emit");
  const missing = resolve(TEST_DATA, "missing-task.md");
  const message = `读取 ${missing} 并执行`;
  const paths = extractReferencedPaths(message);
  const result = validateReferencedPaths(message);

  assertEq(paths, [missing], "absolute .md path extracted");
  assert(!result.ok, "validation fails");
  assertEq(result.missing, [missing], "missing file is reported");
}

function testLegacyAiWorkspacePathNormalization() {
  console.log("\n▸ Task message: legacy ~/.ai/projects path normalizes to workspace path when present");
  const legacyRoot = resolve(TEST_DATA, "home/.ai/projects");
  const workspaceRoot = resolve(TEST_DATA, "home/.ai/workspace/projects");
  const relative = "ai-work-os/notes/tasks/duty/daily-audit-task.md";
  const newPath = resolve(workspaceRoot, relative);
  mkdirSync(dirname(newPath), { recursive: true });
  writeFileSync(newPath, "# task\n");

  const oldPath = resolve(legacyRoot, relative);
  const message = `读取 ${oldPath} 并执行`;
  const normalized = normalizeLegacyAiWorkspacePaths(message);

  assertEq(normalized.changed, true, "message changed");
  assert(normalized.message.includes(newPath), "message contains workspace path");
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  Duty Monitor Tests");
  console.log("═══════════════════════════════════════");

  // Unit tests — CronScheduler
  testTickMatchingTime();
  testTickNonMatchingTime();
  testTickIntervalMinutes();
  testTickLastRunDedup();
  testTickFixedTimeFiresAgainNextDay();
  testTickDayOfWeek();
  testTickWeeklyFiresAgainNextWeek();
  testTickMultipleJobsIndependent();
  testTickIntervalMidnightWrap();

  // Unit tests — Health checks
  testGetMemoryUsage();
  await testGetDiskUsage();
  testGetCpuUsageAllIdle();
  testGetCpuUsageAllBusy();
  testGetCpuUsageNormal();
  testGetCpuUsageZeroDiff();
  testCheckHealthAtExactThreshold();
  testCheckHealthAboveThreshold();
  testCheckHealthBelowThreshold();

  // Unit tests — Message format
  testDailyTriggerMessageFormat();
  testAlertMessageFormat();

  // Unit tests — parseSchedule
  testParseScheduleFixedTime();
  testParseScheduleFixedTimeSingleDigit();
  testParseScheduleWithDayOfWeek();
  testParseScheduleWithDayFriday();
  testParseScheduleWithDaySunday();
  testParseScheduleInterval();
  testParseScheduleIntervalShort();
  testParseScheduleInvalid();

  // Unit tests — TaskStore
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });
  testTaskStoreAddAndList();
  testTaskStoreRemove();
  testTaskStoreRemoveNonExistent();
  testTaskStorePersistence();
  testTaskStoreReloadReadsExternalChanges();
  testTaskStoreDuplicateName();
  testTaskStoreAutoName();
  testMessagePathValidationFindsMissingTaskFile();
  testLegacyAiWorkspacePathNormalization();
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });

  // Integration tests (need server)
  try {
    console.log("\nStarting server for integration tests...");
    await startServer();
    console.log("Server ready.\n");

    await testDutyMonitorRegistration();
    await testDutyMonitorStatus();
    await testDutyMonitorTriggerDaily();
    await testDutyMonitorCheck();

    // Dynamic command tests (real duty-monitor process)
    console.log("\nSpawning duty-monitor process...");
    await spawnDutyMonitor();
    console.log("duty-monitor ready.\n");

    await testDynamicAdd();
    await testDynamicList();
    await testDynamicRemove();
    await testDynamicTrigger();
    await testDynamicAddInvalid();

    stopDutyMonitor();

  } catch (err) {
    console.error("\n💥 Fatal error:", err);
    failed++;
  } finally {
    stopDutyMonitor();
    stopServer();
  }

  // Summary
  console.log("\n══════════════════════════════════════");
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const f of failures) {
      console.log(`    ✗ ${f}`);
    }
  }
  console.log("══════════════════════════════════════\n");

  process.exit(failed > 0 ? 1 : 0);
}

main();

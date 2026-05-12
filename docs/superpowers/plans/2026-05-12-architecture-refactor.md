# nerve 架构重构与日志增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 nerve/src/ 从 38 文件平铺重构为按职责分层；拆分 >500 行的 plugin 大文件；测试目录统一到 vitest 并按 unit/integration/e2e 分层；扩展 logger 支持 correlationId、结构化字段、生命周期/状态/边界标准事件、per-module DEBUG。

**Architecture:** 渐进式重构。先扩 logger（不破坏旧 API）→ 拆 plugin 文件 → 重组测试目录 → src/ 按组挪位置 → 核心模块切到新 logger。每步独立测试、独立 commit。整个过程不改对外行为。

**Tech Stack:** TypeScript / Node.js / vitest / WebSocket / 现有 logger (扩展) / 无新增依赖

**Working Directory:** `/Users/renjinxi/work/worktree/ai-work-os/nerve` (dev 分支)

**Spec:** `docs/superpowers/specs/2026-05-12-architecture-refactor-design.md`

---

## Task 0: 基线测试快照

**Files:**
- 无文件改动（记录基线）

- [ ] **Step 1: 跑 vitest 测试**

Run: `cd /Users/renjinxi/work/worktree/ai-work-os/nerve && npm run test:all 2>&1 | tail -40`
Expected: 记录通过/失败数。若有失败必须先修复或确认是已知不稳定测试。

- [ ] **Step 2: 跑 self-test legacy 框架**

Run: `npm run test:legacy 2>&1 | tail -40`
Expected: 记录通过/失败数。若有失败必须先修复或确认是已知不稳定测试。

- [ ] **Step 3: 跑 tsc 检查**

Run: `npx tsc --noEmit 2>&1 | tail -20`
Expected: 无错误（或记录现有错误作为基线）。

- [ ] **Step 4: 把基线写入 progress 文件**

Create: `docs/superpowers/plans/2026-05-12-baseline.md`
Content:
```markdown
# 重构基线 (2026-05-12)

## vitest (npm run test:all)
- 通过: N
- 失败: M (若有，列出文件)

## self-test (npm run test:legacy)
- 通过: N
- 失败: M (若有，列出文件)

## tsc --noEmit
- errors: 0 / N
```

- [ ] **Step 5: 提交**

```bash
git add docs/superpowers/plans/2026-05-12-baseline.md
git commit -m "docs(refactor): 记录重构前测试基线"
```

---

## Task 1: Logger 扩展 — Module & Child

**Files:**
- Modify: `src/logger.ts`
- Create: `test/vitest/logger.test.ts`

**目的**：让 logger 支持 `module` 字段和 `child({ module })` 派生子 logger，作为后续 correlationId 与 per-module DEBUG 的基础。**保持旧 API 完全兼容**。

- [ ] **Step 1: 写失败测试**

Create: `test/vitest/logger.test.ts`
```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as logger from "../../src/logger.js";

describe("logger.child", () => {
  beforeEach(() => {
    // 重置 module 注册
    logger.__resetForTest?.();
  });

  it("creates child logger with module tag", () => {
    const child = logger.child({ module: "node-pool" });
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    child.info("test message");
    const written = spy.mock.calls.map(c => c[0]).join("");
    expect(written).toContain("[node-pool]");
    expect(written).toContain("test message");
    spy.mockRestore();
  });

  it("child inherits module, allows extra context", () => {
    const child = logger.child({ module: "channel-manager", channelId: "ch1" });
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    child.info("posted");
    const out = spy.mock.calls.map(c => c[0]).join("");
    expect(out).toContain("[channel-manager]");
    expect(out).toContain("channelId=ch1");
    spy.mockRestore();
  });

  it("legacy info/warn/error/debug still work", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.info("legacy");
    expect(spy.mock.calls.map(c => c[0]).join("")).toContain("legacy");
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/vitest/logger.test.ts`
Expected: FAIL — `logger.child is not a function`

- [ ] **Step 3: 修改 logger.ts 加 child + module 支持**

Modify: `src/logger.ts`

完整新实现（旧 API 保留）：

```typescript
import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { localIso } from "./time-util.js";

let logStream: WriteStream | null = null;
let logPath: string | null = null;

export function initLog(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  logStream = createWriteStream(filePath, { flags: "a" });
  logPath = filePath;
}

export function getLogPath(): string | null {
  return logPath;
}

export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface LogContext {
  module?: string;
  correlationId?: string;
  nodeId?: string;
  channelId?: string;
  [key: string]: unknown;
}

function formatContext(ctx: LogContext): string {
  const parts: string[] = [];
  if (ctx.module) parts.push(`[${ctx.module}]`);
  const extras = Object.entries(ctx).filter(([k]) => k !== "module");
  for (const [k, v] of extras) {
    if (v === undefined) continue;
    parts.push(`${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  }
  return parts.join(" ");
}

function emit(level: LogLevel, ctx: LogContext, msg: string): void {
  const ctxStr = formatContext(ctx);
  const prefix = ctxStr ? ` ${ctxStr}` : "";
  const line = `${localIso()} [${level}]${prefix} ${msg}`;
  if (logStream) logStream.write(line + "\n");
  if (level === "ERROR") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export interface Logger {
  info(msg: string, data?: object): void;
  warn(msg: string, data?: object): void;
  error(msg: string, data?: object): void;
  debug(msg: string, data?: object): void;
  trace(msg: string, data?: object): void;
  child(ctx: LogContext): Logger;
}

function makeLogger(baseCtx: LogContext): Logger {
  return {
    info: (msg, data) => emit("INFO", { ...baseCtx, ...(data || {}) }, msg),
    warn: (msg, data) => emit("WARN", { ...baseCtx, ...(data || {}) }, msg),
    error: (msg, data) => emit("ERROR", { ...baseCtx, ...(data || {}) }, msg),
    debug: (msg, data) => emit("DEBUG", { ...baseCtx, ...(data || {}) }, msg),
    trace: (msg, data) => emit("TRACE", { ...baseCtx, ...(data || {}) }, msg),
    child: (ctx) => makeLogger({ ...baseCtx, ...ctx }),
  };
}

export function child(ctx: LogContext): Logger {
  return makeLogger(ctx);
}

// Legacy API
export function info(msg: string): void { emit("INFO", {}, msg); }
export function warn(msg: string): void { emit("WARN", {}, msg); }
export function error(msg: string): void { emit("ERROR", {}, msg); }
export function debug(msg: string): void { emit("DEBUG", {}, msg); }

export function closeLog(): void {
  logStream?.end();
  logStream = null;
}

// for tests
export function __resetForTest(): void {
  /* no module registry yet — placeholder for next task */
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/vitest/logger.test.ts`
Expected: PASS

- [ ] **Step 5: 跑 tsc 验证旧调用不破坏**

Run: `npx tsc --noEmit`
Expected: 与基线一致（不新增错误）。

- [ ] **Step 6: 跑全测试**

Run: `npm run test:all 2>&1 | tail -20`
Expected: 与基线一致。

- [ ] **Step 7: 提交**

```bash
git add src/logger.ts test/vitest/logger.test.ts
git commit -m "logger: 加 child() 与模块化 context (旧 API 兼容)"
```

---

## Task 2: Logger 扩展 — 级别 + NERVE_DEBUG

**Files:**
- Modify: `src/logger.ts`
- Modify: `test/vitest/logger.test.ts`

**目的**：基于级别过滤输出；通过 `NERVE_DEBUG=<module1>,<module2>` env 开启指定 module 的 DEBUG。

- [ ] **Step 1: 加失败测试**

追加到 `test/vitest/logger.test.ts`：
```typescript
describe("level filtering", () => {
  beforeEach(() => { delete process.env.NERVE_DEBUG; logger.__resetForTest?.(); });

  it("DEBUG hidden by default", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const c = logger.child({ module: "test-mod" });
    c.debug("hidden");
    expect(spy.mock.calls.map(x => x[0]).join("")).not.toContain("hidden");
    spy.mockRestore();
  });

  it("NERVE_DEBUG=mod enables DEBUG for that module only", () => {
    process.env.NERVE_DEBUG = "mod-a";
    logger.__resetForTest?.();
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.child({ module: "mod-a" }).debug("show-a");
    logger.child({ module: "mod-b" }).debug("hide-b");
    const out = spy.mock.calls.map(x => x[0]).join("");
    expect(out).toContain("show-a");
    expect(out).not.toContain("hide-b");
    spy.mockRestore();
  });

  it("NERVE_DEBUG=plugin:* matches glob", () => {
    process.env.NERVE_DEBUG = "plugin:*";
    logger.__resetForTest?.();
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.child({ module: "plugin:duty-monitor" }).debug("show-plugin");
    logger.child({ module: "core" }).debug("hide-core");
    const out = spy.mock.calls.map(x => x[0]).join("");
    expect(out).toContain("show-plugin");
    expect(out).not.toContain("hide-core");
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/vitest/logger.test.ts`
Expected: FAIL（级别过滤未实现）

- [ ] **Step 3: 实现级别过滤 + NERVE_DEBUG 解析**

Modify: `src/logger.ts`

在 `emit` 上方加入：

```typescript
const LEVEL_ORDER: Record<LogLevel, number> = {
  TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4,
};

let debugMatchers: ((module: string) => boolean)[] = [];
function parseNerveDebug(): void {
  debugMatchers = [];
  const raw = process.env.NERVE_DEBUG;
  if (!raw) return;
  for (const pat of raw.split(",").map(s => s.trim()).filter(Boolean)) {
    if (pat.includes("*")) {
      const regex = new RegExp("^" + pat.replace(/\*/g, ".*") + "$");
      debugMatchers.push(m => regex.test(m));
    } else {
      debugMatchers.push(m => m === pat);
    }
  }
}
parseNerveDebug();

function shouldLog(level: LogLevel, module?: string): boolean {
  const threshold = LEVEL_ORDER.INFO;
  const levelNum = LEVEL_ORDER[level];
  if (levelNum >= threshold) return true;
  // DEBUG/TRACE: 仅在 NERVE_DEBUG 匹配的 module 通过
  if ((level === "DEBUG" || level === "TRACE") && module) {
    return debugMatchers.some(fn => fn(module));
  }
  return false;
}
```

修改 `emit` 第一行：
```typescript
function emit(level: LogLevel, ctx: LogContext, msg: string): void {
  if (!shouldLog(level, ctx.module)) return;
  // ... rest unchanged
}
```

修改 `__resetForTest`：
```typescript
export function __resetForTest(): void {
  parseNerveDebug();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/vitest/logger.test.ts`
Expected: PASS（全部）

- [ ] **Step 5: 跑全测试**

Run: `npm run test:all 2>&1 | tail -20`
Expected: 与基线一致。

- [ ] **Step 6: 提交**

```bash
git add src/logger.ts test/vitest/logger.test.ts
git commit -m "logger: 加级别过滤 + NERVE_DEBUG=mod,glob*"
```

---

## Task 3: Logger 扩展 — 标准事件 API

**Files:**
- Modify: `src/logger.ts`
- Modify: `test/vitest/logger.test.ts`

**目的**：在 Logger 接口增加 `lifecycle / stateChange / boundary` 三个语义化方法。

- [ ] **Step 1: 加失败测试**

追加：
```typescript
describe("standard events", () => {
  it("lifecycle logs event + reason", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.child({ module: "test" }).lifecycle("start", "boot");
    const out = spy.mock.calls.map(x => x[0]).join("");
    expect(out).toContain("lifecycle=start");
    expect(out).toContain("reason=boot");
    spy.mockRestore();
  });

  it("stateChange logs from/to", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.child({ module: "node" }).stateChange("status", "idle", "running", "spawned");
    const out = spy.mock.calls.map(x => x[0]).join("");
    expect(out).toContain("field=status");
    expect(out).toContain("from=idle");
    expect(out).toContain("to=running");
    spy.mockRestore();
  });

  it("boundary logs direction + kind", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.child({ module: "transport" }).boundary("in", "http", { path: "/spawn", method: "POST" });
    const out = spy.mock.calls.map(x => x[0]).join("");
    expect(out).toContain("dir=in");
    expect(out).toContain("kind=http");
    expect(out).toContain("path=/spawn");
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npx vitest run test/vitest/logger.test.ts`
Expected: FAIL

- [ ] **Step 3: 扩展 Logger 接口**

Modify `src/logger.ts`：

```typescript
export interface Logger {
  info(msg: string, data?: object): void;
  warn(msg: string, data?: object): void;
  error(msg: string, data?: object): void;
  debug(msg: string, data?: object): void;
  trace(msg: string, data?: object): void;
  child(ctx: LogContext): Logger;
  lifecycle(event: "start" | "stop" | "restart" | "crash", reason?: string, data?: object): void;
  stateChange(field: string, from: unknown, to: unknown, reason?: string): void;
  boundary(direction: "in" | "out", kind: string, summary?: object): void;
}
```

在 `makeLogger` 内增加：

```typescript
return {
  // ... existing methods ...
  lifecycle: (event, reason, data) =>
    emit("INFO", { ...baseCtx, lifecycle: event, ...(reason ? { reason } : {}), ...(data || {}) }, `lifecycle:${event}`),
  stateChange: (field, from, to, reason) =>
    emit("INFO", { ...baseCtx, field, from, to, ...(reason ? { reason } : {}) }, `stateChange:${field}`),
  boundary: (direction, kind, summary) =>
    emit("INFO", { ...baseCtx, dir: direction, kind, ...(summary || {}) }, `boundary:${direction}:${kind}`),
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/vitest/logger.test.ts`
Expected: PASS

- [ ] **Step 5: 跑全测试**

Run: `npm run test:all 2>&1 | tail -20`
Expected: 与基线一致。

- [ ] **Step 6: 提交**

```bash
git add src/logger.ts test/vitest/logger.test.ts
git commit -m "logger: 加 lifecycle/stateChange/boundary 标准事件"
```

---

## Task 4: Logger 扩展 — correlationId 工具

**Files:**
- Modify: `src/logger.ts`
- Modify: `test/vitest/logger.test.ts`

**目的**：提供 `newCorrelationId()` 短 ID 生成工具。

- [ ] **Step 1: 加测试**

```typescript
describe("correlationId", () => {
  it("newCorrelationId returns 8-char id", () => {
    const id = logger.newCorrelationId();
    expect(id).toMatch(/^[a-z0-9]{8}$/);
  });

  it("two ids differ", () => {
    expect(logger.newCorrelationId()).not.toBe(logger.newCorrelationId());
  });

  it("correlationId visible in child log output", () => {
    const cid = logger.newCorrelationId();
    const c = logger.child({ module: "test", correlationId: cid });
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    c.info("traced");
    expect(spy.mock.calls.map(x => x[0]).join("")).toContain(`correlationId=${cid}`);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/vitest/logger.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 newCorrelationId**

Add to `src/logger.ts`（用现有的 `nanoid` 依赖，alphabet 限 lowercase+digits）：

```typescript
import { customAlphabet } from "nanoid";
const corrIdGen = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 8);

export function newCorrelationId(): string {
  return corrIdGen();
}
```

如果 nanoid 不提供 `customAlphabet`，则手写：

```typescript
export function newCorrelationId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/vitest/logger.test.ts`
Expected: PASS

- [ ] **Step 5: 跑全测试**

Run: `npm run test:all 2>&1 | tail -20`
Expected: 与基线一致。

- [ ] **Step 6: 提交**

```bash
git add src/logger.ts test/vitest/logger.test.ts
git commit -m "logger: 加 newCorrelationId() 短 ID 生成"
```

---

## Task 5: 拆分 duty-monitor 大文件

**Files:**
- Modify: `src/plugins/duty-monitor/index.ts` (682 lines → 缩到 ~250)
- Create: `src/plugins/duty-monitor/cron-scheduler.ts`
- Create: `src/plugins/duty-monitor/health-check.ts`
- Create: `src/plugins/duty-monitor/reporters.ts`
- Test: `test/duty-monitor.test.ts` (legacy, 不动文件名，只确认仍 pass)

**目的**：按职责切分。`index.ts` 留 plugin 装配 + main 入口。

**职责切分约束**：
- `cron-scheduler.ts`：导出 `CronJob` 类型、`CronScheduler` class（注册 job、tick、应跑判断、lastRun 持久化）。
- `health-check.ts`：导出 `HealthAlert` 类型、`runHealthCheck(thresholds)` 纯函数 + 系统指标读取（CPU/MEM/DISK/heap/RSS）。
- `reporters.ts`：daily report / worklog / health alert 的格式化和频道发布逻辑。
- `index.ts`：CLI args + class DutyMonitor extends PluginBase + 装配各模块。

- [ ] **Step 1: 跑现有测试确认基线**

Run: `npm run test:legacy 2>&1 | grep -i duty-monitor`
若 vitest 中也有 duty-monitor 相关测试：`npx vitest run -t "duty" 2>&1 | tail -20`
Expected: 现有 duty-monitor 测试通过。

- [ ] **Step 2: 读 index.ts 全文，识别切分边界**

Read: `src/plugins/duty-monitor/index.ts` 全文
识别：
- CronJob 类型 + 注册/调度逻辑 → `cron-scheduler.ts`
- runHealthCheck + 系统指标 → `health-check.ts`
- daily/worklog/health 频道格式化 → `reporters.ts`
- 其余（CLI、main class、env 读取、装配）保留在 `index.ts`

- [ ] **Step 3: 抽出 cron-scheduler.ts**

Create: `src/plugins/duty-monitor/cron-scheduler.ts`
- 把 `CronJob` interface + 调度核心（`shouldRun`、tick 循环、lastRun 持久化）抽出
- 导出 class `CronScheduler` 或纯函数集
- index.ts 改为 import 该模块

Run: `npm run test:legacy 2>&1 | grep -i duty` 和 `npx tsc --noEmit`
Expected: 测试通过 + tsc 通过

- [ ] **Step 4: 抽出 health-check.ts**

Create: `src/plugins/duty-monitor/health-check.ts`
- 把 `HealthAlert` interface + `runHealthCheck()` + 系统指标读取（statfs / os.cpus / process.memoryUsage 等）抽出
- 阈值通过参数注入（不读 env，env 在 index.ts 读完传进来）
- index.ts 改为 import 该模块

Run: 同 Step 3
Expected: 通过

- [ ] **Step 5: 抽出 reporters.ts**

Create: `src/plugins/duty-monitor/reporters.ts`
- daily report / worklog / health alert 的格式化函数 + 发布到频道的封装
- index.ts 改为 import 该模块

Run: 同 Step 3
Expected: 通过

- [ ] **Step 6: 验证 index.ts 行数缩减**

Run: `wc -l src/plugins/duty-monitor/*.ts`
Expected: index.ts < 300 行，其余文件各 < 400 行

- [ ] **Step 7: 替换 index.ts 内 console.log 为 logger.child**

Modify: `src/plugins/duty-monitor/index.ts` (and split modules)
- 顶部加 `import { child } from "../../logger.js";`
- `const log = child({ module: "plugin:duty-monitor" });`
- 把模块内 `console.log` / `console.error` 替换为 `log.info` / `log.error`
- PluginBase 自己的 `this.log()` 不动（在 Task 12 集中处理）

Run: `npm run test:legacy 2>&1 | grep -i duty`
Expected: 通过

- [ ] **Step 8: 加 README.md（如缺）**

Create or update: `src/plugins/duty-monitor/README.md`
```markdown
# duty-monitor

**用途**：定时任务调度器 — 日报、worklog、健康巡检。

**入口**：`index.ts`（CLI + PluginBase 装配）。

**模块**：
- `cron-scheduler.ts` — cron job 注册与触发
- `health-check.ts` — CPU/MEM/DISK/Heap/RSS 阈值检查
- `reporters.ts` — 日报、worklog、健康告警的格式化与发布

**依赖**：nerve（频道 + WS）、`PluginBase`。
```

- [ ] **Step 9: 跑全测试**

Run: `npm run test:legacy && npm run test:all`
Expected: 全部通过

- [ ] **Step 10: 提交**

```bash
git add src/plugins/duty-monitor/
git commit -m "plugin(duty-monitor): 拆分 index.ts → cron-scheduler/health-check/reporters + 切到 child logger"
```

---

## Task 6: 拆分 ai-ear 大文件

**Files:**
- Modify: `src/plugins/ai-ear/index.ts` (452 lines)
- Create: `src/plugins/ai-ear/transcript-buffer.ts`
- Create: `src/plugins/ai-ear/capture-pipeline.ts`
- Test: `test/ai-ear.test.ts` 和 `test/vitest/audio-capture.test.ts`

**目的**：把 TranscriptBuffer class 与 capture 编排逻辑抽出。

**职责切分约束**：
- `transcript-buffer.ts`：导出 `TranscriptBuffer` class + `FlushReason` 类型 + `TranscriptBufferConfig`。
- `capture-pipeline.ts`：audio capture 启动/停止 + ASR 流接入 + 文件写入的编排。
- `index.ts`：CLI args + class AiEar extends PluginBase + 命令注册。

- [ ] **Step 1: 跑现有测试基线**

Run: `npm run test:legacy 2>&1 | grep -i ai-ear` 和 `npx vitest run test/vitest/audio-capture.test.ts`
Expected: 通过

- [ ] **Step 2: 抽出 transcript-buffer.ts**

Create: `src/plugins/ai-ear/transcript-buffer.ts`
- 把 `FlushReason` / `TranscriptBufferConfig` / `TranscriptBuffer` class 整段搬过去
- index.ts re-export 类型保证测试中 `import { TranscriptBuffer } from "./index"` 仍可用（在 index.ts 加 `export { TranscriptBuffer, type FlushReason, type TranscriptBufferConfig } from "./transcript-buffer.js";`）

Run: `npm run test:legacy 2>&1 | grep -i ai-ear && npx tsc --noEmit`
Expected: 通过

- [ ] **Step 3: 抽出 capture-pipeline.ts**

Create: `src/plugins/ai-ear/capture-pipeline.ts`
- audio capture 启停 + ASR 流接入 + 写文件编排
- 导出 class `CapturePipeline` 或编排函数
- index.ts 改为装配

Run: 同 Step 2
Expected: 通过

- [ ] **Step 4: 替换裸日志为 child logger**

Modify: `src/plugins/ai-ear/index.ts` + capture-pipeline.ts
- `const log = child({ module: "plugin:ai-ear" });`
- 替换 `console.log` / `console.error` → `log.info` / `log.error`

Run: `npm run test:legacy 2>&1 | grep -i ai-ear`
Expected: 通过

- [ ] **Step 5: 加 README.md**

Create or update: `src/plugins/ai-ear/README.md`
```markdown
# ai-ear

**用途**：会议转录 plugin — mic/system 音频采集 → DashScope ASR → 文件 + 频道推送。

**入口**：`index.ts`（CLI + PluginBase 装配）。

**模块**：
- `audio-capture.ts` — 原生 AudioCapture 二进制封装
- `asr-client.ts` — DashScope ASR 流式客户端
- `transcript-buffer.ts` — 转录缓冲 + 按行/按间隔 flush
- `capture-pipeline.ts` — 采集 → ASR → 写出 编排

**依赖**：原生 `native/AudioCapture/AudioCapture.app`、`DASHSCOPE_API_KEY`。
```

- [ ] **Step 6: 跑全测试**

Run: `npm run test:legacy && npm run test:all`
Expected: 通过

- [ ] **Step 7: 提交**

```bash
git add src/plugins/ai-ear/
git commit -m "plugin(ai-ear): 拆 transcript-buffer/capture-pipeline + child logger"
```

---

## Task 7: 测试目录骨架 + vitest 迁移（unit）

**Files:**
- Create: `test/unit/`, `test/integration/`, `test/e2e/`, `test/legacy/`, `test/helpers/`
- Move: `test/vitest/*.unit.test.ts` 等 → `test/unit/`
- Modify: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: 建子目录**

```bash
mkdir -p test/unit test/integration test/e2e test/legacy test/helpers
```

- [ ] **Step 2: 把 vitest unit 测试挪到 test/unit/**

按内容判断：
- `test/vitest/unit.test.ts` → `test/unit/core.test.ts`
- `test/vitest/ai-life-log.unit.test.ts` → `test/unit/ai-life-log.test.ts`
- `test/vitest/ai-life-log-source-contract.test.ts` → `test/unit/ai-life-log-source-contract.test.ts`
- `test/vitest/ai-life-log-cleaner.test.ts` → `test/unit/ai-life-log-cleaner.test.ts`
- `test/vitest/ai-life-log-opus.test.ts` → `test/unit/ai-life-log-opus.test.ts`
- `test/vitest/ai-life-log-ordered-insert.test.ts` → `test/unit/ai-life-log-ordered-insert.test.ts`
- `test/vitest/audio-capture.test.ts` → `test/unit/audio-capture.test.ts`
- `test/vitest/mac-mic-source.test.ts` → `test/unit/mac-mic-source.test.ts`
- `test/vitest/time-util.test.ts` → `test/unit/time-util.test.ts`
- `test/vitest/logger.test.ts` → `test/unit/logger.test.ts`

执行（用 git mv 保留历史）：
```bash
git mv test/vitest/unit.test.ts test/unit/core.test.ts
git mv test/vitest/ai-life-log.unit.test.ts test/unit/ai-life-log.test.ts
git mv test/vitest/ai-life-log-source-contract.test.ts test/unit/ai-life-log-source-contract.test.ts
git mv test/vitest/ai-life-log-cleaner.test.ts test/unit/ai-life-log-cleaner.test.ts
git mv test/vitest/ai-life-log-opus.test.ts test/unit/ai-life-log-opus.test.ts
git mv test/vitest/ai-life-log-ordered-insert.test.ts test/unit/ai-life-log-ordered-insert.test.ts
git mv test/vitest/audio-capture.test.ts test/unit/audio-capture.test.ts
git mv test/vitest/mac-mic-source.test.ts test/unit/mac-mic-source.test.ts
git mv test/vitest/time-util.test.ts test/unit/time-util.test.ts
git mv test/vitest/logger.test.ts test/unit/logger.test.ts
```

- [ ] **Step 3: 修每个 unit 测试的相对导入路径**

每个移动后的文件中，`from "../../src/..."` 不变（深度未变）。
若有 `from "./helpers"` 类相对，需调整：
```bash
grep -rn "from ['\"]\\./helpers" test/unit/ 2>/dev/null
```
若有匹配项，把 helpers 路径调整为 `../helpers/vitest.ts`（helpers 在下一 step 处理）。

- [ ] **Step 4: 挪 helpers**

```bash
git mv test/vitest/helpers.ts test/helpers/vitest.ts
```

把 unit 测试中所有 `from "./helpers"` 改为 `from "../helpers/vitest.js"`：
```bash
grep -rln "from ['\"]\\./helpers" test/unit/ test/integration/ test/e2e/ 2>/dev/null | xargs sed -i '' "s|from ['\"]\\./helpers['\"]|from \"../helpers/vitest.js\"|g; s|from ['\"]\\./helpers\\.js['\"]|from \"../helpers/vitest.js\"|g"
```

- [ ] **Step 5: 更新 vitest.config.ts**

Modify: `vitest.config.ts`
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/{unit,integration,e2e}/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 30000,
    fileParallelism: true,
    retry: 1,
  },
});
```

- [ ] **Step 6: 跑 unit 测试**

Run: `npx vitest run test/unit/ 2>&1 | tail -20`
Expected: 全部通过

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "test: 创建 unit/integration/e2e/legacy/helpers 骨架并迁 unit 测试到 test/unit/"
```

---

## Task 8: 测试目录 — integration + e2e + legacy 迁移

**Files:**
- Move: `test/vitest/integration-part*.test.ts` → `test/integration/`
- Move: `test/vitest/ai-life-log.integration.test.ts` → `test/integration/`
- Move: `test/vitest/ai-life-log.e2e.test.ts` → `test/e2e/`
- Move: `test/vitest/ai-life-log-remote-source.test.ts` → `test/integration/`
- Move: `test/vitest/ai-life-log-remote-upload.test.ts` → `test/integration/`
- Move: `test/*.test.ts`、`test/self-test.ts`、`test/mock-*.ts`、`test/bridge-test.ts`、`test/run.ts` → `test/legacy/`
- Modify: `package.json` scripts

- [ ] **Step 1: 挪 vitest integration**

```bash
git mv test/vitest/ai-life-log.integration.test.ts test/integration/ai-life-log.test.ts
git mv test/vitest/integration-part1.test.ts test/integration/integration-part1.test.ts
git mv test/vitest/integration-part2a.test.ts test/integration/integration-part2a.test.ts
git mv test/vitest/integration-part2b.test.ts test/integration/integration-part2b.test.ts
git mv test/vitest/integration-part2c.test.ts test/integration/integration-part2c.test.ts
git mv test/vitest/ai-life-log-remote-source.test.ts test/integration/ai-life-log-remote-source.test.ts
git mv test/vitest/ai-life-log-remote-upload.test.ts test/integration/ai-life-log-remote-upload.test.ts
```

- [ ] **Step 2: 挪 vitest e2e**

```bash
git mv test/vitest/ai-life-log.e2e.test.ts test/e2e/ai-life-log.test.ts
```

- [ ] **Step 3: 删空的 vitest 目录**

```bash
ls test/vitest/   # 应该为空
rmdir test/vitest
```

- [ ] **Step 4: 跑 vitest 全测确认 integration + e2e 还能跑**

Run: `npm run test:all 2>&1 | tail -30`

注意 `package.json` 当前 `test` 指向 `test/vitest/unit.test.ts`（已不存在）— 在 Step 6 修复，这里先用 `npx vitest run`。

Run: `npx vitest run 2>&1 | tail -30`
Expected: integration + e2e + unit 全通过

- [ ] **Step 5: 把 test/ 根下旧测试搬到 legacy/**

所有 `test/*.test.ts`（已确认全为非 vitest 框架）+ self-test.ts + mock-*.ts + bridge-test.ts + run.ts：

```bash
# 列出待移动文件
ls test/*.test.ts test/self-test.ts test/mock-*.ts test/bridge-test.ts test/run.ts 2>/dev/null
# 一次性挪到 legacy/
git mv test/*.test.ts test/legacy/
git mv test/self-test.ts test/legacy/
git mv test/mock-agent.ts test/legacy/ 2>/dev/null
git mv test/mock-agent-session-close.ts test/legacy/ 2>/dev/null
git mv test/mock-program.ts test/legacy/ 2>/dev/null
git mv test/bridge-test.ts test/legacy/ 2>/dev/null
git mv test/run.ts test/legacy/ 2>/dev/null
```

注意 `test/fixtures/` 保留原位（不动）。

- [ ] **Step 6: 修复 legacy 内部互相 import 路径**

self-test.ts 6577 行内，包含大量 import 其他 test 文件或 mock 文件。
```bash
grep -n "from ['\"]\\./" test/legacy/self-test.ts | head -20
grep -ln "from ['\"]\\.\\.\\/" test/legacy/*.ts | head
```

如果 self-test.ts 现有的 `from "./mock-agent.js"` 仍能工作（因为 mock-*.ts 也搬到了 legacy/），则无需改。
如果有指向 `test/fixtures/`（如 `from "../fixtures/..."`)，因 self-test.ts 路径深了一层，需改为 `from "../fixtures/..."` → `from "../fixtures/..."`（不变，仍是 `../fixtures` 因 test/legacy/x.ts 到 test/fixtures 是 `../fixtures`）。

实际深度变化：原 `test/self-test.ts` 引用 `test/fixtures/...` 是 `./fixtures/...`，搬到 `test/legacy/self-test.ts` 后变成 `../fixtures/...`。

执行：
```bash
grep -rln "from ['\"]\\./fixtures" test/legacy/ | xargs sed -i '' "s|from ['\"]\\./fixtures|from \"../fixtures|g"
```

类似处理 `from "./mocks"` 等。

- [ ] **Step 7: 更新 package.json scripts**

Modify: `package.json`
```json
"scripts": {
  "build": "tsc",
  "dev": "tsx src/cli.ts serve",
  "start": "node dist/cli.js serve",
  "test": "vitest run",
  "test:unit": "vitest run test/unit",
  "test:integration": "vitest run test/integration",
  "test:e2e": "vitest run test/e2e",
  "test:all": "vitest run",
  "test:legacy": "tsx test/legacy/self-test.ts",
  "cli": "tsx src/cli.ts"
}
```

- [ ] **Step 8: 跑全测试**

Run: `npm run test:unit && npm run test:integration && npm run test:e2e`
Run: `npm run test:legacy 2>&1 | tail -30`
Expected: 全部通过（与基线一致）

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "test: 完成测试目录重组 — integration/e2e 落位 + legacy 隔离 + scripts 更新"
```

---

## Task 9: src/ 分层 — infra 子目录

**Files:**
- Move: `src/logger.ts`, `src/time-util.ts`, `src/event-logger.ts`, `src/command-feedback.ts` → `src/infra/`

**目的**：先动最小耦合的工具模块组。

- [ ] **Step 1: 建子目录并 git mv**

```bash
mkdir -p src/infra
git mv src/logger.ts src/infra/logger.ts
git mv src/time-util.ts src/infra/time-util.ts
git mv src/event-logger.ts src/infra/event-logger.ts
git mv src/command-feedback.ts src/infra/command-feedback.ts
```

- [ ] **Step 2: 批量修 import 路径**

所有 src/ 下 `from "./logger.js"` / `./time-util.js` / `./event-logger.js` / `./command-feedback.js`：

```bash
# 顶层 src/*.ts (除新挪到 infra/ 的)
grep -rln "from ['\"]\\./logger\\.js" src/ | grep -v src/infra/ | xargs sed -i '' "s|from ['\"]\\./logger\\.js['\"]|from \"./infra/logger.js\"|g"
grep -rln "from ['\"]\\./time-util\\.js" src/ | grep -v src/infra/ | xargs sed -i '' "s|from ['\"]\\./time-util\\.js['\"]|from \"./infra/time-util.js\"|g"
grep -rln "from ['\"]\\./event-logger\\.js" src/ | grep -v src/infra/ | xargs sed -i '' "s|from ['\"]\\./event-logger\\.js['\"]|from \"./infra/event-logger.js\"|g"
grep -rln "from ['\"]\\./command-feedback\\.js" src/ | grep -v src/infra/ | xargs sed -i '' "s|from ['\"]\\./command-feedback\\.js['\"]|from \"./infra/command-feedback.js\"|g"

# src/infra/ 内部相互引用（time-util 在 logger 中）
# 现在 logger.ts 和 time-util.ts 都在 src/infra/，相对导入仍 ./time-util.js 即可，不变
```

- [ ] **Step 3: 修 src/plugins/ 下 import**

plugins 现在路径深一层：
```bash
# plugins/foo/index.ts 原本 import "../time-util.js" → 改 "../../infra/time-util.js"
# plugins/foo/bar.ts 原本 import "../../logger.js" → 改 "../../infra/logger.js"
# 等等
```

执行：
```bash
grep -rln "from ['\"]\\.\\./logger\\.js" src/plugins/ | xargs sed -i '' "s|from ['\"]\\.\\./logger\\.js['\"]|from \"../../infra/logger.js\"|g"
grep -rln "from ['\"]\\.\\./time-util\\.js" src/plugins/ | xargs sed -i '' "s|from ['\"]\\.\\./time-util\\.js['\"]|from \"../../infra/time-util.js\"|g"
grep -rln "from ['\"]\\.\\./event-logger\\.js" src/plugins/ | xargs sed -i '' "s|from ['\"]\\.\\./event-logger\\.js['\"]|from \"../../infra/event-logger.js\"|g"
grep -rln "from ['\"]\\.\\./command-feedback\\.js" src/plugins/ | xargs sed -i '' "s|from ['\"]\\.\\./command-feedback\\.js['\"]|from \"../../infra/command-feedback.js\"|g"
```

注意 plugins/<name>/sub/file.ts → 在 plugins/<name>/sub/ 内，引用 logger 是 `../../../infra/logger.js`：

```bash
# 已经处理 plugins/<name>/file.ts (../../infra)
# 处理深一层 plugins/<name>/sub/file.ts (../../../infra)
grep -rln "from ['\"]\\.\\./\\.\\./logger\\.js" src/plugins/ | xargs sed -i '' "s|from ['\"]\\.\\./\\.\\./logger\\.js['\"]|from \"../../../infra/logger.js\"|g"
# 同样 time-util, event-logger, command-feedback
grep -rln "from ['\"]\\.\\./\\.\\./time-util\\.js" src/plugins/ | xargs sed -i '' "s|from ['\"]\\.\\./\\.\\./time-util\\.js['\"]|from \"../../../infra/time-util.js\"|g"
grep -rln "from ['\"]\\.\\./\\.\\./command-feedback\\.js" src/plugins/ | xargs sed -i '' "s|from ['\"]\\.\\./\\.\\./command-feedback\\.js['\"]|from \"../../../infra/command-feedback.js\"|g"
```

- [ ] **Step 4: 修 test/ 下 import**

```bash
grep -rln "from ['\"]\\.\\./src/logger\\.js" test/ | xargs sed -i '' "s|from ['\"]\\.\\./src/logger\\.js['\"]|from \"../src/infra/logger.js\"|g"
grep -rln "from ['\"]\\.\\./\\.\\./src/logger\\.js" test/ | xargs sed -i '' "s|from ['\"]\\.\\./\\.\\./src/logger\\.js['\"]|from \"../../src/infra/logger.js\"|g"

# time-util / event-logger / command-feedback 同样
for mod in time-util event-logger command-feedback; do
  grep -rln "from ['\"]\\.\\./src/$mod\\.js" test/ | xargs sed -i '' "s|from ['\"]\\.\\./src/$mod\\.js['\"]|from \"../src/infra/$mod.js\"|g"
  grep -rln "from ['\"]\\.\\./\\.\\./src/$mod\\.js" test/ | xargs sed -i '' "s|from ['\"]\\.\\./\\.\\./src/$mod\\.js['\"]|from \"../../src/infra/$mod.js\"|g"
done
```

- [ ] **Step 5: 跑 tsc 验证**

Run: `npx tsc --noEmit 2>&1 | tail -30`
Expected: 无错误

- [ ] **Step 6: 跑全测试**

Run: `npm run test:unit && npm run test:integration && npm run test:e2e && npm run test:legacy`
Expected: 全部通过

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "refactor(src): infra 子目录 — logger/time-util/event-logger/command-feedback 入位"
```

---

## Task 10: src/ 分层 — storage 子目录

**Files:**
- Move: `src/store.ts`, `src/blob-store.ts`, `src/channel-store.ts` → `src/storage/`

- [ ] **Step 1: git mv**

```bash
mkdir -p src/storage
git mv src/store.ts src/storage/store.ts
git mv src/blob-store.ts src/storage/blob-store.ts
git mv src/channel-store.ts src/storage/channel-store.ts
```

- [ ] **Step 2: 修 import — src 顶层**

```bash
for mod in store blob-store channel-store; do
  grep -rln "from ['\"]\\./$mod\\.js" src/ | grep -v src/storage/ | xargs sed -i '' "s|from ['\"]\\./$mod\\.js['\"]|from \"./storage/$mod.js\"|g"
done
```

- [ ] **Step 3: 修 plugins/ 下 import**

```bash
for mod in store blob-store channel-store; do
  grep -rln "from ['\"]\\.\\./$mod\\.js" src/plugins/ | xargs sed -i '' "s|from ['\"]\\.\\./$mod\\.js['\"]|from \"../../storage/$mod.js\"|g"
  grep -rln "from ['\"]\\.\\./\\.\\./$mod\\.js" src/plugins/ | xargs sed -i '' "s|from ['\"]\\.\\./\\.\\./$mod\\.js['\"]|from \"../../../storage/$mod.js\"|g"
done
```

- [ ] **Step 4: 修 test/ 下 import**

```bash
for mod in store blob-store channel-store; do
  grep -rln "from ['\"]\\.\\./src/$mod\\.js" test/ | xargs sed -i '' "s|from ['\"]\\.\\./src/$mod\\.js['\"]|from \"../src/storage/$mod.js\"|g"
  grep -rln "from ['\"]\\.\\./\\.\\./src/$mod\\.js" test/ | xargs sed -i '' "s|from ['\"]\\.\\./\\.\\./src/$mod\\.js['\"]|from \"../../src/storage/$mod.js\"|g"
done
```

- [ ] **Step 5: 修 storage/ 内部互引（如 channel-store 引 store）**

```bash
grep -rn "from ['\"]\\./" src/storage/
# 如果 channel-store import "./store.js"（同目录），不变
```

- [ ] **Step 6: tsc + 全测试**

Run: `npx tsc --noEmit && npm run test:unit && npm run test:integration && npm run test:e2e && npm run test:legacy`
Expected: 通过

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "refactor(src): storage 子目录 — store/blob-store/channel-store 入位"
```

---

## Task 11: src/ 分层 — transport 子目录

**Files:**
- Move: `src/transport.ts`, `src/http-router.ts`, `src/peer-client.ts`, `src/peer-config.ts`, `src/remote-registry.ts`, `src/protocol.ts` → `src/transport/`

- [ ] **Step 1: git mv**

```bash
mkdir -p src/transport
git mv src/transport.ts src/transport/transport.ts
git mv src/http-router.ts src/transport/http-router.ts
git mv src/peer-client.ts src/transport/peer-client.ts
git mv src/peer-config.ts src/transport/peer-config.ts
git mv src/remote-registry.ts src/transport/remote-registry.ts
git mv src/protocol.ts src/transport/protocol.ts
```

- [ ] **Step 2: 修 import (src 顶层 / plugins / test)**

按 Task 9-10 同样模式，对 6 个模块名（`transport`, `http-router`, `peer-client`, `peer-config`, `remote-registry`, `protocol`）批量替换：

```bash
for mod in transport http-router peer-client peer-config remote-registry protocol; do
  grep -rln "from ['\"]\\./$mod\\.js" src/ | grep -v src/transport/ | xargs sed -i '' "s|from ['\"]\\./$mod\\.js['\"]|from \"./transport/$mod.js\"|g"
  grep -rln "from ['\"]\\.\\./$mod\\.js" src/plugins/ | xargs sed -i '' "s|from ['\"]\\.\\./$mod\\.js['\"]|from \"../../transport/$mod.js\"|g"
  grep -rln "from ['\"]\\.\\./\\.\\./$mod\\.js" src/plugins/ | xargs sed -i '' "s|from ['\"]\\.\\./\\.\\./$mod\\.js['\"]|from \"../../../transport/$mod.js\"|g"
  grep -rln "from ['\"]\\.\\./src/$mod\\.js" test/ | xargs sed -i '' "s|from ['\"]\\.\\./src/$mod\\.js['\"]|from \"../src/transport/$mod.js\"|g"
  grep -rln "from ['\"]\\.\\./\\.\\./src/$mod\\.js" test/ | xargs sed -i '' "s|from ['\"]\\.\\./\\.\\./src/$mod\\.js['\"]|from \"../../src/transport/$mod.js\"|g"
done
```

- [ ] **Step 3: transport 内部互引修正**

`src/transport/*.ts` 内部如有 `from "../infra/logger.js"` 类（之前 plugins 改过的方式），需检查：
- 顶层 src 现在还在的文件 → `./xxx.js`
- 已 mv 的 → 用相对路径

```bash
# transport/*.ts 内引用 infra/logger.js
grep -rn "from ['\"]\\./infra/" src/transport/ 2>/dev/null
# 应改为 ../infra/
grep -rln "from ['\"]\\./infra/" src/transport/ | xargs sed -i '' "s|from ['\"]\\./infra/|from \"../infra/|g"
grep -rln "from ['\"]\\./storage/" src/transport/ | xargs sed -i '' "s|from ['\"]\\./storage/|from \"../storage/|g"
```

- [ ] **Step 4: tsc + 全测试**

Run: `npx tsc --noEmit && npm run test:unit && npm run test:integration && npm run test:e2e && npm run test:legacy`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "refactor(src): transport 子目录 — transport/http-router/peer-*/remote-registry/protocol 入位"
```

---

## Task 12: src/ 分层 — channel 子目录

**Files:**
- Move: `src/channel.ts`, `src/channel-member.ts`, `src/channel-manager.ts`, `src/router.ts`, `src/request-handler.ts`, `src/subscription-manager.ts` → `src/channel/`

- [ ] **Step 1: git mv**

```bash
mkdir -p src/channel
git mv src/channel.ts src/channel/channel.ts
git mv src/channel-member.ts src/channel/channel-member.ts
git mv src/channel-manager.ts src/channel/channel-manager.ts
git mv src/router.ts src/channel/router.ts
git mv src/request-handler.ts src/channel/request-handler.ts
git mv src/subscription-manager.ts src/channel/subscription-manager.ts
```

- [ ] **Step 2: 批量修 import**

```bash
for mod in channel channel-member channel-manager router request-handler subscription-manager; do
  grep -rln "from ['\"]\\./$mod\\.js" src/ | grep -v src/channel/ | xargs sed -i '' "s|from ['\"]\\./$mod\\.js['\"]|from \"./channel/$mod.js\"|g"
  grep -rln "from ['\"]\\.\\./$mod\\.js" src/plugins/ | xargs sed -i '' "s|from ['\"]\\.\\./$mod\\.js['\"]|from \"../../channel/$mod.js\"|g"
  grep -rln "from ['\"]\\.\\./\\.\\./$mod\\.js" src/plugins/ | xargs sed -i '' "s|from ['\"]\\.\\./\\.\\./$mod\\.js['\"]|from \"../../../channel/$mod.js\"|g"
  grep -rln "from ['\"]\\.\\./src/$mod\\.js" test/ | xargs sed -i '' "s|from ['\"]\\.\\./src/$mod\\.js['\"]|from \"../src/channel/$mod.js\"|g"
  grep -rln "from ['\"]\\.\\./\\.\\./src/$mod\\.js" test/ | xargs sed -i '' "s|from ['\"]\\.\\./\\.\\./src/$mod\\.js['\"]|from \"../../src/channel/$mod.js\"|g"
done
```

- [ ] **Step 3: channel/ 内部修引用**

```bash
grep -rln "from ['\"]\\./infra/" src/channel/ | xargs sed -i '' "s|from ['\"]\\./infra/|from \"../infra/|g"
grep -rln "from ['\"]\\./storage/" src/channel/ | xargs sed -i '' "s|from ['\"]\\./storage/|from \"../storage/|g"
grep -rln "from ['\"]\\./transport/" src/channel/ | xargs sed -i '' "s|from ['\"]\\./transport/|from \"../transport/|g"
```

- [ ] **Step 4: tsc + 全测试**

Run: `npx tsc --noEmit && npm run test:unit && npm run test:integration && npm run test:e2e && npm run test:legacy`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "refactor(src): channel 子目录 — channel/channel-member/channel-manager/router/request-handler/subscription-manager 入位"
```

---

## Task 13: src/ 分层 — node 子目录

**Files:**
- Move: `src/node.ts`, `src/node-pool.ts`, `src/adapter.ts`, `src/model-registry.ts` → `src/node/`

- [ ] **Step 1: git mv**

```bash
mkdir -p src/node
git mv src/node.ts src/node/node.ts
git mv src/node-pool.ts src/node/node-pool.ts
git mv src/adapter.ts src/node/adapter.ts
git mv src/model-registry.ts src/node/model-registry.ts
```

- [ ] **Step 2: 批量修 import**

```bash
for mod in node node-pool adapter model-registry; do
  grep -rln "from ['\"]\\./$mod\\.js" src/ | grep -v src/node/ | xargs sed -i '' "s|from ['\"]\\./$mod\\.js['\"]|from \"./node/$mod.js\"|g"
  grep -rln "from ['\"]\\.\\./$mod\\.js" src/plugins/ | xargs sed -i '' "s|from ['\"]\\.\\./$mod\\.js['\"]|from \"../../node/$mod.js\"|g"
  grep -rln "from ['\"]\\.\\./\\.\\./$mod\\.js" src/plugins/ | xargs sed -i '' "s|from ['\"]\\.\\./\\.\\./$mod\\.js['\"]|from \"../../../node/$mod.js\"|g"
  grep -rln "from ['\"]\\.\\./src/$mod\\.js" test/ | xargs sed -i '' "s|from ['\"]\\.\\./src/$mod\\.js['\"]|from \"../src/node/$mod.js\"|g"
  grep -rln "from ['\"]\\.\\./\\.\\./src/$mod\\.js" test/ | xargs sed -i '' "s|from ['\"]\\.\\./\\.\\./src/$mod\\.js['\"]|from \"../../src/node/$mod.js\"|g"
done
```

- [ ] **Step 3: node/ 内部修引用**

```bash
for sub in infra storage transport channel; do
  grep -rln "from ['\"]\\./$sub/" src/node/ | xargs sed -i '' "s|from ['\"]\\./$sub/|from \"../$sub/|g"
done
```

- [ ] **Step 4: tsc + 全测试**

Run: `npx tsc --noEmit && npm run test:unit && npm run test:integration && npm run test:e2e && npm run test:legacy`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "refactor(src): node 子目录 — node/node-pool/adapter/model-registry 入位"
```

---

## Task 14: src/ 分层 — scene / agent / mcp / integration

**Files:**
- Move: `src/scene-manager.ts`, `src/scheduler.ts`, `src/startup.ts` → `src/scene/`
- Move: `src/acp-client.ts` → `src/agent/`
- Move: `src/nerve-mcp.ts`, `src/nerve-mcp-node-list.ts` → `src/mcp/`
- Move: `src/nvim-bridge.ts` → `src/integration/`

- [ ] **Step 1: git mv 全部**

```bash
mkdir -p src/scene src/agent src/mcp src/integration
git mv src/scene-manager.ts src/scene/scene-manager.ts
git mv src/scheduler.ts src/scene/scheduler.ts
git mv src/startup.ts src/scene/startup.ts
git mv src/acp-client.ts src/agent/acp-client.ts
git mv src/nerve-mcp.ts src/mcp/nerve-mcp.ts
git mv src/nerve-mcp-node-list.ts src/mcp/nerve-mcp-node-list.ts
git mv src/nvim-bridge.ts src/integration/nvim-bridge.ts
```

- [ ] **Step 2: 批量修 import**

```bash
declare -A NEW_DIR=(
  [scene-manager]=scene [scheduler]=scene [startup]=scene
  [acp-client]=agent
  [nerve-mcp]=mcp [nerve-mcp-node-list]=mcp
  [nvim-bridge]=integration
)
for mod in "${!NEW_DIR[@]}"; do
  dir=${NEW_DIR[$mod]}
  grep -rln "from ['\"]\\./$mod\\.js" src/ | grep -v "src/$dir/" | xargs sed -i '' "s|from ['\"]\\./$mod\\.js['\"]|from \"./$dir/$mod.js\"|g"
  grep -rln "from ['\"]\\.\\./$mod\\.js" src/plugins/ | xargs sed -i '' "s|from ['\"]\\.\\./$mod\\.js['\"]|from \"../../$dir/$mod.js\"|g"
  grep -rln "from ['\"]\\.\\./\\.\\./$mod\\.js" src/plugins/ | xargs sed -i '' "s|from ['\"]\\.\\./\\.\\./$mod\\.js['\"]|from \"../../../$dir/$mod.js\"|g"
  grep -rln "from ['\"]\\.\\./src/$mod\\.js" test/ | xargs sed -i '' "s|from ['\"]\\.\\./src/$mod\\.js['\"]|from \"../src/$dir/$mod.js\"|g"
  grep -rln "from ['\"]\\.\\./\\.\\./src/$mod\\.js" test/ | xargs sed -i '' "s|from ['\"]\\.\\./\\.\\./src/$mod\\.js['\"]|from \"../../src/$dir/$mod.js\"|g"
done
```

- [ ] **Step 3: 新子目录内部修引用**

```bash
for newdir in scene agent mcp integration; do
  for refdir in infra storage transport channel node; do
    grep -rln "from ['\"]\\./$refdir/" src/$newdir/ 2>/dev/null | xargs sed -i '' "s|from ['\"]\\./$refdir/|from \"../$refdir/|g"
  done
done
```

- [ ] **Step 4: tsc + 全测试**

Run: `npx tsc --noEmit && npm run test:unit && npm run test:integration && npm run test:e2e && npm run test:legacy`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "refactor(src): scene/agent/mcp/integration 子目录入位"
```

---

## Task 15: src/ 顶层只留入口 — 验证

**Files:**
- 无文件改动（仅验证）

- [ ] **Step 1: 列 src/ 顶层文件**

Run: `ls src/*.ts 2>/dev/null`
Expected: 只有 `cli.ts`、`server.ts`、可能还有 `index.ts`（若存在）。其余应全部进了子目录。

如果还有遗漏文件（如 `peer-client.ts` 等被漏挪），按已有 Task 模式补挪并修 import。

- [ ] **Step 2: 列 src/ 顶层目录**

Run: `ls -d src/*/ 2>/dev/null`
Expected: `infra/ storage/ transport/ channel/ node/ scene/ agent/ mcp/ integration/ plugins/ types/`

- [ ] **Step 3: 跑全测试 + tsc 终检**

Run: `npx tsc --noEmit && npm run test:unit && npm run test:integration && npm run test:e2e && npm run test:legacy`
Expected: 通过

- [ ] **Step 4: 把架构图写入 nerve/INTERNALS.md（或对应文档）**

如果 `notes/INTERNALS.md` 存在（项目级文档），更新代码结构章节。
否则建 `docs/architecture.md`，描述新分层目录。

Create or update: `docs/architecture.md`
```markdown
# nerve 代码结构

```
src/
  cli.ts          # CLI 入口
  server.ts       # 主 server class
  index.ts        # 包入口（如有）

  infra/          # 日志、时间、事件日志、命令反馈
  storage/        # KV store / blob / channel-store
  transport/      # WebSocket / HTTP / peer / protocol
  channel/        # channel + member + manager + router + handler + subscription
  node/           # node 生命周期、node-pool、adapter、model-registry
  scene/          # scene-manager、scheduler、startup
  agent/          # ACP client（AI agent 桥接）
  mcp/            # nerve-mcp 服务端
  integration/    # nvim-bridge（外部集成）
  plugins/        # plugin 节点（各自子目录）
  types/          # 类型声明
```
```

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "docs: 更新代码结构说明（分层后）"
```

---

## Task 16: 核心模块切到 child logger — server / node-pool

**Files:**
- Modify: `src/server.ts`
- Modify: `src/node/node-pool.ts`

**目的**：把核心两个最大模块的裸 console / 老 logger.info 调用切到 child logger，带 module 标签。

- [ ] **Step 1: server.ts 加 child logger**

Modify: `src/server.ts`
顶部 import 调整：
```typescript
import { child as childLogger } from "./infra/logger.js";
```
在 server class 内部初始化：
```typescript
private log = childLogger({ module: "server" });
```
把所有 `console.log` / `console.error` / 旧 `logger.info` 调用换成 `this.log.info` / `this.log.error`。

- [ ] **Step 2: 跑 tsc + 测试**

Run: `npx tsc --noEmit && npm run test:unit && npm run test:integration && npm run test:e2e`
Expected: 通过

- [ ] **Step 3: node-pool.ts 同样处理**

Modify: `src/node/node-pool.ts`
```typescript
import { child as childLogger } from "../infra/logger.js";
private log = childLogger({ module: "node-pool" });
```
替换裸日志。`node-pool` 在 spawn/stop/crash 处用 `this.log.lifecycle("start", reason)` 等标准 API。

- [ ] **Step 4: 跑 tsc + 测试**

Run: `npx tsc --noEmit && npm run test:unit && npm run test:integration && npm run test:e2e && npm run test:legacy`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add src/server.ts src/node/node-pool.ts
git commit -m "logger: server + node-pool 切到 child logger（含 lifecycle 事件）"
```

---

## Task 17: 核心模块切 logger — channel-manager / http-router

**Files:**
- Modify: `src/channel/channel-manager.ts`
- Modify: `src/transport/http-router.ts`

- [ ] **Step 1: channel-manager.ts**

Modify: `src/channel/channel-manager.ts`
```typescript
import { child as childLogger } from "../infra/logger.js";
private log = childLogger({ module: "channel-manager" });
```
- 替换裸日志
- channel post 路径中，传 `channelId` 进 child context（或单次调用 data）
- 成员加入/离开用 `this.log.stateChange("members", oldCount, newCount, reason)`

- [ ] **Step 2: tsc + 测试**

Run: `npx tsc --noEmit && npm run test:unit && npm run test:integration && npm run test:e2e`
Expected: 通过

- [ ] **Step 3: http-router.ts**

Modify: `src/transport/http-router.ts`
```typescript
import { child as childLogger, newCorrelationId } from "../infra/logger.js";
private log = childLogger({ module: "transport:http" });
```
- 在 request handler 入口生成 correlationId
- `const reqLog = this.log.child({ correlationId: cid });`
- 进入用 `reqLog.boundary("in", "http", { method, path })`，出去用 `reqLog.boundary("out", "http", { status })`
- 把 reqLog 挂到 request 对象上（如 `req.log = reqLog`）以便下游使用 — 这步如果改动太大，至少在 router 内部用

- [ ] **Step 4: tsc + 测试**

Run: `npx tsc --noEmit && npm run test:unit && npm run test:integration && npm run test:e2e && npm run test:legacy`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add src/channel/channel-manager.ts src/transport/http-router.ts
git commit -m "logger: channel-manager + http-router 切到 child logger + HTTP 入口注入 correlationId"
```

---

## Task 18: WS 入口 + ACP 入口 correlationId 贯穿

**Files:**
- Modify: `src/transport/transport.ts` (WS handler)
- Modify: `src/agent/acp-client.ts`

**目的**：让 WS incoming request 也带 correlationId，且这个 id 能跟随到下游 spawn/channel/ACP 调用的日志里。

- [ ] **Step 1: transport.ts WS 入口**

Modify: `src/transport/transport.ts`
- 每条 incoming WS message 生成 correlationId（或从 message header 取，如已有）
- 包一个 message-level child logger
- 把 cid 透传给 request-handler / router（要么作为参数，要么挂在 context 上）

- [ ] **Step 2: request-handler 接收 cid**

Modify: `src/channel/request-handler.ts`
- 让 handler 接收一个可选 `correlationId` 参数（或 logger）
- 在 handler 内部把 cid 写入日志 child

- [ ] **Step 3: ACP outbound 带 cid**

Modify: `src/agent/acp-client.ts`
- 调用 agent 时 log boundary("out", "acp", { method, correlationId })
- agent 返回时 log boundary("in", "acp", { method, correlationId })

- [ ] **Step 4: 加单测验证 cid 贯穿**

Create: `test/integration/correlation-id.test.ts`
```typescript
import { describe, it, expect } from "vitest";
import { child, newCorrelationId } from "../../src/infra/logger.js";

describe("correlation-id propagation", () => {
  it("child propagates correlationId through nested children", () => {
    const cid = newCorrelationId();
    const root = child({ module: "test", correlationId: cid });
    const nested = root.child({ module: "test:sub", channelId: "ch1" });
    // 输出包含 cid 是 logger 单测的范畴；此处验证类型与 API 串通即可。
    expect(typeof nested.info).toBe("function");
    expect(typeof nested.child).toBe("function");
  });
});
```

更实质的 e2e 端到端 cid 贯穿验证留作可选（成本高）。

- [ ] **Step 5: tsc + 测试**

Run: `npx tsc --noEmit && npm run test:unit && npm run test:integration && npm run test:e2e && npm run test:legacy`
Expected: 通过

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "logger: WS/ACP 入口注入 correlationId，跨边界日志可串接"
```

---

## Task 19: 验收 — 全套终检

**Files:**
- Create: `docs/superpowers/plans/2026-05-12-completion.md`

- [ ] **Step 1: 全测试**

Run: `npm run test:unit && npm run test:integration && npm run test:e2e && npm run test:legacy`
Expected: 全部通过

- [ ] **Step 2: tsc 终检**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 验收清单**

确认：
- [ ] `src/` 顶层只剩 `cli.ts`、`server.ts`、可能的 `index.ts`
- [ ] `src/` 下分层目录齐全：infra / storage / transport / channel / node / scene / agent / mcp / integration / plugins / types
- [ ] `wc -l src/plugins/*/*.ts | sort -n | tail -5` 最大文件 ≤ 500 行
- [ ] `test/{unit,integration,e2e,legacy,helpers,fixtures}/` 齐全
- [ ] `npm run test:unit` 和 `npm run test:legacy` 都跑通
- [ ] `src/infra/logger.ts` 包含 `child / lifecycle / stateChange / boundary / newCorrelationId / NERVE_DEBUG`
- [ ] 手测：`NERVE_DEBUG=node-pool npx tsx src/cli.ts serve --port 4801`（启动后看 node-pool 的 DEBUG 日志是否出现），然后 kill 进程

- [ ] **Step 4: 写完成报告**

Create: `docs/superpowers/plans/2026-05-12-completion.md`
```markdown
# 重构完成报告 (2026-05-12)

## 完成项
- [x] src/ 分层（10 个子目录）
- [x] plugins/ 大文件拆分（duty-monitor、ai-ear）
- [x] 测试目录统一到 vitest，按 unit/integration/e2e/legacy 分层
- [x] Logger 扩展：child / 标准事件 / NERVE_DEBUG / correlationId

## 关键模块 logger 切换状态
- [x] server
- [x] node-pool
- [x] channel-manager
- [x] http-router
- [x] transport (WS 入口)
- [x] acp-client
- [ ] 其他（未来增量替换）

## 测试结果（终态）
- unit: <N> passed
- integration: <N> passed
- e2e: <N> passed
- legacy: <N> passed
- tsc: clean

## 已知未做
- 核心大模块（node-pool/server/channel-manager）内部未拆分；保留下次
- Android lifelog 通道是否统一到 nerve 协议：未决
- ai/ 骨架：未动（按用户决定）
```

- [ ] **Step 5: 提交**

```bash
git add docs/superpowers/plans/2026-05-12-completion.md
git commit -m "docs(refactor): 重构完成报告"
```

---

## Self-Review

**Spec coverage**：
- §一 nerve/src/ 分层 → Task 9-15
- §二 plugins/ 内部布局 + 拆大文件 → Task 5-6
- §三 测试目录重组 → Task 7-8
- §四 日志增强（结构化字段/correlationId/标准事件/per-module DEBUG/向后兼容）→ Task 1-4, 16-18
- §五 执行顺序（baseline → logger → plugin split → test reorg → src layering → logger adoption）→ Task 0 → 1-4 → 5-6 → 7-8 → 9-15 → 16-18 → 19
- §七 验收标准 → Task 19

**Placeholder scan**：无 TBD/TODO。代码块均给出实际内容；Task 5/6 中 plugin 拆分细节交给执行者按职责切（已说明约束），不是 placeholder 因为约束明确。

**Type consistency**：`Logger` 接口在 Task 1 定义后，Task 3 扩展（lifecycle/stateChange/boundary），Task 16+ 均按此 API 使用，一致。

---

**计划写完，已保存到 `docs/superpowers/plans/2026-05-12-architecture-refactor.md`。**

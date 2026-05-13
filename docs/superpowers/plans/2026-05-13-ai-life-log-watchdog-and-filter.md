# ai-life-log: Wake-Watchdog 阈值 + ASR 文本过滤 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 减少 ai-life-log 录音日志里的两类污染：(1) `mac-mic-source` 的 wake-watchdog 把 60~200s 的事件循环卡顿误判为系统休眠并强制重启 capture（7 天观察到 39 次假重启）；(2) ASR 把静音/外部音频上的幻听输出（`。`、`Yeah.`、`う` 等）和复读全部写进每日日志（2026-05-12 当天 80% 行是垃圾）。

**Architecture:**
- 修 1：把 `SLEEP_DRIFT_MS` 常量从 60_000 提到 300_000。tick 间隔 30s 不变，所以触发条件从 "wall-clock 差 >90s" 变成 ">330s"。短卡顿不再触发，真正长时间休眠仍可恢复。
- 修 2：新建 `transcript-filter.ts`，一个纯 TypeScript 模块（无 IO、无副作用），导出 `TranscriptFilter` 类。`accept(text)` 返回 true/false，内部三条规则：纯标点 / 单短语气词白名单 / 与上一条接受的内容完全相同。`getStats()` 暴露分桶计数供周期性日志使用。接入点只在 `index.ts` 的两个写文件回调里，asr-pipeline 保持纯净。

**Tech Stack:** TypeScript / Node.js / vitest。无新增依赖。

---

## File Structure

| 文件 | 操作 | 责任 |
|------|------|------|
| `src/plugins/ai-life-log/sources/mac-mic-source.ts` | 修改第 20 行常量 | watchdog 阈值 |
| `test/unit/mac-mic-source.test.ts` | 追加 2 个 case | 阈值边界测试 |
| `src/plugins/ai-life-log/transcript-filter.ts` | 新建 | ASR 输出过滤器（纯函数化的有状态模块） |
| `test/unit/transcript-filter.test.ts` | 新建 | 过滤器规则测试 |
| `src/plugins/ai-life-log/index.ts` | 修改两个 `on("text")` handler | 接入过滤 + 周期计数日志 |

---

## Task 1: Watchdog 阈值边界测试（先红）

**Files:**
- Modify: `test/unit/mac-mic-source.test.ts` (append to existing `describe` block)

- [ ] **Step 1.1: 在已有 describe 末尾追加阈值测试**

文件末尾的 `});` 之前插入：

```typescript
  it("watchdog: 120s drift 不触发 restart（短卡顿容忍）", async () => {
    const events: string[] = [];
    const factory = (): FakeCapture => {
      const cap = new EventEmitter() as FakeCapture;
      (cap as any).start = async () => { events.push("start"); };
      (cap as any).stop = () => { events.push("stop"); };
      (cap as any).stopAndWait = async () => { events.push("stopAndWait"); };
      Object.defineProperty(cap, "running", { get: () => true });
      return cap;
    };
    const src = new MacMicSource({ captureFactory: factory });
    await src.start(() => {});
    // 模拟 lastTick 距今 30s + 120s drift = 150s 前
    (src as any).lastTick = Date.now() - 150_000;
    (src as any).running = true;
    (src as any).wakeTick();
    expect(events).toEqual(["start"]); // 没有 stopAndWait / 没有新 start
    await src.stop();
  });

  it("watchdog: 360s drift 触发 restart（真正长休眠）", async () => {
    const events: string[] = [];
    const factory = (): FakeCapture => {
      const cap = new EventEmitter() as FakeCapture;
      (cap as any).start = async () => { events.push("start"); };
      (cap as any).stop = () => { events.push("stop"); };
      (cap as any).stopAndWait = async () => { events.push("stopAndWait"); };
      Object.defineProperty(cap, "running", { get: () => true });
      return cap;
    };
    const src = new MacMicSource({ captureFactory: factory });
    await src.start(() => {});
    (src as any).lastTick = Date.now() - 390_000; // 30s tick + 360s drift
    (src as any).running = true;
    (src as any).wakeTick();
    // wakeTick 内部调度 restartCapture (async)；等待 microtask 队列
    for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
    expect(events).toContain("stopAndWait");
    expect(events.filter(e => e === "start").length).toBeGreaterThanOrEqual(2);
    await src.stop();
  });
```

- [ ] **Step 1.2: 跑测试，确认 360s 那条目前是 PASS（旧阈值就触发）但 120s 那条是 FAIL**

Run: `cd /Users/renjinxi/work/worktree/ai-work-os/nerve && npx vitest run test/unit/mac-mic-source.test.ts`

Expected: 第一个 case `120s drift 不触发` 应该 **FAIL**（因为旧 SLEEP_DRIFT_MS=60_000，120s 会触发 restart）。第二个 case `360s drift 触发` 应该 PASS。

如果第一个 case 反而 PASS 了说明测试本身有 bug，停下来检查。

---

## Task 2: 改阈值常量 让测试变绿

**Files:**
- Modify: `src/plugins/ai-life-log/sources/mac-mic-source.ts:20`

- [ ] **Step 2.1: 修改常量**

把第 20 行：

```typescript
const SLEEP_DRIFT_MS = 60_000;
```

改为：

```typescript
// 5 分钟才视作"系统休眠"——production 数据显示 60s/120s drift 多为 GC/CPU 尖峰，
// 真休眠通常 >5min。提高阈值消除假重启（活动日志 7 天观察到 39 次假重启）。
const SLEEP_DRIFT_MS = 300_000;
```

- [ ] **Step 2.2: 跑测试，确认全绿**

Run: `cd /Users/renjinxi/work/worktree/ai-work-os/nerve && npx vitest run test/unit/mac-mic-source.test.ts`

Expected: 全部 5 个 case 通过（原 3 个 + 新 2 个）。

- [ ] **Step 2.3: 提交**

```bash
cd /Users/renjinxi/work/worktree/ai-work-os/nerve
git add src/plugins/ai-life-log/sources/mac-mic-source.ts test/unit/mac-mic-source.test.ts
git commit -m "ai-life-log: raise watchdog drift threshold 60s→300s

Production logs over 7 days show 39 false-positive 'sleep-wake' restarts,
including drifts as low as 64s/74s/117s — these are GC/event-loop hiccups,
not real sleep. Real sleep is typically >5min. Tolerate up to 300s drift."
```

---

## Task 3: TranscriptFilter 测试（先红）

**Files:**
- Test: `test/unit/transcript-filter.test.ts` (new)

- [ ] **Step 3.1: 写测试文件**

新建 `test/unit/transcript-filter.test.ts`，内容：

```typescript
/**
 * TranscriptFilter — 去掉 ASR 在静音/噪声上的幻听输出 + 连续复读。
 * 真实 2026-05-12 日志：3410 行中 2742 行是 `。`/`Yeah.`/`.` 这类单符号或语气词。
 */
import { describe, it, expect } from "vitest";
import { TranscriptFilter } from "../../src/plugins/ai-life-log/transcript-filter.js";

describe("TranscriptFilter", () => {
  it("接受正常中文 / 英文句子", () => {
    const f = new TranscriptFilter();
    expect(f.accept("今天去了公园")).toBe(true);
    expect(f.accept("对，然后我直接丢")).toBe(true);
    expect(f.accept("This is a sentence.")).toBe(true);
  });

  it("丢弃纯标点和空白", () => {
    const f = new TranscriptFilter();
    expect(f.accept(".")).toBe(false);
    expect(f.accept("。")).toBe(false);
    expect(f.accept("...")).toBe(false);
    expect(f.accept("   ")).toBe(false);
    expect(f.accept("。。、")).toBe(false);
    expect(f.accept("？！")).toBe(false);
  });

  it("丢弃单短语气词白名单（大小写无关，允许尾标点）", () => {
    const f = new TranscriptFilter();
    expect(f.accept("Yeah.")).toBe(false);
    expect(f.accept("yeah")).toBe(false);
    expect(f.accept("YEAH")).toBe(false);
    expect(f.accept("Oh.")).toBe(false);
    expect(f.accept("Okay")).toBe(false);
    expect(f.accept("ok.")).toBe(false);
    expect(f.accept("嗯。")).toBe(false);
    expect(f.accept("啊")).toBe(false);
    expect(f.accept("う")).toBe(false);
    expect(f.accept("そ")).toBe(false);
    expect(f.accept("so")).toBe(false);
    expect(f.accept("The.")).toBe(false);
    expect(f.accept("Hmm")).toBe(false);
  });

  it("保留中文单字（语义性的）", () => {
    const f = new TranscriptFilter();
    expect(f.accept("对")).toBe(true);
    expect(f.accept("好")).toBe(true);
    expect(f.accept("是")).toBe(true);
    expect(f.accept("不")).toBe(true);
  });

  it("丢弃连续重复（trim 后等于上一条接受的）", () => {
    const f = new TranscriptFilter();
    expect(f.accept("学AI，然后用它")).toBe(true);
    expect(f.accept("学AI，然后用它")).toBe(false);
    expect(f.accept("学AI，然后用它  ")).toBe(false); // trim 后相同
    expect(f.accept("换一句")).toBe(true);
    expect(f.accept("学AI，然后用它")).toBe(true); // 中间隔了别的，不算连续重复
  });

  it("被规则丢弃的也算"上一条 accepted"的更新基线？不算", () => {
    // 被任一规则丢弃的不会更新 lastAccepted，避免规则 A 丢的内容造成规则 C 误判
    const f = new TranscriptFilter();
    expect(f.accept("正常一")).toBe(true);
    expect(f.accept(".")).toBe(false);   // punct 丢
    expect(f.accept("正常一")).toBe(false); // 与最后接受的还是相同 → dup 丢
  });

  it("getStats 分桶计数 + resetStats 归零", () => {
    const f = new TranscriptFilter();
    f.accept("正常");
    f.accept(".");          // punct
    f.accept("Yeah.");      // filler
    f.accept("Oh");         // filler
    f.accept("正常");        // dup
    expect(f.getStats()).toEqual({
      dropped: 4,
      byReason: { punct: 1, filler: 2, dup: 1 },
    });
    f.resetStats();
    expect(f.getStats()).toEqual({
      dropped: 0,
      byReason: { punct: 0, filler: 0, dup: 0 },
    });
  });
});
```

- [ ] **Step 3.2: 跑测试，确认 FAIL（模块不存在）**

Run: `cd /Users/renjinxi/work/worktree/ai-work-os/nerve && npx vitest run test/unit/transcript-filter.test.ts`

Expected: FAIL，错误信息类似 `Cannot find module '../../src/plugins/ai-life-log/transcript-filter'`。

---

## Task 4: 实现 TranscriptFilter

**Files:**
- Create: `src/plugins/ai-life-log/transcript-filter.ts`

- [ ] **Step 4.1: 写实现**

新建 `src/plugins/ai-life-log/transcript-filter.ts`，内容：

```typescript
/**
 * TranscriptFilter — 拦截 ASR 在静音/外部音频上的幻听产出和复读。
 *
 * 规则（按 punct → filler → dup 顺序判定）：
 *  1. 纯标点/空白：去掉空白和常见标点后为空 → 丢
 *  2. 单短语气词白名单：去掉尾标点后小写匹配白名单 → 丢
 *  3. 与上一条 accepted 文本 trim 后完全相同 → 丢
 *
 * 中文单字（对/好/是/不等）刻意保留——它们在对话里携带语义。
 * 状态：lastAccepted（只被 accept=true 的输入更新）+ stats（计数器）。
 */

const PUNCT_RE = /[.。,，!！?？;；:：、~～…—\-]/gu;
const TRAIL_PUNCT_RE = /[.。,，!！?？;；:：、~～…—\-\s]+$/u;

const FILLER_WHITELIST = new Set([
  "yeah", "oh", "okay", "ok", "mmm", "hmm", "ah", "uh", "um",
  "well", "so", "the", "yes", "no", "u", "i", "and", "right", "you",
  "う", "あ", "そ", "は", "よ", "ね",
  "嗯", "啊", "哦", "呃", "噢", "哈",
]);

export interface FilterStats {
  dropped: number;
  byReason: { punct: number; filler: number; dup: number };
}

export class TranscriptFilter {
  private lastAccepted = "";
  private stats: FilterStats = {
    dropped: 0,
    byReason: { punct: 0, filler: 0, dup: 0 },
  };

  /** True = keep (write to log), False = drop (silently). */
  accept(text: string): boolean {
    const trimmed = text.trim();

    // Rule 1: 纯标点 / 纯空白
    if (trimmed.replace(PUNCT_RE, "").replace(/\s/gu, "").length === 0) {
      this.stats.dropped++;
      this.stats.byReason.punct++;
      return false;
    }

    // Rule 2: 单短语气词白名单
    const core = trimmed.replace(TRAIL_PUNCT_RE, "").toLowerCase();
    if (FILLER_WHITELIST.has(core)) {
      this.stats.dropped++;
      this.stats.byReason.filler++;
      return false;
    }

    // Rule 3: 与上一条接受的完全相同
    if (trimmed === this.lastAccepted) {
      this.stats.dropped++;
      this.stats.byReason.dup++;
      return false;
    }

    this.lastAccepted = trimmed;
    return true;
  }

  getStats(): FilterStats {
    return {
      dropped: this.stats.dropped,
      byReason: { ...this.stats.byReason },
    };
  }

  resetStats(): void {
    this.stats = { dropped: 0, byReason: { punct: 0, filler: 0, dup: 0 } };
  }
}
```

- [ ] **Step 4.2: 跑测试，确认全绿**

Run: `cd /Users/renjinxi/work/worktree/ai-work-os/nerve && npx vitest run test/unit/transcript-filter.test.ts`

Expected: 全部 7 个 case 通过。

- [ ] **Step 4.3: 跑类型检查**

Run: `cd /Users/renjinxi/work/worktree/ai-work-os/nerve && npx tsc --noEmit`

Expected: 无错误输出。

- [ ] **Step 4.4: 提交**

```bash
cd /Users/renjinxi/work/worktree/ai-work-os/nerve
git add src/plugins/ai-life-log/transcript-filter.ts test/unit/transcript-filter.test.ts
git commit -m "ai-life-log: add TranscriptFilter for ASR hallucination & dup output

Drops three classes of ASR garbage that polluted ~80% of 2026-05-12 log:
- pure punctuation/whitespace (2347 lines of '。')
- single-word filler whitelist (201 lines of 'Yeah.', etc.)
- consecutive duplicates

Meaningful Chinese single chars (对/好/是) are preserved."
```

---

## Task 5: 接入 index.ts（两个 handler + 周期计数日志）

**Files:**
- Modify: `src/plugins/ai-life-log/index.ts`

- [ ] **Step 5.1: 添加 import 和成员**

在文件顶部 import 块末尾追加：

```typescript
import { TranscriptFilter } from "./transcript-filter.js";
```

找到 class `AiLifeLogPlugin` 的字段声明区（`private cleanerTimer:...` 那块），追加：

```typescript
  private filter = new TranscriptFilter();
  private filterLogEvery = 100;
```

- [ ] **Step 5.2: 改 MacMic handler（约第 114 行）**

把现有的：

```typescript
    this.pipeline.on("text", (text: string, ts: Date) => {
      try {
        this.writer.appendOrInsert(text, ts, "mac");
        this.log("info", `[${ts.toISOString()}][mac] ${text}`);
      } catch (err: any) {
        this.log("error", `write failed: ${err.message}`);
      }
    });
```

替换为：

```typescript
    this.pipeline.on("text", (text: string, ts: Date) => {
      if (!this.filter.accept(text)) {
        this.maybeLogFilterStats();
        return;
      }
      try {
        this.writer.appendOrInsert(text, ts, "mac");
        this.log("info", `[${ts.toISOString()}][mac] ${text}`);
      } catch (err: any) {
        this.log("error", `write failed: ${err.message}`);
      }
    });
```

- [ ] **Step 5.3: 改 RemoteSource handler（约第 154 行）**

把：

```typescript
      this.remoteSource.on("text", (text: string, tsMs: number, tag: string) => {
        try {
          this.writer.appendOrInsert(text, new Date(tsMs), tag);
          this.log("info", `[${new Date(tsMs).toISOString()}][${tag}] ${text}`);
        } catch (err: any) {
          this.log("error", `remote write failed: ${err.message}`);
        }
      });
```

替换为：

```typescript
      this.remoteSource.on("text", (text: string, tsMs: number, tag: string) => {
        if (!this.filter.accept(text)) {
          this.maybeLogFilterStats();
          return;
        }
        try {
          this.writer.appendOrInsert(text, new Date(tsMs), tag);
          this.log("info", `[${new Date(tsMs).toISOString()}][${tag}] ${text}`);
        } catch (err: any) {
          this.log("error", `remote write failed: ${err.message}`);
        }
      });
```

- [ ] **Step 5.4: 加 maybeLogFilterStats 私有方法**

在 class 内 `private async stopCapture()` 之前插入：

```typescript
  private maybeLogFilterStats(): void {
    const stats = this.filter.getStats();
    if (stats.dropped >= this.filterLogEvery) {
      this.log(
        "info",
        `transcript-filter: dropped=${stats.dropped} (punct=${stats.byReason.punct}, filler=${stats.byReason.filler}, dup=${stats.byReason.dup})`
      );
      this.filter.resetStats();
    }
  }
```

- [ ] **Step 5.5: 跑类型检查 + 全部单测**

Run:
```
cd /Users/renjinxi/work/worktree/ai-work-os/nerve
npx tsc --noEmit
npx vitest run test/unit/transcript-filter.test.ts test/unit/mac-mic-source.test.ts test/unit/ai-life-log.test.ts
```

Expected: 类型 0 错，3 个 spec 文件全部 PASS。

- [ ] **Step 5.6: 提交**

```bash
cd /Users/renjinxi/work/worktree/ai-work-os/nerve
git add src/plugins/ai-life-log/index.ts
git commit -m "ai-life-log: wire TranscriptFilter into both text handlers

Both MacMic and RemoteUpload text events now pass through the filter
before reaching the writer. Every 100 drops emit one info log line
summarizing buckets, then reset counters."
```

---

## Task 6: 端到端冒烟（可选但建议）

**Files:** none — 跑现有 e2e。

- [ ] **Step 6.1: 跑 ai-life-log 集成测试**

Run: `cd /Users/renjinxi/work/worktree/ai-work-os/nerve && npx vitest run test/integration/ai-life-log.test.ts test/e2e/ai-life-log.test.ts`

Expected: 全部 PASS。如果 e2e 因依赖真实模型而 skip，记录 skipped 数即可，不视为失败。

- [ ] **Step 6.2: 留个 verification note**

不需要重启线上 nerve（用户后续会自己用 `nerve-server deploy` 滚动）。本任务到此结束。

---

## Self-Review

- ✅ Spec 覆盖：阈值改动 → Task 1+2；filter 模块 → Task 3+4；接入 → Task 5；冒烟 → Task 6。
- ✅ 无占位符：所有代码块完整。
- ✅ 类型一致：`TranscriptFilter.accept` / `getStats` / `resetStats` 在 Task 3 测试和 Task 4 实现里签名一致；`FilterStats` 结构在测试期望和实现里一致；`maybeLogFilterStats` 私有方法只在 index.ts 内引用。
- ✅ TDD 顺序：每个修复都是先红后绿（Task 1 红 → Task 2 绿；Task 3 红 → Task 4 绿）。
- ✅ 提交粒度：3 个独立 commit，对应三个语义化改动。

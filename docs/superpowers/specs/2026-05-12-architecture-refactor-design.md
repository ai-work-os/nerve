# nerve 架构重构与日志增强 — 设计

**日期**: 2026-05-12
**范围**: nerve（仓库）
**触发**: 近 7 天 ai-life-log 端到端落地后，`nerve/src/` 顶层扁平、测试目录二元化、插件内部缺规范、日志不足以支撑事后排查。

## 目标

1. nerve/src/ 按职责分层，缓解 38 文件平铺的复杂度。
2. plugins/ 内部布局标准化，拆 >500 行的大文件。
3. 测试目录统一到 vitest，按 unit/integration/e2e 分层；旧 self-test 框架降级为 legacy。
4. 日志增强：correlationId 贯穿、结构化字段、生命周期/状态/边界三类标准事件、per-module DEBUG。
5. **行为不变** — 重构只动文件位置/拆分/日志埋点，不改对外语义。

## 非目标

- 不动 ai/ 骨架（用户决定暂缓）。
- 不动 nerve-tui、nerve-app、notes。
- 不改 ai-life-log 现有功能行为。
- 不引入新的日志/追踪框架（pino/winston/OpenTelemetry）。
- 不引入 path alias，保持相对导入。

---

## 范围决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 大模块是否拆内部 | **不拆** `node-pool` / `server` / `channel-manager` | 一次改太多风险高，先挪位置；内部拆下次再做 |
| plugin 拆分阈值 | **>500 行强制拆** | 本轮拆 `duty-monitor (682)`、`ai-ear (452, 临界)` |
| 老 self-test 框架 | **保留，降级为 legacy** | 新增统一走 vitest；旧的不再增也不强行迁 |
| 日志依赖 | **扩现有 logger.ts** | 不引第三方库，保持依赖精简 |
| 旧 logger API | **保留为 wrapper** | 渐进迁移，避免一次大爆炸 |

---

## 一、nerve/src/ 分层

**当前**：38 个 .ts 文件平铺。最大文件：node-pool.ts (855)、server.ts (710)、channel-manager.ts (704)、nerve-mcp.ts (627)、http-router.ts (582)、cli.ts (529)、scene-manager.ts (417)、acp-client.ts (405)。

**目标布局**：

```
src/
  cli.ts                # 入口，保留顶层
  server.ts             # 主 server class，保留顶层
  index.ts              # 包入口（若有）

  transport/
    transport.ts
    http-router.ts
    peer-client.ts
    peer-config.ts
    remote-registry.ts
    protocol.ts

  storage/
    store.ts
    blob-store.ts
    channel-store.ts

  channel/
    channel.ts
    channel-member.ts
    channel-manager.ts
    router.ts
    request-handler.ts
    subscription-manager.ts

  node/
    node.ts
    node-pool.ts
    adapter.ts
    model-registry.ts

  scene/
    scene-manager.ts
    scheduler.ts
    startup.ts

  agent/
    acp-client.ts

  mcp/
    nerve-mcp.ts
    nerve-mcp-node-list.ts

  infra/
    logger.ts
    time-util.ts
    event-logger.ts
    command-feedback.ts

  integration/
    nvim-bridge.ts

  plugins/              # 位置不变，内部规范见 §二
  types/                # 位置不变
```

**约束**：
- 文件内容不动（除 import 路径）。
- 按分组挪（如先挪 storage/ 三个文件），每组挪完跑全测试，绿了再下一组。
- import 路径用相对路径。

## 二、plugins/ 内部布局规范

**标准**：以 `ai-life-log/` 为样板：
```
plugins/<name>/
  index.ts              # 入口 + plugin 契约
  README.md             # 用途/入口/依赖（3 行起步）
  *.ts                  # 子模块（按职责拆，平铺）
  sources/              # 如有多种输入源
  test/                 # 如有专属测试 fixture
```

**本轮动作**：
- `duty-monitor/index.ts` (682 行) 拆为 `index.ts` + `scheduler.ts` + `reporter.ts`（按实际职责切，不强求三个名）。
- `ai-ear/index.ts` (452 行) 拆为 `index.ts` + `capture-control.ts` + `transcript-handler.ts`（同上）。
- 拆分顺势替换日志为新 logger（§四）。
- 每个 plugin 加 `README.md`（若缺）。

**不动**：`context-guardian` (195)、`observer/`、`user-recorder` (219)、`ai-life-log/`（已合规）。

## 三、测试目录重组

**目标布局**：

```
test/
  unit/                 # 纯函数、单模块（毫秒级）
  integration/          # 多组件，外部走 mock（秒级）
  e2e/                  # 真起 server，全链路（十秒级）
  legacy/               # self-test.ts 驱动的旧框架，仅运行不新增
  fixtures/             # 共享 fixture
  helpers/              # 共享 helper（如 vitest helpers.ts）
```

**迁移规则**：

| 原路径 | 目标路径 |
|--------|---------|
| `test/vitest/*.unit.test.ts` | `test/unit/*.test.ts` |
| `test/vitest/integration-*.test.ts` | `test/integration/*.test.ts` |
| `test/vitest/*.e2e.test.ts` | `test/e2e/*.test.ts` |
| `test/vitest/ai-life-log*.test.ts` | 按 unit/integration/e2e 分散到对应目录 |
| `test/vitest/helpers.ts` | `test/helpers/vitest.ts` |
| `test/vitest/*.test.ts`（其他） | 按内容判断归类 |
| `test/distributed-nerve.e2e.test.ts` | `test/e2e/` |
| `test/harness-phase*.test.ts` | `test/e2e/`（看实际是否 vitest 风格） |
| `test/bug*-*.test.ts` | `test/integration/` 或 `test/legacy/`（按框架） |
| `test/self-test.ts` 及其驱动的 | `test/legacy/` |
| `test/fixtures/` | 保留原位 |

**判断框架**：每个旧测试文件先 grep `from 'vitest'` 或 `describe(`/`it(`/`test(`：
- 有 vitest 导入 → 归入新结构
- 没有 → 进 legacy

**vitest.config.ts** 更新 `include` 模式覆盖 `test/{unit,integration,e2e}/**/*.test.ts`。

**package.json scripts**：
- `test` → vitest run（unit+integration+e2e）
- `test:unit` → vitest run test/unit
- `test:integration` → vitest run test/integration
- `test:e2e` → vitest run test/e2e
- `test:legacy` → npx tsx test/legacy/self-test.ts（若入口在 legacy）

## 四、日志增强

**当前**：`src/logger.ts` + `src/plugins/plugin-base.ts` 中的 logger，本地 ISO 8601 时区已统一。`event-logger.ts` 有事件日志。Android 端有 `RemoteLogBackend` 收日志到 home。

### 4.1 结构化字段（必填）

每条 log entry 强制字段：

```ts
{
  ts: string,           // 本地 ISO 8601 + offset
  level: 'TRACE'|'DEBUG'|'INFO'|'WARN'|'ERROR',
  module: string,       // 'node-pool' / 'plugin:duty-monitor' / 'transport:http'
  msg: string,
  // optional context
  correlationId?: string,
  nodeId?: string,
  channelId?: string,
  // arbitrary structured data
  [key: string]: unknown,
}
```

文件落盘格式保持当前可读形式（不破坏 `node.log`），结构化字段附在行尾 JSON 或 key=value（取现状一致风格）。

### 4.2 correlationId 贯穿

- 任何 incoming request（HTTP / WS / peer / MCP / ACP）入口处生成 `correlationId`（短 ID，8 字符随机即可）。
- 通过 logger 的 `child({ correlationId })` 派生子 logger，**自动继承上下文**。
- 跨模块调用如果需要传递，作为参数或挂在 context object 上往下传。
- 所有派生出来的 spawn / channel post / outgoing call 必须携带相同 id。

### 4.3 标准事件 API

在 `infra/logger.ts` 增加三个语义化方法（不强制，方便统一）：

```ts
logger.lifecycle(event: 'start'|'stop'|'restart'|'crash', reason?: string, data?: object): void
logger.stateChange(field: string, from: unknown, to: unknown, reason?: string): void
logger.boundary(direction: 'in'|'out', kind: string, summary: object): void
```

调用方约束：
- plugin/node 的生命周期变更必须走 `lifecycle`。
- node state、channel member、scene 切换必须走 `stateChange`。
- HTTP/WS/peer/ACP/MCP 进出必须走 `boundary`（默认 INFO 级别）。

### 4.4 per-module DEBUG

环境变量 `NERVE_DEBUG=<module1>,<module2>,...`：
- 匹配的 module 整体输出降为 DEBUG。
- 支持通配 `NERVE_DEBUG=plugin:*` 开所有 plugin。
- 未指定时按现有 level 行为。

实现：logger 工厂读取 env → 给指定 module 的 logger 设 DEBUG threshold。

### 4.5 向后兼容

- 旧 `logger.info(msg)`、`logger.warn(msg)`、`logger.error(msg)` 全部保留。
- 旧调用自动带 `module=unknown`，渐进替换为带 module 的 child logger。
- 第一波（本次重构）：动到的文件顺手替换；没动的文件留待后续。

### 4.6 不做

- 不引入 pino/winston。
- 不接 OpenTelemetry。
- 不动 Android RemoteLogBackend。
- 不做日志集中聚合服务。

---

## 五、执行顺序

每步必须独立可合并，且测试全绿才进下一步。

```
Step 0 — 基线
  - npm test 跑全测试，记录通过/失败基线。
  - 若已有失败，重构前必须先修，否则没法判断回归。

Step 1 — logger 骨架（不挪文件）
  - infra/logger.ts 扩接口（lifecycle/stateChange/boundary, child, NERVE_DEBUG）
  - 旧 API 不破坏
  - 加 logger 单元测试覆盖新接口
  - 全测试绿

Step 2 — 拆 duty-monitor 和 ai-ear
  - 按职责切，每个 plugin 拆一次跑一次测
  - 顺势把 plugin 内部裸日志切到新 logger 的 child
  - 加/补 plugin README.md
  - 全测试绿

Step 3 — 测试目录重组
  - 按 §三 表格 mv
  - vitest.config.ts include 路径更新
  - package.json scripts 增加 test:unit/integration/e2e/legacy
  - 全测试绿（包括 legacy）

Step 4 — src/ 分组挪位置
  - 按 storage → infra → transport → channel → node → scene → agent → mcp → integration 顺序
  - 每组挪完跑 npx tsc --noEmit + 全测试
  - 每组一个 commit

Step 5 — 核心模块切新 logger
  - server / node-pool / channel-manager / http-router / scheduler 等
  - 入口点（HTTP/WS/peer/ACP）注入 correlationId
  - 标准事件 API 调用替换
  - 全测试绿
```

---

## 六、风险与缓解

| 风险 | 缓解 |
|------|------|
| import 路径变更连锁错误 | 每组挪完跑 `tsc --noEmit` + 全测试；分组 commit 便于回滚 |
| 旧 logger 调用被破坏 | 旧 API 保留为 wrapper；新接口为可选；先扩后切 |
| legacy self-test 路径丢 | 单独 `test:legacy` 入口；fixtures 不动；先验证再删旧目录 |
| 大文件拆分引入 bug | TDD 守则：每次拆分前后跑同一组测试；逻辑搬运不改语义 |
| 多步 PR 难以审查 | 每步独立 commit，单步 commit 应能独立通过测试 |
| 性能回归（日志增多） | 默认级别不变；DEBUG 通过 env 开关；不强制路径增日志 |

---

## 七、验收标准

- [ ] `npm test` 全绿（unit + integration + e2e）。
- [ ] `npm run test:legacy` 全绿（旧 self-test 框架可运行）。
- [ ] `npx tsc --noEmit` 无错误。
- [ ] `src/` 顶层只剩 `cli.ts` / `server.ts` / `index.ts` 等入口文件 + 子目录。
- [ ] plugins/ 下无 >500 行单文件。
- [ ] `infra/logger.ts` 新增 `lifecycle / stateChange / boundary / child` 接口，单元测试覆盖。
- [ ] `NERVE_DEBUG=<module>` 能切换指定 module 的 DEBUG 输出（手工验证一次）。
- [ ] 至少一个入口（如 HTTP 请求）携带 correlationId 贯穿到一次 spawn / channel post（看日志能串起来）。

---

## 八、与现有约束的对齐

- **CLAUDE.md TDD 铁律**：每步先确认基线绿，每次改动跑测试。
- **feedback_evolution_first.md**：骨架先扩再用，不一次到位（旧 logger 保留、legacy 测试保留）。
- **feedback_test_on_worktree.md**：所有测试在 worktree dev 分支跑（4801 端口若需要）。
- **feedback_test_speed.md**：本次重组本身就是回应——unit 独立目录便于快跑。
- **feedback_integration_test_isolation.md**：integration/e2e 测试本身已经随机端口+隔离数据目录，迁移过程不破坏。

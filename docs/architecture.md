# nerve 代码结构

2026-05 重构后的分层布局。每个子目录代表一个清晰的职责。

## src/ 顶层

```
src/
  cli.ts          # CLI 入口（npx tsx src/cli.ts serve）
  server.ts       # 主 server class（绑定 WS + HTTP，串联各子系统）
  index.ts        # 包入口（dist/index.js 用）

  infra/          # 基础设施：日志、时间、事件日志、命令反馈
  storage/        # SQLite KV store / blob / channel-store
  transport/      # WebSocket / HTTP / peer / 协议定义
  channel/        # channel + member + manager + router + handler + subscription
  node/           # node 生命周期 / node-pool / adapter / model-registry
  scene/          # scene-manager / scheduler / startup
  agent/          # ACP client（AI agent 桥接）
  mcp/            # nerve-mcp 服务端 + node-list 子模块
  integration/    # nvim-bridge（外部集成）
  plugins/        # plugin 节点（各自子目录，详见 §plugins）
  types/          # 类型声明
```

## 模块职责一览

| 子目录 | 职责 | 主要文件 |
|--------|------|---------|
| `infra/` | 横切支撑，无业务逻辑 | logger / time-util / event-logger / command-feedback |
| `storage/` | 持久层封装（SQLite + blob） | store / blob-store / channel-store |
| `transport/` | I/O 与协议序列化 | transport / http-router / peer-client / peer-config / remote-registry / protocol |
| `channel/` | 多人频道、订阅、消息路由 | channel / channel-member / channel-manager / router / request-handler / subscription-manager |
| `node/` | 节点对象 + 进程池 + adapter 注册表 | node / node-pool / adapter / model-registry |
| `scene/` | 场景定义 + 调度 + 启动编排 | scene-manager / scheduler / startup |
| `agent/` | ACP 协议客户端，连 AI agent 子进程 | acp-client |
| `mcp/` | MCP 服务（暴露 nerve 工具给 AI） | nerve-mcp / nerve-mcp-node-list |
| `integration/` | 客户端集成（neovim 等） | nvim-bridge |
| `plugins/` | 节点形态插件（duty-monitor / ai-ear / ai-life-log / observer / context-guardian / user-recorder） | 各 plugin 自己目录 |

## 依赖方向（建议）

```
cli → server → { transport, channel, node, scene, agent, mcp }
                ↓
              storage
                ↓
              infra
```

- `infra/` 不依赖任何业务模块。
- `storage/` 只依赖 `infra/` 和（部分类型）`transport/protocol`。
- `channel / node / scene / agent / mcp` 之间允许互引，但应避免循环。
- `plugins/` 只依赖 `infra/` 和 `plugins/plugin-base.ts`，不直接引业务子目录。

## plugins/ 内部布局

```
plugins/
  plugin-base.ts          # 共享基类（WS 连接 + 注册 + 命令派发）
  <name>/
    index.ts              # 插件入口 + class extends PluginBase
    README.md             # 3 行说明：用途 / 入口 / 依赖
    *.ts                  # 子模块（按职责拆，单文件 < 500 行）
    sources/              # 多种输入源时（如 ai-life-log）
```

**约束**：插件单文件超 500 行就拆。当前最大：`observer/index.ts` (288)，`user-recorder/index.ts` (219)。

## 测试目录

```
test/
  unit/                   # 纯函数 / 单模块（vitest，毫秒级）
  integration/            # 多组件，外部走 mock（vitest，秒级）
  e2e/                    # 真起 server，全链路（vitest，十秒级）
  legacy/                 # 旧 self-test.ts 框架（仅运行不新增）
    standalone/           # 旧的独立 tsx 单测脚本
  helpers/                # vitest 共享 helper
  fixtures/               # 共享 fixture（音频/wav 等）
```

测试入口：
- `npm test` / `npm run test:all` → vitest 全跑（unit + integration + e2e）
- `npm run test:unit` / `test:integration` / `test:e2e` → 分别跑
- `npm run test:legacy` → `tsx test/legacy/self-test.ts`

## 路径计算注意事项

某些模块用 `dirname(fileURLToPath(import.meta.url))` 推算项目根。如果文件移到更深层，**必须更新 `dirname()` 次数**：

| 位置 | 到项目根 |
|------|---------|
| `src/foo.ts` | `dirname(dirname(...))` 跳两层 |
| `src/sub/foo.ts` | `dirname(dirname(dirname(...)))` 跳三层 |

`src/node/node-pool.ts` 中的 `nerveRoot` 与 `selfDir`（找 nerve-mcp 脚本）就属于此类。重构时一并修正。

## 日志体系

`src/infra/logger.ts` 提供：
- 旧 API：`info / warn / error / debug` — 兼容保留。
- 新 API：
  - `child({ module, correlationId, nodeId, channelId, ... })` 派生子 logger。
  - `lifecycle(event, reason?, data?)` — 节点/插件 start/stop/restart/crash。
  - `stateChange(field, from, to, reason?)` — 状态切换。
  - `boundary("in"|"out", kind, summary?)` — 跨边界（HTTP / WS / ACP / MCP）。
  - `newCorrelationId()` — 8 字符短 ID，贯穿一次请求的所有日志。
- 级别过滤：`INFO+` 默认输出；`DEBUG / TRACE` 仅在 `NERVE_DEBUG=<module>` 时输出（支持 `plugin:*` 通配）。

排查时打 `NERVE_DEBUG=node-pool,channel-manager` 启动 nerve，把这两个模块的细节打开。

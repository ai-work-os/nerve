# Nerve 项目文件结构

## Server 端：~/.ai/nerve/

```
nerve/
├── src/                        # TypeScript 源码（2,468 行）
│   ├── server.ts      (466)    # WS + HTTP 入口，JSON-RPC 分发          ✅
│   ├── bus.ts         (311)    # 核心编排：频道管理、事件广播、消息路由    ✅
│   ├── node-pool.ts   (234)    # 节点生命周期：spawn/stop、ACP 连接管理   ✅
│   ├── acp-client.ts  (339)    # ACP 协议客户端：握手、prompt、反向请求    ✅
│   ├── cli.ts         (334)    # CLI 命令（serve/status/channel/node）    ✅
│   ├── nvim-bridge.ts (241)    # nvim RPC ↔ bus 双向桥接                 ✅
│   ├── store.ts       (152)    # SQLite 持久化（频道、消息、节点）         ✅
│   ├── transport.ts   (154)    # 传输层抽象：StdioTransport / WSTransport ✅
│   ├── protocol.ts    (106)    # JSON-RPC 2.0 类型定义 + LineBuffer       ✅
│   ├── adapter.ts      (73)    # agent CLI 模板（claude/codex/gemini/mock）✅
│   ├── node.ts         (68)    # BusNode 数据模型                         ✅
│   ├── scheduler.ts    (67)    # 每节点串行 prompt 队列                   ✅
│   ├── channel.ts      (49)    # Channel 数据模型                         ✅
│   ├── logger.ts       (41)    # 文件 + stderr 日志                       ✅
│   ├── router.ts       (42)    # @mention 解析 + 路由                     ✅
│   └── index.ts        (37)    # 入口：解析参数，创建 Bus + Server        ✅
│
├── test/
│   ├── self-test.ts  (20k+)   # 46 个端到端测试                          ✅
│   ├── bridge-test.ts (4k)    # nvim bridge 测试（5 个）                  ✅
│   └── mock-agent.ts  (3k)    # 模拟 ACP agent                           ✅
│
├── dist/                       # tsc 编译输出（server 实际运行这里）
├── bin/                        # agent 辅助脚本（nerve-post 等）
│
├── ARCHITECTURE.md             # 设计理念                                 ✅
├── API.md                      # WS JSON-RPC 接口契约                     ✅
├── ACP.md                      # 内部 ACP 协议参考                        ✅
├── INTERNALS.md                # 代码级调用链                             ✅
├── STATUS.md                   # 项目状态                                 ✅
├── ROADMAP.md                  # 路线图（本次新增）                       ✅
├── STRUCTURE.md                # 本文件                                   ✅
├── CLAUDE.md                   # Claude Code 项目指令                     ✅
├── package.json                # 依赖：ws, better-sqlite3, nanoid
└── tsconfig.json               # TS 配置：ES2022, Node16, strict
```

## nvim 客户端：~/.config/nvim/lua/nerve/

```
nerve/
├── init.lua    (133)           # 命令入口 :Nerve spawn|chat|status|stop   ✅
├── client.lua  (388)           # WS JSON-RPC 客户端，节点注册/请求/通知   ✅
├── ws.lua      (329)           # WebSocket 实现（RFC 6455, vim.uv TCP）   ✅
├── chat.lua    (501)           # 1v1 聊天视图，流式渲染                   🔧
├── view.lua    (467)           # 频道面板 UI                              ✅（待 Phase 4）
└── log.lua      (21)           # 文件日志 → ~/.config/nvim/logs/          ✅
```

## 数据文件

```
~/.nerve/
├── bus.db                      # SQLite（频道、消息、节点记录）
└── bus.log                     # server 运行日志
~/.config/nvim/logs/
└── nerve-client.log            # nvim 客户端日志
```

## 依赖关系

```
server.ts ──→ bus.ts ──→ node-pool.ts ──→ acp-client.ts ──→ protocol.ts
                │              │                                  │
                ├→ channel.ts  ├→ transport.ts ←─────────────────┘
                ├→ router.ts   └→ adapter.ts
                ├→ scheduler.ts
                └→ store.ts

init.lua ──→ client.lua ──→ ws.lua
        ├──→ chat.lua ──→ client.lua
        └──→ view.lua ──→ client.lua
```

## 状态图例

- ✅ 已完成，测试通过
- 🔧 进行中（功能写完，端到端待验证）
- ⏳ 待做

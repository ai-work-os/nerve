# Nerve

进程管理器 + 消息路由器。管 AI agent 的生死和消息传递，不管对话内容。

## 快速理解

所有文档在项目根目录 `notes/` 下（`../notes/`）：

1. **../notes/ARCHITECTURE.md** — 设计理念（管什么、不管什么、核心概念）
2. **../notes/API.md** — 外部接口契约（WS JSON-RPC 2.0 + HTTP）
3. **../notes/ACP.md** — 内部协议（nerve ↔ agent 进程的 stdio JSON-RPC）
4. **../notes/INTERNALS.md** — 代码级调用链 + 文件结构
5. **../notes/ROADMAP.md** — 路线图、已完成功能、待做事项
6. **../notes/NEXT.md** — 当前任务进展和下一步

## 当前状态

**Phase 1 完成**：1v1 聊天已跑通。

- `:Nerve chat` 一步开聊（自动 spawn + 打开）
- 1v1 直连（不走频道），node.prompt + node.subscribe
- buffer replay 重连恢复历史
- 自动命名、cwd 分组、多 nvim 连接
- Ctrl+C 取消、阻塞模式
- 118 个测试

## 启动

```bash
cd ~/work/ai-work-os/nerve
npm install
npx tsx src/cli.ts serve    # 端口 4800
```

## 测试

```bash
npx tsx test/self-test.ts
```

## 工程要求

- **日志**：关键路径必须有日志，方便排查问题
- **单元测试**：新增/修改的模块必须有对应测试，方便后续迭代维护
- **测试框架**：`npx tsx test/self-test.ts`（现有 118 个测试）

## 关键设计决策

- nerve 透传 ACP session/update，不解析语义
- 1v1 不走频道，直连 node
- 内存 buffer 存实时输出（不持久化），重连时 replay
- session/cancel 是 ACP notification（不是 request）
- 客户端只是输入框 + 显示区，所有逻辑在 nerve 内部

## 相关目录

| 位置 | 说明 |
|------|------|
| `~/work/ai-work-os/nerve/` | nerve 服务端（本仓库） |
| `~/work/ai-work-os/nerve-tui/` | nerve TUI 客户端（Rust，主力） |
| `~/work/ai-work-os/notes/` | 项目文档（统一文档中心） |
| `~/.config/nvim/lua/nerve/` | nvim 客户端插件（降级备选） |

# Nerve

进程管理器 + 消息路由器。管 AI agent 的生死和消息传递，不管对话内容。

## 快速理解

1. **ARCHITECTURE.md** — 设计理念（管什么、不管什么、三个核心概念）
2. **API.md** — 外部接口契约（WS JSON-RPC 2.0 + HTTP）
3. **ACP.md** — 内部协议（nerve ↔ agent 进程的 stdio JSON-RPC）
4. **INTERNALS.md** — 代码级调用链（spawn、1v1、频道、agent 间通信的完整流程）
5. **STATUS.md** — 项目状态、已完成功能、启动方式

按 1→5 顺序读，读完就能理解全貌。

## 当前目标

**在 nvim 里跑通 1v1 聊天**：用户能和一个 AI agent 实时对话。

流程：`:Nerve spawn claude alice` → `:Nerve chat alice` → 用户打字回车 → agent 实时流式回复

这是最高优先级，其他功能（多 agent 协作、session 恢复等）先不管。

## 已完成

- nerve server 核心（spawn/stop、频道、@mention 路由、SQLite 持久化、51 个测试通过）
- nvim 客户端（`~/.config/nvim/lua/nerve/`）已从 HTTP 轮询重写为 WS 推送
- 1v1 代码链路已写完：通过私有频道 `dm:{agent_name}` + @mention 触发 prompt
- 代码级验证通过，**但还没有实际跑过端到端**

## 排查重点（如果 1v1 不通）

1. WS 连接：nvim `ws.lua` → nerve server 4800 端口
2. node.update detail 格式：claude-agent-acp 推的 session/update 是否被 `chat.lua _extract_text` 正确提取
3. channel.addNode：agent 是否真正加入了 dm 频道（查 `~/.nerve/bus.log`）

## 启动

```bash
cd ~/.ai/nerve
npm install
npx tsx src/cli.ts serve    # 端口 4800
```

## 测试

```bash
npx tsx test/self-test.ts   # 46 端到端测试
```

## 关键设计决策

- nerve 透传 ACP session/update，不解析语义
- 频道消息持久化（SQLite），对话历史不存（agent 是 truth source）
- 客户端只是输入框 + 显示区，所有逻辑在 nerve 内部
- nvim 是第一个客户端但不是唯一的，接口按通用设计

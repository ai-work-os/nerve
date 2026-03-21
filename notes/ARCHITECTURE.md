# Nerve 架构设计

2026-03-19 讨论定稿

## 核心定义

**nerve 管连接，不管内容。**

nerve 是进程管理器 + 消息路由器。管 agent 的生死，把消息送到该去的地方，把 agent 的输出推给该看到的人。不存对话内容，不理解对话语义。

## 三个核心概念

**Agent** = 函数 `f(prompt) → stream<update>`。有手有脑但没有耳朵。不知道外面有谁、不知道自己在哪个频道、不知道其他 agent 的存在。两次 prompt 之间是静止的。agent 的"说话"能力来自 skill（预置的 curl 命令调 nerve API），不来自 ACP 协议。

**频道** = nerve 内部的数据结构（成员列表 + 消息记录）。不是独立实体，不做任何事。所有动作（存消息、路由、推送）都是 nerve 做的。频道只定义一个消息共享的范围。频道消息需要持久化（SQLite），因为是多方共享的公共记录。

**Nerve** = 连接器。做三件事：进程管理（spawn/stop）、消息传递（prompt 下发 + update 透传）、频道路由（@mention 分发）。

## 两条数据路径

**直连（1v1）**：用户 → nerve → agent → nerve → 用户。nerve 不记录内容，只做管道。agent 不知道对面是谁。

**频道**：用户/agent → nerve → 存进频道 → 广播 + @mention 路由 → 目标 agent → 输出回频道 → 所有人看到。nerve 记录频道消息。

两条路径在 agent 端一模一样，都是 prompt → stream<update>。区别只在 nerve 层：消息从哪来、输出推给谁。

## Agent 间通信

agent 之间不直接通信，全部经过频道：

```
agent A 干完活 → 通过 skill 调 nerve HTTP API 发消息到频道
→ nerve 存进频道 → nerve 看到 @B → nerve 通过 ACP 推给 agent B
→ B 干完 → 同样通过 skill 回复到频道
```

## 对话历史

**nerve 不存对话内容，agent 是唯一 truth source。**

- ACP 协议支持 `session/load`：通过 session ID 让 agent 把完整历史通过 session/update 流式推回来
- ACP 协议支持 `session/list`：列出 agent 的所有历史 session
- claude-agent-acp 已完整实现这两个方法
- nerve 内存里有临时 buffer 存当前实时输出供客户端读取，不持久化
- 恢复历史时：nerve 调 session/load → agent 自己推历史 → nerve 透传给客户端
- 频道历史在 nerve 的 SQLite 里（频道是共享的，没有单一 agent 拥有完整记录）

## nerve 的职责边界

**管**：agent 进程 spawn/stop/状态、ACP 握手（initialize → auth → session/new 或 session/load）、prompt 下发 + 串行队列、session/update 透传、频道消息广播 + @mention 路由 + 持久化、session 元信息查询

**不管**：对话内容存储、对话历史恢复（让 agent 自己推）、agent 输出的语义解析、UI 渲染

## 显示层

nvim / web / 手机都是纯客户端，只做两件事：一个输入框、一个显示区。所有逻辑发生在 nerve 内部。

## 使用场景

### 场景 1：1v1 聊天

```
用户在 nvim 里打字
  → nvim 把文字发给 nerve
    → nerve 把文字塞进 agent 的输入
      → agent 开始干活，一边干一边推 update
    → nerve 收到 update，推给 nvim
用户实时看到 agent 在想什么、在做什么
```

### 场景 2：多 agent 协作

```
用户在频道面板打字："@alice 改后端 @bob 改前端"
  → nvim 把文字发给 nerve
    → nerve 存进频道记录
    → nerve 广播给频道所有人
    → nerve 发现 @alice 和 @bob
      → nerve 把消息塞进 alice 和 bob 的输入
      → 它们各自干活，输出推回频道
用户和其他人看到 alice 和 bob 各自在干什么
```

### 场景 3：agent 间通信

```
alice 干完后端
  → alice 通过 skill 调 nerve API 发消息到频道："@bob 后端改好了，接口变了，看一下"
    → nerve 存进频道 → 看到 @bob → 推给 bob
      → bob 收到，调整前端
      → bob 通过 skill 回复频道："前端也改好了"
```

### 场景 4：恢复对话

```
用户想看之前和 alice 聊了什么
  → nvim 告诉 nerve："用这个 session ID 恢复 alice"
    → nerve 调 session/load 告诉 alice："把之前的记录推回来"
      → alice 从自己的存储读出历史，逐条推回（格式和正常 update 一样）
    → nerve 透传给 nvim
用户看到之前的完整对话，可以接着聊
```

## 客户端对接

### nvim 端两套实现的历史

1. **lua/acp/**（旧路径，已停止推进）
   - nvim 直接 spawn agent 进程，自己做 ACP 握手、消息路由、频道管理
   - 4400+ 行，功能齐全但和 nvim 耦合太深
   - 问题：所有逻辑在 nvim 进程内，无法被其他客户端（web/mobile）复用

2. **lua/nerve/**（当前路径，持续推进）
   - nvim 作为 nerve server 的纯客户端
   - 通过 WS/HTTP 调 nerve API，自己只做 UI
   - 符合架构原则：所有逻辑在 nerve 内部，客户端只是输入框 + 显示区

### 对接原则

- nerve 定义标准 API（见 API.md），客户端按契约对接
- nvim 是第一个客户端，但不是唯一的
- 客户端不需要理解 ACP 协议，只需要 nerve 的 WS JSON-RPC

## 已完成的 gap（2026-03-19）

1. ~~node.update 事件没有透传~~ → bus.ts handleNodeEvent 中广播到频道所有 WS 客户端
2. ~~session/load、session/list~~ → AcpClient + NodePool + HTTP/WS 端点
3. ~~DM 表和相关端点~~ → 已删除（违反"nerve 不存对话内容"原则）
4. ~~nerve-dispatch skill~~ → bin/nerve-post 脚本 + spawn 时 PATH 注入
5. ~~spawn 时上下文注入~~ → addNodeToChannel 时生成 systemPrompt，首次 prompt 前置

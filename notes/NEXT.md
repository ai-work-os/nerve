# 接下来要做什么

最后更新：2026-03-19

## 当前阶段：Phase 2 — 单 chat 体验打磨

Phase 1（1v1 聊天跑通）已完成，用户已验证通过。详见 ROADMAP.md。

## 待做任务

优先级从高到低：

### 1. 流式渲染稳定
- 长回复（>50 行代码）是否正确显示
- 代码块、多行输出有没有错位
- 验证方式：让 agent 输出一段长代码，看渲染

### 2. agent 状态同步
- winbar 准确反映 connecting/busy/idle
- 当前 winbar 逻辑在 chat.lua `_update_winbar_status`

### 3. 多行输入
- Shift+Enter 换行，Enter 提交
- 输入框自动高度
- 当前输入框在 chat.lua `_setup_input`

### 遇到再做（不主动做）
- 错误恢复：agent 挂了显示提示，可重新 spawn
- 关闭/重开：`:Nerve chat` toggle 不丢上下文

## 已知问题

- agent 上下文满了后不响应但状态显示 idle，需要检测机制
- acp-bus-dispatch skill 缺少移除 agent 的命令

## 工作方式

- 用户是协调者，你自主决定方案和实现
- 改完代码自己跑测试：`npx tsx test/self-test.ts`
- nvim 客户端代码在 `~/.config/nvim/lua/nerve/`
- nerve 服务端代码在本仓库 `src/`

## 关键上下文

- 1v1 不走频道，直连 node（node.prompt + node.subscribe）
- 内存 buffer 存实时输出，重连时 replay
- session/cancel 是 notification 不是 request
- Ctrl+C 取消绑在 chat.lua `_cancel()`
- _busy 标志只由 _submit/on_done 控制，不受 statusChanged 影响

# Nerve Roadmap

基于 2026-03-19 1v1 聊天调试经验制定。原则：每阶段可端到端验证，先做好单 chat 再做协作。

---

## Phase 1: 1v1 聊天跑通 ✅

**已完成**：
- `:Nerve chat` 一步开聊（自动 spawn + 打开聊天）
- 1v1 去掉频道层，直接 node.prompt + node.subscribe
- 格式对齐 acp/chat.lua（## Assistant / ## You）
- buffer replay：重连后恢复历史（用户输入 + AI 输出）
- spawn cwd 默认 nvim 当前目录，支持手动指定
- 自动命名 {adapter}-{basename(cwd)}，同名追加序号
- 多 nvim 连接（nvim-{pid}）
- cwd 分组：`:Nerve list` 默认当前项目，`-all` 全部
- Ctrl+C 取消 agent 输出（session/cancel notification）
- 阻塞模式：agent 回复时拦截 Enter，可打字不可提交
- spawn 后等 agent 就绪再开 chat

---

## Phase 2: 单 chat 体验打磨

**待优化**（遇到再做）：
- [ ] 流式渲染稳定：长回复、代码块、多行输出正确显示
- [ ] agent 状态同步：winbar 准确反映 connecting/busy/idle
- [ ] 输入框体验：多行输入、自动高度、Shift+Enter 换行
- [ ] 错误恢复：agent 挂了显示提示，可重新 spawn
- [ ] 关闭/重开：`:Nerve chat test` toggle 不丢上下文

---

## Phase 3: Session 管理

**目标**：关闭 nvim 后重新打开能恢复对话

**功能清单**：
- [ ] session/list：列出 agent 的历史 session
- [ ] session/load：恢复指定 session，agent 推历史消息
- [ ] `:Nerve chat test` 自动恢复上次 session（如果 agent 还活着）
- [ ] nvim 端持久化 channel_id ↔ node_name 映射

**验证方式**：
1. 和 agent 对话几轮 → 关闭 chat 窗口 → 重新 `:Nerve chat test`
2. **预期**：看到之前的对话历史，agent 记得上下文

---

## Phase 4: 多 agent 频道协作

**目标**：多个 agent 在同一频道里协作

**功能清单**：
- [ ] 频道面板 UI（view.lua 已有基础）
- [ ] @mention 路由验证（router.ts 已实现，需端到端测试）
- [ ] scheduler 串行队列验证（避免并发 prompt）
- [ ] agent 间通信：@bob 消息通过 nerve-post 工具发送
- [ ] 用户在频道里 @agent 发任务、看回复

**验证方式**：
1. spawn 两个 agent（alice, bob）
2. 创建频道，两个 agent 加入
3. 发消息 "@alice 写后端 @bob 写前端"
4. **预期**：两个 agent 分别回复，互相可见

---

## Phase 5: 生产化

- [ ] nerve server 守护进程化（崩溃自动重启）
- [ ] agent 进程监控（OOM、超时保护）
- [ ] 日志分级（debug 日志不写 bus.log）
- [ ] nvim statusline 集成（显示连接状态、活跃 agent 数）

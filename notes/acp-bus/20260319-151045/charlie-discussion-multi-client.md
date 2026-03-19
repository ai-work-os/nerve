# 发散讨论：nerve 多客户端/多 agent 问题

## 用户提出的 4 个问题 + 分析

### 1. 多个 nvim 实例连接冲突

**现状**：server.ts 支持多 WS 连接，但 `node.register` 时 name 必须唯一。两个 nvim 都注册 `name: "nvim"` 会被拒绝。

**方案**：
- **A. 自动编号**：第二个 nvim 自动注册为 `nvim-2`、`nvim-3`。简单，但 agent 不知道该回复哪个 nvim。
- **B. 实例 ID**：用 `nvim-{pid}` 或 `nvim-{servername}` 作为注册名。唯一性天然保证。
- **C. 会话绑定**：每个 nvim 连接时带 session token，nerve 据此恢复上次状态（频道、agent 关联）。

**建议**：短期用 B（`nvim-{pid}`），长期考虑 C。

**Phase**：**1v1 前提**。多窗口编辑是常见场景。

### 2. 多 agent 管理和区分

**现状**：agent 按 name 区分（`alice`、`bob`），name 全局唯一。无项目/用途维度。

**方案**：
- **A. 命名约定**：`project-role` 格式，如 `nerve-reviewer`、`web-coder`。靠用户自觉。
- **B. 标签/元数据**：spawn 时附 `tags: ["project:nerve", "role:reviewer"]`，list 时可按 tag 过滤。
- **C. 工作区隔离**：每个项目目录一个 nerve 实例（多端口），彼此完全隔离。

**建议**：当前单实例够用，先用 A。需要时加 B（改动小：node 加个 tags 字段）。C 太重。

**Phase**：**多 agent 阶段**。1v1 只有一个 agent，不存在管理问题。

### 3. agent 之间的隔离

**现状**：
- 频道隔离 ✅：不同频道的消息互不可见
- 文件系统隔离 ❌：所有 agent 共享 cwd，可能互相覆盖文件
- prompt 隔离 ✅：每个 agent 独立 session
- update buffer 隔离 ✅：每个 node 独立 buffer

**方案**：
- **A. cwd 隔离**：spawn 时指定不同 cwd。已支持（刚加的功能）。
- **B. git worktree**：每个 agent spawn 时自动创建 worktree，停止时清理。完美隔离但重。
- **C. 权限层级**：nerve 已有 permission level（member/operator），可用于限制 agent 的操作范围。

**建议**：A 已就绪。B 是最终方案但需要额外基础设施。

**Phase**：**多 agent 前提**。1v1 不需要隔离。

### 4. agent 名字重复

**现状**：`isNameTaken` 严格拒绝重名，返回错误。

**方案**：
- **A. 保持严格**（当前）：用户换个名字。最简单。
- **B. 自动后缀**：`alice` 被占 → 自动变 `alice-2`。方便但可能混淆。
- **C. 替换模式**：`--replace` 标志，stop 旧的再 spawn 新的。适合重启场景。

**建议**：A 够用。C 作为快捷方式后续加。

**Phase**：**1v1 阶段就需要**。用户重启 nvim 后 agent 还在运行，再 spawn 同名会冲突。

---

## 用户没提但会遇到的问题

### 5. nvim 断开后 agent 还在跑

**场景**：nvim crash 或 `:q!`，WS 断开，agent 进程还在。重连后怎么恢复？

**现状**：WS close 时 server 会把 nvim 节点从频道移除，但 agent 进程不停。

**方案**：重连后 `node.list` 能看到还活着的 agent，`channel.join` + replay buffer 能恢复上下文。但 chat.lua 的 `_do_open` 每次都创建新频道，不会复用旧的。

**建议**：chat.lua 在 `_setup_channel` 时先查是否已有 `dm:{name}` 频道，有则 join 而非 create。

**Phase**：**1v1 关键**。这是最常见的"断了怎么办"场景。

### 6. agent 卡死/无响应

**场景**：prompt 发出去，agent 不回。5 分钟 timeout 太长。

**方案**：
- winbar 显示 elapsed time
- 用户可 `<C-c>` 取消（但当前 nerve chat 没实现 cancel）
- 超时后自动标记 error 状态

**Phase**：**1v1 体验优化**。

### 7. buffer 无限增长

**场景**：长对话后 nvim buffer 有几千行，渲染变慢。

**方案**：虚拟滚动或分页，只渲染可见区域。或者到一定行数后截断旧消息。

**Phase**：**1v1 体验优化**，不紧急。

### 8. 多 agent 同时输出到同一频道

**场景**：两个 agent 在同一频道，同时流式输出，消息交叉。

**方案**：每个 agent 的流式输出独立追踪（chat.lua 当前只追踪一个 `_streaming` 状态）。

**Phase**：**多 agent 阶段**。

---

## Phase 归属总结

| 问题 | Phase | 紧急度 |
|------|-------|--------|
| 多 nvim 连接（#1） | 1v1 前提 | 高 |
| 名字重复（#4） | 1v1 前提 | 高 |
| 断线恢复（#5） | 1v1 关键 | 高 |
| agent 管理（#2） | 多 agent | 低 |
| agent 隔离（#3） | 多 agent | 中 |
| 卡死处理（#6） | 1v1 优化 | 中 |
| buffer 增长（#7） | 1v1 优化 | 低 |
| 多 agent 输出（#8） | 多 agent | 中 |

**结论**：#1（多 nvim）、#4（重名）、#5（断线恢复）是 1v1 正常使用的前提，建议优先解决。其中 #5 最关键——用户一定会遇到 nvim 重启的情况。

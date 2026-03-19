结论：暂不建议合，仍有 2 个阻塞问题。

1. 渲染没有完全对齐 `acp/chat.lua`
- 主消息块样式已经对齐到 `## Assistant` / `## You`，时间戳和 `---` 分隔线也去掉了。
- 但 tool 行还没对齐。[nerve/chat.lua#L237](/Users/renjinxi/.config/nvim/lua/nerve/chat.lua#L237) 仍写成 `tool: xxx`，而 [acp/chat.lua#L388](/Users/renjinxi/.config/nvim/lua/acp/chat.lua#L388) 是 `🔧 xxx`。
- 这项只是样式差异，不是阻塞。

2. reopen 后 chat 会失活
- [nerve/chat.lua#L48](/Users/renjinxi/.config/nvim/lua/nerve/chat.lua#L48) 在已有 buffer 时只调用 `_create_windows()` 后返回。
- 但 [nerve/chat.lua#L468](/Users/renjinxi/.config/nvim/lua/nerve/chat.lua#L468) 的 `hide()` 已经执行 `_unsubscribe()` 并 `channel.close`。
- 结果是第一次打开正常，`q` 关闭后再打开，不会重新订阅 `node.update` / `channel.message`，也不会重建 1v1 channel。

3. 流式区域更新会覆盖尾部内容
- [nerve/chat.lua#L267](/Users/renjinxi/.config/nvim/lua/nerve/chat.lua#L267) 每个 chunk 都用 `nvim_buf_set_lines(self.buf, start, old_end, ...)`，把从流起点到 buffer 末尾整段替换掉。
- 这和 [acp/chat.lua#L405](/Users/renjinxi/.config/nvim/lua/acp/chat.lua#L405) 不同；ACP 只改最后一行再追加新行。
- 如果流式过程中插入了 `_append_system()` 的 tool 状态或其他尾部内容，后续 chunk 会把这些内容吞掉。

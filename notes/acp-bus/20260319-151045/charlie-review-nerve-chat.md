# Review: nerve/chat.lua 重写（轮询→WS推送）

## 改动摘要

从 HTTP 轮询架构完整迁移到 WS 推送：
- 删除 `_start_poll`/`_stop_poll`/`_load_history`/`_refresh_winbar`（同步）/`_refresh_winbar_with`
- 新增 `_subscribe`/`_unsubscribe`（WS 事件监听）
- 新增 `_handle_update`/`_get_text`（ACP session/update 解析）
- 新增 `_start_stream_block`/`_append_stream`/`_end_stream`（流式输出）
- 新增 `_setup_channel`（1v1 DM 频道创建）
- 渲染格式对齐 acp/chat.lua：`## Assistant` / `## You`，去掉时间戳和 `---` 分隔线

## 与 acp/chat.lua 对比

| 项目 | acp/chat.lua | nerve/chat.lua（改后） | 一致？ |
|------|-------------|----------------------|--------|
| 用户消息 | `## You` | `## You`（via `_render_message`） | ✅ |
| AI 消息 | `## Assistant` | `## Assistant`（via `_start_stream_block`） | ✅ |
| 系统消息 | `*斜体*` | `*斜体*` | ✅ |
| 分隔线 | 无 | 无（已删除 `---`） | ✅ |
| 时间戳 | 无 | 无（已删除） | ✅ |
| 流式追加 | 拼接 last_line | `_stream_lines` 整块替换 | 实现不同，效果等价 |

## 发现的问题

### 1. 死代码：未使用的 `end_line` 变量（轻微）
`_append_stream` 第 286 行：
```lua
local end_line = start + math.max(1, #self._stream_lines)
```
计算后从未使用，应删除。

### 2. 无其他 bug

- `_render_message` 的 `from` 字段优先级逻辑正确（Lua `or`/`and` 短路求值）
- `_end_stream` 在 `_render_message` 和 `_update_winbar_status(idle)` 两处调用，防止状态泄漏 ✓
- `_subscribe`/`_unsubscribe` 配对，`hide()` 时清理频道 ✓
- `_start_stream_block` 的 `count > 2` 空行判断与 acp 一致 ✓

## 结论

**LGTM**，格式已完全对齐 acp/chat.lua。唯一建议删除 `end_line` 死代码。

# M1 当前状态（2026-03-21 16:00）

## 进度

Step 1-5 代码已完成，review 已通过，mcpServers 格式 bug 已修复。**等待端到端验证。**

### 已完成
- [x] Step 1: nerve-mcp.ts（MCP server，暴露 nerve_post）
- [x] Step 2: acp-client.ts（mcpServers 注入 + agentCapabilities bug fix）
- [x] Step 3: node-pool.ts（MCP 配置构造）
- [x] Step 4: bus.ts（去 scheduler + dispatchDirect cancel+prompt）
- [x] Step 5: view.lua（流式渲染 + 状态清理）
- [x] Step 1-4 review 通过（两轮）
- [x] Step 5 review 通过（两轮）
- [x] mcpServers env 格式修复（`Record<string,string>` → `[{name,value}]`）
- [x] 139 测试通过
- [ ] **端到端验证**

### 阻断问题
无。格式问题已修复，理论上可以验证了。

## 端到端验证方法

重启 nerve 后在 nvim 里：

```vim
" 打开频道视图（频道自动创建）
:Nerve bus

" 在视图内用斜杠命令
/spawn claude alice
/spawn claude bob
/join alice
/join bob

" 然后在视图里直接输入消息
@alice 用 ls 看一下当前目录有什么文件，完成后用 nerve_post 工具把结果告诉 bob
```

预期：alice 调用 nerve_post 把结果发给 bob，bob 收到并回复。频道视图里能看到完整对话。

## 改了什么文件

### server 侧（~/work/ai-work-os/nerve/）
| 文件 | 改动 |
|------|------|
| `src/nerve-mcp.ts` | 新增，stdio MCP server，暴露 nerve_post 工具 |
| `src/acp-client.ts` | mcpServers 注入 session/new，env 改为 [{name,value}] 数组 |
| `src/node-pool.ts` | spawn 时构造 MCP 配置，注入 nerve-mcp |
| `src/bus.ts` | 去 scheduler，加 dispatchDirect（busy 时 cancel+prompt），postFromProcess 报错语义 |
| `test/self-test.ts` | 新增 ~21 个测试（mcpServers 注入、nerve_post、cancel+prompt、env 格式） |
| `notes/ACP.md` | 补充 mcpServers schema 文档 |
| `package.json` | 加 @modelcontextprotocol/sdk 依赖 |

### nvim 客户端侧（~/.config/nvim/lua/nerve/）
| 文件 | 改动 |
|------|------|
| `view.lua` | node.update 流式渲染 + _handle_stream + _end_stream 清理 |

## 新会话如何接续

告诉新的 Claude：

```
读 notes/STATUS.md 和 notes/NEXT.md，了解当前 M1 进度。
```

### 如果需要频道调度（多 agent 协作）

```bash
SOCK="$NVIM_LISTEN_ADDRESS"

# 开频道 + 加 agent
nvim --server "$SOCK" --remote-expr 'luaeval("require(\"acp.rpc\").bus_open(_A)", "{\"agent_name\":\"acp-claude\"}")'
nvim --server "$SOCK" --remote-expr 'luaeval("require(\"acp.rpc\").bus_open(_A)", "{\"adapter\":\"codex\",\"agent_name\":\"acp-codex\"}")'

# 发任务
nvim --server "$SOCK" --remote-expr "luaeval(\"require('acp.rpc').bus_send({agent_name='acp-claude',text=_A})\", '你的任务，完成后回复 main')"

# 查状态
nvim --server "$SOCK" --remote-expr 'luaeval("require(\"acp.rpc\").bus_agents()")'

# 读消息
nvim --server "$SOCK" --remote-expr 'luaeval("require(\"acp.rpc\").bus_read({last_n=5})")'
```

## 关键文件索引

| 文件 | 用途 |
|------|------|
| `notes/NEXT.md` | 里程碑路线、M1/M2/M3 规划 |
| `notes/channel-plan.md` | M1 五步实施方案 |
| `notes/BACKLOG.md` | 细节问题暂存（不要现在看） |
| `notes/ARCHITECTURE.md` | 架构设计理念 |
| `notes/API.md` | WS JSON-RPC + HTTP 接口 |
| `notes/ACP.md` | 内部协议（含 mcpServers schema） |
| `notes/INTERNALS.md` | 代码级调用链 |

## 协作规则

- 用户是协调者/PM，不看代码细节，通过 AI 汇报把控节奏
- 用户容易陷入细节 → 非 M1 主线的问题回答"BACKLOG，不是现在"
- 日志和单元测试是硬要求
- spawn ≠ join：spawn 只创建进程（可 1v1），join 是显式加入频道
- 测试命令：`npx tsx test/self-test.ts`

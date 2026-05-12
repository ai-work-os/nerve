# 重构完成报告 (2026-05-12 → 2026-05-13)

## 全部完成项

- [x] **src/ 分层**（10 子目录：`infra/ storage/ transport/ channel/ node/ scene/ agent/ mcp/ integration/ plugins/`）
- [x] **plugins/ 大文件拆分**：`duty-monitor` (682 行 → 5 文件最大 274) / `ai-ear` (452 行 → 5 文件最大 262)
- [x] **测试目录统一**：`test/{unit,integration,e2e,legacy,legacy/standalone,helpers,fixtures}/`
- [x] **Logger 扩展**：
  - `child({ module, ...ctx })` 派生子 logger
  - `lifecycle / stateChange / boundary` 标准事件 API
  - `newCorrelationId()` 8 字符短 ID
  - `NERVE_DEBUG=<module>,<glob>*` per-module DEBUG 开关
  - 旧 `info/warn/error/debug` API 完全兼容
- [x] **核心模块切到 child logger**：
  - `server.ts` (module=`server`)
  - `node-pool.ts` (module=`node-pool`)
  - `channel-manager.ts` (module=`channel-manager`)
  - `http-router.ts` (module=`transport:http`, 入口注入 correlationId)
  - `transport.ts` (WS 入口 boundary + correlationId)
  - `acp-client.ts` (module=`agent:acp`, in/out boundary)
- [x] **架构文档**：`docs/architecture.md` 记录新分层

## 重构途中遇到的 bug 与修复

1. **`src/node/node-pool.ts` 路径计算 bug**（Task 13 引入，同任务内修复）

   `import.meta.url` 计算项目根的 `dirname()` 次数没跟着文件深度调整，导致：
   - program node spawn cwd 错算为 `src/`（应为项目根）→ adapter "src/plugins/X/index.ts" 解析失败 → plugin 立即 exit 1
   - nerve-mcp 脚本 lookup 找不到（Task 14 后又再调一次跳到 `src/mcp/`）
   - PATH bin 注入路径同样错位

   commit `7b9815a` 修复（程序节点 spawn cwd），Task 14 顺带修了 mcp 路径。

   **教训**：以后任何模块用 `dirname(fileURLToPath(import.meta.url))` 推算路径的，移动文件时必须连同 `dirname()` 次数一起改。已在 `docs/architecture.md` 中加了路径计算注意事项一节。

## 测试结果（终态）

| 套件 | 结果 | 基线 |
|------|------|------|
| `npm run test:unit` | **82 passed** (10→11 文件, +3 logger tests, +3 correlation-id tests) | 79 |
| `npm run test:integration` | **144 passed + 1 pre-existing failed** | 144 + 1 |
| `npm run test:e2e` | **1 passed** | 1 |
| `npm run test:legacy` | **620 passed + 5 pre-existing failed** | 620 + 5 |
| `npx tsc --noEmit` | **0 errors** | 0 |

**5 个 pre-existing legacy 失败**（与重构无关，重构前后保持一致）：
- mcp-inject: mock-agent received mcpServers
- log-time: timestamp format valid
- node.log: snapshot is empty
- integ-cleanup: buffer seeded before stop
- model-info: server logged usage_update or context size change

**1 个 pre-existing integration 失败**：
- Integration: Model info in node.list

## NERVE_DEBUG 手动验证

```bash
NERVE_DEBUG=node-pool npx tsx -e '...' 
# DEBUG for node-pool: 显示
# DEBUG for other 模块: 隐藏 ✓
```

## 已知未做（留作下次）

- **核心大模块内部拆分**：`node-pool.ts (855)` / `channel-manager.ts (704)` / `server.ts (710)` / `nerve-mcp.ts (627)` 还是单文件大块，保留下次再切。
- **更多模块切 child logger**：本次只切了 6 个最重要模块。其余文件保留旧 `log.info(...)` 调用，可随后续改动逐步迁移。
- **correlationId 全链路串接**：本次只在 HTTP/WS/ACP boundary 引入。要真正做到一次请求所有日志同一个 cid，需要把 reqLog 沿调用链传下去 — 暴露面太大，留作后续。
- **Android lifelog 通道是否统一**：未决，独立话题。
- **ai/ 骨架补齐**：按用户指示暂缓。

## 提交序列

baseline 之后 18 个 commit，可在 `git log --oneline cff94b3..HEAD` 看到完整序列。

每个 task 一个独立 commit，tsc + 全测试都跑过基线才入。

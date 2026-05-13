#!/usr/bin/env npx tsx
/**
 * Command feedback mechanism — unit tests (TDD red phase)
 *
 * Tests the return value processing logic for dispatchCommand.
 *
 * ▸ Coder 需要做的：
 *   1. 在 nerve/src/command-feedback.ts 中导出纯函数：
 *      - formatCommandResponse(result: CommandResult, from?: string): string[]
 *        将 onCommand 返回值转换为要发到频道的消息列表（0~2 条）
 *      - formatHelpText(commands: Record<string, CommandDef>, from?: string): string[]
 *        将 help 命令转为频道消息
 *      - formatUnknownCommand(cmd: string, available: string[], from?: string): string[]
 *        将未知命令转为频道错误消息
 *      - formatReportError(to: string | undefined, message: string): string | undefined
 *        reportError 的消息格式化
 *   2. 在 plugin-base.ts 的 dispatchCommand 中调用这些纯函数
 *
 * 测试导入路径：../../src/command-feedback.ts
 */

// --- Test infrastructure ---

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, name: string, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    const msg = detail ? `${name}: ${detail}` : name;
    failures.push(msg);
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

function assertEq(actual: unknown, expected: unknown, name: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, name, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- Import under test ---
// 模块尚不存在，coder 需要创建 nerve/src/command-feedback.ts

type CommandResult = { error?: string; reply?: string } | string | void;

interface CommandDef {
  description: string;
  args?: Record<string, string>;
}

let formatCommandResponse: (result: CommandResult, from?: string) => string[];
let formatHelpText: (commands: Record<string, CommandDef>, from?: string) => string[];
let formatUnknownCommand: (cmd: string, available: string[], from?: string) => string[];
let formatReportError: (to: string | undefined, message: string) => string | undefined;

try {
  const mod = await import("../../../src/infra/command-feedback.js");
  formatCommandResponse = mod.formatCommandResponse;
  formatHelpText = mod.formatHelpText;
  formatUnknownCommand = mod.formatUnknownCommand;
  formatReportError = mod.formatReportError;
} catch {
  console.log("⚠ Cannot import command-feedback.ts — module not yet created");
  console.log("  All tests will fail (expected in TDD red phase)\n");
  formatCommandResponse = () => { throw new Error("formatCommandResponse not implemented"); };
  formatHelpText = () => { throw new Error("formatHelpText not implemented"); };
  formatUnknownCommand = () => { throw new Error("formatUnknownCommand not implemented"); };
  formatReportError = () => { throw new Error("formatReportError not implemented"); };
}

// --- Fixtures ---

const testCommands: Record<string, CommandDef> = {
  start: { description: "Start recording", args: { source: "audio source" } },
  stop: { description: "Stop recording" },
  status: { description: "Show current status" },
};

// --- Tests ---

function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  Command Feedback Tests (TDD Red Phase)");
  console.log("═══════════════════════════════════════════");

  // ── Case 1: onCommand 返回 void → 不产生频道回复 ──
  console.log("\n▸ Case 1: void result → no channel messages");
  try {
    const msgs = formatCommandResponse(undefined, "alice");
    assertEq(msgs, [], "void → empty array");
    const msgs2 = formatCommandResponse(undefined, undefined);
    assertEq(msgs2, [], "void + no from → empty array");
  } catch (e) {
    assert(false, "void result", String(e));
  }

  // ── Case 2: onCommand 返回 string → @mention [error] 回复 ──
  console.log("\n▸ Case 2: string result → @mention [error] reply");
  try {
    const msgs = formatCommandResponse("some error", "alice");
    assertEq(msgs.length, 1, "one message");
    assertEq(msgs[0], "@alice [error] some error", "format: @from [error] msg");
  } catch (e) {
    assert(false, "string result", String(e));
  }

  // ── Case 3: onCommand 返回 { error: "msg" } → @mention [error] 回复 ──
  console.log("\n▸ Case 3: { error } → @mention [error] reply");
  try {
    const msgs = formatCommandResponse({ error: "disk full" }, "bob");
    assertEq(msgs.length, 1, "one message");
    assertEq(msgs[0], "@bob [error] disk full", "format: @from [error] msg");
  } catch (e) {
    assert(false, "{ error } result", String(e));
  }

  // ── Case 4: onCommand 返回 { reply: "data" } → @mention 回复（无 [error]）──
  console.log("\n▸ Case 4: { reply } → @mention reply (no [error] prefix)");
  try {
    const msgs = formatCommandResponse({ reply: "status: ok" }, "carol");
    assertEq(msgs.length, 1, "one message");
    assertEq(msgs[0], "@carol status: ok", "format: @from reply (no [error])");
    // 确认没有 [error] 前缀
    assert(!msgs[0].includes("[error]"), "no [error] in reply message");
  } catch (e) {
    assert(false, "{ reply } result", String(e));
  }

  // ── Case 5: onCommand 返回 { error + reply } → 两条回复 ──
  console.log("\n▸ Case 5: { error, reply } → two messages");
  try {
    const msgs = formatCommandResponse({ error: "partial fail", reply: "data so far" }, "dave");
    assertEq(msgs.length, 2, "two messages");
    assertEq(msgs[0], "@dave [error] partial fail", "first: error message");
    assertEq(msgs[1], "@dave data so far", "second: reply message");
  } catch (e) {
    assert(false, "{ error, reply } result", String(e));
  }

  // ── Case 6: 未知命令 → @mention [error] unknown command ──
  console.log("\n▸ Case 6: unknown command → @mention [error] unknown command");
  try {
    const msgs = formatUnknownCommand("foo", ["start", "stop", "status"], "eve");
    assertEq(msgs.length, 1, "one message");
    assert(msgs[0].startsWith("@eve [error]"), "starts with @mention [error]");
    assert(msgs[0].includes("foo"), "includes the unknown command name");
    assert(msgs[0].includes("start"), "includes available commands");
  } catch (e) {
    assert(false, "unknown command", String(e));
  }

  // ── Case 7: help 命令 → 频道回复（列出所有命令）──
  console.log("\n▸ Case 7: help → channel reply listing all commands");
  try {
    const msgs = formatHelpText(testCommands, "frank");
    assertEq(msgs.length, 1, "one message");
    assert(msgs[0].startsWith("@frank"), "starts with @mention");
    assert(msgs[0].includes("start"), "includes 'start' command");
    assert(msgs[0].includes("stop"), "includes 'stop' command");
    assert(msgs[0].includes("status"), "includes 'status' command");
    assert(msgs[0].includes("help"), "includes 'help' itself");
    assert(msgs[0].includes("Start recording"), "includes command description");
  } catch (e) {
    assert(false, "help command", String(e));
  }

  // ── Case 8: from 为 undefined → 不回复频道 ──
  console.log("\n▸ Case 8: from undefined → no channel messages");
  try {
    // string error but no from → can't @mention → empty
    const msgs1 = formatCommandResponse("error msg", undefined);
    assertEq(msgs1, [], "string error + no from → empty");
    // { error } but no from → empty
    const msgs2 = formatCommandResponse({ error: "fail" }, undefined);
    assertEq(msgs2, [], "{ error } + no from → empty");
    // { reply } but no from → empty
    const msgs3 = formatCommandResponse({ reply: "data" }, undefined);
    assertEq(msgs3, [], "{ reply } + no from → empty");
    // unknown command but no from → empty
    const msgs4 = formatUnknownCommand("foo", ["start"], undefined);
    assertEq(msgs4, [], "unknown cmd + no from → empty");
    // help but no from → empty
    const msgs5 = formatHelpText(testCommands, undefined);
    assertEq(msgs5, [], "help + no from → empty");
  } catch (e) {
    assert(false, "from undefined", String(e));
  }

  // ── Case 9: channelId 为 undefined → dispatchCommand 不调用 postToChannel ──
  // 注：这个 case 测的是 dispatchCommand 的行为，不是纯函数
  // formatCommandResponse 本身不关心 channelId，由调用方（dispatchCommand）决定是否发送
  // 这里验证 formatCommandResponse 仍然生成消息（调用方决定是否发送）
  console.log("\n▸ Case 9: formatCommandResponse still generates messages (caller decides to send)");
  try {
    // 即使 channelId 可能为 undefined，formatCommandResponse 的职责是格式化消息
    // dispatchCommand 负责检查 channelId 再决定是否发送
    const msgs = formatCommandResponse("error", "alice");
    assertEq(msgs.length, 1, "still generates message regardless of channelId");
  } catch (e) {
    assert(false, "channelId irrelevant to format", String(e));
  }

  // ── Case 10: reportError → @mention [error] + 消息 ──
  console.log("\n▸ Case 10: reportError → @mention [error] message");
  try {
    const msg = formatReportError("grace", "connection lost");
    assertEq(msg, "@grace [error] connection lost", "format: @to [error] msg");

    // to 为 undefined → 不生成消息
    const msg2 = formatReportError(undefined, "connection lost");
    assertEq(msg2, undefined, "to undefined → undefined (no message)");
  } catch (e) {
    assert(false, "reportError", String(e));
  }

  // ── Edge cases ──
  console.log("\n▸ Edge: empty string error");
  try {
    // 空字符串是 falsy，应视为无错误（和 void 一样）
    const msgs = formatCommandResponse("", "alice");
    assertEq(msgs, [], "empty string → no messages (treated as void)");
  } catch (e) {
    assert(false, "empty string error", String(e));
  }

  console.log("\n▸ Edge: { error: '', reply: '' } → no messages");
  try {
    const msgs = formatCommandResponse({ error: "", reply: "" }, "alice");
    assertEq(msgs, [], "empty error + empty reply → no messages");
  } catch (e) {
    assert(false, "empty error + reply", String(e));
  }

  console.log("\n▸ Edge: help with empty commands");
  try {
    const msgs = formatHelpText({}, "alice");
    assertEq(msgs.length, 1, "still generates help message");
    assert(msgs[0].includes("help"), "includes help command even with empty commands");
  } catch (e) {
    assert(false, "help empty commands", String(e));
  }

  // Summary
  console.log("\n══════════════════════════════════════════");
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const f of failures) console.log(`    ✗ ${f}`);
  }
  console.log("══════════════════════════════════════════\n");
  process.exit(failed > 0 ? 1 : 0);
}

main();

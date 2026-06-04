import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildMorningBrief, localDate, previousLocalDate } from "../../src/morning-brief/generator.js";

describe("morning brief generator", () => {
  it("builds the three fixed morning sections from yesterday sources", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "nerve-brief-"));
    const dataDir = resolve(root, ".nerve");
    const homeDir = resolve(root, "home");
    const yesterday = "2026-05-25";
    const today = "2026-05-26";

    mkdirSync(resolve(dataDir, "plugins/ai-life-log/log"), { recursive: true });
    mkdirSync(resolve(dataDir, "plugins/observer/events"), { recursive: true });
    mkdirSync(resolve(homeDir, ".ai/ops/reports"), { recursive: true });

    writeFileSync(
      resolve(dataDir, `plugins/ai-life-log/log/${yesterday}.txt`),
      [
        "[09:10:00][phone] 讨论 ERP 订单同步异常",
        "[14:30:00][phone] 继续推进 morning brief push",
      ].join("\n"),
    );
    writeFileSync(
      resolve(dataDir, `plugins/observer/events/${yesterday}.jsonl`),
      [
        JSON.stringify({ ts: "2026-05-25T10:00:00.000Z", type: "channel.message", chName: "duty", from: "duty-agent", content: "ERP 清理完成，输出 /tmp/erp.md" }),
        JSON.stringify({ ts: "2026-05-25T11:00:00.000Z", type: "node.statusChanged", node: "codex", status: "busy" }),
      ].join("\n"),
    );
    writeFileSync(
      resolve(homeDir, `.ai/ops/reports/${yesterday}-duty-run.md`),
      [
        "# duty",
        "- 08:30 **erp-worktree-cleanup** — `ok` — ERP worktree 已清理 — /tmp/a.md",
        "- 22:00 **conversation-archive** — `failed:empty` — 没有新会话 — /tmp/b.md",
      ].join("\n"),
    );

    const brief = await buildMorningBrief({
      dataDir,
      homeDir,
      now: new Date("2026-05-26T08:30:00+08:00"),
    });

    expect(brief.date).toBe(today);
    expect(brief.sourceDate).toBe(yesterday);
    expect(brief.sections.map((section) => section.title)).toEqual([
      "昨天我做了什么",
      "昨天团队 / ERP / 系统发生了什么",
      "今天建议优先做什么",
      "数据源状态",
    ]);
    expect(brief.notificationTitle).toBe("早报已准备好");
    expect(brief.notificationBody).toContain("ERP");
    expect(brief.markdown).toContain("morning brief push");
    expect(brief.markdown).toContain("ERP workspace 已清理");
    expect(brief.sources.some((source) => source.kind === "life-log")).toBe(true);
    expect(brief.sources.some((source) => source.kind === "duty-report")).toBe(true);
    expect(brief.sources.some((source) => source.kind === "observer")).toBe(true);
  });

  it("uses local calendar dates for morning source selection", () => {
    const now = new Date(2026, 4, 1, 8, 30, 0);
    expect(localDate(now)).toBe("2026-05-01");
    expect(previousLocalDate(now)).toBe("2026-04-30");
  });

  it("keeps mobile summary free of task markup and absolute paths", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "nerve-brief-clean-"));
    const dataDir = resolve(root, ".nerve");
    const homeDir = resolve(root, "home");
    const yesterday = "2026-05-25";

    mkdirSync(resolve(homeDir, ".ai/ops/reports"), { recursive: true });
    writeFileSync(
      resolve(homeDir, `.ai/ops/reports/${yesterday}-duty-run.md`),
      [
        "# duty",
        "- 23:35 **conversation-archive** — `ok` — home: 34 条 — /home/renjinxi/.ai/workspace/activity/conversations/other/2026-05-25-home.md",
        "- 08:30 **erp-worktree-cleanup** — `ok` — ERP workspace 已清理 — /tmp/a.md",
      ].join("\n"),
    );

    const brief = await buildMorningBrief({
      dataDir,
      homeDir,
      now: new Date("2026-05-26T08:30:00+08:00"),
      workRoots: [],
    });

    const visibleText = [brief.notificationBody, ...brief.sections.flatMap((section) => section.items)].join("\n");
    expect(brief.notificationBody.length).toBeLessThanOrEqual(96);
    expect(visibleText).not.toMatch(/\*\*|`/);
    expect(visibleText).not.toMatch(/\/home\/renjinxi|\/tmp\//);
    expect(visibleText).not.toContain("conversation-archive");
    expect(visibleText).toContain("会话归档");
    expect(visibleText).toContain("ERP workspace 已清理");
  });

  it("uses daily digest facts and exposes source diagnostics as a section", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "nerve-brief-digest-"));
    const dataDir = resolve(root, ".nerve");
    const homeDir = resolve(root, "home");
    const yesterday = "2026-06-03";
    const today = "2026-06-04";

    mkdirSync(resolve(homeDir, ".ai/timeline/digest"), { recursive: true });
    mkdirSync(resolve(homeDir, ".ai/ops/reports"), { recursive: true });
    writeFileSync(
      resolve(homeDir, `.ai/timeline/digest/${today}.md`),
      [
        "# 一站式早报",
        "## 昨天我做了什么",
        "- 收口 Android 文件上传，并完成 0.8.17 发版验证。",
        "## 团队 / ERP / 系统",
        "- ERP 分诊台 prompt 真身完成调整，后续要继续观察订单链路。",
        "## 今天建议",
        "- 先修复早报数据完整性和诊断输出。",
      ].join("\n"),
    );
    writeFileSync(
      resolve(homeDir, `.ai/ops/reports/${yesterday}-duty-run.md`),
      [
        "# duty",
        "- 07:45 **daily-digest** — `ok` — 生成一站式早报 — /tmp/digest.md",
      ].join("\n"),
    );

    const brief = await buildMorningBrief({
      dataDir,
      homeDir,
      now: new Date("2026-06-04T08:30:00+08:00"),
      workRoots: [],
    });

    expect(brief.sources).toContainEqual(
      expect.objectContaining({ kind: "daily-digest", available: true, count: 3 }),
    );
    expect(brief.sections.find((section) => section.title === "昨天我做了什么")?.items.join("\n")).toContain("Android 文件上传");
    expect(brief.sections.find((section) => section.title === "昨天团队 / ERP / 系统发生了什么")?.items.join("\n")).toContain("ERP 分诊台");
    expect(brief.sections.find((section) => section.title === "今天建议优先做什么")?.items.join("\n")).toContain("早报数据完整性");
    expect(brief.sections.find((section) => section.title === "数据源状态")?.items.join("\n")).toContain("daily-digest ok");
    expect(brief.markdown).toContain("daily-digest");
  });
});

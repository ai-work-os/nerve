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
    ]);
    expect(brief.notificationTitle).toBe("早报已准备好");
    expect(brief.notificationBody).toContain("ERP");
    expect(brief.markdown).toContain("morning brief push");
    expect(brief.markdown).toContain("erp-worktree-cleanup");
    expect(brief.sources.some((source) => source.kind === "life-log")).toBe(true);
    expect(brief.sources.some((source) => source.kind === "duty-report")).toBe(true);
    expect(brief.sources.some((source) => source.kind === "observer")).toBe(true);
  });

  it("uses local calendar dates for morning source selection", () => {
    const now = new Date(2026, 4, 1, 8, 30, 0);
    expect(localDate(now)).toBe("2026-05-01");
    expect(previousLocalDate(now)).toBe("2026-04-30");
  });
});

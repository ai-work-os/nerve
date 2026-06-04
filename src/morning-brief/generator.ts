import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface MorningBriefSection {
  title: string;
  items: string[];
}

export interface MorningBriefSource {
  kind: "life-log" | "duty-report" | "observer" | "daily-digest" | "git";
  path: string;
  available: boolean;
  count?: number;
}

export interface MorningBrief {
  date: string;
  sourceDate: string;
  generatedAt: string;
  notificationTitle: string;
  notificationBody: string;
  sections: MorningBriefSection[];
  sources: MorningBriefSource[];
  markdown: string;
}

export interface BuildMorningBriefOptions {
  dataDir: string;
  homeDir?: string;
  now?: Date;
  workRoots?: string[];
}

interface ObserverEvent {
  ts?: string;
  type?: string;
  chName?: string;
  from?: string;
  content?: string;
  node?: string;
  status?: string;
}

interface DailyDigestFacts {
  personal: string[];
  system: string[];
  today: string[];
}

export function localDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function previousLocalDate(d: Date = new Date()): string {
  const prev = new Date(d.getTime());
  prev.setDate(prev.getDate() - 1);
  return localDate(prev);
}

export async function buildMorningBrief(opts: BuildMorningBriefOptions): Promise<MorningBrief> {
  const now = opts.now ?? new Date();
  const date = localDate(now);
  const sourceDate = previousLocalDate(now);
  const home = opts.homeDir ?? homedir();
  const sources: MorningBriefSource[] = [];

  const dailyDigestPath = resolve(home, ".ai/timeline/digest", `${date}.md`);
  const dailyDigest = await readDailyDigestFacts(dailyDigestPath);
  sources.push({
    kind: "daily-digest",
    path: dailyDigestPath,
    available: existsSync(dailyDigestPath),
    count: dailyDigest.personal.length + dailyDigest.system.length + dailyDigest.today.length,
  });

  const lifeLogPath = resolve(opts.dataDir, "plugins/ai-life-log/log", `${sourceDate}.txt`);
  const lifeLogLines = await readUsefulLines(lifeLogPath, 12);
  sources.push({ kind: "life-log", path: lifeLogPath, available: existsSync(lifeLogPath), count: lifeLogLines.length });

  const dutyReportPath = resolve(home, ".ai/ops/reports", `${sourceDate}-duty-run.md`);
  const dutyLines = await readUsefulLines(dutyReportPath, 12);
  sources.push({ kind: "duty-report", path: dutyReportPath, available: existsSync(dutyReportPath), count: dutyLines.length });

  const observerPath = resolve(opts.dataDir, "plugins/observer/events", `${sourceDate}.jsonl`);
  const observerEvents = await readObserverEvents(observerPath);
  sources.push({ kind: "observer", path: observerPath, available: existsSync(observerPath), count: observerEvents.length });

  const gitItems = await collectGitItems(opts.workRoots ?? defaultWorkRoots(home), sourceDate);
  for (const item of gitItems.sources) sources.push(item);

  const personalItems = compactItems([
    ...dailyDigest.personal,
    ...lifeLogLines.map(stripLifeLogPrefix),
    ...dutyLines.filter((line) => /`ok`|ok|完成|推进|提交|清理|汇总/i.test(line)).map(formatDutyLineForMobile),
    ...gitItems.personal,
  ], 6);

  const systemItems = compactItems([
    ...dailyDigest.system,
    ...observerEvents
      .filter((event) => event.type === "channel.message" && event.content)
      .map((event) => `${event.chName ?? "channel"} / ${event.from ?? "unknown"}: ${event.content}`),
    ...observerEvents
      .filter((event) => event.type === "node.statusChanged" && event.node)
      .slice(0, 4)
      .map((event) => `${event.node} 状态变为 ${event.status ?? "unknown"}`),
    ...gitItems.team,
  ], 8);

  const todayItems = compactItems([
    ...dailyDigest.today,
    ...inferTodayItems(personalItems, systemItems, dutyLines),
  ], 4);
  const sections: MorningBriefSection[] = [
    {
      title: "昨天我做了什么",
      items: personalItems.length > 0 ? personalItems : ["没有读到足够的个人活动记录，先检查 ai-life-log 和 duty 输出是否正常。"],
    },
    {
      title: "昨天团队 / ERP / 系统发生了什么",
      items: systemItems.length > 0 ? systemItems : ["没有读到团队或系统事件；observer/duty 数据源可能昨天为空。"],
    },
    {
      title: "今天建议优先做什么",
      items: todayItems,
    },
    {
      title: "数据源状态",
      items: renderSourceDiagnostics(sources),
    },
  ];

  const notificationBody = buildNotificationBody(sections);
  return {
    date,
    sourceDate,
    generatedAt: now.toISOString(),
    notificationTitle: "早报已准备好",
    notificationBody,
    sections,
    sources,
    markdown: renderMarkdown(date, sourceDate, sections, sources),
  };
}

async function readUsefulLines(path: string, limit: number): Promise<string[]> {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf-8");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .slice(-limit);
}

async function readObserverEvents(path: string): Promise<ObserverEvent[]> {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf-8");
  const events: ObserverEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // ignore malformed JSONL rows
    }
  }
  return events.slice(-40);
}

async function readDailyDigestFacts(path: string): Promise<DailyDigestFacts> {
  const facts: DailyDigestFacts = { personal: [], system: [], today: [] };
  if (!existsSync(path)) return facts;

  const text = await readFile(path, "utf-8");
  let section: keyof DailyDigestFacts | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      section = classifyDigestHeading(line);
      continue;
    }
    if (!section || !/^[-*]\s+/.test(line)) continue;
    facts[section].push(line);
  }

  facts.personal = compactItems(facts.personal, 6);
  facts.system = compactItems(facts.system, 8);
  facts.today = compactItems(facts.today, 4);
  return facts;
}

function classifyDigestHeading(heading: string): keyof DailyDigestFacts | undefined {
  const text = heading.replace(/^#+\s*/, "");
  if (/昨天.*我|个人|做了什么|完成/.test(text)) return "personal";
  if (/团队|ERP|系统|发生/.test(text)) return "system";
  if (/今天|建议|优先|下一步|待办/.test(text)) return "today";
  return undefined;
}

function stripLifeLogPrefix(line: string): string {
  return line.replace(/^\[[^\]]+\]\[[^\]]+\]\s*/, "").trim();
}

function cleanMarkdownLine(line: string): string {
  return line
    .replace(/^[-*]\s*/, "")
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .replace(/\/(?:home|tmp|Users)\/\S+/g, "")
    .replace(/\bworktree\b/gi, "workspace")
    .replace(/\s+—\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compactItems(items: string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of items) {
    const item = cleanMarkdownLine(raw).slice(0, 120);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function formatDutyLineForMobile(line: string): string {
  const dutyMatch = line.match(/\*\*([^*]+)\*\*\s+—\s+`?([^`—]+)`?\s+—\s+(.+)$/);
  if (dutyMatch) {
    const task = dutyMatch[1].trim();
    const detail = cleanMarkdownLine(dutyMatch[3]);
    if (task === "conversation-archive") {
      const count = detail.match(/home:\s*(\d+)\s*条/)?.[1];
      return count ? `会话归档完成: home ${count} 条` : "会话归档完成";
    }
    if (detail) return detail;
  }

  const cleaned = cleanMarkdownLine(line);
  const parts = cleaned.split(/\s+—\s+/).map((part) => part.trim()).filter(Boolean);
  const taskName = parts.find((part) => /[a-z0-9][a-z0-9-]+/i.test(part)) ?? "";
  const meaningful = parts
    .filter((part) => part !== taskName)
    .filter((part) => !/^(ok|failed|failed:empty)$/i.test(part))
    .filter((part) => !/^home:\s*\d+\s*条$/.test(part));

  if (taskName === "conversation-archive") {
    const count = cleaned.match(/home:\s*(\d+)\s*条/)?.[1];
    return count ? `会话归档完成: home ${count} 条` : "会话归档完成";
  }
  return meaningful[0] ?? cleaned;
}

function inferTodayItems(personal: string[], system: string[], duty: string[]): string[] {
  const joined = [...personal, ...system, ...duty].join("\n");
  const items: string[] = [];
  if (/ERP|订单|worktree/i.test(joined)) items.push("先收口 ERP / worktree 相关遗留项，避免昨天的上下文断掉。");
  if (/failed|异常|失败|health|alert/i.test(joined)) items.push("优先看失败或健康告警项，确认是否需要人工介入。");
  if (/brief|日报|汇总|daily/i.test(joined)) items.push("检查早报和日报链路，把能自动化的每日追问固定下来。");
  items.push("打开 Nerve 看完整早报后，只挑 1-3 件今天必须完成的事推进。");
  return compactItems(items, 4);
}

function buildNotificationBody(sections: MorningBriefSection[]): string {
  const first = sections[0]?.items[0] ?? "";
  const second = sections[2]?.items[0] ?? "";
  return [first, second].filter(Boolean).join("；").slice(0, 96);
}

function renderSourceDiagnostics(sources: MorningBriefSource[]): string[] {
  return sources.map((source) => {
    const status = source.available ? "ok" : "missing";
    const count = source.count !== undefined ? ` (${source.count})` : "";
    return `${source.kind} ${status}${count}`;
  });
}

function renderMarkdown(date: string, sourceDate: string, sections: MorningBriefSection[], sources: MorningBriefSource[]): string {
  const lines = [`# 早报 ${date}`, "", `基于 ${sourceDate} 的记录生成。`, ""];
  for (const section of sections) {
    lines.push(`## ${section.title}`, "");
    for (const item of section.items) lines.push(`- ${item}`);
    lines.push("");
  }
  lines.push("## 数据源", "");
  for (const source of sources) {
    lines.push(`- ${source.available ? "ok" : "missing"} ${source.kind}: ${source.path}${source.count !== undefined ? ` (${source.count})` : ""}`);
  }
  return lines.join("\n").trimEnd() + "\n";
}

function defaultWorkRoots(home: string): string[] {
  return [
    resolve(home, "work/ai-work-os/nerve"),
    resolve(home, "work/ai-work-os/nerve-app"),
    resolve(home, "work/ai-work-os/nerve-tui"),
    resolve(home, "work/erp"),
    resolve(home, "work/ai-work-os"),
  ];
}

async function collectGitItems(workRoots: string[], sourceDate: string): Promise<{ personal: string[]; team: string[]; sources: MorningBriefSource[] }> {
  const personal: string[] = [];
  const team: string[] = [];
  const sources: MorningBriefSource[] = [];
  for (const root of workRoots) {
    for (const repo of await findGitRepos(root)) {
      const result = await readGitCommits(repo, sourceDate);
      sources.push({ kind: "git", path: repo, available: result.available, count: result.commits.length });
      for (const commit of result.commits) {
        const item = `${repo.split("/").slice(-2).join("/")}: ${commit}`;
        if (/renjinxi/i.test(commit)) personal.push(item);
        else team.push(item);
      }
    }
  }
  return { personal: compactItems(personal, 6), team: compactItems(team, 8), sources };
}

async function findGitRepos(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  if (existsSync(resolve(root, ".git"))) return [root];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => resolve(root, entry.name))
      .filter((path) => existsSync(resolve(path, ".git")))
      .slice(0, 12);
  } catch {
    return [];
  }
}

async function readGitCommits(repo: string, sourceDate: string): Promise<{ available: boolean; commits: string[] }> {
  try {
    const since = `${sourceDate} 00:00`;
    const until = `${sourceDate} 23:59`;
    const { stdout } = await execFileAsync("git", ["-C", repo, "log", "--since", since, "--until", until, "--pretty=format:%an %h %s", "--max-count=8"], { timeout: 3000 });
    return { available: true, commits: stdout.split("\n").map((line) => line.trim()).filter(Boolean) };
  } catch {
    return { available: existsSync(resolve(repo, ".git")), commits: [] };
  }
}

#!/usr/bin/env node
/**
 * system-watchdog — L1 节点级健康监控。
 *
 * 定时（默认 60s）拉 node.list，对每个声明了 health 契约的节点对账，
 * 异常写文件 + push #ops 频道（去重窗口 60min）。
 *
 * Commands: status, scan, list, silence
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { PluginBase, type CommandDef, type CommandResult } from "../plugin-base.js";
import type { HealthContract, NodeInfo } from "../../transport/protocol.js";
import { evaluateAll, type Alert } from "./evaluator.js";
import { alertKey, shouldEmit, loadSilence, saveSilence, type SilenceState } from "./silence.js";
import { formatChannelMessage, appendAlertsToFile } from "./reporters.js";

function getArg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const PORT = parseInt(getArg("--port", "4800"));
const SCAN_INTERVAL_MS = parseInt(process.env.WATCHDOG_INTERVAL_MS ?? "60000");
const SILENCE_WINDOW_MS = parseInt(process.env.WATCHDOG_SILENCE_MS ?? String(60 * 60 * 1000));
const ALERT_FILE = process.env.WATCHDOG_ALERT_FILE ?? resolve(homedir(), ".ai/ops/state/system-alerts.md");
const OPS_CHANNEL_NAME = process.env.WATCHDOG_OPS_CHANNEL ?? "ops";
const SILENCE_FILE_OVERRIDE = process.env.WATCHDOG_SILENCE_FILE;

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e: any) {
    if (e.code === "EPERM") return true;  // 权限不足但进程存在
    return false;
  }
}

function getProcessMemoryMB(pid: number): number | null {
  try {
    const out = execSync(`ps -o rss= -p ${pid}`, { encoding: "utf-8" }).trim();
    const rssKB = parseInt(out);
    if (isNaN(rssKB)) return null;
    return Math.round(rssKB / 1024);
  } catch {
    return null;
  }
}

class SystemWatchdog extends PluginBase {
  private silenceState: SilenceState = {};
  private silencePath: string;
  private scanTimer?: ReturnType<typeof setInterval>;
  private lastScanAt?: number;
  private lastAlertCount = 0;
  private opsChannelId?: string;

  constructor() {
    super({
      port: PORT,
      name: "system-watchdog",
      capabilities: ["monitor"],
      permissions: "observer",
    });
    this.silencePath = SILENCE_FILE_OVERRIDE ?? resolve(this.dataDir, "silence.json");
  }

  override getHealth(): HealthContract {
    return { liveness: "process", maxIdleMs: 120_000, maxMemoryMB: 100 };
  }

  override getCommands(): Record<string, CommandDef> {
    return {
      status: { description: "运行状态：监控节点数 / 上次 scan / 本次 alert 数" },
      scan: { description: "立刻触发一次 scan" },
      list: { description: "列出所有有 health 契约的节点" },
      silence: { description: "手动静默某项报警 N 分钟", args: { node: "node 名", metric: "liveness/idle/memory", minutes: "分钟" } },
    };
  }

  protected override async onReady(): Promise<void> {
    this.silenceState = loadSilence(this.silencePath);
    this.log("info", `loaded silence state: ${Object.keys(this.silenceState).length} entries`);
    this.log("info", `scan interval: ${SCAN_INTERVAL_MS}ms, silence window: ${SILENCE_WINDOW_MS}ms`);
    this.log("info", `alert file: ${ALERT_FILE}, ops channel: #${OPS_CHANNEL_NAME}`);

    await this.refreshOpsChannel();
    this.scanTimer = setInterval(() => void this.scan(), SCAN_INTERVAL_MS);
    void this.scan();
  }

  protected override onDisconnect(): void {
    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = undefined; }
  }

  protected override onCommand(command: string, args: Record<string, string>, _from?: string): CommandResult {
    switch (command) {
      case "status": {
        const lastScan = this.lastScanAt ? `${Math.round((Date.now() - this.lastScanAt) / 1000)}s ago` : "never";
        return { reply: `last scan: ${lastScan}, last alerts: ${this.lastAlertCount}, silence entries: ${Object.keys(this.silenceState).length}` };
      }
      case "scan":
        void this.scan();
        return { reply: "scanning" };
      case "list":
        void this.listMonitored();
        return { reply: "listing (see channel)" };
      case "silence": {
        if (!args.node || !args.metric || !args.minutes) {
          return { reply: "格式：silence <node> <metric> <minutes>" };
        }
        const key = `${args.node}:${args.metric}`;
        const minutes = parseInt(args.minutes);
        if (isNaN(minutes) || minutes <= 0) return { reply: "minutes 必须是正整数" };
        // 设置 lastAlertedAt，使 shouldEmit 返回 false 直到指定分钟过去
        // 公式：使 (now+minutes*60_000) - lastAlertedAt = SILENCE_WINDOW_MS → lastAlertedAt = now + minutes*60_000 - SILENCE_WINDOW_MS
        this.silenceState[key] = Date.now() + (minutes * 60 * 1000) - SILENCE_WINDOW_MS;
        saveSilence(this.silencePath, this.silenceState);
        this.log("info", `silenced ${key} for ${minutes}min`);
        return { reply: `silenced ${key} for ${minutes}min` };
      }
    }
  }

  private async refreshOpsChannel(): Promise<void> {
    try {
      const r = await this.request("channel.list");
      const channels = r.channels as Array<{ id: string; name?: string }>;
      const ops = channels.find(c => c.name === OPS_CHANNEL_NAME);
      if (ops) {
        this.opsChannelId = ops.id;
        this.log("info", `found #${OPS_CHANNEL_NAME} channel: ${ops.id}`);
      } else {
        this.opsChannelId = undefined;
        this.log("warn", `#${OPS_CHANNEL_NAME} channel not found, will only write file`);
      }
    } catch (err: any) {
      this.log("warn", `channel.list failed: ${err.message}`);
    }
  }

  private async scan(): Promise<void> {
    this.lastScanAt = Date.now();
    let nodes: NodeInfo[];
    try {
      const r = await this.request("node.list");
      nodes = r.nodes || [];
    } catch (err: any) {
      this.log("error", `node.list failed: ${err.message}`);
      return;
    }

    const now = Date.now();
    const allAlerts: Alert[] = [];
    for (const node of nodes) {
      if (node.name === this.options.name) continue;  // 不评估自己
      const alerts = evaluateAll(node, now, isProcessAlive, getProcessMemoryMB);
      allAlerts.push(...alerts);
    }
    this.lastAlertCount = allAlerts.length;

    if (allAlerts.length === 0) {
      this.log("info", `scan: ${nodes.length} nodes, no alerts`);
      return;
    }

    // 文件总是写
    appendAlertsToFile(ALERT_FILE, allAlerts, new Date(now));
    this.log("info", `scan: ${nodes.length} nodes, ${allAlerts.length} alerts → ${ALERT_FILE}`);

    // 频道：去重后只推未在静默窗口的
    const toEmit: Alert[] = [];
    for (const alert of allAlerts) {
      const key = alertKey(alert);
      if (shouldEmit(key, this.silenceState, SILENCE_WINDOW_MS, now)) {
        toEmit.push(alert);
        this.silenceState[key] = now;
      } else {
        this.log("debug", `silenced: ${key}`);
      }
    }
    saveSilence(this.silencePath, this.silenceState);

    if (toEmit.length === 0) {
      this.log("info", "all alerts in silence window, skipping channel post");
      return;
    }

    await this.postToOps(formatChannelMessage(toEmit));
  }

  private async listMonitored(): Promise<void> {
    try {
      const r = await this.request("node.list");
      const nodes = (r.nodes || []) as NodeInfo[];
      const monitored = nodes.filter(n => n.health && n.name !== this.options.name);
      const lines = monitored.map(n => {
        const c = n.health!;
        const parts = [
          c.liveness ? `liveness=${c.liveness}` : "",
          c.maxIdleMs !== undefined ? `idle≤${c.maxIdleMs === "none" ? "∞" : Math.round((c.maxIdleMs as number) / 1000) + "s"}` : "",
          c.maxMemoryMB ? `mem≤${c.maxMemoryMB}MB` : "",
        ].filter(Boolean);
        return `• ${n.name}: ${parts.join(", ")}`;
      });
      const msg = monitored.length === 0 ? "无受监控节点" : lines.join("\n");
      await this.postToOps(msg);
    } catch (err: any) {
      this.log("warn", `list failed: ${err.message}`);
    }
  }

  private async postToOps(content: string): Promise<void> {
    if (!this.opsChannelId) {
      await this.refreshOpsChannel();
    }
    if (!this.opsChannelId) {
      this.log("warn", `cannot post: no #${OPS_CHANNEL_NAME} channel`);
      return;
    }
    try {
      await this.request("channel.post", { channelId: this.opsChannelId, content });
      this.log("info", `posted to #${OPS_CHANNEL_NAME}`);
    } catch (err: any) {
      this.log("warn", `channel.post failed: ${err.message}`);
      this.opsChannelId = undefined;  // 下次重新查
    }
  }
}

// --- Main ---
const isDirectRun = process.argv[1]?.endsWith("system-watchdog/index.ts") ||
                    process.argv[1]?.endsWith("system-watchdog/index.js");
if (isDirectRun) {
  const watchdog = new SystemWatchdog();
  watchdog.start().catch((err) => {
    console.error(`[system-watchdog] failed to start: ${err}`);
    process.exit(1);
  });
  process.on("SIGTERM", () => { watchdog.stop(); process.exit(0); });
  process.on("SIGINT", () => { watchdog.stop(); process.exit(0); });
}

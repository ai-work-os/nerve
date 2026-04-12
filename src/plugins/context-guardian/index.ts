#!/usr/bin/env node
/**
 * Context Guardian — monitors agent context usage, triggers summary + session reset.
 *
 * Lightweight non-AI plugin node. Connects to nerve via WS, polls node.list,
 * detects when agents approach context limits, and posts @mention to trigger
 * summary + handoff.
 *
 * Usage:
 *   npx tsx src/plugins/context-guardian/index.ts [options]
 *
 * Options:
 *   --port <n>       nerve port (default: 4800)
 *   --threshold <f>  trigger threshold 0-1 (default: 0.5)
 *   --cooldown <n>   cooldown seconds (default: 60)
 *   --interval <n>   poll interval seconds (default: 10)
 */

import { PluginBase, type CommandDef, type CommandResult } from "../plugin-base.js";
import { getThreshold, shouldTrigger, type ThresholdConfig, type NodeInfo } from "./logic.js";

export { getThreshold, shouldTrigger, type ThresholdConfig, type NodeInfo } from "./logic.js";

// --- CLI args ---

function getArg(flag: string, defaultVal: string): string {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : defaultVal;
}

const PORT = parseInt(getArg("--port", "4800"));
const THRESHOLD_UNIFORM = process.argv.includes("--threshold") ? parseFloat(getArg("--threshold", "0.5")) : undefined;
const THRESHOLD_LARGE = parseFloat(getArg("--threshold-large", "0.5"));
const THRESHOLD_SMALL = parseFloat(getArg("--threshold-small", "0.8"));
const COOLDOWN_MS = parseInt(getArg("--cooldown", "60")) * 1000;
const INTERVAL_MS = parseInt(getArg("--interval", "10")) * 1000;

class ContextGuardian extends PluginBase {
  private triggeredSessions = new Map<string, string>();  // nodeName → lastTriggeredSessionId
  private lastTriggerTime = new Map<string, number>();     // nodeName → timestamp
  private pollTimer?: ReturnType<typeof setInterval>;
  private lastActivity?: string;  // Most recent notable activity for display

  constructor() {
    super({
      port: PORT,
      name: "context-guardian",
      capabilities: ["monitor"],
      permissions: "observer",
    });
  }

  override getCommands(): Record<string, CommandDef> {
    return {
      status: { description: "Show monitoring status" },
      trigger: { description: "Force trigger check on an agent", args: { name: "agent name" } },
    };
  }

  override getEvents(): string[] {
    return ["context_warning", "context_triggered"];
  }

  protected override onCommand(command: string, args: Record<string, string>, from?: string): CommandResult {
    switch (command) {
      case "status":
        return { reply: `monitoring, triggered=${this.triggeredSessions.size}, large=${THRESHOLD_LARGE}, small=${THRESHOLD_SMALL}` };
      case "trigger":
        this.log("info", `manual trigger requested for ${args.name || "unknown"}`);
        void this.poll();
        break;
    }
  }

  protected async onReady(): Promise<void> {
    this.log("info", `config: threshold-large=${THRESHOLD_LARGE}, threshold-small=${THRESHOLD_SMALL}, uniform=${THRESHOLD_UNIFORM ?? "none"}, cooldown=${COOLDOWN_MS}ms, interval=${INTERVAL_MS}ms`);
    await this.setActivity("starting");

    // Start polling
    this.pollTimer = setInterval(() => this.poll(), INTERVAL_MS);
    // Run immediately
    void this.poll();
  }

  protected onDisconnect(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.lastActivity = undefined;
  }

  private async poll(): Promise<void> {
    try {
      const result = await this.request("node.list");
      const nodes: NodeInfo[] = result.nodes || [];
      // Count monitored agents (stdio nodes excluding self)
      const agents = nodes.filter(n => n.transport === "stdio");
      if (agents.length > 0) {
        const summary = agents.map(a => {
          const usage = a.usage ? `${((a.usage.tokenUsed / (a.usage.tokenSize || 1)) * 100).toFixed(0)}%` : "n/a";
          return `${a.name}(${usage})`;
        }).join(", ");
        this.log("info", `poll: ${agents.length} agents — ${summary}`);
      }
      this.checkAgents(nodes);
      // Update activity with current monitoring status
      const triggered = this.lastActivity;
      await this.setActivity(triggered || `monitoring ${agents.length} agents`);
    } catch (err) {
      this.log("warn", `poll failed: ${err}`);
      await this.setActivity("poll failed").catch(() => {});
    }
  }

  private async setActivity(activity: string): Promise<void> {
    try {
      await this.request("node.activity", { activity });
    } catch {
      // Ignore — activity update is best-effort
    }
  }

  private checkAgents(nodes: NodeInfo[]): void {
    this.lastActivity = undefined;  // Reset per poll cycle

    for (const node of nodes) {
      if (node.name === this.options.name) continue;  // Skip self

      const dynamicThreshold = node.usage?.tokenSize
        ? getThreshold(node.usage.tokenSize, { uniform: THRESHOLD_UNIFORM, large: THRESHOLD_LARGE, small: THRESHOLD_SMALL, boundary: 500_000 })
        : THRESHOLD_LARGE;
      if (!shouldTrigger(node, dynamicThreshold, this.triggeredSessions)) continue;

      // Cooldown check
      const lastTime = this.lastTriggerTime.get(node.name) || 0;
      if (Date.now() - lastTime < COOLDOWN_MS) {
        this.log("info", `${node.name}: cooldown active, skipping`);
        const remaining = Math.ceil((COOLDOWN_MS - (Date.now() - lastTime)) / 1000);
        this.lastActivity = `cooldown ${node.name} ${remaining}s`;
        continue;
      }

      const ratio = node.usage!.tokenUsed / node.usage!.tokenSize;
      const used = node.usage!.tokenUsed;
      const size = node.usage!.tokenSize;
      this.log("info", `${node.name}: triggering reset — usage=${used}/${size} (${(ratio * 100).toFixed(0)}%), threshold=${(dynamicThreshold * 100).toFixed(0)}%, status=${node.status}, session=${node.sessionId}, channels=${node.channels.join(",") || "none"}`);
      void this.triggerSummary(node, ratio);
      this.lastActivity = `triggered ${node.name}`;

      // Mark as triggered
      this.triggeredSessions.set(node.name, node.sessionId!);
      this.lastTriggerTime.set(node.name, Date.now());
    }
  }

  private async triggerSummary(node: NodeInfo, ratio: number): Promise<void> {
    const channelId = node.channels?.[0];
    if (!channelId) {
      this.log("warn", `${node.name}: not in any channel, cannot trigger (channels=[])`);
      return;
    }

    const pct = (ratio * 100).toFixed(0);
    const used = node.usage?.tokenUsed ?? 0;
    const size = node.usage?.tokenSize ?? 0;
    this.log("info", `${node.name}: posting summary trigger to channel=${channelId}, usage=${used}/${size} (${pct}%), session=${node.sessionId}`);
    try {
      await this.request("channel.post", {
        channelId,
        content: [
          `@${node.name} 上下文已用 ${pct}%，请执行上下文交接：`,
          `1. 总结当前状态写入 ~/.nerve/summaries/${node.name}-${node.sessionId}.md`,
          `2. 调用 nerve_session_reset({ summary_path: "写入的文件路径" })`,
        ].join("\n"),
      });
      this.log("info", `${node.name}: summary trigger posted successfully to channel ${channelId}`);
    } catch (err) {
      this.log("error", `${node.name}: failed to post trigger to channel=${channelId}: ${err}`);
    }
  }
}

// --- Main ---

const guardian = new ContextGuardian();

guardian.start().catch((err) => {
  console.error(`[context-guardian] failed to start: ${err}`);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGTERM", () => { guardian.stop(); process.exit(0); });
process.on("SIGINT", () => { guardian.stop(); process.exit(0); });

#!/usr/bin/env node
/**
 * email-watcher — nerve plugin 包装 python IDLE daemon。
 *
 * 自身只负责生命周期管理 + 日志聚合 + 自动重启。
 * 真实的 IMAP IDLE / deepseek 调用 / pbcopy 全在
 * ~/.ai/ops/scripts/email-watcher.py 里（zero-dep python）。
 *
 * Commands: pause, resume, status, restart
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { PluginBase, type CommandDef, type CommandResult } from "../plugin-base.js";

function getArg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const PORT = parseInt(getArg("--port", "4800"));

const SCRIPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "email-watcher.py");
const ACCOUNTS_PATH = resolve(homedir(), ".config/email-watcher/accounts.json");
const RESTART_BACKOFF_MS = [1_000, 3_000, 10_000, 30_000, 60_000];

class EmailWatcherPlugin extends PluginBase {
  private child: ChildProcess | null = null;
  private paused = false;
  private restartAttempt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private startTime = Date.now();
  private lastError: string | null = null;
  private pythonBin: string;

  constructor() {
    super({
      port: PORT,
      name: "email-watcher",
      capabilities: ["monitor"],
      permissions: "member",
    });
    // 优先 homebrew python3，fallback 系统 python3
    this.pythonBin = existsSync("/opt/homebrew/bin/python3")
      ? "/opt/homebrew/bin/python3"
      : "/usr/bin/python3";
  }

  protected async onReady(): Promise<void> {
    if (!existsSync(SCRIPT_PATH)) {
      this.lastError = `脚本不存在: ${SCRIPT_PATH}`;
      this.log("error", this.lastError);
      await this.setActivity("error: script missing");
      return;
    }
    if (!existsSync(ACCOUNTS_PATH)) {
      this.lastError = `凭证不存在: ${ACCOUNTS_PATH}（先填邮箱用户名 + IMAP 授权码）`;
      this.log("error", this.lastError);
      await this.setActivity("error: accounts missing");
      return;
    }
    this.log("info", `python=${this.pythonBin}`);
    this.log("info", `script=${SCRIPT_PATH}`);
    this.spawnChild();
  }

  protected onDisconnect(): void {
    this.killChild("nerve disconnect");
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
  }

  override getCommands(): Record<string, CommandDef> {
    return {
      pause: { description: "暂停监听（kill 子进程，不再重启）" },
      resume: { description: "恢复监听（重新拉起子进程）" },
      status: { description: "运行状态 / pid / uptime / 错误" },
      restart: { description: "立刻重启子进程" },
    };
  }

  override getHealth() {
    return { liveness: "process" as const, maxIdleMs: "none" as const, maxMemoryMB: 200 };
  }

  protected override onCommand(command: string, _args: Record<string, string>, _from?: string): CommandResult {
    switch (command) {
      case "pause":
        this.paused = true;
        this.killChild("manual pause");
        void this.setActivity("paused");
        this.log("info", "paused");
        return { reply: "paused" };
      case "resume":
        this.paused = false;
        this.restartAttempt = 0;
        this.spawnChild();
        void this.setActivity("watching");
        this.log("info", "resumed");
        return { reply: "resumed" };
      case "restart":
        this.killChild("manual restart");
        this.restartAttempt = 0;
        setTimeout(() => this.spawnChild(), 500);
        return { reply: "restarting" };
      case "status": {
        const uptime = Math.round((Date.now() - this.startTime) / 1000);
        const pid = this.child?.pid ?? "-";
        const mode = this.lastError
          ? `error: ${this.lastError}`
          : this.paused ? "paused" : (this.child ? "watching" : "starting");
        return { reply: `${mode}; pid=${pid}; uptime=${uptime}s; restarts=${this.restartAttempt}` };
      }
      default:
        return {};
    }
  }

  private spawnChild(): void {
    if (this.paused) {
      this.log("info", "paused — skip spawn");
      return;
    }
    if (this.child && !this.child.killed) {
      this.log("warn", "child 还在跑，先 kill");
      this.killChild("respawn");
    }

    this.log("info", `spawn ${this.pythonBin} ${SCRIPT_PATH} daemon`);
    const child = spawn(this.pythonBin, [SCRIPT_PATH, "daemon"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (buf: Buffer) => {
      for (const line of buf.toString("utf-8").split("\n")) {
        if (line.trim()) this.log("info", `[py] ${line}`);
      }
    });
    child.stderr?.on("data", (buf: Buffer) => {
      for (const line of buf.toString("utf-8").split("\n")) {
        if (line.trim()) this.log("info", `[py] ${line}`);
      }
    });
    child.on("exit", (code, signal) => {
      this.log("warn", `python exited code=${code} signal=${signal}`);
      this.child = null;
      if (this.paused) return;
      const attempt = this.restartAttempt;
      if (attempt >= RESTART_BACKOFF_MS.length) {
        this.log("error", `${attempt} restarts failed, giving up`);
        this.lastError = `python 子进程崩溃 ${attempt} 次，已放弃`;
        void this.setActivity("error: giving up");
        return;
      }
      const delay = RESTART_BACKOFF_MS[attempt];
      this.restartAttempt = attempt + 1;
      this.log("info", `${delay}ms 后重启（attempt ${attempt + 1}）`);
      this.restartTimer = setTimeout(() => this.spawnChild(), delay);
    });

    this.child = child;
    this.lastError = null;
    void this.setActivity("watching");
  }

  private killChild(reason: string): void {
    if (!this.child) return;
    this.log("info", `kill child (${reason})`);
    try { this.child.kill("SIGTERM"); } catch (e: any) { this.log("warn", `kill: ${e.message}`); }
    this.child = null;
  }

  private async setActivity(activity: string): Promise<void> {
    try { await this.request("node.activity", { activity }); } catch { /* best-effort */ }
  }
}

// --- Main ---
import { fileURLToPath as _flu } from "node:url";
const _thisFile = _flu(import.meta.url);
const _isMain = process.argv[1] && (
  process.argv[1] === _thisFile ||
  process.argv[1].endsWith("email-watcher/index.ts") ||
  process.argv[1].endsWith("email-watcher/index.js")
);

if (_isMain) {
  const plugin = new EmailWatcherPlugin();
  plugin.start().catch((err) => {
    console.error(`[email-watcher] failed to start: ${err}`);
    process.exit(1);
  });
  process.on("SIGTERM", () => { plugin.stop(); process.exit(0); });
  process.on("SIGINT", () => { plugin.stop(); process.exit(0); });
}

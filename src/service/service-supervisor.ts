/**
 * service-supervisor — 纯进程监督器。
 *
 * 读取 ServiceSpec 列表，spawn 子进程，崩溃后按退避策略重启。
 * 不连接 NodePool / ChannelManager，不期待子进程注册。
 * 适合管理需要连到外部 nerve（非本机）的进程，如 mac-clipboard。
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { ServiceSpec } from "./service-config.js";

// ---- Public types ----

/** 最小子进程接口。Node 的 ChildProcess 满足它。 */
export interface SupervisedChild {
  pid?: number;
  kill(signal?: string): void;
  on(event: "exit", cb: (code: number | null) => void): this;
  on(event: "error", cb: (err: Error) => void): this;
}

export type SpawnFn = (spec: ServiceSpec) => SupervisedChild;

export interface SupervisorLog {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface SupervisorOptions {
  specs: ServiceSpec[];
  spawn?: SpawnFn;
  log?: SupervisorLog;
  /** Backoff delays in ms between restarts. Default: [1000, 3000, 10000, 30000, 60000] */
  backoffMs?: number[];
  /** If a process lives at least this long (ms), reset attempt counter. Default: 60000 */
  stableMs?: number;
}

export type ProcessState = "running" | "restarting" | "stopped";

export interface ProcessStatus {
  name: string;
  pid?: number;
  state: ProcessState;
  restarts: number;
}

// ---- Internal state per supervised process ----

interface ChildState {
  spec: ServiceSpec;
  child: SupervisedChild | null;
  /** Number of times this process has actually been restarted (not counting initial spawn) */
  restarts: number;
  /** Restart backoff attempt count (1-based: 1 = first restart, used as backoffMs[attempt-1]). */
  attempt: number;
  /** Timestamp when the current child was spawned */
  spawnedAt: number;
  /** Pending restart timer */
  restartTimer: ReturnType<typeof setTimeout> | null;
  /** True once exit/error has fired and we are between child processes */
  restarting: boolean;
}

// ---- Default spawn ----

const defaultSpawn: SpawnFn = (spec: ServiceSpec): SupervisedChild => {
  // I1: use "inherit" for stdout/stderr — "pipe" creates an OS pipe that, if
  // no one drains it, fills its 64KB buffer and silently blocks the child.
  return nodeSpawn(spec.cmd, spec.args ?? [], {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ["ignore", "inherit", "inherit"],
  }) as unknown as SupervisedChild;
};

const noopLog: SupervisorLog = {
  info(_msg: string) {},
  warn(_msg: string) {},
};

// ---- ServiceSupervisor ----

export class ServiceSupervisor {
  private readonly specs: ServiceSpec[];
  private readonly spawnFn: SpawnFn;
  private readonly log: SupervisorLog;
  private readonly backoffMs: number[];
  private readonly stableMs: number;

  private stopped = false;
  private started = false;
  private states: Map<string, ChildState> = new Map();

  constructor(options: SupervisorOptions) {
    this.specs = options.specs;
    this.spawnFn = options.spawn ?? defaultSpawn;
    this.log = options.log ?? noopLog;
    this.backoffMs = options.backoffMs ?? [1000, 3000, 10000, 30000, 60000];
    this.stableMs = options.stableMs ?? 60000;
  }

  start(): void {
    // M4: guard against repeated start() — would rebuild states and leak
    // orphaned child processes.
    if (this.started) {
      throw new Error("ServiceSupervisor: start() already called");
    }
    this.started = true;
    for (const spec of this.specs) {
      const state: ChildState = {
        spec,
        child: null,
        restarts: 0,
        attempt: 0,
        spawnedAt: 0,
        restartTimer: null,
        restarting: false,
      };
      this.states.set(spec.name, state);
      this._spawnChild(state);
    }
  }

  stop(): void {
    this.stopped = true;
    this.log.info("ServiceSupervisor: stop() called — killing all children");

    for (const state of this.states.values()) {
      if (state.restartTimer !== null) {
        clearTimeout(state.restartTimer);
        state.restartTimer = null;
      }
      if (state.child !== null) {
        this.log.info(`ServiceSupervisor: sending SIGTERM to ${state.spec.name} (pid=${state.child.pid})`);
        try {
          state.child.kill("SIGTERM");
        } catch (err: any) {
          this.log.warn(`ServiceSupervisor: kill error for ${state.spec.name}: ${err.message}`);
        }
      }
    }
  }

  status(): ProcessStatus[] {
    const result: ProcessStatus[] = [];
    for (const state of this.states.values()) {
      let st: ProcessState;
      if (this.stopped) {
        st = "stopped";
      } else if (state.restarting) {
        st = "restarting";
      } else {
        st = "running";
      }
      result.push({
        name: state.spec.name,
        pid: state.child?.pid,
        state: st,
        restarts: state.restarts,
      });
    }
    return result;
  }

  // ---- private ----

  private _spawnChild(state: ChildState): void {
    state.restarting = false;
    state.spawnedAt = Date.now();
    const child = this.spawnFn(state.spec);
    state.child = child;

    this.log.info(
      `ServiceSupervisor: spawned ${state.spec.name} pid=${child.pid} (restarts=${state.restarts})`
    );

    child.on("exit", (code) => {
      this._onExit(state, `exit code=${code}`);
    });

    child.on("error", (err) => {
      this.log.warn(`ServiceSupervisor: error from ${state.spec.name}: ${err.message}`);
      this._onExit(state, `error: ${err.message}`);
    });
  }

  private _onExit(state: ChildState, reason: string): void {
    // C1: Node emits "error" then "exit" for the same failed child — only
    // handle it once. child===null means this exit was already processed.
    if (state.child === null) return;
    state.child = null;

    if (this.stopped) {
      this.log.info(`ServiceSupervisor: ${state.spec.name} exited (${reason}) — supervisor stopped, no restart`);
      return;
    }

    const uptime = Date.now() - state.spawnedAt;

    if (state.spec.restart === "never") {
      // M2: never-restart processes never increment restarts.
      this.log.info(
        `ServiceSupervisor: ${state.spec.name} exited (${reason}) — restart=never, skip restart`
      );
      return;
    }

    state.restarts += 1;

    // Reset attempt counter if process was stable long enough
    if (uptime >= this.stableMs) {
      this.log.info(
        `ServiceSupervisor: ${state.spec.name} was stable for ${uptime}ms (>= ${this.stableMs}ms), resetting backoff`
      );
      state.attempt = 0;
    }

    // attempt is 1-based: increment first, then index backoffMs as attempt-1.
    state.attempt += 1;
    const delay = this.backoffMs[Math.min(state.attempt - 1, this.backoffMs.length - 1)];
    state.restarting = true;

    this.log.warn(
      `ServiceSupervisor: ${state.spec.name} exited (${reason}) — restarting in ${delay}ms (attempt=${state.attempt})`
    );

    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      if (this.stopped) return;
      this.log.info(`ServiceSupervisor: restarting ${state.spec.name} now`);
      this._spawnChild(state);
    }, delay);
  }
}

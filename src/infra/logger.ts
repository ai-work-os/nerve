import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { customAlphabet } from "nanoid";
import { localIso } from "./time-util.js";

const corrIdGen = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 8);

export function newCorrelationId(): string {
  return corrIdGen();
}

let logStream: WriteStream | null = null;
let logPath: string | null = null;

export function initLog(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  logStream = createWriteStream(filePath, { flags: "a" });
  logPath = filePath;
}

export function getLogPath(): string | null {
  return logPath;
}

export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface LogContext {
  module?: string;
  correlationId?: string;
  nodeId?: string;
  channelId?: string;
  [key: string]: unknown;
}

function formatContext(ctx: LogContext): string {
  const parts: string[] = [];
  if (ctx.module) parts.push(`[${ctx.module}]`);
  const extras = Object.entries(ctx).filter(([k]) => k !== "module");
  for (const [k, v] of extras) {
    if (v === undefined) continue;
    parts.push(`${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  }
  return parts.join(" ");
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4,
};

let debugMatchers: ((module: string) => boolean)[] = [];
function parseNerveDebug(): void {
  debugMatchers = [];
  const raw = process.env.NERVE_DEBUG;
  if (!raw) return;
  for (const pat of raw.split(",").map(s => s.trim()).filter(Boolean)) {
    if (pat.includes("*")) {
      const regex = new RegExp("^" + pat.replace(/\*/g, ".*") + "$");
      debugMatchers.push(m => regex.test(m));
    } else {
      debugMatchers.push(m => m === pat);
    }
  }
}
parseNerveDebug();

function shouldLog(level: LogLevel, module?: string): boolean {
  const threshold = LEVEL_ORDER.INFO;
  const levelNum = LEVEL_ORDER[level];
  if (levelNum >= threshold) return true;
  if ((level === "DEBUG" || level === "TRACE") && module) {
    return debugMatchers.some(fn => fn(module));
  }
  return false;
}

function emit(level: LogLevel, ctx: LogContext, msg: string): void {
  if (!shouldLog(level, ctx.module)) return;
  const ctxStr = formatContext(ctx);
  const prefix = ctxStr ? ` ${ctxStr}` : "";
  const line = `${localIso()} [${level}]${prefix} ${msg}`;
  if (logStream) logStream.write(line + "\n");
  if (level === "ERROR") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export interface Logger {
  info(msg: string, data?: object): void;
  warn(msg: string, data?: object): void;
  error(msg: string, data?: object): void;
  debug(msg: string, data?: object): void;
  trace(msg: string, data?: object): void;
  child(ctx: LogContext): Logger;
  lifecycle(event: "start" | "stop" | "restart" | "crash", reason?: string, data?: object): void;
  stateChange(field: string, from: unknown, to: unknown, reason?: string): void;
  boundary(direction: "in" | "out", kind: string, summary?: object): void;
}

function makeLogger(baseCtx: LogContext): Logger {
  return {
    info: (msg, data) => emit("INFO", { ...baseCtx, ...(data || {}) }, msg),
    warn: (msg, data) => emit("WARN", { ...baseCtx, ...(data || {}) }, msg),
    error: (msg, data) => emit("ERROR", { ...baseCtx, ...(data || {}) }, msg),
    debug: (msg, data) => emit("DEBUG", { ...baseCtx, ...(data || {}) }, msg),
    trace: (msg, data) => emit("TRACE", { ...baseCtx, ...(data || {}) }, msg),
    child: (ctx) => makeLogger({ ...baseCtx, ...ctx }),
    lifecycle: (event, reason, data) =>
      emit("INFO", { ...baseCtx, lifecycle: event, ...(reason ? { reason } : {}), ...(data || {}) }, `lifecycle:${event}`),
    stateChange: (field, from, to, reason) =>
      emit("INFO", { ...baseCtx, field, from, to, ...(reason ? { reason } : {}) }, `stateChange:${field}`),
    boundary: (direction, kind, summary) =>
      emit("INFO", { ...baseCtx, dir: direction, kind, ...(summary || {}) }, `boundary:${direction}:${kind}`),
  };
}

export function child(ctx: LogContext): Logger {
  return makeLogger(ctx);
}

// Legacy API
export function info(msg: string): void { emit("INFO", {}, msg); }
export function warn(msg: string): void { emit("WARN", {}, msg); }
export function error(msg: string): void { emit("ERROR", {}, msg); }
export function debug(msg: string): void { emit("DEBUG", {}, msg); }

export function closeLog(): void {
  logStream?.end();
  logStream = null;
}

export function __resetForTest(): void {
  parseNerveDebug();
}

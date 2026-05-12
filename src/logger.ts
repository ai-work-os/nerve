import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { localIso } from "./time-util.js";

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

function emit(level: LogLevel, ctx: LogContext, msg: string): void {
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
}

function makeLogger(baseCtx: LogContext): Logger {
  return {
    info: (msg, data) => emit("INFO", { ...baseCtx, ...(data || {}) }, msg),
    warn: (msg, data) => emit("WARN", { ...baseCtx, ...(data || {}) }, msg),
    error: (msg, data) => emit("ERROR", { ...baseCtx, ...(data || {}) }, msg),
    debug: (msg, data) => emit("DEBUG", { ...baseCtx, ...(data || {}) }, msg),
    trace: (msg, data) => emit("TRACE", { ...baseCtx, ...(data || {}) }, msg),
    child: (ctx) => makeLogger({ ...baseCtx, ...ctx }),
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
  /* placeholder — next task adds NERVE_DEBUG re-parse */
}

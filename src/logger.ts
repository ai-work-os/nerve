import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { dirname } from "node:path";

let logStream: WriteStream | null = null;
let logPath: string | null = null;

/** Initialize file logging. Call once at startup. */
export function initLog(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  logStream = createWriteStream(filePath, { flags: "a" });
  logPath = filePath;
}

/** Get current log file path (for AI to read) */
export function getLogPath(): string | null {
  return logPath;
}

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function write(level: string, msg: string): void {
  const line = `${ts()} [${level}] ${msg}`;
  if (logStream) logStream.write(line + "\n");
  if (level === "ERROR") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export function info(msg: string): void { write("INFO", msg); }
export function warn(msg: string): void { write("WARN", msg); }
export function error(msg: string): void { write("ERROR", msg); }
export function debug(msg: string): void { write("DEBUG", msg); }

export function closeLog(): void {
  logStream?.end();
  logStream = null;
}

import { mkdirSync, createWriteStream } from "node:fs";
import { dirname } from "node:path";
let logStream = null;
let logPath = null;
/** Initialize file logging. Call once at startup. */
export function initLog(filePath) {
    mkdirSync(dirname(filePath), { recursive: true });
    logStream = createWriteStream(filePath, { flags: "a" });
    logPath = filePath;
}
/** Get current log file path (for AI to read) */
export function getLogPath() {
    return logPath;
}
function ts() {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
}
function write(level, msg) {
    const line = `${ts()} [${level}] ${msg}`;
    if (logStream)
        logStream.write(line + "\n");
    if (level === "ERROR") {
        process.stderr.write(line + "\n");
    }
    else {
        process.stdout.write(line + "\n");
    }
}
export function info(msg) { write("INFO", msg); }
export function warn(msg) { write("WARN", msg); }
export function error(msg) { write("ERROR", msg); }
export function debug(msg) { write("DEBUG", msg); }
export function closeLog() {
    logStream?.end();
    logStream = null;
}
//# sourceMappingURL=logger.js.map
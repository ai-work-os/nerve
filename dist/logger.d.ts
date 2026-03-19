/** Initialize file logging. Call once at startup. */
export declare function initLog(filePath: string): void;
/** Get current log file path (for AI to read) */
export declare function getLogPath(): string | null;
export declare function info(msg: string): void;
export declare function warn(msg: string): void;
export declare function error(msg: string): void;
export declare function debug(msg: string): void;
export declare function closeLog(): void;

/**
 * transcript-buffer.ts — Transcript accumulation + timed/threshold flush.
 *
 * Exported for unit testing via `index.ts` re-exports.
 */

export type FlushReason = "interval" | "line_count" | "manual" | "stop";

export interface TranscriptBufferConfig {
  pushInterval: number;
  pushLines: number;
  onFlush: (lines: string[], reason: FlushReason) => void;
}

export class TranscriptBuffer {
  private lines: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private config: TranscriptBufferConfig;

  constructor(config: TranscriptBufferConfig) {
    this.config = config;
    this.timer = setInterval(() => this.doFlush("interval"), config.pushInterval);
  }

  add(line: string): void {
    this.lines.push(line);
    if (this.lines.length >= this.config.pushLines) {
      this.doFlush("line_count");
    }
  }

  flush(): void {
    this.doFlush("manual");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.doFlush("stop");
  }

  private doFlush(reason: FlushReason): void {
    if (this.lines.length === 0) return;
    const batch = this.lines;
    this.lines = [];
    this.config.onFlush(batch, reason);
  }
}

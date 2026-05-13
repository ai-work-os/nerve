import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { NerveNode } from "../node/node.js";
import * as log from "./logger.js";

type EventDetail = Record<string, unknown> | undefined;

export class EventLogger {
  private filePath?: string;
  private warned = false;

  constructor(filePath?: string) {
    if (!filePath) return;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, "", { flag: "a" });
      this.filePath = filePath;
    } catch (err: any) {
      this.disable(err);
    }
  }

  log(event: string, detail?: Record<string, unknown>): void {
    if (!this.filePath) return;
    try {
      appendFileSync(this.filePath, `${JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...(detail || {}),
      })}\n`);
    } catch (err: any) {
      this.disable(err);
    }
  }

  logNode(event: string, node: NerveNode, detail?: EventDetail): void {
    const base: Record<string, unknown> = {
      nodeId: node.id,
      name: node.name,
      status: node.status,
      activity: node.activity,
      transport: node.transport.type,
      adapter: node.adapter,
      source: node.source,
      cwd: node.cwd,
    };

    if (event === "node.update") {
      const update = detail?.update as Record<string, unknown> | undefined;
      const content = update?.content as Record<string, unknown> | undefined;
      this.log(event, {
        ...base,
        updateType: update?.sessionUpdate,
        contentType: content?.type,
        text: typeof content?.text === "string" ? content.text : undefined,
        from: detail?.from,
      });
      return;
    }

    this.log(event, {
      ...base,
      ...(detail || {}),
    });
  }

  close(): void {
    // appendFileSync is unbuffered, nothing to flush
  }

  private disable(err: unknown): void {
    this.filePath = undefined;
    if (this.warned) return;
    this.warned = true;
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`event log disabled: ${msg}`);
  }
}

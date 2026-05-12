/**
 * TaskStore — persistent task definition storage.
 *
 * Responsibilities:
 *  - TaskDef type
 *  - TaskStore class: add/remove/list/reload/normalizeMessages
 *  - extractReferencedPaths(), validateReferencedPaths()
 *  - normalizeLegacyAiWorkspacePaths()
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { child as childLogger } from "../../logger.js";
import type { Schedule } from "./cron-scheduler.js";

const log = childLogger({ module: "plugin:duty-monitor:task-store" });

// --- Types ---

export interface TaskDef {
  name: string;
  schedule: Schedule;
  message: string;
}

// --- Path helpers ---

export function extractReferencedPaths(message: string): string[] {
  const matches = message.match(/\/[^\s`"'，。；:]+?\.(?:md|json|ya?ml)\b/g) ?? [];
  return [...new Set(matches)];
}

export function validateReferencedPaths(message: string): { ok: boolean; missing: string[] } {
  const missing = extractReferencedPaths(message).filter(path => !existsSync(path));
  return { ok: missing.length === 0, missing };
}

export function normalizeLegacyAiWorkspacePaths(message: string): { message: string; changed: boolean } {
  const paths = extractReferencedPaths(message);
  let normalized = message;
  for (const path of paths) {
    if (!path.includes("/.ai/projects/") || existsSync(path)) continue;
    const candidate = path.replace("/.ai/projects/", "/.ai/workspace/projects/");
    if (existsSync(candidate)) {
      normalized = normalized.split(path).join(candidate);
    }
  }
  return { message: normalized, changed: normalized !== message };
}

// --- TaskStore ---

export class TaskStore {
  private tasks: TaskDef[] = [];
  private filePath: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = resolve(dataDir, "tasks.json");
    this.load();
    log.debug(`initialized: ${this.filePath}`);
  }

  get path(): string {
    return this.filePath;
  }

  add(task: TaskDef): void {
    if (!task.name) {
      task.name = task.message.replace(/^@\S+\s*/, "").slice(0, 20).trim() || `task-${Date.now()}`;
    }
    const idx = this.tasks.findIndex(t => t.name === task.name);
    if (idx >= 0) {
      this.tasks[idx] = task;
    } else {
      this.tasks.push(task);
    }
    this.save();
  }

  remove(name: string): boolean {
    const idx = this.tasks.findIndex(t => t.name === name);
    if (idx < 0) return false;
    this.tasks.splice(idx, 1);
    this.save();
    return true;
  }

  list(): TaskDef[] {
    return [...this.tasks];
  }

  reload(): boolean {
    return this.load();
  }

  normalizeMessages(): string[] {
    const changed: string[] = [];
    for (const task of this.tasks) {
      const normalized = normalizeLegacyAiWorkspacePaths(task.message);
      if (normalized.changed) {
        task.message = normalized.message;
        changed.push(task.name);
      }
    }
    if (changed.length > 0) this.save();
    return changed;
  }

  private load(): boolean {
    if (!existsSync(this.filePath)) { this.tasks = []; return true; }
    try {
      this.tasks = JSON.parse(readFileSync(this.filePath, "utf-8"));
      return true;
    } catch {
      this.tasks = [];
      return false;
    }
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.tasks, null, 2));
  }
}

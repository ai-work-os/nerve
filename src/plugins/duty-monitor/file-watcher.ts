/**
 * FileWatcher — watches a set of file paths for changes.
 *
 * Responsibilities:
 *  - Open / close fs.watch handles
 *  - Debounce-free: fires onChange on any write
 *
 * Caller provides paths to watch and an onChange callback.
 */

import { existsSync, watch, type FSWatcher } from "node:fs";
import { child as childLogger } from "../../logger.js";

const log = childLogger({ module: "plugin:duty-monitor:file-watcher" });

export class FileWatcher {
  private handles: FSWatcher[] = [];

  /**
   * Replace current watches with a new set of paths.
   * onChange is called with the changed path.
   */
  reset(paths: Iterable<string>, onChange: (path: string) => void): void {
    this.close();
    for (const path of paths) {
      if (!existsSync(path)) {
        log.warn(`watch skipped missing file: ${path}`);
        continue;
      }
      try {
        const handle = watch(path, { persistent: false }, () => {
          log.info(`watch change: ${path}`);
          onChange(path);
        });
        handle.on("error", err => {
          log.error(`watch error for ${path}: ${(err as Error).message}`);
        });
        this.handles.push(handle);
      } catch (err) {
        log.error(`watch failed for ${path}: ${err}`);
      }
    }
  }

  close(): void {
    for (const handle of this.handles) {
      try { handle.close(); } catch { /* ignore close races */ }
    }
    this.handles = [];
  }
}

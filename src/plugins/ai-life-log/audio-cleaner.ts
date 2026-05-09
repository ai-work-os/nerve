import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface CleanStats { deleted: number; }

/** Recursively remove .opus files under audioDir whose mtime is older than retainDays. */
export function cleanOldAudio(audioDir: string, retainDays: number): CleanStats {
  if (!existsSync(audioDir)) return { deleted: 0 };
  const cutoff = Date.now() - retainDays * 86400_000;
  let deleted = 0;
  const visit = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) { visit(p); continue; }
      if (!entry.isFile()) continue;
      if (!p.endsWith(".opus")) continue;
      try {
        const st = statSync(p);
        if (st.mtimeMs < cutoff) { unlinkSync(p); deleted++; }
      } catch { /* race — ignore */ }
    }
  };
  visit(audioDir);
  return { deleted };
}

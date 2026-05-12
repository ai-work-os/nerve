import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface StartupConfig {
  scenes: string[];
}

export interface StartStartupScenesOptions {
  dataDir: string;
  startScene: (name: string) => Promise<void>;
  log: (message: string) => void;
}

type LogFn = (message: string) => void;

export function loadStartupConfig(dataDir: string, log: LogFn = () => {}): StartupConfig {
  const file = resolve(dataDir, "startup.json");
  if (!existsSync(file)) return { scenes: [] };

  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as { scenes?: unknown };
    const scenes = Array.isArray(parsed.scenes)
      ? parsed.scenes.filter((scene): scene is string => typeof scene === "string" && scene.trim().length > 0)
      : [];
    return { scenes };
  } catch (err: any) {
    log(`startup config invalid: ${err.message}`);
    return { scenes: [] };
  }
}

export async function startStartupScenes(options: StartStartupScenesOptions): Promise<void> {
  const config = loadStartupConfig(options.dataDir, options.log);
  for (const scene of config.scenes) {
    try {
      await options.startScene(scene);
      options.log(`startup scene started: ${scene}`);
    } catch (err: any) {
      options.log(`startup scene failed: ${scene}: ${err.message}`);
    }
  }
}

#!/usr/bin/env npx tsx

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelManager } from "../../src/channel/channel-manager.js";
import { Server } from "../../src/server.js";
import { startStartupScenes } from "../../src/startup.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, name: string, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    const msg = detail ? `${name}: ${detail}` : name;
    failures.push(msg);
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  Startup scene integration test");
  console.log("═══════════════════════════════════════════════");

  const dataDir = mkdtempSync(join(tmpdir(), "nerve-startup-scene-"));
  const port = 14991;
  const cm = new ChannelManager({ dataDir, port });
  const server = new Server(cm, port);

  try {
    mkdirSync(join(dataDir, "scenes"), { recursive: true });
    writeFileSync(join(dataDir, "startup.json"), JSON.stringify({ scenes: ["work"] }));
    writeFileSync(join(dataDir, "scenes", "work.json"), JSON.stringify({
      name: "work",
      nodes: [{ adapter: "mock", name: "work-agent" }],
      channel: { name: "work", auto_create: true },
    }));

    server.start();
    await startStartupScenes({
      dataDir,
      startScene: (name) => server.startScene(name),
      log: () => {},
    });

    const ready = await waitFor(() => {
      const node = cm.nodePool.getByName("work-agent");
      const channel = cm.listChannels().find((ch) => ch.name === "work");
      return !!node && !!channel && channel.nodes.has("work-agent");
    });

    assert(ready, "startup scene creates work channel and joins work-agent");

    const dutyScene = JSON.parse(readFileSync(join(process.cwd(), "scenes", "duty.json"), "utf8"));
    const commands = (dutyScene.on_ready || []).map((cmd: { to?: string; command?: string }) => `${cmd.to || ""}:${cmd.command || ""}`);
    assert(
      commands.includes("duty-monitor:subscribe task_fired:daily-audit name=duty-agent"),
      "duty scene subscribes duty-agent to daily-audit task events",
    );
    assert(
      commands.includes("duty-monitor:subscribe health_alert name=duty-agent"),
      "duty scene subscribes duty-agent to health alerts",
    );
  } finally {
    await server.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }

  if (failed > 0) {
    console.error(`\n${failed} failed, ${passed} passed`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

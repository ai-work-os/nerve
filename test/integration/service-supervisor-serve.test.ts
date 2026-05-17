/**
 * service-supervisor-serve 集成测试。
 *
 * 验证 `nerve serve` 启动时会拉起 ServiceSupervisor，
 * 以及 --no-services 开关能跳过它。
 *
 * 隔离策略：随机端口 + 临时 data 目录 + 临时 services.json。
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

// --- helpers ---

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const addr = server.address() as net.AddressInfo;
      server.close(() => resolve(addr.port));
    });
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Start `nerve serve` via `npx tsx src/cli.ts serve` and wait until it logs
 * "started on port" before resolving.
 */
async function startNerveServe(opts: {
  port: number;
  dataDir: string;
  servicesFile: string;
  extraArgs?: string[];
}): Promise<ChildProcess> {
  const args = [
    "tsx",
    "src/cli.ts",
    "serve",
    "--port",
    String(opts.port),
    "--data",
    opts.dataDir,
    "--no-guardian",
    "--no-duty",
    "--no-life-log",
    "--no-feishu",
    "--no-email-watcher",
    "--no-watchdog",
    "--no-screenshot",
    ...(opts.extraArgs ?? []),
  ];

  const proc = spawn("npx", args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NERVE_SERVICES_FILE: opts.servicesFile,
    },
  });

  // Wait for server to be ready
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("nerve serve start timeout")),
      15_000
    );
    const onData = (d: Buffer) => {
      if (d.toString().includes("started on port")) {
        clearTimeout(timeout);
        proc.stdout?.off("data", onData);
        resolve();
      }
    };
    proc.stdout?.on("data", onData);
    proc.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    proc.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`nerve serve exited with code ${code}`));
      }
    });
  });

  return proc;
}

function stopProc(proc: ChildProcess): void {
  if (!proc.killed) {
    proc.kill("SIGTERM");
  }
}

// --- tests ---

describe("service-supervisor-serve integration", () => {
  describe("with services configured", () => {
    let tmpDir: string;
    let servicesFile: string;
    let markerFile: string;
    let dataDir: string;
    let port: number;
    let proc: ChildProcess | null = null;

    beforeAll(async () => {
      port = await findFreePort();
      tmpDir = mkdtempSync(join(tmpdir(), "svc-sup-serve-"));
      dataDir = join(tmpDir, "data");
      markerFile = join(tmpDir, "marker.txt");
      servicesFile = join(tmpDir, "services.json");

      // Service: cmd=node, runs once (restart=never), writes marker file via env var
      writeFileSync(
        servicesFile,
        JSON.stringify({
          services: [
            {
              name: "marker-writer",
              cmd: "node",
              args: [
                "-e",
                "require('fs').writeFileSync(process.env.NERVE_SVC_MARKER,'ok')",
              ],
              restart: "never",
              env: {
                NERVE_SVC_MARKER: markerFile,
              },
            },
          ],
        })
      );

      proc = await startNerveServe({ port, dataDir, servicesFile });
    });

    afterAll(() => {
      if (proc) stopProc(proc);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("ServiceSupervisor spawns the configured service → marker file appears", async () => {
      // Poll up to 5s for marker file
      const deadline = Date.now() + 5_000;
      while (!existsSync(markerFile) && Date.now() < deadline) {
        await sleep(100);
      }
      expect(existsSync(markerFile), `marker file should exist at ${markerFile}`).toBe(true);
    }, 10_000);
  });

  describe("with --no-services flag", () => {
    let tmpDir: string;
    let servicesFile: string;
    let markerFile: string;
    let dataDir: string;
    let port: number;
    let proc: ChildProcess | null = null;

    beforeAll(async () => {
      port = await findFreePort();
      tmpDir = mkdtempSync(join(tmpdir(), "svc-sup-serve-nosvc-"));
      dataDir = join(tmpDir, "data");
      markerFile = join(tmpDir, "marker.txt");
      servicesFile = join(tmpDir, "services.json");

      // Same services.json — but we pass --no-services to skip it
      writeFileSync(
        servicesFile,
        JSON.stringify({
          services: [
            {
              name: "marker-writer",
              cmd: "node",
              args: [
                "-e",
                "require('fs').writeFileSync(process.env.NERVE_SVC_MARKER,'ok')",
              ],
              restart: "never",
              env: {
                NERVE_SVC_MARKER: markerFile,
              },
            },
          ],
        })
      );

      proc = await startNerveServe({
        port,
        dataDir,
        servicesFile,
        extraArgs: ["--no-services"],
      });
    });

    afterAll(() => {
      if (proc) stopProc(proc);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("--no-services prevents ServiceSupervisor from running → marker file absent", async () => {
      // Give enough time for the service to have run if it were going to.
      // The service is a one-line `node -e` script that finishes in tens of
      // milliseconds, so 2s is a comfortable margin to confirm it never ran.
      await sleep(2_000);
      expect(existsSync(markerFile), `marker file should NOT exist at ${markerFile}`).toBe(false);
    }, 10_000);
  });
});

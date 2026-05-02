import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const ROOT = process.cwd();
const DATA = mkdtempSync(join(tmpdir(), "nerve-peer-auth-"));
const PEERS = join(DATA, "peers.json");
const PORT = 4910;
let proc: ChildProcess | undefined;

async function post(path: string, body: object, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function waitHealth(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

async function main(): Promise<void> {
  writeFileSync(PEERS, JSON.stringify({ name: "mac", token: "server-token", peers: {} }));
  proc = spawn("npx", ["tsx", "src/index.ts", "--port", String(PORT), "--data", DATA], {
    cwd: ROOT,
    env: { ...process.env, NERVE_PEERS_FILE: PEERS },
    stdio: "ignore",
  });
  await waitHealth();

  const localhost = await post("/peer/health", {});
  assert.equal(localhost.status, 200);
  assert.equal(localhost.json.ok, true);

  const withToken = await post("/peer/health", {}, "server-token");
  assert.equal(withToken.status, 200);
  assert.equal(withToken.json.ok, true);

  console.log("2 passed, 0 failed");
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  proc?.kill();
  rmSync(DATA, { recursive: true, force: true });
});

#!/usr/bin/env npx tsx
/**
 * Integration test: nvim bridge receives messages from Nerve server.
 */

import { spawn, ChildProcess } from "node:child_process";
import http from "node:http";

const PORT = 4850;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function httpPost(path: string, data: Record<string, unknown>): Promise<any> {
  const body = JSON.stringify(data);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "localhost",
      port: PORT,
      path,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

let server: ChildProcess;
let bridge: ChildProcess;
let passed = 0;
let failed = 0;

function assert(ok: boolean, msg: string) {
  if (ok) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.log(`  ✗ ${msg}`);
    failed++;
  }
}

async function main() {
  // Start server
  server = spawn("npx", ["tsx", "src/cli.ts", "serve", "--port", String(PORT)], {
    cwd: "/Users/renjinxi/.ai/nerve",
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Wait for server to start
  await new Promise<void>((resolve) => {
    server.stderr!.on("data", (d) => {
      const s = d.toString();
      if (s.includes("started on port")) resolve();
    });
    server.stdout!.on("data", (d) => {
      const s = d.toString();
      if (s.includes("started on port")) resolve();
    });
    setTimeout(resolve, 3000); // fallback
  });

  // Create a channel
  const ch = await httpPost("/channel/create", { cwd: "/tmp", name: "test-bridge" });
  const channelId = ch.channelId;
  assert(!!channelId, "channel created");

  // Start bridge in stdout mode (no nvim sock)
  let bridgeOutput = "";
  bridge = spawn("npx", ["tsx", "src/integration/nvim-bridge.ts", "--port", String(PORT), "--channel", channelId, "--name", "nvim-test"], {
    cwd: "/Users/renjinxi/.ai/nerve",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NVIM_LISTEN_ADDRESS: "" },
  });
  bridge.stdout!.on("data", (d) => { bridgeOutput += d.toString(); });
  bridge.stderr!.on("data", (d) => { bridgeOutput += d.toString(); });

  await sleep(2000); // wait for bridge to connect and join

  assert(bridgeOutput.includes("[bridge] connected"), "bridge connected to server");

  // Check node list — bridge should be registered
  const nodes = await httpPost("/node/list", {});
  const nvimNode = (nodes.nodes || []).find((n: any) => n.name === "nvim-test");
  assert(!!nvimNode, "bridge registered as node");

  // Post a message to the channel via HTTP (simulating another agent)
  // We need to register a "user" node first, or use an existing mechanism
  // Actually /channel/post requires the poster to be a registered node via from field
  // Let's post via /post which looks up by name — but we need a node with that name
  // For simplicity, use /channel/post with channelId
  // Hmm, /post requires from to match a registered node... Let's just use channel.post directly
  // Actually looking at the code, /post and /channel/post just require a from string and channelId
  const postResult = await httpPost("/channel/post", {
    channelId,
    from: "tester",
    content: "hello from test",
  });
  assert(!postResult.error, "message posted to channel");

  await sleep(1000);

  // Bridge should have printed the message to stdout
  assert(bridgeOutput.includes("[tester] hello from test"), "bridge received and printed message");

  console.log(`\n  ${passed} passed, ${failed} failed`);

  // Cleanup
  bridge.kill("SIGTERM");
  server.kill("SIGTERM");

  await sleep(500);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Test error: ${err.message}`);
  bridge?.kill("SIGTERM");
  server?.kill("SIGTERM");
  process.exit(1);
});

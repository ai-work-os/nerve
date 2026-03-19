#!/usr/bin/env node

import { resolve } from "node:path";
import { homedir } from "node:os";
import { Bus } from "./bus.js";
import { Server } from "./server.js";

// Parse CLI args
const args = process.argv.slice(2);
let port = 4800;
let dataDir = resolve(homedir(), ".nerve");

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === "--data" && args[i + 1]) {
    dataDir = resolve(args[i + 1]);
    i++;
  }
}

const bus = new Bus({ dataDir, port });
const server = new Server(bus, port);

server.start();

// Graceful shutdown
const shutdown = async () => {
  console.log("\n[INFO] shutting down...");
  await server.shutdown();
  console.log("[INFO] shutdown complete");
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

#!/usr/bin/env npx tsx
/**
 * nvim ↔ Nerve bridge.
 *
 * Connects to Bus server via WebSocket, registers as "nvim" node,
 * and forwards messages bidirectionally:
 *   Bus → nvim: channel.message notification → nvim --remote-expr
 *   nvim → Bus: nvim calls `nerve channel post` (HTTP, no bridge needed)
 *
 * Usage:
 *   nerve bridge [--port 4800] [--sock $NVIM_LISTEN_ADDRESS] [--channel ID]
 *
 * Or standalone:
 *   npx tsx src/nvim-bridge.ts --sock /tmp/nvim.sock --channel abc123
 */
export declare function main(argv?: string[]): Promise<void>;

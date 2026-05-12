/**
 * Scene Manager — declarative orchestration of node groups.
 *
 * A scene is a JSON config that declares nodes to spawn, a channel to create,
 * and on_ready commands to execute after all nodes are ready.
 *
 * Config files live in {dataDir}/scenes/*.json
 */

import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import * as log from "./infra/logger.js";
import type { ChannelManager } from "./channel-manager.js";

// --- Types ---

export interface SceneNodeDef {
  adapter: string;
  name?: string;
  /** Role-specific system prompt, appended to channel system prompt */
  prompt?: string;
}

export interface SceneOnReady {
  /** Target node name */
  to: string;
  /** Command to send (e.g. "start", "subscribe") */
  command: string;
  /** Target for subscribe-like commands */
  target?: string;
  /** If true, send as prompt (for AI nodes) instead of node.message (for program nodes) */
  prompt?: boolean;
}

export interface SceneConfig {
  name: string;
  nodes: SceneNodeDef[];
  channel?: {
    name?: string;
    auto_create?: boolean;
  };
  on_ready?: SceneOnReady[];
}

export interface RunningScene {
  name: string;
  config: SceneConfig;
  nodeIds: string[];
  channelId?: string;
  startedAt: number;
  /** Warnings from on_ready execution (target not found, transport dead, etc.) */
  warnings?: string[];
}

// --- Manager ---

export class SceneManager {
  private scenesDir: string;
  private running = new Map<string, RunningScene>();
  private abortControllers = new Map<string, AbortController>();
  private nodeEventListeners = new Set<(event: string, n: { id: string }) => void>();
  private nodeEventHooked = false;

  constructor(private cm: ChannelManager, dataDir: string) {
    this.scenesDir = resolve(dataDir, "scenes");
    mkdirSync(this.scenesDir, { recursive: true });
  }

  /** Install a single hook on cm.onNodeEvent that fans out to all listeners */
  private ensureNodeEventHook(): void {
    if (this.nodeEventHooked) return;
    this.nodeEventHooked = true;
    const prevHandler = this.cm.onNodeEvent;
    this.cm.onNodeEvent = (event, n, detail) => {
      prevHandler?.(event, n, detail);
      for (const listener of this.nodeEventListeners) {
        listener(event, n);
      }
    };
  }

  /** List available scene configs from disk */
  list(): Array<{ name: string; file: string; running: boolean; warnings?: string[] }> {
    if (!existsSync(this.scenesDir)) return [];

    const files = readdirSync(this.scenesDir).filter(f => f.endsWith(".json"));
    return files.map(f => {
      const config = this.loadConfig(resolve(this.scenesDir, f));
      const name = config?.name || basename(f, ".json");
      const scene = this.running.get(name);
      return { name, file: f, running: !!scene, warnings: scene?.warnings };
    }).filter(s => s.name); // skip invalid configs
  }

  /** Load a scene config by name (matches filename without .json or config.name) */
  loadConfig(pathOrName: string): SceneConfig | null {
    let filePath = pathOrName;
    if (!filePath.endsWith(".json")) {
      filePath = resolve(this.scenesDir, `${pathOrName}.json`);
    }
    if (!existsSync(filePath)) return null;

    try {
      const raw = readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as SceneConfig;
    } catch (err: any) {
      log.warn(`failed to load scene config ${filePath}: ${err.message}`);
      return null;
    }
  }

  /**
   * Wait for a node to become ready (transport alive).
   * For stdio nodes, waits for ACP handshake; for program nodes, waits for WS connect.
   * Returns true if ready, false if timed out.
   */
  private waitForReady(nodeId: string, timeoutMs = 10000): Promise<boolean> {
    const node = this.cm.nodePool.get(nodeId);
    if (!node) {
      log.warn(`waitForReady: node ${nodeId} not found`);
      return Promise.resolve(false);
    }
    // For stdio (AI) nodes, transport is alive from creation but session may not exist yet.
    // Must wait for node.ready which fires after ACP handshake (sessionId assigned).
    const isReady = node.isProcess
      ? (node.transport.alive && !!node.sessionId)
      : node.transport.alive;
    if (isReady) {
      log.debug(`waitForReady: ${node.name} already ready`);
      return Promise.resolve(true);
    }
    log.debug(`waitForReady: waiting for ${node.name} (timeout=${timeoutMs}ms)`);

    this.ensureNodeEventHook();

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        log.warn(`waitForReady: ${node.name} timed out after ${timeoutMs}ms`);
        cleanup();
        resolve(false);
      }, timeoutMs);

      const handler = (event: string, n: { id: string }) => {
        if (event === "node.ready" && n.id === nodeId) {
          log.debug(`waitForReady: ${node.name} ready`);
          cleanup();
          resolve(true);
        } else if (event === "node.stopped" && n.id === nodeId) {
          log.warn(`waitForReady: ${node.name} stopped while waiting`);
          cleanup();
          resolve(false);
        }
      };

      this.nodeEventListeners.add(handler);

      const cleanup = () => {
        clearTimeout(timer);
        this.nodeEventListeners.delete(handler);
      };
    });
  }

  /** Start a scene: spawn nodes → create channel → join → on_ready */
  async start(sceneName: string, cwd?: string): Promise<RunningScene> {
    if (this.running.has(sceneName)) {
      throw new Error(`scene "${sceneName}" is already running`);
    }

    const config = this.loadConfig(sceneName);
    if (!config) {
      throw new Error(`scene "${sceneName}" not found`);
    }

    const effectiveCwd = cwd || process.cwd();
    const nodeIds: string[] = [];
    const nodeNames: string[] = [];

    const rollbackNodes = () => {
      for (const id of nodeIds) {
        try { void this.cm.stopNode(id); } catch (e) { log.warn(`rollback stopNode ${id} failed: ${e}`); }
      }
    };

    // Step 1: Spawn all nodes
    for (const nodeDef of config.nodes) {
      const name = nodeDef.name || nodeDef.adapter;
      if (this.cm.nodePool.isNameTaken(name)) {
        log.warn(`scene ${sceneName}: node "${name}" already exists, reusing`);
        const existing = this.cm.nodePool.getByName(name);
        if (existing) {
          nodeIds.push(existing.id);
          nodeNames.push(name);
          continue;
        }
      }

      try {
        const node = await this.cm.spawnNode(nodeDef.adapter, name, effectiveCwd);
        nodeIds.push(node.id);
        nodeNames.push(node.name);
        log.info(`scene ${sceneName}: spawned ${node.name} (${node.id})`);
      } catch (err: any) {
        log.error(`scene ${sceneName}: failed to spawn ${name}: ${err.message}`);
        rollbackNodes();
        throw new Error(`failed to spawn node "${name}": ${err.message}`);
      }
    }

    // Step 2: Create or reuse channel (do NOT join nodes yet — they may not be connected)
    let channelId: string | undefined;
    if (config.channel) {
      try {
        const chName = config.channel.name || config.name;

        // Try to find existing channel by name
        const existing = this.cm.listChannels().find(ch => ch.name === chName);
        if (existing) {
          channelId = existing.id;
          log.info(`scene ${sceneName}: reusing channel "${chName}" (${channelId})`);
        } else if (config.channel.auto_create !== false) {
          const ch = this.cm.createChannel(effectiveCwd, chName);
          channelId = ch.id;
          log.info(`scene ${sceneName}: created channel "${chName}" (${channelId})`);
        }
      } catch (err: any) {
        log.error(`scene ${sceneName}: channel setup failed: ${err.message}`);
        rollbackNodes();
        throw new Error(`channel setup failed: ${err.message}`);
      }
    }

    // Register scene immediately so TUI gets fast response
    const scene: RunningScene = {
      name: sceneName,
      config,
      nodeIds,
      channelId,
      startedAt: Date.now(),
    };
    this.running.set(sceneName, scene);

    // Step 3: Async — wait for nodes ready, join channel, execute on_ready (non-blocking)
    const ac = new AbortController();
    this.abortControllers.set(sceneName, ac);
    this.executeOnReady(sceneName, scene, nodeIds, nodeNames, channelId, config, ac.signal).catch(err => {
      if (err.name !== "AbortError") {
        log.error(`scene ${sceneName}: on_ready failed: ${err.message}`);
      }
    });

    return scene;
  }

  /** Async background: wait for nodes, join channel, execute on_ready commands */
  private async executeOnReady(
    sceneName: string,
    scene: RunningScene,
    nodeIds: string[],
    nodeNames: string[],
    channelId: string | undefined,
    config: SceneConfig,
    signal: AbortSignal,
  ): Promise<void> {
    const checkAborted = () => {
      if (signal.aborted) throw new DOMException("scene stopped", "AbortError");
    };

    const warnings: string[] = [];

    // Wait for all nodes ready in parallel, track which succeeded
    const readyResults = await Promise.all(nodeIds.map(id => this.waitForReady(id)));
    checkAborted();

    const readyNodeIds = new Set<string>();
    for (let i = 0; i < nodeIds.length; i++) {
      if (readyResults[i]) {
        readyNodeIds.add(nodeIds[i]);
      } else {
        const msg = `${nodeNames[i]} not ready after timeout`;
        log.warn(`scene ${sceneName}: ${msg}`);
        warnings.push(msg);
      }
    }

    // Join only ready nodes to channel
    if (channelId) {
      for (let i = 0; i < nodeIds.length; i++) {
        if (readyNodeIds.has(nodeIds[i])) {
          this.cm.addNodeToChannel(channelId, nodeIds[i], nodeNames[i]);
          log.debug(`scene ${sceneName}: joined ${nodeNames[i]} to channel ${channelId}`);
        } else {
          log.warn(`scene ${sceneName}: skipped joining ${nodeNames[i]} to channel (not ready)`);
        }
      }
    }

    // Inject per-node prompts from scene config
    for (const nodeDef of config.nodes) {
      if (!nodeDef.prompt) continue;
      const name = nodeDef.name || nodeDef.adapter;
      const node = this.cm.nodePool.getByName(name);
      if (node?.systemPrompt) {
        node.systemPrompt += "\n\n" + nodeDef.prompt;
        log.info(`scene ${sceneName}: injected role prompt for ${name} (${nodeDef.prompt.length} chars)`);
      }
    }

    checkAborted();

    // Execute on_ready commands — only for ready nodes
    if (config.on_ready && config.on_ready.length > 0) {
      for (const cmd of config.on_ready) {
        checkAborted();
        const t0 = Date.now();

        const targetNode = this.cm.nodePool.getByName(cmd.to);
        if (!targetNode) {
          const msg = `on_ready target "${cmd.to}" not found`;
          log.warn(`scene ${sceneName}: ${msg}`);
          warnings.push(msg);
          continue;
        }

        if (!readyNodeIds.has(targetNode.id)) {
          const msg = `${cmd.to} not ready, skipped on_ready`;
          log.warn(`scene ${sceneName}: ${msg}`);
          warnings.push(msg);
          continue;
        }

        const content = cmd.target
          ? `${cmd.command} ${cmd.target}`
          : cmd.command;

        if (cmd.prompt || targetNode.isProcess) {
          const result = await this.cm.nodePool.promptNode(targetNode.id, content);
          checkAborted();
          if (result.error) {
            const msg = `${cmd.to} prompt failed: ${result.error}`;
            log.warn(`scene ${sceneName}: ${msg}`);
            warnings.push(msg);
          } else {
            log.info(`scene ${sceneName}: prompted ${cmd.to} with "${content.slice(0, 80)}..." (${Date.now() - t0}ms)`);
          }
        } else if (targetNode.transport.alive) {
          targetNode.transport.send({
            jsonrpc: "2.0",
            method: "node.message",
            params: { content, from: "scene" },
          } as any);
          log.info(`scene ${sceneName}: sent "${content}" to ${cmd.to} (${Date.now() - t0}ms)`);
        } else {
          const msg = `${cmd.to} transport not alive, skipped "${content}"`;
          log.warn(`scene ${sceneName}: ${msg}`);
          warnings.push(msg);
        }
      }
    }

    checkAborted();

    // Update scene with warnings (async)
    if (warnings.length > 0) {
      scene.warnings = warnings;
    }
    this.abortControllers.delete(sceneName);
    log.info(`scene ${sceneName}: on_ready complete`);
  }

  /** Stop a running scene: stop all nodes, optionally close channel */
  async stop(sceneName: string): Promise<void> {
    const scene = this.running.get(sceneName);
    if (!scene) {
      throw new Error(`scene "${sceneName}" is not running`);
    }

    // Abort async on_ready if still running
    const ac = this.abortControllers.get(sceneName);
    if (ac) {
      ac.abort();
      this.abortControllers.delete(sceneName);
      log.info(`scene ${sceneName}: aborted async on_ready`);
    }

    // Stop all nodes
    for (const nodeId of scene.nodeIds) {
      try {
        void this.cm.stopNode(nodeId);
      } catch (err: any) {
        log.warn(`scene ${sceneName}: failed to stop node ${nodeId}: ${err.message}`);
      }
    }

    // Close channel
    if (scene.channelId) {
      try {
        this.cm.closeChannel(scene.channelId);
      } catch (err: any) {
        log.warn(`scene ${sceneName}: failed to close channel: ${err.message}`);
      }
    }

    this.running.delete(sceneName);
    log.info(`scene ${sceneName}: stopped`);
  }

  /** Get a running scene by name */
  get(sceneName: string): RunningScene | undefined {
    return this.running.get(sceneName);
  }

  /** List running scenes */
  listRunning(): RunningScene[] {
    return [...this.running.values()];
  }
}

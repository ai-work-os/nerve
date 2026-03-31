/**
 * ASR Client — DashScope WebSocket ASR (Qwen3 realtime protocol).
 *
 * Connects to DashScope, sends PCM audio, emits transcript events.
 * Supports pending chunk buffering before session ready.
 */

import { EventEmitter } from "node:events";
import WebSocket from "ws";

export interface AsrClientConfig {
  model: string;
  apiKey: string;
  /** Override WS URL (for testing) */
  wsUrl?: string;
  sampleRate?: number;
  audioFormat?: string;
  language?: string;
}

export class AsrClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: Required<Pick<AsrClientConfig, "model" | "apiKey" | "sampleRate" | "audioFormat" | "language">> & { wsUrl: string };
  private sessionReady = false;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private stopped = false;
  private reconnecting = false;
  private hasUncommittedAudio = false;

  // 5s of 16kHz 16bit mono PCM = 160KB
  private readonly MAX_PENDING_BYTES = 160 * 1024;

  constructor(config: AsrClientConfig) {
    super();
    const model = config.model;
    this.config = {
      model,
      apiKey: config.apiKey,
      sampleRate: config.sampleRate ?? 16000,
      audioFormat: config.audioFormat ?? "pcm",
      language: config.language ?? "zh",
      wsUrl: config.wsUrl ?? `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${model}`,
    };
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.config.wsUrl, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      this.ws.on("open", () => {
        // Send session configuration
        this.ws!.send(JSON.stringify({
          type: "session.update",
          session: {
            modalities: ["text"],
            input_audio_format: this.config.audioFormat,
            sample_rate: this.config.sampleRate,
            input_audio_transcription: { language: this.config.language },
            turn_detection: { type: "server_vad" },
          },
        }));
        resolve();
      });

      this.ws.on("message", (data) => {
        let msg: any;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        this.handleMessage(msg);
      });

      this.ws.on("error", (err) => {
        this.emit("error", err);
        if (!this.sessionReady) reject(err);
      });

      this.ws.on("close", () => {
        this.sessionReady = false;
        this.emit("close");
        // Auto-reconnect if not intentionally stopped
        if (!this.stopped && !this.reconnecting) {
          this.reconnecting = true;
          setTimeout(() => {
            this.reconnecting = false;
            if (!this.stopped) {
              this.emit("reconnecting");
              this.connect().catch((err) => {
                this.emit("error", err);
              });
            }
          }, 2000);
        }
      });
    });
  }

  private handleMessage(msg: any): void {
    const type = msg?.type;

    if (type === "session.created" || type === "session.updated") {
      this.sessionReady = true;
      // Flush pending chunks
      for (const chunk of this.pending) {
        this.sendAudioRaw(chunk);
      }
      this.pending = [];
      this.pendingBytes = 0;
      this.emit("ready");
    } else if (type === "conversation.item.input_audio_transcription.completed") {
      const text = msg.transcript;
      if (text) this.emit("text", text, false);
    } else if (type === "conversation.item.input_audio_transcription.text") {
      const stash = msg.stash;
      if (stash) this.emit("text", stash, true);
    } else if (type === "error") {
      this.emit("error", new Error(msg?.error?.message || "ASR error"));
    }
  }

  sendAudio(pcm: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.sessionReady) {
      // Enforce pending buffer cap — drop oldest chunks when full
      this.pending.push(pcm);
      this.pendingBytes += pcm.length;
      while (this.pendingBytes > this.MAX_PENDING_BYTES && this.pending.length > 1) {
        const dropped = this.pending.shift()!;
        this.pendingBytes -= dropped.length;
      }
      return;
    }
    this.sendAudioRaw(pcm);
  }

  private sendAudioRaw(pcm: Buffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: pcm.toString("base64"),
      }));
      this.hasUncommittedAudio = true;
    }
  }

  commit(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.hasUncommittedAudio) {
      this.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      this.hasUncommittedAudio = false;
    }
  }

  disconnect(): void {
    this.stopped = true;
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.commit();
      }
      // Delay close to allow final transcripts
      setTimeout(() => {
        this.ws?.close();
        this.ws = null;
      }, 1000);
    }
    this.sessionReady = false;
    this.pending = [];
    this.pendingBytes = 0;
  }
}

/**
 * Thin wrapper around @larksuiteoapi/node-sdk for two operations:
 *   - subscribe to im.message.receive_v1 via long-polling WSClient
 *   - reply to a message via REST API
 *
 * Defined as an interface so tests can inject a Mock.
 */

import * as lark from "@larksuiteoapi/node-sdk";
import type { FeishuConfig } from "./config.js";

/** Subset of fields we actually use from im.message.receive_v1 payload. */
export interface ReceiveMessageEvent {
  /** Stable chat id (oc_xxx for group, p2p uses chat_id too) */
  chatId: string;
  /** Per-message unique id (om_xxx) used for reply */
  messageId: string;
  /** "text" | "post" | "image" | ... */
  messageType: string;
  /** Raw content JSON string (parse per type) */
  contentJson: string;
  /** Sender open_id or union_id (for logging only in MVP) */
  senderId?: string;
}

export interface IFeishuClient {
  start(onMessage: (evt: ReceiveMessageEvent) => void | Promise<void>): Promise<void>;
  reply(messageId: string, text: string): Promise<void>;
  stop(): Promise<void>;
}

export class FeishuClient implements IFeishuClient {
  private cfg: FeishuConfig;
  private apiClient: lark.Client;
  private wsClient?: lark.WSClient;
  private log: (level: string, msg: string) => void;

  constructor(cfg: FeishuConfig, log: (level: string, msg: string) => void = () => {}) {
    this.cfg = cfg;
    this.log = log;
    this.apiClient = new lark.Client({
      appId: cfg.app_id,
      appSecret: cfg.app_secret,
      disableTokenCache: false,
    });
  }

  async start(onMessage: (evt: ReceiveMessageEvent) => void | Promise<void>): Promise<void> {
    this.wsClient = new lark.WSClient({
      appId: this.cfg.app_id,
      appSecret: this.cfg.app_secret,
      loggerLevel: lark.LoggerLevel.warn,
    });

    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: any) => {
        const m = data?.message;
        if (!m) return;
        const evt: ReceiveMessageEvent = {
          chatId: m.chat_id,
          messageId: m.message_id,
          messageType: m.message_type,
          contentJson: m.content,
          senderId: data?.sender?.sender_id?.open_id,
        };
        try {
          await onMessage(evt);
        } catch (err: any) {
          this.log("error", `onMessage handler error: ${err?.message || err}`);
        }
      },
    });

    this.wsClient.start({ eventDispatcher: dispatcher });
    this.log("info", `feishu WSClient started (app_id=${this.cfg.app_id})`);
  }

  async reply(messageId: string, text: string): Promise<void> {
    await this.apiClient.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text }),
        msg_type: "text",
      },
    });
  }

  async stop(): Promise<void> {
    // SDK 没有显式 close；保留接口便于将来扩展
    this.wsClient = undefined;
  }
}

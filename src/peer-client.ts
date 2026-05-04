export interface PeerClientOptions {
  url: string;
  token: string;
  timeoutMs?: number;
}

export class PeerClient {
  constructor(private opts: PeerClientOptions) {}

  async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30000);
    try {
      const res = await fetch(new URL(path, this.opts.url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.opts.token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      const parsed = text ? JSON.parse(text) : {};
      if (!res.ok) {
        const msg = parsed && typeof parsed.error === "string" ? parsed.error : `peer request failed: ${res.status}`;
        throw new Error(msg);
      }
      return parsed;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Shared HTTP client + output helpers for nerve CLI commands.
 *
 * Output contract (AI-friendly):
 * - Default mode is JSON: one JSON object per command to stdout, errors to stderr as {error: "..."}.
 * - --human flag (per-command) flips to a compact human-readable rendering.
 * - Exit code is 0 on success, 1 on error.
 *
 * Host resolution: see cli/host-resolver.ts. Once `setBaseUrl()` is called from
 * the main entry, all post/get calls use that base URL.
 */

import http from "node:http";

let baseUrl = process.env.NERVE_URL || "http://localhost:4800";
let outputMode: "json" | "human" = "json";

export function setBaseUrl(url: string): void {
  baseUrl = url;
}

export function getBaseUrl(): string {
  return baseUrl;
}

export function setOutputMode(mode: "json" | "human"): void {
  outputMode = mode;
}

export function getOutputMode(): "json" | "human" {
  return outputMode;
}

/** POST JSON body, decode JSON response. */
export function post(path: string, data: Record<string, unknown> = {}): Promise<any> {
  const url = new URL(path, baseUrl);
  const body = JSON.stringify(data);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch { reject(new Error(d || `empty response (${res.statusCode})`)); }
      });
    });
    req.on("error", (e) => reject(new Error(`cannot connect to nerve at ${baseUrl}: ${e.message}`)));
    req.write(body);
    req.end();
  });
}

/** GET JSON response. */
export function get(path: string): Promise<any> {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch { reject(new Error(d || `empty response (${res.statusCode})`)); }
      });
    }).on("error", (e) => reject(new Error(`cannot connect to nerve at ${baseUrl}: ${e.message}`)));
  });
}

/** GET raw text response (used for /log). */
export function getText(path: string): Promise<string> {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => resolve(d));
    }).on("error", (e) => reject(new Error(`cannot connect to nerve at ${baseUrl}: ${e.message}`)));
  });
}

/** Print a structured result. JSON mode: compact one-line per call to stdout.
 *  Human mode: caller-supplied renderer. */
export function emit(result: unknown, humanRender?: (r: any) => string): void {
  if (outputMode === "human" && humanRender) {
    const s = humanRender(result);
    if (s) console.log(s);
    return;
  }
  console.log(JSON.stringify(result));
}

/** Print error and exit. JSON mode: {error: msg} to stderr. */
export function die(msg: string, code = 1): never {
  if (outputMode === "human") {
    console.error(`error: ${msg}`);
  } else {
    console.error(JSON.stringify({ error: msg }));
  }
  process.exit(code);
}

/** Throw if the response body has an .error field.
 *  The error may be a string or a structured object — render both readably. */
export function checkErr(result: any, contextMsg = "request failed"): any {
  if (result && typeof result === "object" && result.error) {
    const err = result.error;
    const msg = typeof err === "string" ? err : JSON.stringify(err);
    die(`${contextMsg}: ${msg}`);
  }
  return result;
}

/** Parse key=value style --args repeated flag and an optional --json '{...}'.
 *  Returns the merged object. */
export function parseArgPairs(args: string[], startFrom = 0): { rest: string[]; pairs: Record<string, any> } {
  const pairs: Record<string, any> = {};
  const rest: string[] = [];
  for (let i = startFrom; i < args.length; i++) {
    if (args[i] === "--args" && args[i + 1]) {
      const kv = args[i + 1];
      const eq = kv.indexOf("=");
      if (eq > 0) pairs[kv.slice(0, eq)] = kv.slice(eq + 1);
      i++;
    } else if (args[i] === "--json-args" && args[i + 1]) {
      try {
        const parsed = JSON.parse(args[i + 1]);
        Object.assign(pairs, parsed);
      } catch (e: any) {
        die(`invalid --json-args: ${e.message}`);
      }
      i++;
    } else {
      rest.push(args[i]);
    }
  }
  return { rest, pairs };
}

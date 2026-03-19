export function isRequest(msg) {
    return "method" in msg && "id" in msg;
}
export function isResponse(msg) {
    return "id" in msg && ("result" in msg || "error" in msg) && !("method" in msg);
}
export function isNotification(msg) {
    return "method" in msg && !("id" in msg);
}
let _nextId = 0;
export function nextId() {
    return ++_nextId;
}
export function encodeRequest(id, method, params) {
    return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}
export function encodeResponse(id, result) {
    return JSON.stringify({ jsonrpc: "2.0", id, result });
}
export function encodeError(id, code, message) {
    return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}
export function encodeNotification(method, params) {
    return JSON.stringify({ jsonrpc: "2.0", method, params });
}
// Line buffer for parsing newline-delimited JSON from stdio
export class LineBuffer {
    buf = "";
    feed(chunk) {
        this.buf += chunk;
        const lines = [];
        let idx;
        while ((idx = this.buf.indexOf("\n")) !== -1) {
            const line = this.buf.slice(0, idx).trim();
            this.buf = this.buf.slice(idx + 1);
            if (line)
                lines.push(line);
        }
        return lines;
    }
}
//# sourceMappingURL=protocol.js.map
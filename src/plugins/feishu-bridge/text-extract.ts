/**
 * Extract plain text from a Feishu message.
 *
 * 飞书 message.content 是 JSON 字符串，结构按 message_type 而异：
 *   text → {"text": "..."}        // 可能含 @_user_N 占位 mention
 *   post → {"title", "content":[[{tag:"text",text:"..."},{tag:"a",...}], ...]}
 *   其它 → 暂不支持
 */

const MENTION_PLACEHOLDER = /@_user_\d+\s*/g;

export function extractText(messageType: string, contentJson: string): string | null {
  let parsed: any;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return null;
  }

  switch (messageType) {
    case "text": {
      const raw = typeof parsed?.text === "string" ? parsed.text : "";
      const stripped = raw.replace(MENTION_PLACEHOLDER, "").trim();
      return stripped.length > 0 ? stripped : null;
    }

    case "post": {
      const parts: string[] = [];
      const content = parsed?.content;
      if (Array.isArray(content)) {
        for (const line of content) {
          if (!Array.isArray(line)) continue;
          for (const node of line) {
            if (node?.tag === "text" && typeof node.text === "string") {
              parts.push(node.text);
            }
          }
        }
      }
      const joined = parts.join("").replace(MENTION_PLACEHOLDER, "").trim();
      return joined.length > 0 ? joined : null;
    }

    default:
      return null;
  }
}

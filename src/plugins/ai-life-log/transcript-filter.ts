/**
 * TranscriptFilter — 拦截 ASR 在静音/外部音频上的幻听产出和复读。
 *
 * 规则（按 punct → filler → dup 顺序判定）：
 *  1. 纯标点/空白：去掉空白和常见标点后为空 → 丢
 *  2. 单短语气词白名单：去掉尾标点后小写匹配白名单 → 丢
 *  3. 与上一条 accepted 文本 trim 后完全相同 → 丢
 *
 * 中文单字（对/好/是/不等）刻意保留——它们在对话里携带语义。
 * 状态：lastAccepted（只被 accept=true 的输入更新）+ stats（计数器）。
 */

const PUNCT_RE = /[.。,，!！?？;；:：、~～…—\-]/gu;
const TRAIL_PUNCT_RE = /[.。,，!！?？;；:：、~～…—\-\s]+$/u;

const FILLER_WHITELIST = new Set([
  "yeah", "oh", "okay", "ok", "mmm", "hmm", "ah", "uh", "um",
  "well", "so", "the", "yes", "no", "u", "i", "and", "right", "you",
  "う", "あ", "そ", "は", "よ", "ね",
  "嗯", "啊", "哦", "呃", "噢", "哈",
]);

export interface FilterStats {
  dropped: number;
  byReason: { punct: number; filler: number; dup: number };
}

export class TranscriptFilter {
  private lastAccepted = "";
  private stats: FilterStats = {
    dropped: 0,
    byReason: { punct: 0, filler: 0, dup: 0 },
  };

  /** True = keep (write to log), False = drop (silently). */
  accept(text: string): boolean {
    const trimmed = text.trim();

    if (trimmed.replace(PUNCT_RE, "").replace(/\s/gu, "").length === 0) {
      this.stats.dropped++;
      this.stats.byReason.punct++;
      return false;
    }

    const core = trimmed.replace(TRAIL_PUNCT_RE, "").toLowerCase();
    if (FILLER_WHITELIST.has(core)) {
      this.stats.dropped++;
      this.stats.byReason.filler++;
      return false;
    }

    if (trimmed === this.lastAccepted) {
      this.stats.dropped++;
      this.stats.byReason.dup++;
      return false;
    }

    this.lastAccepted = trimmed;
    return true;
  }

  getStats(): FilterStats {
    return {
      dropped: this.stats.dropped,
      byReason: { ...this.stats.byReason },
    };
  }

  resetStats(): void {
    this.stats = { dropped: 0, byReason: { punct: 0, filler: 0, dup: 0 } };
  }
}

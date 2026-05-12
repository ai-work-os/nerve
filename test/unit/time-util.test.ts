import { describe, it, expect } from "vitest";
import { localIso, localTimeOnly } from "../../src/infra/time-util.js";

describe("localTimeOnly", () => {
  it("formats HH:MM:SS in local time", () => {
    const orig = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = () => -480; // UTC+8
    try {
      // 03:19:47Z = 11:19:47 in UTC+8
      const d = new Date("2026-05-08T03:19:47.123Z");
      // Note: getTimezoneOffset mock alone won't change getHours(); but if the
      // underlying system IS UTC+8 this matches. We assert on getHours()-derived
      // expected to keep test environment-independent.
      const expected = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
      expect(localTimeOnly(d)).toBe(expected);
    } finally {
      Date.prototype.getTimezoneOffset = orig;
    }
  });

  it("matches /^\\d{2}:\\d{2}:\\d{2}$/", () => {
    expect(localTimeOnly(new Date())).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("does NOT round-trip through toISOString (the old buggy behavior)", () => {
    // Old code: new Date(ts).toISOString().slice(11, 19) — UTC, wrong on
    // any non-UTC machine. Verify that we DON'T do that.
    const d = new Date("2026-05-08T03:19:47.000Z");
    const utcSlice = d.toISOString().slice(11, 19); // "03:19:47"
    const localOnly = localTimeOnly(d);
    // On any TZ != UTC these MUST differ. On UTC they coincidentally match,
    // so we only assert difference when offset is non-zero.
    if (d.getTimezoneOffset() !== 0) {
      expect(localOnly).not.toBe(utcSlice);
    }
    // And the local one matches local Date getters
    expect(localOnly).toBe(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`);
  });
});

describe("localIso", () => {
  it("matches ISO 8601 local-with-offset shape", () => {
    const s = localIso(new Date("2026-05-08T03:19:47.123Z"));
    // YYYY-MM-DDTHH:MM:SS.sss±HH:MM — exact form depends on system TZ at runtime
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  });

  it("round-trips through new Date(s) to the same instant", () => {
    const orig = new Date("2026-05-08T03:19:47.123Z");
    const s = localIso(orig);
    const parsed = new Date(s);
    expect(parsed.getTime()).toBe(orig.getTime());
  });

  it("keeps wall-clock fields agreeing with local Date getters", () => {
    const d = new Date("2026-05-08T03:19:47.123Z");
    const s = localIso(d);
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    const want =
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
      `.${pad(d.getMilliseconds(), 3)}`;
    expect(s.startsWith(want)).toBe(true);
  });

  it("formats offset for known TZ inputs (mock via Date prototype)", () => {
    // Force getTimezoneOffset to claim UTC+8 (Asia/Shanghai). Date in JS reports
    // the offset as -minutes, so +08:00 is -480.
    const d = new Date("2026-05-08T03:19:47.123Z");
    const orig = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = () => -480;
    try {
      const s = localIso(d);
      expect(s.endsWith("+08:00")).toBe(true);
    } finally {
      Date.prototype.getTimezoneOffset = orig;
    }
  });

  it("formats negative offsets (e.g. UTC-5)", () => {
    const d = new Date("2026-05-08T03:19:47.123Z");
    const orig = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = () => 300; // UTC-5
    try {
      const s = localIso(d);
      expect(s.endsWith("-05:00")).toBe(true);
    } finally {
      Date.prototype.getTimezoneOffset = orig;
    }
  });

  it("formats half-hour offsets (e.g. India UTC+5:30)", () => {
    const d = new Date("2026-05-08T03:19:47.123Z");
    const orig = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = () => -330; // UTC+5:30
    try {
      const s = localIso(d);
      expect(s.endsWith("+05:30")).toBe(true);
    } finally {
      Date.prototype.getTimezoneOffset = orig;
    }
  });
});

import { describe, it, expect } from "vitest";
import { localIso } from "../../src/time-util.js";

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

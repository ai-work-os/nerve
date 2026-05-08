/**
 * ISO 8601 timestamp in **local time** with explicit numeric offset.
 *
 * Example output: `2026-05-08T11:19:47.123+08:00`
 *
 * Why not `Date.toISOString()` (which always normalizes to UTC + `Z`)?
 * On a machine in `Asia/Shanghai`, the OS clock and `tail`'d logs all read in
 * local time, but `toISOString()` writes `2026-05-08T03:19:47Z` — readers see
 * an apparent 8-hour skew across log files (some local, some UTC) and call it
 * "时差" even though wall clocks are perfectly aligned. Local-with-offset is
 * unambiguous (still valid ISO 8601, parses with `new Date(s)`) AND visually
 * matches what the user sees on `date`.
 */
export function localIso(d: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const offStr = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}${offStr}`
  );
}

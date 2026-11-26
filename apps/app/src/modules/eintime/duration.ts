/**
 * Flexible duration input (spec eintime FR-008): "2", "2.5", "2h 30min",
 * "1:30", "90m" all parse to minutes. Plain numbers read as hours; "h:mm"
 * reads as hours:minutes; unit groups combine.
 */
export function parseDurationMinutes(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (s === "") return null;

  const hm = /^(\d+)\s*:\s*(\d{1,2})$/.exec(s);
  if (hm) {
    const mins = Number(hm[2]);
    if (mins >= 60) return null;
    return Number(hm[1]) * 60 + mins;
  }

  const unitRe = /(\d+(?:[.,]\d+)?)\s*(h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?)/g;
  if (unitRe.test(s)) {
    unitRe.lastIndex = 0;
    let total = 0;
    let consumed = "";
    for (const m of s.matchAll(unitRe)) {
      consumed += m[0];
      const val = Number((m[1] ?? "").replace(",", "."));
      total += (m[2] ?? "m").startsWith("h") ? val * 60 : val;
    }
    // The whole input must consist of unit groups and separators only.
    if (s.replace(/[\s,]+/g, "") !== consumed.replace(/[\s,]+/g, "")) return null;
    return Math.round(total * 100) / 100;
  }

  const n = /^(\d+(?:[.,]\d+)?)$/.exec(s);
  if (n) {
    const v = Number((n[1] ?? "").replace(",", "."));
    if (!Number.isFinite(v) || v < 0) return null;
    return Math.round(v * 60 * 100) / 100;
  }
  return null;
}

/** Format minutes as `h:mm` (e.g. 90 → "1:30"). */
export function formatDuration(minutes: number): string {
  const m = Math.round(minutes);
  return `${Math.floor(m / 60)}:${String(Math.abs(m) % 60).padStart(2, "0")}`;
}

/**
 * EinTime day segmentation (spec eintime FR-005): entries are stored as one row
 * but served split at local midnight so every day surface (list, grid, sheet,
 * report) sees exact per-day totals. `tzOffsetMin` uses `Date.getTimezoneOffset()`
 * semantics — minutes to add to local time to get UTC (Berlin UTC+1 → -60).
 */

export interface Segmentable {
  id: string;
  start: string;
  end: string | null;
}

export interface DaySegment<T extends Segmentable> {
  entryId: string;
  /** Local day key `YYYY-MM-DD` the segment belongs to. */
  day: string;
  segStart: string;
  segEnd: string;
  /** True when the source entry is still running (end null). */
  running: boolean;
  entry: T;
}

/** Local day key for a UTC instant. */
export function segmentDayKey(utcMs: number, tzOffsetMin: number): string {
  return new Date(utcMs - tzOffsetMin * 60_000).toISOString().slice(0, 10);
}

/** UTC instant of local midnight starting `day` (`YYYY-MM-DD`). */
export function segmentDayStartMs(day: string, tzOffsetMin: number): number {
  return Date.parse(`${day}T00:00:00Z`) + tzOffsetMin * 60_000;
}

/** Split one entry into day segments; a running entry segments up to `now`. */
export function segmentEntry<T extends Segmentable>(
  entry: T,
  now: Date,
  tzOffsetMin = 0,
): DaySegment<T>[] {
  const startMs = Date.parse(entry.start);
  const endMs = entry.end === null ? now.getTime() : Date.parse(entry.end);
  const running = entry.end === null;
  // Degenerate zero-length entries still surface once so nothing is lost.
  if (endMs <= startMs) {
    return [
      {
        entryId: entry.id,
        day: segmentDayKey(startMs, tzOffsetMin),
        segStart: entry.start,
        segEnd: entry.end ?? now.toISOString(),
        running,
        entry,
      },
    ];
  }
  const out: DaySegment<T>[] = [];
  let cur = startMs;
  while (cur < endMs) {
    const day = segmentDayKey(cur, tzOffsetMin);
    const nextBoundary = segmentDayStartMs(day, tzOffsetMin) + 86_400_000;
    const segEnd = Math.min(endMs, nextBoundary);
    out.push({
      entryId: entry.id,
      day,
      segStart: new Date(cur).toISOString(),
      segEnd: new Date(segEnd).toISOString(),
      running,
      entry,
    });
    cur = segEnd;
  }
  return out;
}

export function segmentEntries<T extends Segmentable>(
  entries: T[],
  now: Date,
  tzOffsetMin = 0,
): DaySegment<T>[] {
  return entries.flatMap((e) => segmentEntry(e, now, tzOffsetMin));
}

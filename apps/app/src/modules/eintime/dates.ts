/** Local day key `YYYY-MM-DD` for a Date. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local midnight of a `YYYY-MM-DD` day key. */
export function dayStart(key: string): Date {
  return new Date(`${key}T00:00:00`);
}

/** Monday of the week containing `d` (ISO week, spec assumption: week starts Monday). */
export function weekStart(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** The `days` consecutive day keys starting at `first`. */
export function dayKeys(first: Date, days: number): string[] {
  return Array.from({ length: days }, (_, i) => dayKey(addDays(first, i)));
}

/** `[from, to)` ISO range covering the given local day keys (expects a non-empty array). */
export function dayRangeIso(keys: string[]): { from: string; to: string } {
  const first = keys[0] ?? "1970-01-01";
  const last = keys[keys.length - 1] ?? first;
  return {
    from: dayStart(first).toISOString(),
    to: addDays(dayStart(last), 1).toISOString(),
  };
}

/** ISO instant `mins` minutes after local midnight of a day key. */
export function dayIso(day: string, mins: number): string {
  return new Date(dayStart(day).getTime() + mins * 60_000).toISOString();
}

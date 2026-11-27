/** Display-only formatting for EinPill projections. */
export function formatPills(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(value);
}

export function formatDate(date: string | null, locale: string): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

export function todayInputValue(): string {
  return new Date().toISOString().slice(0, 10);
}

export function validDailyUsage(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value > 0 &&
    value <= 100 &&
    Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7
  );
}

export function validPillsPerPackage(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 10_000;
}

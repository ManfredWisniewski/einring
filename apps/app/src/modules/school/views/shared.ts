/** Shared school-view helpers (D56): dates are local YYYY-MM-DD strings. */

export const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
};

export const addDaysLocal = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
};

export const weekStart = (date: string) => {
  const d = new Date(`${date}T12:00:00`);
  const wd = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - wd);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
};

export const fmtDate = (iso: string | null | undefined, lang: string) =>
  iso
    ? new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(new Date(`${iso}T12:00:00`))
    : "—";

export const fmtCents = (cents: number | null | undefined, lang: string, currency = "EUR") =>
  cents == null
    ? "—"
    : new Intl.NumberFormat(lang, { style: "currency", currency }).format(cents / 100);

/** Current Berlin month `YYYY-MM`. */
export const currentPeriod = () => todayLocal().slice(0, 7);

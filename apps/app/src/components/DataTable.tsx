import { useTranslation } from "react-i18next";
import type { TableColumn, TableRow } from "~/api/types";
import i18n from "~/i18n";

/** i18n language → Intl locale (de/fr/ru use the comma decimal separator). */
const NUMBER_LOCALES: Record<string, string> = {
  de: "de-DE",
  en: "en-US",
  fr: "fr-FR",
  ru: "ru-RU",
};
const numberFormats = new Map<string, Intl.NumberFormat>();

export function formatNumber(n: number, digits?: number): string {
  const lang = (i18n.resolvedLanguage ?? i18n.language ?? "en").split("-")[0] ?? "en";
  const locale = NUMBER_LOCALES[lang] ?? "en-US";
  const key = `${locale}:${digits ?? ""}`;
  let f = numberFormats.get(key);
  if (!f) {
    f =
      digits === undefined
        ? new Intl.NumberFormat(locale)
        : new Intl.NumberFormat(locale, {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
          });
    numberFormats.set(key, f);
  }
  return f.format(n);
}

export function formatCell(value: unknown, t: (key: string) => string): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean") return t(value ? "common.yes" : "common.no");
  if (typeof value === "number") return formatNumber(value);
  if (Array.isArray(value)) return value.map((v) => formatCell(v, t)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function DataTable({ columns, rows }: { columns: TableColumn[]; rows: TableRow[] }) {
  const { t } = useTranslation();
  if (rows.length === 0) return <p className="muted">{t("modules.tables.empty")}</p>;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.id} scope="col">
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              {columns.map((c) => (
                <td key={c.id}>{formatCell(r.cells[String(c.id)], t)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

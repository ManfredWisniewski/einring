import { useTranslation } from "react-i18next";
import type { TableColumn, TableRow } from "@/api/types";

export function formatCell(value: unknown, t: (key: string) => string): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean") return t(value ? "common.yes" : "common.no");
  if (Array.isArray(value)) return value.map((v) => formatCell(v, t)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function DataTable({ columns, rows }: { columns: TableColumn[]; rows: TableRow[] }) {
  const { t } = useTranslation();
  if (rows.length === 0) return <p className="muted">{t("tables.empty")}</p>;
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

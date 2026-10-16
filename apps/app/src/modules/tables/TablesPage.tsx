import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/client";
import { useCurrentTable, useNextcloudConnection } from "@/api/hooks";
import { DataTable } from "@/components/DataTable";
import { NextcloudGate } from "@/components/NextcloudGate";
import { Button } from "@/components/ui/button";

export function TablesPage() {
  return (
    <NextcloudGate>
      <TablesContent />
    </NextcloudGate>
  );
}

function TablesContent() {
  const { t } = useTranslation();
  const connected = useNextcloudConnection().data?.status === "connected";
  const table = useCurrentTable(connected);

  return (
    <>
      {table.isPending && <p className="muted">{t("modules.tables.loading")}</p>}
      {table.isError && (
        <div className="alert alert--danger row">
          <span>
            {t("modules.tables.error", {
              status: table.error instanceof ApiError ? table.error.status : "?",
            })}
          </span>
          <Button variant="outline" onClick={() => void table.refetch()}>
            {t("modules.tables.retry")}
          </Button>
        </div>
      )}
      {table.data && (
        <section className="stack">
          <h2>
            {table.data.emoji ? `${table.data.emoji} ` : ""}
            {table.data.title}{" "}
            <span className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
              {t("modules.tables.rowCount", { count: table.data.rows.length })}
            </span>
          </h2>
          <DataTable columns={table.data.columns} rows={table.data.rows} />
        </section>
      )}
    </>
  );
}

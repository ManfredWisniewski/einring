import { Button } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/client";
import { useCurrentTable, useDisconnectNextcloud, useNextcloudConnection } from "@/api/hooks";
import { DataTable } from "@/components/DataTable";
import { NextcloudConnect } from "@/components/NextcloudConnect";

export function TablesPage() {
  const { t } = useTranslation();
  const connection = useNextcloudConnection();
  const disconnect = useDisconnectNextcloud();
  const connected = connection.data?.status === "connected";
  const table = useCurrentTable(connected);

  if (connection.isPending) return <p className="muted">{t("tables.loading")}</p>;
  if (connection.isError) {
    const status = connection.error instanceof ApiError ? connection.error.status : "?";
    return <p className="alert alert--danger">{t("nextcloud.error", { status })}</p>;
  }
  if (!connected || connection.data.status !== "connected") return <NextcloudConnect />;

  return (
    <div className="stack">
      <div className="row muted">
        <span>
          {t("nextcloud.connectedAs", {
            loginName: connection.data.loginName,
            server: connection.data.server,
          })}
        </span>
        <Button className="btn btn--ghost" onPress={() => disconnect.mutate()}>
          {t("nextcloud.disconnect")}
        </Button>
      </div>

      {table.isPending && <p className="muted">{t("tables.loading")}</p>}
      {table.isError && (
        <div className="alert alert--danger row">
          <span>
            {t("tables.error", {
              status: table.error instanceof ApiError ? table.error.status : "?",
            })}
          </span>
          <Button className="btn" onPress={() => void table.refetch()}>
            {t("tables.retry")}
          </Button>
        </div>
      )}
      {table.data && (
        <section className="stack">
          <h2>
            {table.data.emoji ? `${table.data.emoji} ` : ""}
            {table.data.title}{" "}
            <span className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
              {t("tables.rowCount", { count: table.data.rows.length })}
            </span>
          </h2>
          <DataTable columns={table.data.columns} rows={table.data.rows} />
        </section>
      )}
    </div>
  );
}

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError } from "~/api/client";
import {
  useConnectorDisconnect,
  useConnectorStatus,
  useStalwartInfo,
  useStalwartPrincipals,
} from "~/api/hooks";
import type { StalwartPrincipal } from "~/api/types";
import { ConnectorPage } from "~/components/ConnectorPage";

function PrincipalRow({ p }: { p: StalwartPrincipal }) {
  return (
    <div className="row" style={{ justifyContent: "space-between" }}>
      <span>{p.name ?? p.id}</span>
      <span className="muted">
        {p.email}
        {p.description ? ` · ${p.description}` : ""}
      </span>
    </div>
  );
}

function Section({
  title,
  items,
}: {
  title: string;
  items: { id: string; name?: string | null; email?: string | null; description?: string | null }[];
}) {
  if (!items.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="stack" style={{ gap: "var(--space-1)" }}>
        {items.map((p) => (
          <PrincipalRow
            key={p.id}
            p={{
              id: p.id,
              name: p.name ?? null,
              email: p.email ?? null,
              description: p.description ?? null,
            }}
          />
        ))}
      </CardContent>
    </Card>
  );
}

export function StalwartPage() {
  const { t } = useTranslation();
  const status = useConnectorStatus("stalwart");
  const disconnect = useConnectorDisconnect("stalwart");
  const connected = status.data?.connected === true;
  const info = useStalwartInfo(connected);
  const principals = useStalwartPrincipals(connected);

  if (!connected) return <ConnectorPage service="stalwart" userPass />;

  const err = info.error ?? principals.error;
  const p = principals.data;

  return (
    <div className="stack">
      <div className="row einhub-header">
        <p className="muted">{t("modules.stalwart.connectedAs", { url: status.data?.url })}</p>
        <Button
          variant="outlined"
          size="sm"
          onClick={() => disconnect.mutate()}
          disabled={disconnect.isPending}
        >
          {disconnect.isPending
            ? t("modules.stalwart.disconnecting")
            : t("modules.stalwart.disconnect")}
        </Button>
      </div>
      {(info.isPending || principals.isPending) && <p className="muted">{t("common.loading")}</p>}
      {err && (
        <div className="alert alert--danger">
          {t("modules.stalwart.error", {
            status: err instanceof ApiError ? err.status : "?",
          })}
        </div>
      )}
      {info.data && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("modules.stalwart.capabilities")}</CardTitle>
            <CardDescription>{info.data.apiUrl}</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="muted">{info.data.capabilities.join(", ")}</p>
          </CardContent>
        </Card>
      )}
      {p && (
        <>
          <Section title={t("modules.stalwart.accounts")} items={p.accounts} />
          <Section title={t("modules.stalwart.groups")} items={p.groups} />
          <Section title={t("modules.stalwart.lists")} items={p.lists} />
          <Section title={t("modules.stalwart.roles")} items={p.roles} />
          <Section title={t("modules.stalwart.domains")} items={p.domains} />
          <Section
            title={t("modules.stalwart.mailDomains")}
            items={p.mailDomains.map((d) => ({ id: d.id, name: d.name }))}
          />
          {!p.accounts.length &&
            !p.groups.length &&
            !p.lists.length &&
            !p.roles.length &&
            !p.domains.length &&
            !p.mailDomains.length && <p className="muted">{t("modules.stalwart.empty")}</p>}
        </>
      )}
    </div>
  );
}

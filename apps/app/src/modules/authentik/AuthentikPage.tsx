import { useTranslation } from "react-i18next";
import { useConnectorDisconnect, useConnectorStatus } from "@/api/hooks";
import { AuthentikStatusView } from "@/components/AuthentikStatus";
import { ConnectorPage } from "@/components/ConnectorPage";
import { Button } from "@/components/ui/button";

export function AuthentikPage() {
  const { t } = useTranslation();
  const status = useConnectorStatus("authentik");
  const disconnect = useConnectorDisconnect("authentik");
  const connected = status.data?.connected === true;

  if (!connected) return <ConnectorPage service="authentik" />;

  return (
    <div className="stack">
      <div className="row einhub-header">
        <p className="muted">{t("modules.authentik.connectedAs", { url: status.data?.url })}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => disconnect.mutate()}
          disabled={disconnect.isPending}
        >
          {disconnect.isPending
            ? t("modules.authentik.disconnecting")
            : t("modules.authentik.disconnect")}
        </Button>
      </div>
      <p className="muted">{t("modules.authentik.monitorHint")}</p>
      <AuthentikStatusView />
    </div>
  );
}

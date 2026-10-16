import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/client";
import { useDisconnectNextcloud, useNextcloudConnection } from "@/api/hooks";
import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { isEmbedded } from "@/embedded";
import { NextcloudConnect } from "./NextcloudConnect";

/**
 * Service gate for modules that require Nextcloud: renders the connect card until
 * credentials exist, then the connected-as row and the module content.
 */
export function NextcloudGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { logout } = useAuth();
  const connection = useNextcloudConnection();
  const disconnect = useDisconnectNextcloud();

  // Embedded: disconnect = logout — it drops the credential AND the session server-side
  // and clears the local session token.
  const onDisconnect = () => (isEmbedded() ? void logout() : disconnect.mutate());

  if (connection.isPending) return <p className="muted">{t("common.loading")}</p>;
  if (connection.isError) {
    const status = connection.error instanceof ApiError ? connection.error.status : "?";
    return <p className="alert alert--danger">{t("nextcloud.error", { status })}</p>;
  }
  if (connection.data?.status !== "connected") return <NextcloudConnect />;

  return (
    <div className="stack">
      <div className="row muted">
        <span>
          {t("nextcloud.connectedAs", {
            user: connection.data.displayName ?? connection.data.loginName,
            server: connection.data.server,
          })}
        </span>
        <Button variant="ghost" size="sm" onClick={onDisconnect}>
          {t("nextcloud.disconnect")}
        </Button>
      </div>
      {children}
    </div>
  );
}

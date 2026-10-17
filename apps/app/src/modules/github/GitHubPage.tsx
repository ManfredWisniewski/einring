import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/client";
import { useConnectorDisconnect, useConnectorStatus, useGitHubNotifications } from "@/api/hooks";
import type { GitHubNotification } from "@/api/types";
import { ConnectorPage } from "@/components/ConnectorPage";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** One notification thread — clicking opens the upstream subject (PR, issue, …). */
function ThreadRow({ n }: { n: GitHubNotification }) {
  const inner = (
    <CardHeader>
      <CardTitle className="text-base">
        {n.reason}: {n.title}
      </CardTitle>
      <CardDescription>
        {n.type}
        {n.repo ? ` · ${n.repo}` : ""}
        {n.updatedAt ? ` · ${new Date(n.updatedAt).toLocaleString()}` : ""}
      </CardDescription>
    </CardHeader>
  );
  return (
    <Card>
      {n.url ? (
        <a href={n.url} target="_blank" rel="noreferrer" className="block">
          {inner}
        </a>
      ) : (
        inner
      )}
    </Card>
  );
}

export function GitHubPage() {
  const { t } = useTranslation();
  const status = useConnectorStatus("github");
  const disconnect = useConnectorDisconnect("github");
  const connected = status.data?.connected === true;
  const feed = useGitHubNotifications(connected);

  if (!connected) return <ConnectorPage service="github" />;

  return (
    <div className="stack">
      <div className="row einhub-header">
        <p className="muted">{t("modules.github.connectedAs", { url: status.data?.url })}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => disconnect.mutate()}
          disabled={disconnect.isPending}
        >
          {disconnect.isPending
            ? t("modules.github.disconnecting")
            : t("modules.github.disconnect")}
        </Button>
      </div>
      {feed.isPending && <p className="muted">{t("common.loading")}</p>}
      {feed.isError && (
        <div className="alert alert--danger">
          {t("modules.github.error", {
            status: feed.error instanceof ApiError ? feed.error.status : "?",
          })}
        </div>
      )}
      {feed.data?.notifications.length === 0 && (
        <p className="muted">{t("modules.github.empty")}</p>
      )}
      {feed.data?.notifications.map((n) => (
        <ThreadRow key={n.id} n={n} />
      ))}
    </div>
  );
}

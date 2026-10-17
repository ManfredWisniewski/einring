import DOMPurify from "dompurify";
import { marked } from "marked";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/client";
import {
  useConnectorDisconnect,
  useConnectorStatus,
  useGotifyApplications,
  useGotifyCreateApp,
  useGotifyDeleteAll,
  useGotifyDeleteApp,
  useGotifyDeleteMessage,
  useGotifyMessages,
  useGotifyStream,
  useGotifyUser,
} from "@/api/hooks";
import type { GotifyMessage } from "@/api/types";
import { ConnectorPage } from "@/components/ConnectorPage";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Priority dot: Gotify priorities — ≥8 alert, ≥4 noticeable, else low. */
function prioClass(priority: number): string {
  if (priority >= 8) return "status-dot status-dot--dnd";
  if (priority >= 4) return "status-dot status-dot--away";
  return "status-dot status-dot--offline";
}

/** One expandable message row — body renders as markdown when declared so. */
function MessageRow({ msg, appName }: { msg: GotifyMessage; appName: string | undefined }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const del = useGotifyDeleteMessage();
  const html =
    open && msg.contentType === "text/markdown"
      ? DOMPurify.sanitize(marked.parse(msg.message) as string)
      : null;

  return (
    <Card>
      <button
        type="button"
        className="w-full text-left"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <span className={prioClass(msg.priority)} aria-hidden />
            {msg.title || t("modules.gotify.noTitle")}
          </CardTitle>
          <CardDescription>
            {appName ?? `#${msg.appId}`} · {new Date(msg.date).toLocaleString()}
          </CardDescription>
        </CardHeader>
      </button>
      {open && (
        <CardContent>
          {html ? (
            // Sanitized by DOMPurify; source is the user's own Gotify server.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown rendered through DOMPurify
            <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <p className="email-text">{msg.message}</p>
          )}
          <div className="row">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => del.mutate(msg.id)}
              disabled={del.isPending}
            >
              {del.isPending ? t("modules.gotify.deleting") : t("modules.gotify.delete")}
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function ApplicationsSection() {
  const { t } = useTranslation();
  const apps = useGotifyApplications();
  const create = useGotifyCreateApp();
  const del = useGotifyDeleteApp();
  const [name, setName] = useState("");
  const nameId = "gotify-app-name";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("modules.gotify.apps")}</CardTitle>
        <CardDescription>{t("modules.gotify.appsHint")}</CardDescription>
      </CardHeader>
      <CardContent className="stack">
        {(apps.data?.applications ?? []).map((a) => (
          <div key={a.id} className="status-item">
            <div className="grow">
              <div>{a.name}</div>
              <div className="muted">{a.description || a.token}</div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => del.mutate(a.id)}
              disabled={del.isPending}
            >
              {t("modules.gotify.delete")}
            </Button>
          </div>
        ))}
        <div className="row" style={{ alignItems: "end" }}>
          <div className="flex flex-col gap-1 grow">
            <Label htmlFor={nameId}>{t("modules.gotify.newApp")}</Label>
            <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <Button
            onClick={() => create.mutate({ name: name.trim() })}
            disabled={create.isPending || !name.trim()}
          >
            {create.isPending ? t("modules.gotify.creating") : t("modules.gotify.create")}
          </Button>
        </div>
        {create.data && (
          <div className="alert alert--success">
            {t("modules.gotify.appCreated", { token: create.data.application.token })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function GotifyPage() {
  const { t } = useTranslation();
  const status = useConnectorStatus("gotify");
  const connected = status.data?.connected === true;
  const list = useGotifyMessages(connected);
  const apps = useGotifyApplications(connected);
  const user = useGotifyUser(connected);
  const disconnect = useConnectorDisconnect("gotify");
  const delAll = useGotifyDeleteAll();
  const [filter, setFilter] = useState<number | null>(null);
  useGotifyStream(connected);

  if (status.isPending) return <p className="muted">{t("common.loading")}</p>;
  if (status.isError || !connected) return <ConnectorPage service="gotify" userPass />;

  const appName = (id: number) => apps.data?.applications.find((a) => a.id === id)?.name;
  const messages = (list.data?.messages ?? []).filter((m) => filter === null || m.appId === filter);

  return (
    <div className="stack">
      <div className="row">
        {user.data && (
          <p className="muted">{t("modules.gotify.connectedAs", { name: user.data.name })}</p>
        )}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => disconnect.mutate()}
          disabled={disconnect.isPending}
        >
          {disconnect.isPending
            ? t("modules.gotify.disconnecting")
            : t("modules.gotify.disconnect")}
        </Button>
      </div>
      <div className="row">
        {(apps.data?.applications ?? []).length > 1 && (
          <>
            <Button
              variant={filter === null ? "default" : "outline"}
              size="sm"
              onClick={() => setFilter(null)}
            >
              {t("modules.gotify.allApps")}
            </Button>
            {(apps.data?.applications ?? []).map((a) => (
              <Button
                key={a.id}
                variant={filter === a.id ? "default" : "outline"}
                size="sm"
                onClick={() => setFilter(a.id)}
              >
                {a.name}
              </Button>
            ))}
          </>
        )}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => delAll.mutate()}
          disabled={delAll.isPending || !list.data?.messages.length}
        >
          {delAll.isPending ? t("modules.gotify.deleting") : t("modules.gotify.deleteAll")}
        </Button>
      </div>
      {list.isError && (
        <div className="alert alert--danger">
          {t("modules.gotify.error", {
            status: list.error instanceof ApiError ? list.error.status : "?",
          })}
        </div>
      )}
      {list.isPending && <p className="muted">{t("common.loading")}</p>}
      {!messages.length && !list.isPending && <p className="muted">{t("modules.gotify.empty")}</p>}
      {messages.map((m) => (
        <MessageRow key={m.id} msg={m} appName={appName(m.appId)} />
      ))}
      <ApplicationsSection />
    </div>
  );
}

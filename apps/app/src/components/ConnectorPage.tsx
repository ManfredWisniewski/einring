import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/client";
import { useConnectorConnect, useConnectorDisconnect, useConnectorStatus } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Shared connect/disconnect screen for connector modules (D41). `service` is the
 * module id — routes are `/api/<service>/status|credentials`. `userPass` swaps the
 * apiKey field for username+password (e.g. Navidrome's Subsonic auth).
 * i18n keys live under `modules.<service>.*`.
 */
export function ConnectorPage({ service, userPass }: { service: string; userPass?: boolean }) {
  const { t } = useTranslation();
  const keyId = useId();
  const userId = useId();
  const urlId = useId();
  const status = useConnectorStatus(service);
  const connect = useConnectorConnect(service);
  const disconnect = useConnectorDisconnect(service);
  const [apiKey, setApiKey] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [url, setUrl] = useState("");

  if (status.isPending) return <p className="muted">{t("common.loading")}</p>;
  if (status.isError) {
    const s = status.error instanceof ApiError ? status.error.status : "?";
    return (
      <div className="alert alert--danger">{t(`modules.${service}.error`, { status: s })}</div>
    );
  }

  const errStatus = connect.error instanceof ApiError ? connect.error.status : null;

  if (status.data?.connected) {
    return (
      <div className="stack">
        <div className="alert alert--success">
          {t(`modules.${service}.connected`, { url: status.data.url })}
        </div>
        <div className="row">
          <Button
            variant="outline"
            onClick={() => disconnect.mutate()}
            disabled={disconnect.isPending}
          >
            {disconnect.isPending
              ? t(`modules.${service}.disconnecting`)
              : t(`modules.${service}.disconnect`)}
          </Button>
        </div>
        <p className="muted">{t(`modules.${service}.hint`)}</p>
      </div>
    );
  }

  const secretOk = userPass ? username.trim() && password : apiKey.trim();
  return (
    <div className="stack">
      <p className="muted">{t(`modules.${service}.intro`)}</p>
      <div className="row" style={{ alignItems: "end" }}>
        {userPass ? (
          <>
            <div className="flex flex-col gap-1 grow">
              <Label htmlFor={userId}>{t(`modules.${service}.username`)}</Label>
              <Input
                id={userId}
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1 grow">
              <Label htmlFor={keyId}>{t(`modules.${service}.password`)}</Label>
              <Input
                id={keyId}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-1 grow">
            <Label htmlFor={keyId}>{t(`modules.${service}.apiKey`)}</Label>
            <Input
              id={keyId}
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t(`modules.${service}.apiKeyPlaceholder`)}
            />
          </div>
        )}
        <div className="flex flex-col gap-1 grow">
          <Label htmlFor={urlId}>{t(`modules.${service}.url`)}</Label>
          <Input
            id={urlId}
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={status.data?.url ?? "https://…"}
          />
        </div>
        <Button
          onClick={() =>
            connect.mutate(
              userPass
                ? { username, password, url: url.trim() || undefined }
                : { apiKey, url: url.trim() || undefined },
            )
          }
          disabled={connect.isPending || !secretOk}
        >
          {connect.isPending ? t(`modules.${service}.connecting`) : t(`modules.${service}.connect`)}
        </Button>
      </div>
      {connect.isError && (
        <div className="alert alert--danger">
          {errStatus === 401
            ? t(`modules.${service}.invalidKey`)
            : t(`modules.${service}.error`, { status: errStatus ?? "?" })}
        </div>
      )}
      {disconnect.isError && (
        <div className="alert alert--danger">
          {t(`modules.${service}.error`, {
            status: disconnect.error instanceof ApiError ? disconnect.error.status : "?",
          })}
        </div>
      )}
    </div>
  );
}

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/client";
import {
  useEmailAccounts,
  useEmailAddAccount,
  useEmailProbe,
  useEmailRemoveAccount,
} from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Email settings surface (D59): manage mail accounts — list, add, remove (D60). */
export function EmailSettings() {
  const { t } = useTranslation();
  const accounts = useEmailAccounts();
  const add = useEmailAddAccount();
  const remove = useEmailRemoveAccount();
  const probe = useEmailProbe();
  const userId = useId();
  const passId = useId();
  const urlId = useId();
  const protoId = useId();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [server, setServer] = useState("");
  const [proto, setProto] = useState<"auto" | "jmap" | "imap">("auto");

  if (accounts.isPending) return <p className="muted">{t("common.loading")}</p>;
  if (accounts.isError) {
    const s = accounts.error instanceof ApiError ? accounts.error.status : "?";
    return <div className="alert alert--danger">{t("modules.email.error", { status: s })}</div>;
  }
  const list = accounts.data?.accounts ?? [];

  /**
   * Protocol detection (D61): on leaving the server field with all credentials
   * filled, the app probes JMAP then IMAP and sets the dropdown to the winner.
   */
  const maybeProbe = () => {
    const s = server.trim();
    if (proto !== "auto" || !s || s.includes("://") || !username || !password) return;
    probe.mutate({ username, password, url: s }, { onSuccess: (d) => setProto(d.protocol) });
  };

  return (
    <div className="stack">
      <Card>
        <CardHeader>
          <CardTitle>{t("modules.email.accounts")}</CardTitle>
        </CardHeader>
        <CardContent className="stack">
          {!list.length && <p className="muted">{t("modules.email.noAccounts")}</p>}
          {list.map((a) => (
            <div key={a.id} className="row" style={{ justifyContent: "space-between" }}>
              <span>
                {a.username}
                {a.url ? ` · ${a.url.startsWith("http") ? "JMAP" : "IMAP"} · ${a.url}` : ""}
              </span>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => remove.mutate(a.id)}
                disabled={remove.isPending}
              >
                {t("modules.email.removeAccount")}
              </Button>
            </div>
          ))}
          {remove.isError && (
            <div className="alert alert--danger">
              {t("modules.email.error", {
                status: remove.error instanceof ApiError ? remove.error.status : "?",
              })}
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("modules.email.addAccount")}</CardTitle>
          <CardDescription>{t("modules.email.intro")}</CardDescription>
        </CardHeader>
        <CardContent className="stack">
          <form
            className="row"
            style={{ alignItems: "end" }}
            onSubmit={(e) => {
              e.preventDefault();
              const s = server.trim();
              const url = s.includes("://")
                ? s
                : proto === "jmap"
                  ? `jmap://${s}`
                  : proto === "imap"
                    ? `imaps://${s}`
                    : s || undefined;
              add.mutate({ username, password, url });
            }}
          >
            <div className="stack" style={{ gap: "var(--space-1)" }}>
              <Label htmlFor={userId}>{t("modules.email.username")}</Label>
              <Input
                id={userId}
                value={username}
                onChange={(e) => setUsername(e.currentTarget.value)}
                onBlur={maybeProbe}
                required
                autoComplete="username"
              />
            </div>
            <div className="stack" style={{ gap: "var(--space-1)" }}>
              <Label htmlFor={passId}>{t("modules.email.password")}</Label>
              <Input
                id={passId}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
                onBlur={maybeProbe}
                required
                autoComplete="current-password"
              />
            </div>
            <div className="stack" style={{ gap: "var(--space-1)" }}>
              <Label htmlFor={urlId}>{t("modules.email.url")}</Label>
              <Input
                id={urlId}
                value={server}
                onChange={(e) => setServer(e.currentTarget.value)}
                onBlur={maybeProbe}
                required
                placeholder="mail.example.com"
              />
            </div>
            <div className="stack" style={{ gap: "var(--space-1)" }}>
              <Label htmlFor={protoId}>{t("modules.email.protocol")}</Label>
              <Select value={proto} onValueChange={(v) => setProto(v as typeof proto)}>
                <SelectTrigger id={protoId} aria-label={t("modules.email.protocol")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t("modules.email.protocolAuto")}</SelectItem>
                  <SelectItem value="jmap">JMAP</SelectItem>
                  <SelectItem value="imap">IMAP</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={add.isPending || probe.isPending}>
              {probe.isPending
                ? t("modules.email.probing")
                : add.isPending
                  ? t("modules.email.adding")
                  : t("modules.email.addAccount")}
            </Button>
          </form>
          {probe.isError && (
            <div className="alert alert--danger">
              {t("modules.email.probeFailed", {
                status: probe.error instanceof ApiError ? probe.error.status : "?",
              })}
            </div>
          )}
          {add.isError && (
            <div className="alert alert--danger">
              {add.error instanceof ApiError && add.error.status === 401
                ? t("modules.email.invalidKey")
                : t("modules.email.error", {
                    status: add.error instanceof ApiError ? add.error.status : "?",
                  })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

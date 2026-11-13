import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "~/api/client";
import { useCreateMcpToken, useMcpTokens, useRevokeMcpToken } from "~/api/hooks";

/** EinChat settings surface (D59): MCP access tokens — create, list, revoke. */
export function EinChatSettings() {
  const { t } = useTranslation();
  const tokens = useMcpTokens();
  const create = useCreateMcpToken();
  const revoke = useRevokeMcpToken();
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<string | null>(null);

  if (tokens.isPending) return <p className="muted">{t("common.loading")}</p>;
  const list = tokens.data?.tokens ?? [];
  const err = (e: unknown) => (e instanceof ApiError ? e.status : "?");

  return (
    <div className="stack">
      <Card>
        <CardHeader>
          <CardTitle>{t("modules.einchat.mcpTitle")}</CardTitle>
          <CardDescription>{t("modules.einchat.mcpIntro")}</CardDescription>
        </CardHeader>
        <CardContent className="stack">
          {list.length === 0 && <p className="muted">{t("modules.einchat.mcpNone")}</p>}
          {list.map((tok) => (
            <div key={tok.tokenHash} className="row" style={{ justifyContent: "space-between" }}>
              <span>
                {tok.label || tok.tokenHash.slice(0, 12)}
                {tok.createdAt ? ` · ${tok.createdAt.slice(0, 10)}` : ""}
                {tok.revokedAt ? ` · ${t("modules.einchat.mcpRevoked")}` : ""}
              </span>
              {!tok.revokedAt && (
                <Button
                  variant="filled"
                  className="bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90"
                  size="sm"
                  onClick={() => revoke.mutate(tok.tokenHash)}
                  disabled={revoke.isPending}
                >
                  {t("modules.einchat.mcpRevoke")}
                </Button>
              )}
            </div>
          ))}
          {created && (
            <div className="alert">
              <p>{t("modules.einchat.mcpCreated")}</p>
              <code style={{ wordBreak: "break-all" }}>{created}</code>
            </div>
          )}
          {(tokens.isError || create.isError || revoke.isError) && (
            <div className="alert alert--danger">
              {t("modules.einchat.mcpError", {
                status: err(tokens.error ?? create.error ?? revoke.error),
              })}
            </div>
          )}
          <div className="row">
            <Label htmlFor="mcp-label" className="sr-only">
              {t("modules.einchat.mcpTokenLabel")}
            </Label>
            <Input
              id="mcp-label"
              value={label}
              placeholder={t("modules.einchat.mcpTokenLabel")}
              onChange={(e) => setLabel(e.target.value)}
            />
            <Button
              variant="filled"
              onClick={() =>
                create.mutate(label || undefined, {
                  onSuccess: (d) => {
                    setCreated(d.token);
                    setLabel("");
                  },
                })
              }
              disabled={create.isPending}
            >
              {t("modules.einchat.mcpCreate")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

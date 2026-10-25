import DOMPurify from "dompurify";

/** External-content markup: strip images — remote <img> would beacon the viewer IP out. */
const SANITIZE_OPTS = { FORBID_TAGS: ["img"] };

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/client";
import { useConnectorStatus, useEmailDelete, useEmailList, useEmailMessage } from "@/api/hooks";
import type { EmailSummary } from "@/api/types";
import { ConnectorPage } from "@/components/ConnectorPage";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** One expandable mail row: header always visible, body lazy-fetched on expand. */
function MailRow({ uid, subject, from, date }: EmailSummary) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const msg = useEmailMessage(open ? uid : null);
  const del = useEmailDelete();
  const sender = from?.name || from?.address || t("modules.email.unknownSender");

  return (
    <Card>
      <button
        type="button"
        className="w-full text-left"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <CardHeader>
          <CardTitle className="text-base">{subject ?? t("modules.email.noSubject")}</CardTitle>
          <CardDescription>
            {sender}
            {date ? ` · ${new Date(date).toLocaleString()}` : ""}
          </CardDescription>
        </CardHeader>
      </button>
      {open && (
        <CardContent>
          {msg.isPending && <p className="muted">{t("common.loading")}</p>}
          {msg.isError && (
            <div className="alert alert--danger">
              {t("modules.email.error", {
                status: msg.error instanceof ApiError ? msg.error.status : "?",
              })}
            </div>
          )}
          {msg.data &&
            (msg.data.text ? (
              <p className="email-text">{msg.data.text}</p>
            ) : msg.data.html ? (
              // Sanitized by DOMPurify; source is the user's own mailbox.
              <div
                // biome-ignore lint/security/noDangerouslySetInnerHtml: remote mail HTML is sanitized
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(msg.data.html, SANITIZE_OPTS),
                }}
              />
            ) : (
              <p className="muted">{t("modules.email.noContent")}</p>
            ))}
          {del.isError && (
            <div className="alert alert--danger">
              {t("modules.email.error", {
                status: del.error instanceof ApiError ? del.error.status : "?",
              })}
            </div>
          )}
          <div className="row">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => del.mutate(uid)}
              disabled={del.isPending}
            >
              {del.isPending ? t("modules.email.deleting") : t("modules.email.delete")}
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

export function EmailPage() {
  const { t } = useTranslation();
  const status = useConnectorStatus("email");
  const list = useEmailList(status.data?.connected === true);

  if (status.isPending) return <p className="muted">{t("common.loading")}</p>;
  if (status.isError || !status.data?.connected) return <ConnectorPage service="email" userPass />;

  if (list.isPending) return <p className="muted">{t("common.loading")}</p>;
  if (list.isError) {
    const s = list.error instanceof ApiError ? list.error.status : "?";
    return <div className="alert alert--danger">{t("modules.email.error", { status: s })}</div>;
  }
  const emails = list.data?.emails ?? [];
  if (!emails.length) return <p className="muted">{t("modules.email.empty")}</p>;

  return (
    <div className="stack">
      {emails.map((m) => (
        <MailRow key={m.uid} {...m} />
      ))}
    </div>
  );
}

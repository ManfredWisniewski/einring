import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSchoolSendMessage, useSchoolThreadMessages, useSchoolThreads } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/** In-app messaging — threads list + conversation + compose. */
export default function MessagesView() {
  const { t, i18n } = useTranslation();
  const threads = useSchoolThreads();
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="stack">
      {open === null ? (
        <>
          <h2>{t("modules.school.messages.title")}</h2>
          <ul className="stack" style={{ gap: "var(--space-2)" }}>
            {(threads.data?.threads ?? []).map((th) => (
              <li key={th.id}>
                <button type="button" className="linklike" onClick={() => setOpen(th.id)}>
                  <strong>{th.title ?? t("modules.school.messages.direct")}</strong>{" "}
                  {th.unread && <span className="text-danger">●</span>}{" "}
                  <span className="muted">
                    {th.lastBody?.slice(0, 60)}
                    {th.lastAt
                      ? ` · ${new Intl.DateTimeFormat(i18n.language, {
                          dateStyle: "short",
                          timeStyle: "short",
                        }).format(new Date(th.lastAt))}`
                      : ""}
                  </span>
                </button>
              </li>
            ))}
            {threads.data && threads.data.threads.length === 0 && (
              <li className="muted">{t("modules.school.messages.empty")}</li>
            )}
          </ul>
        </>
      ) : (
        <Conversation threadId={open} onBack={() => setOpen(null)} />
      )}
    </div>
  );
}

function Conversation({ threadId, onBack }: { threadId: string; onBack: () => void }) {
  const { t } = useTranslation();
  const messages = useSchoolThreadMessages(threadId);
  const send = useSchoolSendMessage();
  const [body, setBody] = useState("");

  return (
    <div className="stack">
      <Button size="sm" variant="ghost" onClick={onBack} className="self-start">
        {t("modules.school.messages.back")}
      </Button>
      <ul className="stack" style={{ gap: "var(--space-2)" }}>
        {(messages.data?.messages ?? []).map((m) => (
          <li key={m.id}>
            <strong className="muted">{m.senderName ?? m.senderSub}</strong>
            <p>{m.body}</p>
          </li>
        ))}
      </ul>
      <Textarea
        value={body}
        onChange={(e) => setBody(e.currentTarget.value)}
        placeholder={t("modules.school.messages.placeholder")}
        rows={3}
      />
      <div className="row">
        <Button
          size="sm"
          disabled={send.isPending || !body.trim()}
          onClick={() => {
            void send.mutateAsync({ threadId, body }).then(() => setBody(""));
          }}
        >
          {t("modules.school.messages.send")}
        </Button>
      </div>
    </div>
  );
}

import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/client";
import {
  useApi,
  useNextcloudConnection,
  useSendTalkImage,
  useSendTalkMessage,
  useTalkMessages,
  useTalkRooms,
} from "@/api/hooks";
import type { TalkFileParam, TalkMessage } from "@/api/types";
import { NextcloudGate } from "@/components/NextcloudGate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** First `file` rich-object parameter on a message, if any (D51). */
function fileParam(m: TalkMessage): TalkFileParam | null {
  for (const p of Object.values(m.messageParameters ?? {})) {
    if (p && typeof p === "object" && (p as TalkFileParam).type === "file") {
      return p as TalkFileParam;
    }
  }
  return null;
}

/** Display text with `{placeholder}` tokens removed (attachments render separately). */
function cleanText(m: TalkMessage): string {
  const raw = m.message ?? "";
  const params = Object.keys(m.messageParameters ?? {});
  let out = raw;
  for (const key of params) out = out.replaceAll(`{${key}}`, "").trim();
  return out.trim();
}

function fmtTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Authenticated blob → object URL (D51; bearer token can't ride an <img src>). */
function TalkImage({ path, name }: { path: string; name: string }) {
  const api = useApi();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let objectUrl: string | null = null;
    setFailed(false);
    void api
      .blob(`/talk/file?path=${encodeURIComponent(path)}`)
      .then((b) => {
        objectUrl = URL.createObjectURL(b);
        setUrl(objectUrl);
      })
      .catch(() => setFailed(true));
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, path]);
  if (failed) return <span className="muted">{name}</span>;
  if (!url) return <span className="muted">{name} …</span>;
  return <img className="talk-image" src={url} alt={name} />;
}

function MessagePane({
  token,
  title,
  selfId,
  onBack,
}: {
  token: string;
  title: string;
  selfId: string | null;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const messages = useTalkMessages(token);
  const send = useSendTalkMessage();
  const sendImage = useSendTalkImage();
  const [text, setText] = useState("");
  const [attachKey, setAttachKey] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const attachId = useId();

  const list = [...(messages.data?.messages ?? [])].sort((a, b) => a.id - b.id);

  useEffect(() => {
    if (list.length === 0) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [list.length]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || send.isPending) return;
    send.mutate({ token, text: trimmed }, { onSuccess: () => setText("") });
  };

  return (
    <div className="stack talk-pane">
      <div className="row">
        <Button variant="ghost" size="sm" onClick={onBack}>
          {t("modules.talk.back")}
        </Button>
        <h2 className="text-lg" style={{ flex: 1 }}>
          {title}
        </h2>
      </div>
      <div ref={scrollRef} className="talk-scroll">
        {messages.isPending && <p className="muted">{t("common.loading")}</p>}
        {messages.isError && (
          <p className="alert alert--danger">
            {t("modules.talk.error", {
              status: messages.error instanceof ApiError ? messages.error.status : "?",
            })}
          </p>
        )}
        {list.map((m) => {
          const file = fileParam(m);
          const textBody = cleanText(m);
          const own = selfId !== null && m.actorId === selfId;
          if (m.messageType === "system" || m.systemMessage) {
            return (
              <p key={m.id} className="talk-system">
                {textBody || m.systemMessage}
              </p>
            );
          }
          return (
            <div key={m.id} className={`talk-bubble${own ? " talk-bubble--own" : ""}`}>
              <div className="talk-meta">
                <span className="talk-actor">{m.actorDisplayName || m.actorId}</span>
                <span className="muted">{fmtTime(m.timestamp)}</span>
              </div>
              {file?.path &&
                (file.mimetype?.startsWith("image/") ? (
                  <TalkImage path={file.path} name={file.name ?? "image"} />
                ) : (
                  <span className="muted">📎 {file.name ?? file.path}</span>
                ))}
              {textBody && <p className="talk-text">{textBody}</p>}
            </div>
          );
        })}
      </div>
      {sendImage.isPending && <p className="muted">{t("modules.talk.uploading")}</p>}
      <div className="row">
        <Input
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={t("modules.talk.placeholder")}
          className="talk-input"
          aria-label={t("modules.talk.placeholder")}
        />
        <input
          id={attachId}
          key={attachKey}
          type="file"
          accept="image/*"
          className="sr-only"
          aria-label={t("modules.talk.attach")}
          onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={sendImage.isPending}
          onClick={() => document.getElementById(attachId)?.click()}
        >
          {t("modules.talk.attach")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!file || sendImage.isPending}
          onClick={() => {
            if (file) {
              sendImage.mutate(
                { token, file },
                {
                  onSuccess: () => {
                    setFile(null);
                    setAttachKey((k) => k + 1);
                  },
                },
              );
            }
          }}
        >
          {t("modules.talk.sendImage")}
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={submit}
          disabled={!text.trim() || send.isPending}
        >
          {t("modules.talk.send")}
        </Button>
      </div>
      {file && <p className="muted">{file.name}</p>}
      {send.isError && (
        <p className="alert alert--danger">
          {t("modules.talk.error", {
            status: send.error instanceof ApiError ? send.error.status : "?",
          })}
        </p>
      )}
    </div>
  );
}

function TalkPageInner() {
  const { t } = useTranslation();
  const rooms = useTalkRooms();
  const connection = useNextcloudConnection();
  const [openToken, setOpenToken] = useState<string | null>(null);
  const open = rooms.data?.rooms.find((r) => r.token === openToken);
  const selfId = connection.data?.status === "connected" ? connection.data.loginName : null;

  if (open) {
    return (
      <MessagePane
        token={open.token}
        title={open.displayName || open.name}
        selfId={selfId}
        onBack={() => setOpenToken(null)}
      />
    );
  }

  const notConnected =
    rooms.isError && rooms.error instanceof ApiError && rooms.error.status === 424;

  return (
    <div className="stack">
      {notConnected && <p className="muted">{t("modules.talk.notConnected")}</p>}
      {rooms.isError && !notConnected && (
        <p className="alert alert--danger">
          {t("modules.talk.error", {
            status: rooms.error instanceof ApiError ? rooms.error.status : "?",
          })}
        </p>
      )}
      {rooms.isPending && <p className="muted">{t("common.loading")}</p>}
      {rooms.data?.rooms.length === 0 && <p className="muted">{t("modules.talk.empty")}</p>}
      <ul className="status-list">
        {rooms.data?.rooms.map((r) => (
          <li key={r.token} className="status-item">
            <button
              type="button"
              className="linklike"
              style={{ flex: 1, textAlign: "left" }}
              onClick={() => setOpenToken(r.token)}
            >
              <span style={{ fontWeight: 600 }}>{r.displayName || r.name}</span>
              {r.lastMessage && (
                <span className="muted" style={{ display: "block" }}>
                  {r.lastMessage}
                </span>
              )}
            </button>
            <span className="muted">{fmtTime(r.lastActivity)}</span>
            {r.unread > 0 && <span className="talk-unread">{r.unread}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TalkPage() {
  return (
    <NextcloudGate>
      <TalkPageInner />
    </NextcloudGate>
  );
}

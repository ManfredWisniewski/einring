import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/client";
import {
  useApi,
  useConnectorDisconnect,
  useConnectorStatus,
  useMatrixMessages,
  useMatrixRooms,
  useMatrixSelf,
  useSendMatrixFile,
  useSendMatrixMessage,
} from "@/api/hooks";
import type { MatrixMessage } from "@/api/types";
import { ConnectorPage } from "@/components/ConnectorPage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function fmtTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Authenticated blob → object URL for mxc media (D52). */
function MatrixImage({ mxc, name }: { mxc: string; name: string }) {
  const api = useApi();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let objectUrl: string | null = null;
    setFailed(false);
    void api
      .blob(`/matrix/media?mxc=${encodeURIComponent(mxc)}`)
      .then((b) => {
        objectUrl = URL.createObjectURL(b);
        setUrl(objectUrl);
      })
      .catch(() => setFailed(true));
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, mxc]);
  if (failed) return <span className="muted">{name}</span>;
  if (!url) return <span className="muted">{name} …</span>;
  return <img className="talk-image" src={url} alt={name} />;
}

/** Attachment: images inline, other types as an authenticated download link. */
function Attachment({ m }: { m: MatrixMessage }) {
  const { t } = useTranslation();
  const api = useApi();
  if (!m.url) return null;
  if (m.msgtype === "m.image" || m.info?.mimetype?.startsWith("image/")) {
    return <MatrixImage mxc={m.url} name={m.body || "image"} />;
  }
  return (
    <button
      type="button"
      className="linklike"
      onClick={() => {
        void api.blob(`/matrix/media?mxc=${encodeURIComponent(m.url ?? "")}`).then((b) => {
          const u = URL.createObjectURL(b);
          const a = document.createElement("a");
          a.href = u;
          a.download = m.body || "file";
          a.click();
          URL.revokeObjectURL(u);
        });
      }}
    >
      {t("modules.matrix.download", { name: m.body || "file" })}
    </button>
  );
}

function MessagePane({
  roomId,
  title,
  selfId,
  onBack,
}: {
  roomId: string;
  title: string;
  selfId: string | null;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const messages = useMatrixMessages(roomId);
  const send = useSendMatrixMessage();
  const sendFile = useSendMatrixFile();
  const [text, setText] = useState("");
  const [attachKey, setAttachKey] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const attachId = useId();

  // The BFF returns newest-first (dir=b) — display chronologically.
  const list = [...(messages.data?.messages ?? [])].reverse();

  useEffect(() => {
    if (list.length === 0) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [list.length]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || send.isPending) return;
    send.mutate({ roomId, text: trimmed }, { onSuccess: () => setText("") });
  };

  return (
    <div className="stack talk-pane">
      <div className="row">
        <Button variant="ghost" size="sm" onClick={onBack}>
          {t("modules.matrix.back")}
        </Button>
        <h2 className="text-lg" style={{ flex: 1 }}>
          {title}
        </h2>
      </div>
      <div ref={scrollRef} className="talk-scroll">
        {messages.isPending && <p className="muted">{t("common.loading")}</p>}
        {messages.isError && (
          <p className="alert alert--danger">
            {t("modules.matrix.error", {
              status: messages.error instanceof ApiError ? messages.error.status : "?",
            })}
          </p>
        )}
        {list.map((m) => {
          const own = selfId !== null && m.sender === selfId;
          if (m.type !== "m.room.message") {
            return (
              <p key={m.id ?? `${m.sender}-${m.ts}`} className="talk-system">
                {m.body || m.type}
              </p>
            );
          }
          return (
            <div
              key={m.id ?? `${m.sender}-${m.ts}`}
              className={`talk-bubble${own ? " talk-bubble--own" : ""}`}
            >
              <div className="talk-meta">
                <span className="talk-actor">{m.senderName || m.sender}</span>
                <span className="muted">{fmtTime(m.ts)}</span>
              </div>
              <Attachment m={m} />
              {m.msgtype === "m.text" && m.body && <p className="talk-text">{m.body}</p>}
              {m.msgtype === "m.emote" && (
                <p className="talk-text">
                  * {m.senderName} {m.body}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {sendFile.isPending && <p className="muted">{t("modules.matrix.uploading")}</p>}
      <div className="row">
        <Input
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={t("modules.matrix.placeholder")}
          className="talk-input"
          aria-label={t("modules.matrix.placeholder")}
        />
        <input
          id={attachId}
          key={attachKey}
          type="file"
          className="sr-only"
          aria-label={t("modules.matrix.attach")}
          onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={sendFile.isPending}
          onClick={() => document.getElementById(attachId)?.click()}
        >
          {t("modules.matrix.attach")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!file || sendFile.isPending}
          onClick={() => {
            if (file) {
              sendFile.mutate(
                { roomId, file },
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
          {t("modules.matrix.sendFile")}
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={submit}
          disabled={!text.trim() || send.isPending}
        >
          {t("modules.matrix.send")}
        </Button>
      </div>
      {file && <p className="muted">{file.name}</p>}
      {(send.isError || sendFile.isError) && (
        <p className="alert alert--danger">
          {t("modules.matrix.error", {
            status:
              (send.error ?? sendFile.error) instanceof ApiError
                ? ((send.error ?? sendFile.error) as ApiError).status
                : "?",
          })}
        </p>
      )}
    </div>
  );
}

function MatrixInner() {
  const { t } = useTranslation();
  const status = useConnectorStatus("matrix");
  const disconnect = useConnectorDisconnect("matrix");
  const rooms = useMatrixRooms();
  const self = useMatrixSelf();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = rooms.data?.rooms.find((r) => r.id === openId);
  const selfId = self.data?.userId ?? null;

  if (open) {
    return (
      <MessagePane
        roomId={open.id}
        title={open.name || open.id}
        selfId={selfId}
        onBack={() => setOpenId(null)}
      />
    );
  }

  return (
    <div className="stack">
      <div className="row einhub-header">
        <p className="muted">{t("modules.matrix.connectedAs", { url: status.data?.url })}</p>
        <Button
          variant="outline"
          size="sm"
          disabled={disconnect.isPending}
          onClick={() => disconnect.mutate()}
        >
          {disconnect.isPending
            ? t("modules.matrix.disconnecting")
            : t("modules.matrix.disconnect")}
        </Button>
      </div>
      {rooms.isError && (
        <p className="alert alert--danger">
          {t("modules.matrix.error", {
            status: rooms.error instanceof ApiError ? rooms.error.status : "?",
          })}
        </p>
      )}
      {rooms.isPending && <p className="muted">{t("common.loading")}</p>}
      {rooms.data?.rooms.length === 0 && <p className="muted">{t("modules.matrix.empty")}</p>}
      <ul className="status-list">
        {rooms.data?.rooms.map((r) => (
          <li key={r.id} className="status-item">
            <button
              type="button"
              className="linklike"
              style={{ flex: 1, textAlign: "left" }}
              onClick={() => setOpenId(r.id)}
            >
              <span style={{ fontWeight: 600 }}>{r.name || r.id}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MatrixPage() {
  const status = useConnectorStatus("matrix");
  if (status.data?.connected !== true) return <ConnectorPage service="matrix" userPass />;
  return <MatrixInner />;
}

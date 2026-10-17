import DOMPurify from "dompurify";
import { marked } from "marked";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/client";
import {
  useEinChatMessage,
  useEinChatSetTools,
  useEinChatStatus,
  useEinChatTools,
} from "@/api/hooks";
import type { EinChatMessage, EinChatTool } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function Bubble({ msg }: { msg: EinChatMessage }) {
  if (msg.role === "assistant") {
    const html = DOMPurify.sanitize(marked.parse(msg.content) as string);
    return (
      <article className="chat-msg chat-msg--assistant">
        {/* Sanitized by DOMPurify; source is the configured LLM provider's reply. */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: markdown rendered through DOMPurify */}
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </article>
    );
  }
  return <article className="chat-msg chat-msg--user">{msg.content}</article>;
}

/** Data connections: per-module toggle over the tools the module lends EinChat. */
function Connections({ tools }: { tools: EinChatTool[] }) {
  const { t } = useTranslation();
  const setTools = useEinChatSetTools();
  const byModule = new Map<string, EinChatTool[]>();
  for (const tool of tools) {
    byModule.set(tool.module, [...(byModule.get(tool.module) ?? []), tool]);
  }
  if (byModule.size === 0) return null;

  const toggle = (module: string, enabled: boolean) => {
    const moduleTools = byModule.get(module) ?? [];
    const off = new Set(tools.filter((t2) => !t2.enabled).map((t2) => t2.name));
    for (const mt of moduleTools) {
      if (enabled) off.delete(mt.name);
      else off.add(mt.name);
    }
    setTools.mutate([...off]);
  };

  return (
    <section className="chat-connections stack" aria-label={t("modules.einchat.connections")}>
      <span className="muted">{t("modules.einchat.connections")}</span>
      {[...byModule.entries()].map(([module, moduleTools]) => {
        const enabled = moduleTools.some((t2) => t2.enabled);
        return (
          <label key={module} className="row" style={{ gap: "var(--space-2)" }}>
            <input
              type="checkbox"
              checked={enabled}
              disabled={setTools.isPending}
              onChange={(e) => toggle(module, e.target.checked)}
            />
            <span>{t(`modules.${module}.nav`, { defaultValue: module })}</span>
            <span className="muted">{moduleTools.map((t2) => t2.name).join(", ")}</span>
          </label>
        );
      })}
      {setTools.isError && (
        <div className="alert alert--danger">
          {t("modules.einchat.connectionsError", {
            status: setTools.error instanceof ApiError ? setTools.error.status : "?",
          })}
        </div>
      )}
    </section>
  );
}

/** Multi-turn chat with module tools (D41). History lives client-side; the BFF is stateless. */
export function EinChatPage() {
  const { t } = useTranslation();
  const inputId = useId();
  const [messages, setMessages] = useState<EinChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const status = useEinChatStatus(true);
  const tools = useEinChatTools(true);
  const send = useEinChatMessage();

  if (status.isPending) return <p className="muted">{t("common.loading")}</p>;
  if (!status.data?.configured) {
    return <p className="muted">{t("modules.einchat.notConfigured")}</p>;
  }

  const submit = () => {
    const content = draft.trim();
    if (!content || send.isPending) return;
    const next: EinChatMessage[] = [...messages, { role: "user", content }];
    setMessages(next);
    setDraft("");
    send.mutate(next, {
      onSuccess: (res) => {
        setMessages((cur) => [...cur, { role: "assistant", content: res.reply }]);
        bottomRef.current?.scrollIntoView({ block: "end" });
      },
    });
  };

  const sendStatus = send.error instanceof ApiError ? send.error.status : null;

  return (
    <div className="stack">
      <Connections tools={tools.data?.tools ?? []} />
      <div className="chat-thread stack" role="log" aria-label={t("modules.einchat.nav")}>
        {messages.length === 0 && <p className="muted">{t("modules.einchat.empty")}</p>}
        {messages.map((m, i) => (
          // Append-only history — the index is a stable key here.
          <Bubble key={m.role + String(i)} msg={m} />
        ))}
        {send.isPending && (
          <article className="chat-msg chat-msg--assistant muted">
            {t("modules.einchat.thinking")}
          </article>
        )}
        <div ref={bottomRef} />
      </div>
      {send.isError && (
        <div className="alert alert--danger">
          {sendStatus === 424
            ? t("modules.einchat.notConfigured")
            : t("modules.einchat.error", { status: sendStatus ?? "?" })}
        </div>
      )}
      <div className="row">
        <div className="flex flex-col gap-1 grow">
          <Label htmlFor={inputId}>{t("modules.einchat.inputLabel")}</Label>
          <Input
            id={inputId}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder={t("modules.einchat.placeholder")}
            aria-label={t("modules.einchat.inputLabel")}
          />
        </div>
        <Button onClick={submit} disabled={send.isPending || !draft.trim()}>
          {send.isPending ? t("modules.einchat.sending") : t("modules.einchat.send")}
        </Button>
      </div>
      {status.data.tools.length > 0 && (
        <span className="muted">
          {t("modules.einchat.tools", { tools: status.data.tools.join(", ") })}
        </span>
      )}
    </div>
  );
}

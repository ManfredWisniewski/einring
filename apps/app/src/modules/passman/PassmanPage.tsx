import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import sjcl from "sjcl";
import { ApiError } from "@/api/client";
import { usePassmanVault, usePassmanVaults } from "@/api/hooks";
import type { PassmanCredential, PassmanVault } from "@/api/types";
import { NextcloudGate } from "@/components/NextcloudGate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** base64(SJCL JSON) → plaintext, or null on wrong key / bad data. SJCL embeds
 * its parameters (iter/ks/mode/ts) in the ciphertext, so no config is needed. */
function decrypt(key: string, b64: string | null | undefined): string | null {
  if (typeof b64 !== "string" || b64.length === 0) return null;
  try {
    return sjcl.decrypt(key, window.atob(b64));
  } catch {
    return null;
  }
}

interface CustomField {
  label: string;
  value: string;
  secret: boolean;
}

/** A credential with its secret fields already decrypted (in memory only, D50). */
interface Plain {
  id: number;
  label: string;
  username: string;
  email: string;
  tags: string[];
  description: string | null;
  password: string | null;
  url: string | null;
  fields: CustomField[];
}

/**
 * Passman serializes `tags` inconsistently (PHP non-sequential arrays become
 * objects, single tags lose their array, some installs return a JSON string) —
 * normalize every observed shape to a flat string list.
 */
export function passmanTags(raw: unknown): string[] {
  if (raw == null) return [];
  if (typeof raw === "string") {
    try {
      return passmanTags(JSON.parse(raw));
    } catch {
      return raw.trim() ? [raw.trim()] : [];
    }
  }
  if (Array.isArray(raw)) {
    return raw
      .flatMap((t) =>
        typeof t === "string" ? [t] : t && typeof t === "object" ? passmanTags(t) : [],
      )
      .filter(Boolean);
  }
  if (typeof raw === "object") {
    const o = raw as { text?: unknown };
    if (typeof o.text === "string") return o.text ? [o.text] : [];
    return Object.values(raw).flatMap(passmanTags);
  }
  return [];
}

function decryptCredential(key: string, c: PassmanCredential): Plain {
  const fieldsRaw = decrypt(key, c.custom_fields);
  let fields: CustomField[] = [];
  if (fieldsRaw) {
    try {
      const parsed = JSON.parse(fieldsRaw) as {
        label?: string;
        value?: string;
        secret?: boolean;
      }[];
      if (Array.isArray(parsed)) {
        fields = parsed.map((f) => ({
          label: String(f.label ?? ""),
          value: String(f.value ?? ""),
          secret: f.secret === true,
        }));
      }
    } catch {
      fields = [];
    }
  }
  return {
    id: c.credential_id,
    label: c.label ?? "",
    username: c.username ?? "",
    email: c.email ?? "",
    tags: passmanTags(c.tags),
    description: decrypt(key, c.description),
    password: decrypt(key, c.password),
    url: decrypt(key, c.url),
    fields,
  };
}

function CopyButton({
  value,
  label,
  onCopied,
  copied,
}: {
  value: string | null;
  label: string;
  onCopied: (id: string) => void;
  copied: string | null;
}) {
  const { t } = useTranslation();
  if (value == null || value === "") return null;
  const id = `${label}:${value.length}`;
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={copied === id}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => onCopied(id));
      }}
    >
      {copied === id ? t("modules.passman.copied") : label}
    </Button>
  );
}

function CredentialRow({
  cred,
  onCopied,
  copied,
  onTag,
}: {
  cred: Plain;
  onCopied: (id: string) => void;
  copied: string | null;
  onTag: (tag: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="status-item passman-cred">
      <div className="flex flex-col gap-1" style={{ flex: 1, minWidth: 0 }}>
        <button
          type="button"
          className="linklike"
          onClick={() => setExpanded(!expanded)}
          style={{ fontWeight: 600 }}
        >
          {cred.label || t("modules.passman.untitled")}
        </button>
        <span className="muted">{[cred.username, cred.email].filter(Boolean).join(" · ")}</span>
        {cred.tags.length > 0 && (
          <span className="passman-tags">
            {cred.tags.map((tag) => (
              <button key={tag} type="button" className="passman-tag" onClick={() => onTag(tag)}>
                {tag}
              </button>
            ))}
          </span>
        )}
        {expanded && (
          <div className="stack" style={{ marginTop: "var(--space-2)" }}>
            {cred.description && <p className="muted">{cred.description}</p>}
            {cred.url && (
              <span className="muted" style={{ wordBreak: "break-all" }}>
                {cred.url}
              </span>
            )}
            {cred.fields.map((f) => (
              <div key={f.label} className="row">
                <span>{f.label}:</span>
                <span className="muted">{f.secret ? "••••••" : f.value}</span>
                <CopyButton
                  value={f.value}
                  label={t("modules.passman.copyField")}
                  onCopied={onCopied}
                  copied={copied}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      <CopyButton
        value={cred.password}
        label={t("modules.passman.copyPassword")}
        onCopied={onCopied}
        copied={copied}
      />
      <CopyButton
        value={cred.url}
        label={t("modules.passman.copyUrl")}
        onCopied={onCopied}
        copied={copied}
      />
    </li>
  );
}

function PassmanPageInner() {
  const { t } = useTranslation();
  const vaults = usePassmanVaults();
  const [openGuid, setOpenGuid] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [pwInput, setPwInput] = useState("");
  const [badPw, setBadPw] = useState(false);
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const detail = usePassmanVault(key !== null ? openGuid : null);
  const selected = vaults.data?.vaults.find((v) => v.guid === openGuid);

  const onCopied = useCallback((id: string) => {
    setCopied(id);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1500);
  }, []);

  const lock = useCallback(() => {
    setKey(null);
    setOpenGuid(null);
    setPwInput("");
    setBadPw(false);
    setTagFilter(null);
    setQuery("");
  }, []);

  const unlock = (v: PassmanVault) => {
    if (!pwInput) return;
    if (v.challenge_password && decrypt(pwInput, v.challenge_password) === null) {
      setBadPw(true);
      return;
    }
    setBadPw(false);
    setKey(pwInput);
    setPwInput("");
  };

  const plains = useMemo(() => {
    if (!key || !detail.data?.vault.credentials) return [];
    return detail.data.vault.credentials
      .filter((c) => !c.hidden)
      .map((c) => decryptCredential(key, c));
  }, [key, detail.data]);

  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const c of plains) for (const tag of c.tags) s.add(tag);
    return [...s].sort();
  }, [plains]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plains.filter((c) => {
      if (tagFilter && !c.tags.includes(tagFilter)) return false;
      if (!q) return true;
      const hay = [c.label, c.username, c.email, c.description ?? "", ...c.tags]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [plains, query, tagFilter]);

  const notConnected =
    vaults.isError && vaults.error instanceof ApiError && vaults.error.status === 424;

  return (
    <div className="stack">
      {notConnected && <p className="muted">{t("modules.passman.notConnected")}</p>}
      {vaults.isError && !notConnected && (
        <p className="alert alert--danger">
          {t("modules.passman.error", {
            status: vaults.error instanceof ApiError ? vaults.error.status : "?",
          })}
        </p>
      )}
      {vaults.isPending && <p className="muted">{t("common.loading")}</p>}

      {key === null && (
        <ul className="status-list">
          {vaults.data?.vaults.length === 0 && (
            <li className="muted">{t("modules.passman.empty")}</li>
          )}
          {vaults.data?.vaults.map((v) => (
            <li key={v.guid} className="status-item">
              <button
                type="button"
                className="linklike"
                style={{ fontWeight: 600, flex: 1, textAlign: "left" }}
                onClick={() => setOpenGuid(openGuid === v.guid ? null : v.guid)}
              >
                {v.name}
              </button>
              {openGuid === v.guid && (
                <div className="row">
                  <Label htmlFor="passman-pw" className="sr-only">
                    {t("modules.passman.vaultPassword")}
                  </Label>
                  <Input
                    id="passman-pw"
                    type="password"
                    placeholder={t("modules.passman.vaultPassword")}
                    className="w-56"
                    value={pwInput}
                    onChange={(e) => setPwInput(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === "Enter" && unlock(v)}
                  />
                  <Button variant="outline" size="sm" onClick={() => unlock(v)}>
                    {t("modules.passman.unlock")}
                  </Button>
                </div>
              )}
            </li>
          ))}
          {badPw && <li className="alert alert--danger">{t("modules.passman.badPassword")}</li>}
        </ul>
      )}

      {key !== null && (
        <div className="stack">
          <div className="row">
            <h2 className="text-lg" style={{ flex: 1 }}>
              {selected?.name ?? ""}
            </h2>
            <Button variant="outline" size="sm" onClick={lock}>
              {t("modules.passman.lock")}
            </Button>
          </div>
          <Input
            placeholder={t("modules.passman.search")}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            className="w-64"
            aria-label={t("modules.passman.search")}
          />
          {allTags.length > 0 && (
            <div className="row" style={{ flexWrap: "wrap" }}>
              {allTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className={`passman-tag${tagFilter === tag ? " passman-tag--active" : ""}`}
                  onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
          {detail.isPending && <p className="muted">{t("common.loading")}</p>}
          {detail.isError && (
            <p className="alert alert--danger">
              {t("modules.passman.error", {
                status: detail.error instanceof ApiError ? detail.error.status : "?",
              })}
            </p>
          )}
          {detail.data && filtered.length === 0 && (
            <p className="muted">{t("modules.passman.noResults")}</p>
          )}
          <ul className="status-list">
            {filtered.map((c) => (
              <CredentialRow
                key={c.id}
                cred={c}
                onCopied={onCopied}
                copied={copied}
                onTag={setTagFilter}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function PassmanPage() {
  return (
    <NextcloudGate>
      <PassmanPageInner />
    </NextcloudGate>
  );
}

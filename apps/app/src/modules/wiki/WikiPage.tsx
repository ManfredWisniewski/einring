import DOMPurify from "dompurify";
import { marked } from "marked";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/client";
import {
  useWikiAsk,
  useWikiLlmIndex,
  useWikiLlmStatus,
  useWikiPage,
  useWikiSearch,
  useWikiSync,
  useWikiTree,
} from "@/api/hooks";
import type { WikiPageMeta } from "@/api/types";
import { NextcloudGate } from "@/components/NextcloudGate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface TreeNode {
  name: string;
  path: string | null;
  children: TreeNode[];
}

/** Builds a per-collective nested tree from the flat page list. */
function buildTree(pages: WikiPageMeta[]): Map<string, TreeNode> {
  const collectives = new Map<string, TreeNode>();
  const sorted = [...pages].sort((a, b) => a.path.localeCompare(b.path));
  for (const page of sorted) {
    let root = collectives.get(page.collective);
    if (!root) {
      root = { name: page.collective, path: null, children: [] };
      collectives.set(page.collective, root);
    }
    let node = root;
    const segments = page.path.split("/").slice(1); // skip collective segment
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i] ?? "";
      const isLeaf = i === segments.length - 1;
      let child = node.children.find((c) => c.name === seg);
      if (!child) {
        child = {
          name: isLeaf ? page.title : seg,
          path: isLeaf ? page.path : null,
          children: [],
        };
        node.children.push(child);
      }
      if (isLeaf && !child.path) child.path = page.path;
      node = child;
    }
  }
  return collectives;
}

function TreeList({
  nodes,
  selected,
  onSelect,
  depth,
}: {
  nodes: TreeNode[];
  selected: string | null;
  onSelect: (path: string) => void;
  depth: number;
}) {
  return (
    <ul
      className="wiki-tree"
      style={depth === 0 ? undefined : { paddingInlineStart: "var(--space-4)" }}
    >
      {nodes.map((n) => (
        <li key={n.path ?? `${n.name}/${depth}`}>
          {n.path ? (
            <Button
              variant="ghost"
              size="clear"
              className={`wiki-tree__item${n.path === selected ? " wiki-tree__item--active" : ""}`}
              onClick={() => onSelect(n.path as string)}
            >
              {n.name}
            </Button>
          ) : (
            <span className="wiki-tree__dir">{n.name}</span>
          )}
          {n.children.length > 0 && (
            <TreeList
              nodes={n.children}
              selected={selected}
              onSelect={onSelect}
              depth={depth + 1}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

export function WikiPage() {
  return (
    <NextcloudGate>
      <WikiContent />
    </NextcloudGate>
  );
}

function WikiContent() {
  const { t } = useTranslation();
  const tree = useWikiTree(true);
  const sync = useWikiSync();
  const searchId = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const page = useWikiPage(selected, true);
  const search = useWikiSearch(query.trim(), true);

  const collectives = useMemo(() => buildTree(tree.data?.pages ?? []), [tree.data]);
  const searching = query.trim().length > 0;

  if (tree.isPending) return <p className="muted">{t("common.loading")}</p>;
  if (tree.isError) {
    const status = tree.error instanceof ApiError ? tree.error.status : "?";
    return (
      <div className="alert alert--danger row">
        <span>{t("modules.wiki.error", { status })}</span>
        <Button variant="outline" onClick={() => void tree.refetch()}>
          {t("modules.wiki.retry")}
        </Button>
      </div>
    );
  }

  const rendered = page.data ? DOMPurify.sanitize(marked.parse(page.data.content) as string) : null;

  return (
    <div className="stack">
      <div className="row">
        <div className="flex flex-col gap-1">
          <Label htmlFor={searchId}>{t("modules.wiki.search")}</Label>
          <Input
            id={searchId}
            className="w-72"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("modules.wiki.search")}
            aria-label={t("modules.wiki.search")}
          />
        </div>
        <Button variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending}>
          {sync.isPending ? t("modules.wiki.syncing") : t("modules.wiki.sync")}
        </Button>
        {tree.data.syncedAt && (
          <span className="muted">
            {t("modules.wiki.syncedAt", { date: new Date(tree.data.syncedAt).toLocaleString() })}
          </span>
        )}
      </div>
      {sync.isError && (
        <div className="alert alert--danger">
          {t("modules.wiki.syncError", {
            status: sync.error instanceof ApiError ? sync.error.status : "?",
          })}
        </div>
      )}
      <AskPanel onSelectPage={setSelected} />
      <div className="wiki">
        <nav className="wiki__nav" aria-label={t("modules.wiki.nav")}>
          {collectives.size === 0 ? (
            <p className="muted">{t("modules.wiki.empty")}</p>
          ) : (
            [...collectives.values()].map((c) => (
              <div key={c.name} className="stack" style={{ gap: "var(--space-1)" }}>
                <span className="wiki-tree__collective">{c.name}</span>
                <TreeList nodes={c.children} selected={selected} onSelect={setSelected} depth={0} />
              </div>
            ))
          )}
        </nav>
        <div className="wiki__content">
          {searching ? (
            <SearchResults
              results={search.data ?? []}
              pending={search.isPending}
              onSelect={(p) => {
                setSelected(p);
                setQuery("");
              }}
            />
          ) : selected ? (
            <PageView
              title={page.data?.title}
              html={rendered}
              pending={page.isPending}
              error={page.error}
            />
          ) : (
            <p className="muted">{t("modules.wiki.selectPage")}</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Stateless Q&A over the mirrored pages (D39). Hidden unless the BFF reports LLM configured. */
function AskPanel({ onSelectPage }: { onSelectPage: (path: string) => void }) {
  const { t } = useTranslation();
  const askId = useId();
  const [question, setQuestion] = useState("");
  const status = useWikiLlmStatus(true);
  const index = useWikiLlmIndex();
  const ask = useWikiAsk();

  if (!status.data?.configured) return null;

  const submit = () => {
    const q = question.trim();
    if (q) ask.mutate(q);
  };
  const answerHtml = ask.data ? DOMPurify.sanitize(marked.parse(ask.data.answer) as string) : null;
  const askStatus = ask.error instanceof ApiError ? ask.error.status : null;

  return (
    <section className="wiki-ask stack" aria-label={t("modules.wiki.askTitle")}>
      <div className="row">
        <div className="flex flex-col gap-1 grow">
          <Label htmlFor={askId}>{t("modules.wiki.askTitle")}</Label>
          <Input
            id={askId}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder={t("modules.wiki.askPlaceholder")}
            aria-label={t("modules.wiki.askTitle")}
          />
        </div>
        <Button onClick={submit} disabled={ask.isPending || !question.trim()}>
          {ask.isPending ? t("modules.wiki.asking") : t("modules.wiki.ask")}
        </Button>
        <Button
          variant="outline"
          onClick={() => index.mutate()}
          disabled={index.isPending || status.data.indexing}
        >
          {index.isPending || status.data.indexing
            ? t("modules.wiki.indexing")
            : t("modules.wiki.indexNow")}
        </Button>
      </div>
      <span className="muted">
        {t("modules.wiki.indexStatus", {
          indexed: status.data.indexedPages,
          pages: status.data.pages,
          chunks: status.data.chunks,
        })}
      </span>
      {index.isError && (
        <div className="alert alert--danger">
          {t("modules.wiki.indexError", {
            status: index.error instanceof ApiError ? index.error.status : "?",
          })}
        </div>
      )}
      {ask.isError && (
        <div className="alert alert--danger">
          {askStatus === 409
            ? t("modules.wiki.notIndexed")
            : t("modules.wiki.askError", { status: askStatus ?? "?" })}
        </div>
      )}
      {answerHtml && (
        <article className="wiki__doc stack">
          {/* Sanitized by DOMPurify; source is the configured LLM provider's answer. */}
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: markdown rendered through DOMPurify */}
          <div dangerouslySetInnerHTML={{ __html: answerHtml }} />
          {ask.data && ask.data.sources.length > 0 && (
            <div className="row">
              <span className="muted">{t("modules.wiki.sources")}</span>
              {ask.data.sources.map((s) => (
                <Button
                  key={s.path}
                  variant="link"
                  size="clear"
                  onClick={() => onSelectPage(s.path)}
                >
                  {s.title}
                </Button>
              ))}
            </div>
          )}
        </article>
      )}
    </section>
  );
}

function SearchResults({
  results,
  pending,
  onSelect,
}: {
  results: { path: string; title: string; collective: string; snippet: string }[];
  pending: boolean;
  onSelect: (path: string) => void;
}) {
  const { t } = useTranslation();
  if (pending) return <p className="muted">{t("common.loading")}</p>;
  if (results.length === 0) return <p className="muted">{t("modules.wiki.noResults")}</p>;
  return (
    <ul className="status-list">
      {results.map((r) => (
        <li
          key={r.path}
          className="status-item"
          style={{ flexDirection: "column", alignItems: "start" }}
        >
          <Button variant="link" size="clear" onClick={() => onSelect(r.path)}>
            {r.title}
          </Button>
          <span className="muted">{r.collective}</span>
          {r.snippet && <span className="muted">{r.snippet}</span>}
        </li>
      ))}
    </ul>
  );
}

function PageView({
  title,
  html,
  pending,
  error,
}: {
  title?: string;
  html: string | null;
  pending: boolean;
  error: Error | null;
}) {
  const { t } = useTranslation();
  if (pending) return <p className="muted">{t("common.loading")}</p>;
  if (error) {
    const status = error instanceof ApiError ? error.status : "?";
    return <div className="alert alert--danger">{t("modules.wiki.pageError", { status })}</div>;
  }
  if (!html) return null;
  return (
    <article className="wiki__doc stack">
      {title && <h2>{title}</h2>}
      {/* Sanitized by DOMPurify; source is the user's own Collectives content. */}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: markdown rendered through DOMPurify */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  );
}

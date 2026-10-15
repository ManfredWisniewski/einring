import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo, useState } from "react";
import { Button, Input, Label, TextField } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/client";
import { useWikiPage, useWikiSearch, useWikiSync, useWikiTree } from "@/api/hooks";
import type { WikiPageMeta } from "@/api/types";
import { NextcloudGate } from "@/components/NextcloudGate";

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
              className={`wiki-tree__item${n.path === selected ? " wiki-tree__item--active" : ""}`}
              onPress={() => onSelect(n.path as string)}
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
        <Button className="btn" onPress={() => void tree.refetch()}>
          {t("modules.wiki.retry")}
        </Button>
      </div>
    );
  }

  const rendered = page.data ? DOMPurify.sanitize(marked.parse(page.data.content) as string) : null;

  return (
    <div className="stack">
      <div className="row">
        <TextField
          className="select"
          value={query}
          onChange={setQuery}
          aria-label={t("modules.wiki.search")}
        >
          <Label>{t("modules.wiki.search")}</Label>
          <Input className="input" placeholder={t("modules.wiki.search")} />
        </TextField>
        <Button className="btn" onPress={() => sync.mutate()} isDisabled={sync.isPending}>
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
          <Button className="link" onPress={() => onSelect(r.path)}>
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

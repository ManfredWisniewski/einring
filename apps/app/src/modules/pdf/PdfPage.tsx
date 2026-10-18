import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { useApi } from "@/api/hooks";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Renders every page of `doc` into canvases inside `container` — sequential, cancellable (D49). */
async function renderPages(
  doc: PDFDocumentProxy,
  container: HTMLElement,
  cancelled: () => boolean,
): Promise<void> {
  const cssWidth = container.clientWidth || 600;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (let p = 1; p <= doc.numPages; p++) {
    if (cancelled()) return;
    const page = await doc.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.className = "pdf-page";
    const context = canvas.getContext("2d");
    if (!context) continue;
    container.appendChild(canvas);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
  }
}

export function PdfPage() {
  const { t } = useTranslation();
  const api = useApi();
  const [params] = useSearchParams();
  const fileId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [rendered, setRendered] = useState(0);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const src = params.get("src");
  const titleParam = params.get("title");

  // Load the document — from a picked file or an /api-relative ?src= path (D49).
  const load = useCallback(async (data: ArrayBuffer, name: string | null) => {
    setTitle(name);
    setState("loading");
    setDoc(null);
    try {
      const d = await getDocument({ data }).promise;
      setDoc(d);
      setState("idle");
    } catch {
      setState("error");
    }
  }, []);

  const pickFile = (file: File | null) => {
    if (!file) return;
    void file.arrayBuffer().then((buf) => load(buf, file.name));
  };

  useEffect(() => {
    if (!src?.startsWith("/")) return;
    let cancelled = false;
    setState("loading");
    void api
      .blob(src)
      .then((b) => b.arrayBuffer())
      .then((buf) => {
        if (!cancelled) void load(buf, titleParam);
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [src, titleParam, api, load]);

  // Paint the pages whenever the loaded document changes.
  useEffect(() => {
    const container = containerRef.current;
    if (!doc || !container) return;
    container.replaceChildren();
    setRendered(0);
    let cancelled = false;
    void renderPages(doc, container, () => cancelled).then(() => {
      if (!cancelled) setRendered(doc.numPages);
    });
    return () => {
      cancelled = true;
    };
  }, [doc]);

  return (
    <div className="stack">
      <div className="row">
        <div className="flex flex-col gap-1">
          <Label htmlFor={fileId}>{t("modules.pdf.open")}</Label>
          <Input
            id={fileId}
            type="file"
            accept="application/pdf,.pdf"
            onChange={(e) => pickFile(e.currentTarget.files?.[0] ?? null)}
          />
        </div>
      </div>
      {state === "loading" && <p className="muted">{t("common.loading")}</p>}
      {state === "error" && <p className="alert alert--danger">{t("modules.pdf.error")}</p>}
      {doc && (
        <p className="muted">
          {title ? `${title} — ` : ""}
          {t("modules.pdf.pages", { count: doc.numPages })}
          {rendered < doc.numPages ? ` (${t("common.loading")})` : ""}
        </p>
      )}
      {!doc && state === "idle" && !src && <p className="muted">{t("modules.pdf.empty")}</p>}
      <div ref={containerRef} className="pdf-pages" />
    </div>
  );
}

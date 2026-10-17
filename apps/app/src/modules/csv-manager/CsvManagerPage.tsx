import { ArrowLeft, Minus, Plus, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/client";
import {
  useCsvAddRow,
  useCsvDeleteFile,
  useCsvDeleteRow,
  useCsvFile,
  useCsvFiles,
  useCsvImport,
  useCsvUpdateRow,
} from "@/api/hooks";
import type { CsvFileMeta, CsvRow } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

/** The store's `datetime('now')` is "YYYY-MM-DD HH:MM:SS" UTC — normalize for `Date`. */
const parseDbDate = (s: string) => new Date(`${s.replace(" ", "T")}Z`);

const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : "?");

export function CsvManagerPage() {
  const [fileId, setFileId] = useState<number | null>(null);
  return fileId === null ? (
    <FileList onOpen={setFileId} />
  ) : (
    <FileView id={fileId} onBack={() => setFileId(null)} />
  );
}

function FileList({ onOpen }: { onOpen: (id: number) => void }) {
  const { t } = useTranslation();
  const files = useCsvFiles();
  const importCsv = useCsvImport();
  const deleteFile = useCsvDeleteFile();
  const picker = useRef<HTMLInputElement>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    e.target.value = ""; // re-picking the same file must fire onChange again
    if (!picked) return;
    const csv = await picked.text();
    importCsv.mutate({ name: picked.name, csv }, { onSuccess: (meta) => onOpen(meta.id) });
  };

  return (
    <section className="stack">
      <div className="row">
        <h2>{t("modules.csv-manager.files")}</h2>
        <input
          ref={picker}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => void onPick(e)}
        />
        <Button
          variant="outline"
          onClick={() => picker.current?.click()}
          disabled={importCsv.isPending}
        >
          <Upload />
          {importCsv.isPending
            ? t("modules.csv-manager.importing")
            : t("modules.csv-manager.import")}
        </Button>
      </div>
      {importCsv.isError && (
        <div className="alert alert--danger">
          {t("modules.csv-manager.importError", { status: statusOf(importCsv.error) })}
        </div>
      )}
      {files.isPending && <p className="muted">{t("common.loading")}</p>}
      {files.isError && (
        <div className="alert alert--danger row">
          <span>{t("modules.csv-manager.error", { status: statusOf(files.error) })}</span>
          <Button variant="outline" onClick={() => void files.refetch()}>
            {t("modules.csv-manager.retry")}
          </Button>
        </div>
      )}
      {files.data && files.data.length === 0 && (
        <p className="muted">{t("modules.csv-manager.empty")}</p>
      )}
      {files.data && files.data.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t("modules.csv-manager.name")}</th>
                <th scope="col">{t("modules.csv-manager.rows")}</th>
                <th scope="col">{t("modules.csv-manager.imported")}</th>
                <th scope="col">
                  <span className="sr-only">{t("modules.csv-manager.deleteFile")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {files.data.map((f) => (
                <FileListRow
                  key={f.id}
                  file={f}
                  confirming={confirmId === f.id}
                  onOpen={() => onOpen(f.id)}
                  onDelete={() => setConfirmId(f.id)}
                  onConfirmDelete={() => {
                    setConfirmId(null);
                    deleteFile.mutate(f.id);
                  }}
                  onCancelDelete={() => setConfirmId(null)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FileListRow({
  file,
  confirming,
  onOpen,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  file: CsvFileMeta;
  confirming: boolean;
  onOpen: () => void;
  onDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <tr>
      <td>
        <Button variant="link" size="clear" onClick={onOpen}>
          {file.name}
        </Button>
      </td>
      <td>{file.rowCount}</td>
      <td>{parseDbDate(file.createdAt).toLocaleString()}</td>
      <td>
        {confirming ? (
          <span className="row">
            <Button variant="destructive" size="sm" onClick={onConfirmDelete}>
              {t("modules.csv-manager.confirmDelete")}
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancelDelete}>
              {t("modules.csv-manager.back")}
            </Button>
          </span>
        ) : (
          <Button
            variant="ghost"
            size="clear"
            onClick={onDelete}
            aria-label={t("modules.csv-manager.deleteFile")}
          >
            <Trash2 />
          </Button>
        )}
      </td>
    </tr>
  );
}

function FileView({ id, onBack }: { id: number; onBack: () => void }) {
  const { t } = useTranslation();
  const file = useCsvFile(id);
  const updateRow = useCsvUpdateRow(id);
  const addRow = useCsvAddRow(id);
  const deleteRow = useCsvDeleteRow(id);
  const deleteFile = useCsvDeleteFile();
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (file.isPending) return <p className="muted">{t("common.loading")}</p>;
  if (file.isError) {
    return (
      <div className="stack">
        <div className="alert alert--danger row">
          <span>{t("modules.csv-manager.fileError", { status: statusOf(file.error) })}</span>
          <Button variant="outline" onClick={() => void file.refetch()}>
            {t("modules.csv-manager.retry")}
          </Button>
        </div>
        <Button variant="ghost" size="clear" onClick={onBack}>
          <ArrowLeft /> {t("modules.csv-manager.back")}
        </Button>
      </div>
    );
  }
  const data = file.data;

  return (
    <section className="stack">
      <div className="row">
        <Button variant="ghost" size="clear" onClick={onBack}>
          <ArrowLeft /> {t("modules.csv-manager.back")}
        </Button>
        <h2>{data.name}</h2>
        <Button variant="outline" onClick={() => addRow.mutate()} disabled={addRow.isPending}>
          <Plus /> {t("modules.csv-manager.addRow")}
        </Button>
        {confirmDelete ? (
          <>
            <Button
              variant="destructive"
              onClick={() => deleteFile.mutate(id, { onSuccess: onBack })}
            >
              {t("modules.csv-manager.confirmDelete")}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {t("modules.csv-manager.back")}
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
            <Trash2 /> {t("modules.csv-manager.deleteFile")}
          </Button>
        )}
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t("modules.csv-manager.done")}</th>
              {data.headers.map((h, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: csv columns are positional — the index is the identity
                <th key={i} scope="col">
                  {h || t("modules.csv-manager.untitled", { index: i + 1 })}
                </th>
              ))}
              <th scope="col">
                <span className="sr-only">{t("modules.csv-manager.deleteRow")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <RowEditor key={r.id} row={r} headers={data.headers} fileId={id} />
            ))}
          </tbody>
        </table>
        {data.rows.length === 0 && (
          <p className="muted" style={{ padding: "var(--space-3)" }}>
            {t("modules.csv-manager.emptyRows")}
          </p>
        )}
      </div>
      {(updateRow.isError || deleteRow.isError || addRow.isError) && (
        <div className="alert alert--danger">
          {t("modules.csv-manager.fileError", {
            status: statusOf(updateRow.error ?? deleteRow.error ?? addRow.error),
          })}
        </div>
      )}
    </section>
  );
}

function RowEditor({ row, headers, fileId }: { row: CsvRow; headers: string[]; fileId: number }) {
  const { t } = useTranslation();
  const updateRow = useCsvUpdateRow(fileId);
  const deleteRow = useCsvDeleteRow(fileId);
  return (
    <tr className={row.done ? "csv-row--done" : undefined}>
      <td>
        <Checkbox
          checked={row.done}
          onCheckedChange={(v) => updateRow.mutate({ rowId: row.id, done: v === true })}
          aria-label={t("modules.csv-manager.done")}
        />
      </td>
      {row.cells.map((cell, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: csv cells are positional — the index is the identity
        <td key={i}>
          <CellEditor
            value={cell}
            label={headers[i] || t("modules.csv-manager.untitled", { index: i + 1 })}
            onCommit={(v) =>
              updateRow.mutate({
                rowId: row.id,
                cells: row.cells.map((c, j) => (j === i ? v : c)),
              })
            }
          />
        </td>
      ))}
      <td>
        <Button
          variant="ghost"
          size="clear"
          onClick={() => deleteRow.mutate(row.id)}
          aria-label={t("modules.csv-manager.deleteRow")}
        >
          <Trash2 />
        </Button>
      </td>
    </tr>
  );
}

/** A cell committing on blur/Enter; numeric values get −/+ steppers. */
function CellEditor({
  value,
  label,
  onCommit,
}: {
  value: string;
  label: string;
  onCommit: (v: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const numeric = value.trim() !== "" && Number.isFinite(Number(value));

  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  const step = (delta: number) => onCommit(String(Number(value) + delta));

  return (
    <span className="csv-cell">
      {numeric && (
        <Button
          variant="ghost"
          size="clear"
          onClick={() => step(-1)}
          aria-label={t("modules.csv-manager.decrease")}
        >
          <Minus />
        </Button>
      )}
      <Input
        className="csv-cell__input h-8 w-36"
        value={draft ?? value}
        aria-label={label}
        onFocus={() => setDraft(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur(); // commits via onBlur
          if (e.key === "Escape") {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
      {numeric && (
        <Button
          variant="ghost"
          size="clear"
          onClick={() => step(+1)}
          aria-label={t("modules.csv-manager.increase")}
        >
          <Plus />
        </Button>
      )}
    </span>
  );
}

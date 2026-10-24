import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useApi,
  useSchoolAssignHomework,
  useSchoolAssignments,
  useSchoolDeleteHomework,
  useSchoolHomework,
  useSchoolHomeworkDetail,
  useSchoolPatchAssignment,
  useSchoolPersons,
  useSchoolSaveHomework,
  useSchoolSubmitHomework,
} from "@/api/hooks";
import type { SchoolHomeworkAssignment, SchoolHomeworkSubmission } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { fmtDate } from "./shared";

/**
 * Homework (D57): teachers keep a library (title, markup body, MusicXML),
 * assign items to students; students reply with a message + audio/video file.
 */
export default function HomeworkView({ staff }: { staff: boolean }) {
  const { t, i18n } = useTranslation();
  const assignments = useSchoolAssignments();
  const [open, setOpen] = useState<string | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);

  return (
    <div className="stack">
      <div className="row">
        <h2>{t("modules.school.homework.assignments")}</h2>
        {staff && (
          <Button size="sm" variant="outline" onClick={() => setShowLibrary(!showLibrary)}>
            {t("modules.school.homework.library")}
          </Button>
        )}
      </div>
      {staff && showLibrary && <Library />}

      <ul className="stack" style={{ gap: "var(--space-2)" }}>
        {(assignments.data?.assignments ?? []).map((a) => (
          <li key={a.id}>
            <button
              type="button"
              className="linklike"
              onClick={() => setOpen(open === a.id ? null : a.id)}
            >
              <strong>{a.homeworkTitle}</strong>{" "}
              <span className="muted">
                {staff ? `${a.studentName} · ` : ""}
                {a.teacherName ? `${a.teacherName} · ` : ""}
                {t(`modules.school.homework.status.${a.status}`)}
                {a.dueDate
                  ? ` · ${t("modules.school.homework.due")} ${fmtDate(a.dueDate, i18n.language)}`
                  : ""}
              </span>
            </button>
            {open === a.id && <AssignmentDetail a={a} staff={staff} />}
          </li>
        ))}
        {assignments.data && assignments.data.assignments.length === 0 && (
          <li className="muted">{t("modules.school.homework.empty")}</li>
        )}
      </ul>
    </div>
  );
}

function AssignmentDetail({ a, staff }: { a: SchoolHomeworkAssignment; staff: boolean }) {
  const { t } = useTranslation();
  const detail = useSchoolHomeworkDetail(a.homeworkId);
  const submit = useSchoolSubmitHomework();
  const patch = useSchoolPatchAssignment();
  const [message, setMessage] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [feedback, setFeedback] = useState(a.feedback ?? "");

  const hw = detail.data?.homework;
  const sheetUrl = useMemo(
    () =>
      hw?.musicxml
        ? URL.createObjectURL(
            new Blob([hw.musicxml], { type: "application/vnd.recordare.musicxml+xml" }),
          )
        : null,
    [hw?.musicxml],
  );
  useEffect(
    () => () => {
      if (sheetUrl) URL.revokeObjectURL(sheetUrl);
    },
    [sheetUrl],
  );
  return (
    <div className="stack" style={{ gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
      {a.note && <p className="muted">{a.note}</p>}
      {hw?.body && <p style={{ whiteSpace: "pre-wrap" }}>{hw.body}</p>}
      {hw?.musicxml && sheetUrl && (
        <a className="linklike" href={sheetUrl} download={hw.musicxmlName ?? "sheet.musicxml"}>
          {t("modules.school.homework.sheet")} ({hw.musicxmlName ?? "MusicXML"})
        </a>
      )}
      {a.submissions.length > 0 && (
        <ul className="stack" style={{ gap: "var(--space-2)" }}>
          {a.submissions.map((s) => (
            <li key={s.id}>
              <p>{s.message}</p>
              {s.mediaName && <SubmissionMedia s={s} />}
            </li>
          ))}
        </ul>
      )}
      {a.feedback && (
        <p className="muted">
          {t("modules.school.homework.feedback")}: {a.feedback}
        </p>
      )}

      {!staff && (
        <div className="stack" style={{ gap: "var(--space-2)" }}>
          <Textarea
            placeholder={t("modules.school.homework.message")}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <Input
            type="file"
            accept="audio/*,video/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <div className="row">
            <Button
              size="sm"
              disabled={submit.isPending || !message || !file}
              onClick={() =>
                void submit
                  .mutateAsync({ assignmentId: a.id, message, file: file as File })
                  .then(() => {
                    setMessage("");
                    setFile(null);
                  })
              }
            >
              {t("modules.school.homework.submit")}
            </Button>
          </div>
        </div>
      )}

      {staff && a.status === "submitted" && (
        <div className="stack" style={{ gap: "var(--space-2)" }}>
          <Textarea
            placeholder={t("modules.school.homework.feedbackPlaceholder")}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <div className="row">
            <Button
              size="sm"
              disabled={patch.isPending}
              onClick={() =>
                void patch.mutateAsync({
                  id: a.id,
                  body: { status: "reviewed", feedback: feedback || undefined },
                })
              }
            >
              {t("modules.school.homework.markReviewed")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Authenticated media fetch → object URL, then an audio/video element (D57). */
function SubmissionMedia({ s }: { s: SchoolHomeworkSubmission }) {
  const { t } = useTranslation();
  const api = useApi();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let objectUrl: string | null = null;
    void api
      .blob(`/school/homework/submissions/${s.id}/media`)
      .then((b) => {
        objectUrl = URL.createObjectURL(b);
        setUrl(objectUrl);
      })
      .catch(() => setError(true));
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, s.id]);

  if (error) return <span className="muted">{t("modules.school.homework.mediaError")}</span>;
  if (!url) return <span className="muted">{s.mediaName}</span>;
  const Tag = s.mediaMime?.startsWith("video/") ? "video" : "audio";
  return (
    <div className="stack" style={{ gap: "var(--space-1)" }}>
      {/* biome-ignore lint/a11y/useMediaCaption: student recordings carry no captions */}
      <Tag controls src={url} style={{ maxWidth: "100%" }} />
      <a className="linklike muted" href={url} download={s.mediaName ?? "recording"}>
        {s.mediaName}
      </a>
    </div>
  );
}

/* ------------------------------------------------------------- library */

function Library() {
  const { t } = useTranslation();
  const homework = useSchoolHomework();
  const del = useSchoolDeleteHomework();
  const [form, setForm] = useState<string | null>(null);
  return (
    <div className="stack" style={{ gap: "var(--space-2)" }}>
      <div className="row">
        <h3>{t("modules.school.homework.library")}</h3>
        <Button size="sm" variant="outline" onClick={() => setForm(form === "new" ? null : "new")}>
          {t("modules.school.homework.new")}
        </Button>
      </div>
      {form === "new" && <HomeworkForm onDone={() => setForm(null)} />}
      <ul className="stack" style={{ gap: "var(--space-2)" }}>
        {(homework.data?.homework ?? []).map((h) => (
          <li key={h.id}>
            <strong>{h.title}</strong>{" "}
            <span className="muted">
              {h.teacherName ?? ""}
              {h.hasMusicxml ? ` · ${h.musicxmlName ?? "MusicXML"}` : ""}
            </span>
            <div className="row">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setForm(form === h.id ? null : h.id)}
              >
                {t("modules.school.homework.assign")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={del.isPending}
                onClick={() => void del.mutateAsync(h.id)}
              >
                {t("modules.school.homework.delete")}
              </Button>
            </div>
            {form === h.id && <AssignForm homeworkId={h.id} onDone={() => setForm(null)} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

function HomeworkForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const save = useSchoolSaveHomework();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [musicxml, setMusicxml] = useState<string | null>(null);
  const [musicxmlName, setMusicxmlName] = useState<string | null>(null);
  return (
    <div className="stack" style={{ gap: "var(--space-2)" }}>
      <Input
        placeholder={t("modules.school.homework.titlePlaceholder")}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <Textarea
        placeholder={t("modules.school.homework.bodyPlaceholder")}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <Input
        type="file"
        accept=".musicxml,.xml,text/xml"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          void f.text().then((text) => {
            setMusicxml(text);
            setMusicxmlName(f.name);
          });
        }}
      />
      <div className="row">
        <Button
          size="sm"
          disabled={save.isPending || !title}
          onClick={() =>
            void save
              .mutateAsync({
                body: {
                  title,
                  body,
                  musicxml: musicxml ?? undefined,
                  musicxmlName: musicxmlName ?? undefined,
                },
              })
              .then(onDone)
          }
        >
          {t("modules.school.form.save")}
        </Button>
      </div>
    </div>
  );
}

function AssignForm({ homeworkId, onDone }: { homeworkId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const assign = useSchoolAssignHomework();
  const students = useSchoolPersons("student");
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [due, setDue] = useState("");
  const nameOf = (id: string) =>
    (students.data?.persons ?? []).find((p) => p.id === id)?.name ?? id;
  return (
    <div className="stack" style={{ gap: "var(--space-2)" }}>
      <Select value="" onValueChange={(v) => setPicked([...new Set([...picked, v])])}>
        <SelectTrigger aria-label={t("modules.school.form.students")}>
          <SelectValue placeholder={t("modules.school.form.pickStudents")} />
        </SelectTrigger>
        <SelectContent>
          {(students.data?.persons ?? [])
            .filter((p) => !picked.includes(p.id))
            .map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      {picked.length > 0 && (
        <p className="muted">
          {picked.map((id) => (
            <button
              key={id}
              type="button"
              className="linklike"
              onClick={() => setPicked(picked.filter((x) => x !== id))}
            >
              {nameOf(id)} ✕{" "}
            </button>
          ))}
        </p>
      )}
      <Input
        placeholder={t("modules.school.homework.notePlaceholder")}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
      <div className="row">
        <Button
          size="sm"
          disabled={assign.isPending || picked.length === 0}
          onClick={() =>
            void assign
              .mutateAsync({
                homeworkId,
                studentIds: picked,
                note: note || undefined,
                dueDate: due || undefined,
              })
              .then(onDone)
          }
        >
          {t("modules.school.homework.assign")}
        </Button>
      </div>
    </div>
  );
}

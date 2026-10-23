import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useSchoolCheckConflicts,
  useSchoolCreateLesson,
  useSchoolDeleteSeries,
  useSchoolHolidays,
  useSchoolLessons,
  useSchoolLessonTypes,
  useSchoolPersons,
  useSchoolSaveHoliday,
  useSchoolSaveSeries,
  useSchoolSeries,
} from "@/api/hooks";
import type { SchoolPerson } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { addDaysLocal, fmtDate, todayLocal, weekStart } from "./shared";

/** Week calendar + series/holiday management (staff sections gated by props). */
export default function CalendarView({
  staff,
  admin,
  person,
}: {
  staff: boolean;
  admin: boolean;
  person: SchoolPerson | null;
}) {
  const { t, i18n } = useTranslation();
  const [anchor, setAnchor] = useState(todayLocal());
  const start = weekStart(anchor);
  const end = addDaysLocal(start, 6);
  const lessons = useSchoolLessons(start, end);
  const holidays = useSchoolHolidays();
  const [showForm, setShowForm] = useState<"series" | "lesson" | "holiday" | null>(null);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDaysLocal(start, i)), [start]);
  const byDay = useMemo(() => {
    const map = new Map<
      string,
      typeof lessons.data extends undefined ? never : NonNullable<typeof lessons.data>["lessons"]
    >();
    for (const d of days) map.set(d, []);
    for (const l of lessons.data?.lessons ?? []) map.get(l.date)?.push(l);
    return map;
  }, [lessons.data, days]);

  return (
    <div className="stack">
      <div className="row">
        <Button size="sm" variant="outline" onClick={() => setAnchor(addDaysLocal(start, -7))}>
          ←
        </Button>
        <strong>
          {fmtDate(start, i18n.language)} – {fmtDate(end, i18n.language)}
        </strong>
        <Button size="sm" variant="outline" onClick={() => setAnchor(addDaysLocal(start, 7))}>
          →
        </Button>
        <Button size="sm" variant="outline" onClick={() => setAnchor(todayLocal())}>
          {t("modules.school.calendar.thisWeek")}
        </Button>
      </div>

      <ul className="stack" style={{ gap: "var(--space-2)" }}>
        {days.map((d) => (
          <li key={d}>
            <strong>{fmtDate(d, i18n.language)}</strong>
            <ul className="muted">
              {(byDay.get(d) ?? []).length === 0 && <li>—</li>}
              {(byDay.get(d) ?? []).map((l) => (
                <li key={l.id}>
                  {l.startTime} · {l.typeName ?? t("modules.school.lesson")} ·{" "}
                  {l.students.map((s) => s.studentName ?? "…").join(", ") || l.teacherName}
                  {l.status !== "scheduled" ? ` [${t(`modules.school.status.${l.status}`)}]` : ""}
                  {l.isMakeup ? ` [${t("modules.school.makeup")}]` : ""}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>

      {staff && (
        <div className="row">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowForm(showForm === "lesson" ? null : "lesson")}
          >
            {t("modules.school.calendar.newLesson")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowForm(showForm === "series" ? null : "series")}
          >
            {t("modules.school.calendar.newSeries")}
          </Button>
          {admin && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowForm(showForm === "holiday" ? null : "holiday")}
            >
              {t("modules.school.calendar.newHoliday")}
            </Button>
          )}
        </div>
      )}
      {showForm === "lesson" && (
        <LessonForm teacherId={person?.id ?? null} onDone={() => setShowForm(null)} />
      )}
      {showForm === "series" && (
        <SeriesForm admin={admin} teacherId={person?.id ?? null} onDone={() => setShowForm(null)} />
      )}
      {showForm === "holiday" && admin && <HolidayForm onDone={() => setShowForm(null)} />}

      {staff && <SeriesList admin={admin} />}
      {admin && (
        <div className="stack">
          <h3>{t("modules.school.calendar.holidays")}</h3>
          <ul className="muted">
            {(holidays.data?.holidays ?? []).map((h) => (
              <li key={h.id}>
                {h.name}: {h.startDate ?? h.start_date} – {h.endDate ?? h.end_date}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function TeacherStudentsSelect({
  value,
  onChange,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const students = useSchoolPersons("student");
  return (
    <Select value="" onValueChange={(v) => onChange([...new Set([...value, v])])}>
      <SelectTrigger aria-label={t("modules.school.form.students")}>
        <SelectValue placeholder={t("modules.school.form.pickStudents")} />
      </SelectTrigger>
      <SelectContent>
        {(students.data?.persons ?? []).map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function LessonForm({ teacherId, onDone }: { teacherId: string | null; onDone: () => void }) {
  const { t } = useTranslation();
  const create = useSchoolCreateLesson();
  const check = useSchoolCheckConflicts();
  const types = useSchoolLessonTypes();
  const [date, setDate] = useState(todayLocal());
  const [time, setTime] = useState("15:00");
  const [duration, setDuration] = useState(45);
  const [typeId, setTypeId] = useState("");
  const [studentIds, setStudentIds] = useState<string[]>([]);
  const [conflicts, setConflicts] = useState<string[]>([]);

  const submit = async (force = false) => {
    if (!teacherId && !types.data) return;
    const body = {
      teacherId: teacherId ?? undefined,
      lessonTypeId: typeId || undefined,
      date,
      startTime: time,
      durationMin: duration,
      studentIds,
      force: force || undefined,
    };
    if (!force) {
      const res = await check.mutateAsync({
        teacherId: teacherId ?? "",
        studentIds,
        date,
        startTime: time,
        durationMin: duration,
      });
      if (res.conflicts.length > 0) {
        setConflicts(res.conflicts.map((c) => c.detail));
        return;
      }
    }
    await create.mutateAsync(body);
    onDone();
  };

  return (
    <div className="stack">
      <h3>{t("modules.school.calendar.newLesson")}</h3>
      <div className="row">
        <Label>{t("modules.school.form.date")}</Label>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <Label>{t("modules.school.form.time")}</Label>
        <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        <Label>{t("modules.school.form.duration")}</Label>
        <Input
          type="number"
          min={5}
          value={duration}
          onChange={(e) => setDuration(Number(e.target.value))}
        />
      </div>
      <div className="row">
        <Select value={typeId} onValueChange={setTypeId}>
          <SelectTrigger aria-label={t("modules.school.form.type")}>
            <SelectValue placeholder={t("modules.school.form.type")} />
          </SelectTrigger>
          <SelectContent>
            {(types.data?.lessonTypes ?? []).map((lt) => (
              <SelectItem key={lt.id} value={lt.id}>
                {lt.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <TeacherStudentsSelect value={studentIds} onChange={setStudentIds} />
      </div>
      {conflicts.map((c) => (
        <p key={c} className="text-danger">
          {c}
        </p>
      ))}
      <div className="row">
        <Button
          size="sm"
          disabled={create.isPending || studentIds.length === 0}
          onClick={() => void submit(false)}
        >
          {t("modules.school.form.save")}
        </Button>
        {conflicts.length > 0 && (
          <Button size="sm" variant="destructive" onClick={() => void submit(true)}>
            {t("modules.school.form.saveForced")}
          </Button>
        )}
      </div>
    </div>
  );
}

function SeriesForm({
  admin,
  teacherId,
  onDone,
}: {
  admin: boolean;
  teacherId: string | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const save = useSchoolSaveSeries();
  const types = useSchoolLessonTypes();
  const teachers = useSchoolPersons("teacher", admin);
  const [weekday, setWeekday] = useState("1");
  const [time, setTime] = useState("15:00");
  const [duration, setDuration] = useState(45);
  const [from, setFrom] = useState(todayLocal());
  const [until, setUntil] = useState("");
  const [typeId, setTypeId] = useState("");
  const [tid, setTid] = useState(teacherId ?? "");
  const [studentIds, setStudentIds] = useState<string[]>([]);

  const submit = async () => {
    await save.mutateAsync({
      body: {
        teacherId: tid,
        lessonTypeId: typeId || undefined,
        weekday: Number(weekday),
        startTime: time,
        durationMin: duration,
        validFrom: from,
        validUntil: until || undefined,
        studentIds,
      },
    });
    onDone();
  };

  return (
    <div className="stack">
      <h3>{t("modules.school.calendar.newSeries")}</h3>
      <div className="row">
        {admin && (
          <Select value={tid} onValueChange={setTid}>
            <SelectTrigger aria-label={t("modules.school.form.teacher")}>
              <SelectValue placeholder={t("modules.school.form.teacher")} />
            </SelectTrigger>
            <SelectContent>
              {(teachers.data?.persons ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={weekday} onValueChange={setWeekday}>
          <SelectTrigger aria-label={t("modules.school.form.weekday")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[1, 2, 3, 4, 5, 6, 0].map((d) => (
              <SelectItem key={d} value={String(d)}>
                {t(`modules.school.weekday.${d}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        <Input
          type="number"
          min={5}
          value={duration}
          onChange={(e) => setDuration(Number(e.target.value))}
          aria-label={t("modules.school.form.duration")}
        />
      </div>
      <div className="row">
        <Label>{t("modules.school.form.validFrom")}</Label>
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Label>{t("modules.school.form.validUntil")}</Label>
        <Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
        <Select value={typeId} onValueChange={setTypeId}>
          <SelectTrigger aria-label={t("modules.school.form.type")}>
            <SelectValue placeholder={t("modules.school.form.type")} />
          </SelectTrigger>
          <SelectContent>
            {(types.data?.lessonTypes ?? []).map((lt) => (
              <SelectItem key={lt.id} value={lt.id}>
                {lt.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <TeacherStudentsSelect value={studentIds} onChange={setStudentIds} />
      </div>
      <div className="row">
        <Button
          size="sm"
          disabled={save.isPending || !tid || studentIds.length === 0}
          onClick={() => void submit()}
        >
          {t("modules.school.form.save")}
        </Button>
      </div>
    </div>
  );
}

function HolidayForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const save = useSchoolSaveHoliday();
  const [name, setName] = useState("");
  const [from, setFrom] = useState(todayLocal());
  const [to, setTo] = useState(todayLocal());
  return (
    <div className="stack">
      <h3>{t("modules.school.calendar.newHoliday")}</h3>
      <div className="row">
        <Input
          placeholder={t("modules.school.form.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <Button
          size="sm"
          disabled={save.isPending || !name}
          onClick={() => void save.mutateAsync({ name, startDate: from, endDate: to }).then(onDone)}
        >
          {t("modules.school.form.save")}
        </Button>
      </div>
    </div>
  );
}

function SeriesList({ admin }: { admin: boolean }) {
  const { t } = useTranslation();
  const series = useSchoolSeries(true);
  const del = useSchoolDeleteSeries();
  return (
    <div className="stack">
      <h3>{t("modules.school.calendar.series")}</h3>
      {(series.data?.series ?? []).length === 0 && (
        <p className="muted">{t("modules.school.calendar.noSeries")}</p>
      )}
      <ul className="muted">
        {(series.data?.series ?? []).map((s) => (
          <li key={s.id}>
            {t(`modules.school.weekday.${s.weekday}`)} {s.startTime} ·{" "}
            {s.typeName ?? t("modules.school.lesson")} · {s.teacherName} ·{" "}
            {(s.students ?? []).map((x) => x.name).join(", ")} ({s.validFrom}
            {s.validUntil ? ` – ${s.validUntil}` : ` – ${t("modules.school.calendar.openEnded")}`})
            {admin && (
              <>
                {" "}
                <button
                  type="button"
                  className="linklike text-danger"
                  onClick={() => del.mutate(s.id)}
                >
                  {t("modules.school.calendar.endSeries")}
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

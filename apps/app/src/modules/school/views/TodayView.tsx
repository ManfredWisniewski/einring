import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSchoolLessons, useSchoolMarkAttendance, useSchoolReportAbsence } from "@/api/hooks";
import type { SchoolLesson, SchoolPerson, SchoolRole } from "@/api/types";
import { Button } from "@/components/ui/button";
import { todayLocal } from "./shared";

/**
 * "Today" — the daily-driver view: today's lessons with one-tap attendance
 * (staff) or absence reporting (parents/students).
 */
export default function TodayView({
  roles,
  person,
}: {
  roles: SchoolRole[];
  person: SchoolPerson | null;
}) {
  const { t, i18n } = useTranslation();
  const today = todayLocal();
  const lessons = useSchoolLessons(today, today);
  const mark = useSchoolMarkAttendance();
  const report = useSchoolReportAbsence();
  const [expanded, setExpanded] = useState<string | null>(null);
  const staff = roles.includes("admin") || roles.includes("teacher");
  const canReport = roles.includes("parent") || roles.includes("student");

  if (lessons.isPending) return <p className="muted">{t("common.loading")}</p>;
  const items = lessons.data?.lessons ?? [];

  const statusLabel = (l: SchoolLesson) =>
    l.status === "scheduled" ? null : t(`modules.school.status.${l.status}`);

  return (
    <div className="stack">
      <h2>{t("modules.school.today.title")}</h2>
      {items.length === 0 && <p className="muted">{t("modules.school.today.empty")}</p>}
      <ul className="stack" style={{ gap: "var(--space-2)" }}>
        {items.map((l) => (
          <li key={l.id} className="eindav-row">
            <button
              type="button"
              className="linklike"
              onClick={() => setExpanded(expanded === l.id ? null : l.id)}
            >
              <strong>
                {l.startTime} · {l.typeName ?? t("modules.school.lesson")}
              </strong>{" "}
              <span className="muted">
                {l.teacherName}
                {l.substituteName ? ` → ${l.substituteName}` : ""}
                {l.location ? ` · ${l.location}` : ""}
              </span>
              {statusLabel(l) && <span className="text-danger"> {statusLabel(l)}</span>}
            </button>
            {l.students.length > 0 && (
              <ul className="muted">
                {l.students.map((s) => (
                  <li key={s.studentId}>
                    {s.studentName ?? s.studentId}
                    {s.attendance ? ` — ${t(`modules.school.attendance.${s.attendance}`)}` : ""}
                  </li>
                ))}
              </ul>
            )}
            {expanded === l.id && (
              <div className="stack" style={{ gap: "var(--space-2)" }}>
                {staff &&
                  l.status === "scheduled" &&
                  l.students.map((s) => (
                    <div key={s.studentId} className="row">
                      <span>{s.studentName ?? s.studentId}</span>
                      {(["attended", "absent_excused", "absent_unexcused"] as const).map((a) => (
                        <Button
                          key={a}
                          size="sm"
                          variant={s.attendance === a ? "default" : "outline"}
                          disabled={mark.isPending}
                          onClick={() =>
                            mark.mutate({ lessonId: l.id, studentId: s.studentId, attendance: a })
                          }
                        >
                          {t(`modules.school.attendance.${a}`)}
                        </Button>
                      ))}
                    </div>
                  ))}
                {canReport &&
                  l.status === "scheduled" &&
                  l.students
                    .filter((s) => !s.attendance)
                    .map((s) => (
                      <div key={s.studentId} className="row">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={report.isPending}
                          onClick={() =>
                            report.mutate({
                              lessonId: l.id,
                              studentId: s.studentId,
                              wantMakeup: true,
                            })
                          }
                        >
                          {t("modules.school.today.reportAbsence", {
                            name: s.studentName ?? person?.name ?? "",
                          })}
                        </Button>
                      </div>
                    ))}
                {l.students.some((s) => s.practice) && (
                  <p className="muted">
                    {t("modules.school.today.practice")}:{" "}
                    {l.students
                      .map((s) => s.practice)
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
                {l.students.some((s) => s.publicNote) && (
                  <p className="muted">
                    {l.students
                      .map((s) => s.publicNote)
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="muted">
        {new Intl.DateTimeFormat(i18n.language, { dateStyle: "full" }).format(new Date())}
      </p>
    </div>
  );
}

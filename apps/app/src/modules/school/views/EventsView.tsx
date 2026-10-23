import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSchoolConfirmParticipation, useSchoolEvents, useSchoolSaveEvent } from "@/api/hooks";
import type { SchoolPerson } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmtDate } from "./shared";

/** Recitals/exams: list + detail + parent confirmation (D56). */
export default function EventsView({
  staff,
  person,
}: {
  staff: boolean;
  person: SchoolPerson | null;
}) {
  const { t, i18n } = useTranslation();
  const events = useSchoolEvents();
  const confirm = useSchoolConfirmParticipation();
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="stack">
      <div className="row">
        <h2>{t("modules.school.events.title")}</h2>
        {staff && (
          <Button size="sm" variant="outline" onClick={() => setShowForm(!showForm)}>
            {t("modules.school.events.new")}
          </Button>
        )}
      </div>
      {showForm && staff && <EventForm onDone={() => setShowForm(false)} />}
      <ul className="stack" style={{ gap: "var(--space-3)" }}>
        {(events.data?.events ?? []).map((e) => (
          <li key={e.id}>
            <strong>{e.title}</strong>{" "}
            <span className="muted">
              {t(`modules.school.events.kind.${e.kind}`)} · {fmtDate(e.date, i18n.language)}
              {e.startTime ? ` ${e.startTime}` : ""}
              {e.location ? ` · ${e.location}` : ""}
              {e.teacherName ? ` · ${e.teacherName}` : ""}
            </span>
            {e.description && <p className="muted">{e.description}</p>}
            {e.participants.length > 0 && (
              <ul className="muted">
                {e.participants.map((p) => (
                  <li key={p.studentId} className="row">
                    <span>
                      {p.studentName}
                      {p.piece ? ` — ${p.piece}` : ""} (
                      {t(`modules.school.events.status.${p.status}`)})
                    </span>
                    {p.status === "invited" && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={confirm.isPending}
                          onClick={() =>
                            confirm.mutate({
                              eventId: e.id,
                              studentId: p.studentId,
                              status: "confirmed",
                            })
                          }
                        >
                          {t("modules.school.events.confirm")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={confirm.isPending}
                          onClick={() =>
                            confirm.mutate({
                              eventId: e.id,
                              studentId: p.studentId,
                              status: "declined",
                            })
                          }
                        >
                          {t("modules.school.events.decline")}
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {e.rehearsals.length > 0 && (
              <p className="muted">
                {t("modules.school.events.rehearsals")}:{" "}
                {e.rehearsals
                  .map((r) => `${fmtDate(r.date, i18n.language)} ${r.startTime}`)
                  .join(", ")}
              </p>
            )}
          </li>
        ))}
        {events.data && events.data.events.length === 0 && (
          <li className="muted">{t("modules.school.events.empty")}</li>
        )}
      </ul>
      {person === null && staff === false && null}
    </div>
  );
}

function EventForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const save = useSchoolSaveEvent();
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [location, setLocation] = useState("");
  return (
    <div className="row">
      <Input
        placeholder={t("modules.school.form.name")}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
      <Input
        placeholder={t("modules.school.form.location")}
        value={location}
        onChange={(e) => setLocation(e.target.value)}
      />
      <Button
        size="sm"
        disabled={save.isPending || !title || !date}
        onClick={() =>
          void save
            .mutateAsync({
              body: {
                title,
                date,
                startTime: time || undefined,
                location: location || undefined,
                kind: "recital",
              },
            })
            .then(onDone)
        }
      >
        {t("modules.school.form.save")}
      </Button>
    </div>
  );
}

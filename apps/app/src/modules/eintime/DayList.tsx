import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEintimeDeleteEntry, useEintimeUpdateEntry } from "~/api/hooks";
import type { EintimeSegment } from "~/api/types";
import { formatDuration } from "./duration";

const hm = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const segMinutes = (s: EintimeSegment) =>
  Math.max(0, (Date.parse(s.segEnd) - Date.parse(s.segStart)) / 60_000);

function EntryRow({ seg }: { seg: EintimeSegment }) {
  const { t } = useTranslation();
  const update = useEintimeUpdateEntry();
  const del = useEintimeDeleteEntry();
  const [description, setDescription] = useState(seg.description);
  const [tags, setTags] = useState(seg.tags.join(", "));

  const commit = () => {
    const tagList = tags
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (description !== seg.description || tagList.join() !== seg.tags.join()) {
      update.mutate({ id: seg.entryId, patch: { description, tags: tagList } });
    }
  };

  return (
    <div className="row eintime-entry">
      <span className="muted eintime-entry__time">
        {hm(seg.segStart)}–{hm(seg.segEnd)}
      </span>
      <span className="eintime-entry__dur">
        {seg.running ? <em>{t("modules.eintime.running")}</em> : formatDuration(segMinutes(seg))}
      </span>
      <Input
        className="grow"
        value={description}
        aria-label={t("modules.eintime.whatWorking")}
        onChange={(e) => setDescription(e.target.value)}
        onBlur={commit}
      />
      <span className="muted eintime-entry__proj">
        {[seg.projectName, seg.taskName].filter(Boolean).join(" · ")}
      </span>
      <Input
        className="w-32"
        value={tags}
        aria-label={t("modules.eintime.tags")}
        onChange={(e) => setTags(e.target.value)}
        onBlur={commit}
      />
      <Label className="row gap-1">
        <Checkbox
          checked={seg.billable}
          onCheckedChange={(v) =>
            update.mutate({ id: seg.entryId, patch: { billable: v === true } })
          }
          aria-label={t("modules.eintime.billable")}
        />
      </Label>
      <Button
        variant="text"
        size="icon"
        aria-label={t("modules.eintime.delete")}
        onClick={() => {
          if (window.confirm(t("modules.eintime.deleteConfirm"))) del.mutate(seg.entryId);
        }}
      >
        <Trash2 className="size-4" aria-hidden />
      </Button>
    </div>
  );
}

/** Entries rolled up under localized day headers, newest first (spec eintime FR-006). */
export function DayList({ segments }: { segments: EintimeSegment[] }) {
  const { t } = useTranslation();
  const days = [...new Map(segments.map((s) => [s.day, s.day])).keys()].sort().reverse();
  if (days.length === 0) return <p className="muted">{t("modules.eintime.entriesEmpty")}</p>;
  return (
    <div className="stack">
      {days.map((day) => {
        const segs = segments
          .filter((s) => s.day === day)
          .sort((a, b) => Date.parse(b.segStart) - Date.parse(a.segStart));
        const total = segs.reduce((sum, s) => sum + segMinutes(s), 0);
        return (
          <section key={day} className="stack">
            <h3 className="row justify-between">
              <span>
                {new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                })}
              </span>
              <span className="muted">{formatDuration(total)}</span>
            </h3>
            {segs.map((s) => (
              <EntryRow key={`${s.entryId}-${s.segStart}`} seg={s} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

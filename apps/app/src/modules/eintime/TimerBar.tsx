import { Play, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useEintimePatchTimer,
  useEintimeProjects,
  useEintimeStartTimer,
  useEintimeStopTimer,
} from "~/api/hooks";
import type { EintimeEntry } from "~/api/types";
import { ProjectTaskPickers, resolveMapping } from "./Pickers";

const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  return `${h}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * The module-page timer (spec eintime FR-002/FR-003): start now, attach
 * project/task/tags/billable while it runs or after stop.
 */
export function TimerBar({ running }: { running: EintimeEntry | null }) {
  const { t } = useTranslation();
  const projects = useEintimeProjects();
  const start = useEintimeStartTimer();
  const patch = useEintimePatchTimer();
  const stop = useEintimeStopTimer();

  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  // Mirror the running entry into the editable fields whenever a different entry
  // starts running (adjust-state-during-render, not an effect).
  const [prevRunningId, setPrevRunningId] = useState(running?.id);
  if (running?.id !== prevRunningId) {
    setPrevRunningId(running?.id);
    setDescription(running?.description ?? "");
    setTags((running?.tags ?? []).join(", "));
    setProjectId(running?.projectExternalId ?? null);
    setTaskId(running?.taskExternalId ?? null);
  }

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [running]);

  const mapping = () => resolveMapping(projects.data, projectId, taskId);
  const onPick = (p: string | null, x: string | null) => {
    setProjectId(p);
    setTaskId(x);
    if (running) patch.mutate(resolveMapping(projects.data, p, x));
  };
  const onBlur = () => {
    if (!running) return;
    const tagList = tags
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (description !== running.description || tagList.join() !== running.tags.join()) {
      patch.mutate({ description, tags: tagList });
    }
  };
  const onStart = () => {
    const tagList = tags
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    start.mutate({ description, tags: tagList, ...mapping() });
  };

  return (
    <div className="stack eintime-timer">
      <div className="row">
        <Input
          className="grow"
          value={description}
          placeholder={t("modules.eintime.whatWorking")}
          aria-label={t("modules.eintime.whatWorking")}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={onBlur}
        />
        {running ? (
          <span className="eintime-timer__clock" aria-live="off">
            {clock((now - Date.parse(running.start)) / 1000)}
          </span>
        ) : null}
        <Button
          onClick={running ? () => stop.mutate() : onStart}
          disabled={start.isPending || stop.isPending}
        >
          {running ? (
            <>
              <Square className="size-4" aria-hidden /> {t("modules.eintime.timerStop")}
            </>
          ) : (
            <>
              <Play className="size-4" aria-hidden /> {t("modules.eintime.timerStart")}
            </>
          )}
        </Button>
      </div>
      <div className="row">
        <ProjectTaskPickers
          projects={projects.data}
          projectExternalId={projectId}
          taskExternalId={taskId}
          onChange={onPick}
        />
        <Input
          className="min-w-40"
          value={tags}
          placeholder={t("modules.eintime.tagsPlaceholder")}
          aria-label={t("modules.eintime.tags")}
          onChange={(e) => setTags(e.target.value)}
          onBlur={onBlur}
        />
        <Label className="row gap-2">
          <Checkbox
            checked={running ? running.billable : false}
            disabled={!running}
            onCheckedChange={(v) => patch.mutate({ billable: v === true })}
            aria-label={t("modules.eintime.billable")}
          />
          {t("modules.eintime.billable")}
        </Label>
      </div>
      {projects.data && projects.data.projects.length === 0 && (
        <p className="muted">{t("modules.eintime.pickersEmpty")}</p>
      )}
    </div>
  );
}

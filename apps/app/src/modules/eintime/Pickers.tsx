import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { EintimeEntryInput } from "~/api/hooks";
import type { EintimeProjects } from "~/api/types";

const NONE = "__none";

/** Resolve a picked project/task pair into the entry write shape (ids + name snapshots). */
export function resolveMapping(
  projects: EintimeProjects | undefined,
  projectExternalId: string | null,
  taskExternalId: string | null,
): EintimeEntryInput {
  if (!projects || !projectExternalId) {
    return {
      provider: null,
      projectExternalId: null,
      taskExternalId: null,
      clientName: null,
      projectName: null,
      taskName: null,
    };
  }
  const project = projects.projects.find((p) => p.externalId === projectExternalId);
  const client = projects.clients.find((c) => c.externalId === project?.clientExternalId);
  const task = projects.tasks.find(
    (t) => t.projectExternalId === projectExternalId && t.externalId === taskExternalId,
  );
  return {
    provider: project?.provider ?? null,
    projectExternalId: project?.externalId ?? null,
    taskExternalId: task?.externalId ?? null,
    clientName: client?.name ?? null,
    projectName: project?.name ?? null,
    taskName: task?.name ?? null,
  };
}

/**
 * Project + task pickers over the provider mapping layer (spec eintime FR-009).
 * Tasks filter by the chosen project; clearing the project clears the task.
 */
export function ProjectTaskPickers({
  projects,
  projectExternalId,
  taskExternalId,
  onChange,
}: {
  projects: EintimeProjects | undefined;
  projectExternalId: string | null;
  taskExternalId: string | null;
  onChange: (projectExternalId: string | null, taskExternalId: string | null) => void;
}) {
  const { t } = useTranslation();
  const tasks = (projects?.tasks ?? []).filter(
    (x) => projectExternalId && x.projectExternalId === projectExternalId,
  );
  const clientName = (externalId: string | null) =>
    projects?.clients.find((c) => c.externalId === externalId)?.name;

  return (
    <>
      <Select
        value={projectExternalId ?? NONE}
        onValueChange={(v) => onChange(v === NONE ? null : v, null)}
      >
        <SelectTrigger className="min-w-40" aria-label={t("modules.eintime.project")}>
          <SelectValue placeholder={t("modules.eintime.noProject")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{t("modules.eintime.noProject")}</SelectItem>
          {(projects?.projects ?? []).map((p) => (
            <SelectItem key={`${p.provider}:${p.externalId}`} value={p.externalId}>
              {p.name}
              {p.clientExternalId ? ` · ${clientName(p.clientExternalId) ?? ""}` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={taskExternalId ?? NONE}
        onValueChange={(v) => onChange(projectExternalId, v === NONE ? null : v)}
        disabled={!projectExternalId || tasks.length === 0}
      >
        <SelectTrigger className="min-w-40" aria-label={t("modules.eintime.task")}>
          <SelectValue placeholder={t("modules.eintime.noTask")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{t("modules.eintime.noTask")}</SelectItem>
          {tasks.map((x) => (
            <SelectItem key={x.externalId} value={x.externalId}>
              {x.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}

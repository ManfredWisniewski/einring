import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ApiError } from "~/api/client";
import { useEinpillMedications } from "~/api/hooks";
import type { EinpillMedication } from "~/api/types";
import { formatDate, formatPills } from "./format";
import { CreateMedicationForm, MedicationEditor } from "./MedicationForm";
import { PackageList } from "./PackageList";

const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : "?");

function stateText(medication: EinpillMedication, t: (key: string) => string): string | null {
  if (medication.projection.state === "untracked") return t("modules.einpill.noPackage");
  if (medication.projection.state === "exhausted") return t("modules.einpill.exhausted");
  return null;
}

export function EinpillPage() {
  const { t, i18n } = useTranslation();
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const medications = useEinpillMedications(showArchived);
  const rows = medications.data?.medications ?? [];

  return (
    <section className="stack">
      <div className="row">
        <h2>{t("modules.einpill.title")}</h2>
        <Button variant="outlined" onClick={() => setCreating((v) => !v)}>
          {creating ? t("modules.einpill.cancel") : t("modules.einpill.addMedication")}
        </Button>
        <Button variant="text" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? t("modules.einpill.hideArchived") : t("modules.einpill.showArchived")}
        </Button>
      </div>

      {creating && <CreateMedicationForm onDone={() => setCreating(false)} />}
      {medications.isPending && <p className="muted">{t("common.loading")}</p>}
      {medications.isError && (
        <div className="alert alert--danger row">
          <span>{t("modules.einpill.loadError", { status: statusOf(medications.error) })}</span>
          <Button variant="outlined" onClick={() => void medications.refetch()}>
            {t("modules.einpill.retry")}
          </Button>
        </div>
      )}
      {!medications.isPending && !medications.isError && rows.length === 0 && (
        <p className="muted">{t("modules.einpill.empty")}</p>
      )}

      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t("modules.einpill.name")}</th>
                <th scope="col">{t("modules.einpill.dailyUsage")}</th>
                <th scope="col">{t("modules.einpill.pillsPerPackage")}</th>
                <th scope="col">{t("modules.einpill.currentSince")}</th>
                <th scope="col">{t("modules.einpill.currentRemaining")}</th>
                <th scope="col">{t("modules.einpill.spares")}</th>
                <th scope="col">{t("modules.einpill.runout")}</th>
                <th scope="col">{t("modules.einpill.remaining")}</th>
                <th scope="col">
                  <span className="sr-only">{t("modules.einpill.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((medication) => {
                const state = stateText(medication, t);
                const open = openId === medication.id;
                return (
                  <Fragment key={medication.id}>
                    <tr>
                      <td>
                        <span className="row">
                          <Button
                            variant="text"
                            size="clear"
                            className="underline-offset-4 hover:underline"
                            onClick={() => setOpenId(open ? null : medication.id)}
                          >
                            {medication.name}
                          </Button>
                          {medication.archived && (
                            <span className="muted">{t("modules.einpill.archivedBadge")}</span>
                          )}
                        </span>
                      </td>
                      <td>{formatPills(medication.dailyUsage, i18n.language)}</td>
                      <td>{medication.pillsPerPackage}</td>
                      <td>{formatDate(medication.projection.currentStartedDate, i18n.language)}</td>
                      <td>
                        {medication.projection.state === "untracked"
                          ? "—"
                          : formatPills(medication.projection.currentRemainingPills, i18n.language)}
                      </td>
                      <td>{medication.projection.sparePackages}</td>
                      <td>
                        {formatDate(medication.projection.runoutDate, i18n.language)}
                        {state ? ` · ${state}` : ""}
                      </td>
                      <td>
                        {medication.projection.state === "untracked"
                          ? "—"
                          : t("modules.einpill.days", {
                              count: medication.projection.remainingDays,
                            })}
                      </td>
                      <td>
                        <Button
                          variant="outlined"
                          size="sm"
                          onClick={() => setOpenId(open ? null : medication.id)}
                        >
                          {open ? t("modules.einpill.close") : t("modules.einpill.edit")}
                        </Button>
                      </td>
                    </tr>
                    {open && (
                      <tr key={`${medication.id}-details`}>
                        <td colSpan={9}>
                          <div className="stack">
                            <MedicationEditor
                              key={medication.id}
                              medication={medication}
                              onDeleted={() => setOpenId(null)}
                            />
                            <PackageList medication={medication} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

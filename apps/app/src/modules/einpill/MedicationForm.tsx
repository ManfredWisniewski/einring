import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "~/api/client";
import {
  useEinpillCreateMedication,
  useEinpillDeleteMedication,
  useEinpillPatchMedication,
  useEinpillPutRevision,
} from "~/api/hooks";
import type { EinpillMedication } from "~/api/types";
import { todayInputValue, validDailyUsage, validPillsPerPackage } from "./format";

const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : "?");

function ErrorText({ error, prefix }: { error: unknown; prefix: string }) {
  const { t } = useTranslation();
  if (!error) return null;
  return <div className="alert alert--danger">{t(prefix, { status: statusOf(error) })}</div>;
}

export function CreateMedicationForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const create = useEinpillCreateMedication();
  const [name, setName] = useState("");
  const [pills, setPills] = useState("30");
  const [usage, setUsage] = useState("1");
  const [effectiveDate, setEffectiveDate] = useState(todayInputValue());
  const [invalid, setInvalid] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const pillsPerPackage = Number(pills);
    const dailyUsage = Number(usage);
    if (!name.trim() || !validPillsPerPackage(pillsPerPackage) || !validDailyUsage(dailyUsage)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    create.mutate(
      {
        name: name.trim(),
        pillsPerPackage,
        dailyUsage,
        ...(effectiveDate ? { effectiveDate } : {}),
      },
      { onSuccess: onDone },
    );
  };

  return (
    <form className="stack" onSubmit={submit}>
      <h3>{t("modules.einpill.addMedication")}</h3>
      <Label>
        {t("modules.einpill.name")}
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
      </Label>
      <div className="row">
        <Label>
          {t("modules.einpill.pillsPerPackage")}
          <Input
            type="number"
            min={1}
            max={10000}
            step={1}
            value={pills}
            onChange={(e) => setPills(e.target.value)}
            required
          />
        </Label>
        <Label>
          {t("modules.einpill.dailyUsage")}
          <Input
            type="number"
            min={0.001}
            max={100}
            step={0.001}
            value={usage}
            onChange={(e) => setUsage(e.target.value)}
            required
          />
        </Label>
        <Label>
          {t("modules.einpill.effectiveDate")}
          <Input
            type="date"
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
          />
        </Label>
      </div>
      {invalid && <div className="alert alert--danger">{t("modules.einpill.validation")}</div>}
      <ErrorText error={create.error} prefix="modules.einpill.createError" />
      <div className="row">
        <Button type="submit" disabled={create.isPending}>
          {t("modules.einpill.create")}
        </Button>
        <Button type="button" variant="text" onClick={onDone}>
          {t("modules.einpill.cancel")}
        </Button>
      </div>
    </form>
  );
}

export function MedicationEditor({
  medication,
  onDeleted,
}: {
  medication: EinpillMedication;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const patch = useEinpillPatchMedication();
  const putRevision = useEinpillPutRevision();
  const deleteMedication = useEinpillDeleteMedication();
  const [name, setName] = useState(medication.name);
  const [effectiveDate, setEffectiveDate] = useState(todayInputValue());
  const [pills, setPills] = useState(String(medication.pillsPerPackage));
  const [usage, setUsage] = useState(String(medication.dailyUsage));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [invalidName, setInvalidName] = useState(false);
  const [invalidRevision, setInvalidRevision] = useState(false);

  useEffect(() => {
    setName(medication.name);
    setPills(String(medication.pillsPerPackage));
    setUsage(String(medication.dailyUsage));
    setConfirmDelete(false);
    setInvalidName(false);
  }, [medication.name, medication.pillsPerPackage, medication.dailyUsage]);

  const saveName = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setInvalidName(true);
      return;
    }
    setInvalidName(false);
    patch.mutate({ id: medication.id, name: name.trim() });
  };

  const saveRevision = (e: React.FormEvent) => {
    e.preventDefault();
    const pillsPerPackage = Number(pills);
    const dailyUsage = Number(usage);
    if (!effectiveDate || !validPillsPerPackage(pillsPerPackage) || !validDailyUsage(dailyUsage)) {
      setInvalidRevision(true);
      return;
    }
    setInvalidRevision(false);
    putRevision.mutate({ id: medication.id, effectiveDate, pillsPerPackage, dailyUsage });
  };

  const writeError = patch.error ?? putRevision.error ?? deleteMedication.error;

  return (
    <div className="stack">
      <form className="row" onSubmit={saveName}>
        <Label>
          {t("modules.einpill.name")}
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
        </Label>
        <Button type="submit" variant="outlined" disabled={patch.isPending}>
          {t("modules.einpill.save")}
        </Button>
      </form>
      {invalidName && (
        <div className="alert alert--danger">{t("modules.einpill.nameValidation")}</div>
      )}

      <form className="stack" onSubmit={saveRevision}>
        <h3>{t("modules.einpill.revisionTitle")}</h3>
        <p className="muted">{t("modules.einpill.revisionHint")}</p>
        <div className="row">
          <Label>
            {t("modules.einpill.effectiveDate")}
            <Input
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
              required
            />
          </Label>
          <Label>
            {t("modules.einpill.pillsPerPackage")}
            <Input
              type="number"
              min={1}
              max={10000}
              step={1}
              value={pills}
              onChange={(e) => setPills(e.target.value)}
              required
            />
          </Label>
          <Label>
            {t("modules.einpill.dailyUsage")}
            <Input
              type="number"
              min={0.001}
              max={100}
              step={0.001}
              value={usage}
              onChange={(e) => setUsage(e.target.value)}
              required
            />
          </Label>
        </div>
        {invalidRevision && (
          <div className="alert alert--danger">{t("modules.einpill.validation")}</div>
        )}
        <div className="row">
          <Button type="submit" variant="outlined" disabled={putRevision.isPending}>
            {t("modules.einpill.saveRevision")}
          </Button>
        </div>
      </form>

      <div className="row">
        <Button
          type="button"
          variant="outlined"
          onClick={() => patch.mutate({ id: medication.id, archived: !medication.archived })}
          disabled={patch.isPending}
        >
          {medication.archived ? t("modules.einpill.reactivate") : t("modules.einpill.archive")}
        </Button>
        {confirmDelete ? (
          <>
            <Button
              type="button"
              variant="filled"
              className="bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90"
              onClick={() => deleteMedication.mutate(medication.id, { onSuccess: onDeleted })}
              disabled={deleteMedication.isPending}
            >
              {t("modules.einpill.confirmDelete")}
            </Button>
            <Button type="button" variant="text" onClick={() => setConfirmDelete(false)}>
              {t("modules.einpill.cancel")}
            </Button>
          </>
        ) : (
          <Button type="button" variant="text" onClick={() => setConfirmDelete(true)}>
            {t("modules.einpill.delete")}
          </Button>
        )}
      </div>
      <ErrorText error={writeError} prefix="modules.einpill.actionError" />
    </div>
  );
}

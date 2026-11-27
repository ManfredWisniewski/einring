import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "~/api/client";
import { useEinpillAddPackage, useEinpillDeletePackage, useEinpillPatchPackage } from "~/api/hooks";
import type { EinpillMedication, EinpillPackage } from "~/api/types";
import { todayInputValue } from "./format";

const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : "?");

function PackageRow({ pkg }: { pkg: EinpillPackage }) {
  const { t } = useTranslation();
  const patch = useEinpillPatchPackage();
  const del = useEinpillDeletePackage();
  const [date, setDate] = useState(pkg.addedDate);
  const [confirm, setConfirm] = useState(false);
  const today = todayInputValue();
  const error = patch.error ?? del.error;
  return (
    <tr>
      <td>
        <Input
          type="date"
          value={date}
          max={today}
          onChange={(e) => setDate(e.target.value)}
          aria-label={t("modules.einpill.addedDate")}
        />
      </td>
      <td>
        <span className="row">
          <Button
            type="button"
            variant="outlined"
            size="sm"
            disabled={patch.isPending || !date || date > today || date === pkg.addedDate}
            onClick={() => patch.mutate({ id: pkg.id, addedDate: date })}
          >
            {t("modules.einpill.save")}
          </Button>
          {confirm ? (
            <>
              <Button
                type="button"
                variant="filled"
                size="sm"
                className="bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90"
                disabled={del.isPending}
                onClick={() => del.mutate(pkg.id)}
              >
                {t("modules.einpill.confirmDelete")}
              </Button>
              <Button type="button" variant="text" size="sm" onClick={() => setConfirm(false)}>
                {t("modules.einpill.cancel")}
              </Button>
            </>
          ) : (
            <Button type="button" variant="text" size="sm" onClick={() => setConfirm(true)}>
              {t("modules.einpill.deletePackage")}
            </Button>
          )}
        </span>
        {error && (
          <div className="alert alert--danger">
            {t("modules.einpill.actionError", { status: statusOf(error) })}
          </div>
        )}
      </td>
    </tr>
  );
}

export function PackageList({ medication }: { medication: EinpillMedication }) {
  const { t } = useTranslation();
  const add = useEinpillAddPackage();
  const [date, setDate] = useState(todayInputValue());
  const today = todayInputValue();
  const error = add.error;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!date || date > today) return;
    add.mutate({ id: medication.id, addedDate: date });
  };

  return (
    <section className="stack">
      <h3>{t("modules.einpill.packageTitle")}</h3>
      <form className="row" onSubmit={submit}>
        <Label>
          {t("modules.einpill.addedDate")}
          <Input
            type="date"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </Label>
        <Button type="submit" variant="outlined" disabled={add.isPending || !date || date > today}>
          {t("modules.einpill.addPackage")}
        </Button>
      </form>
      {error && (
        <div className="alert alert--danger">
          {t("modules.einpill.actionError", { status: statusOf(error) })}
        </div>
      )}
      {medication.packages.length === 0 ? (
        <p className="muted">{t("modules.einpill.packageEmpty")}</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t("modules.einpill.addedDate")}</th>
                <th scope="col">
                  <span className="sr-only">{t("modules.einpill.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {medication.packages.map((pkg) => (
                <PackageRow key={pkg.id} pkg={pkg} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

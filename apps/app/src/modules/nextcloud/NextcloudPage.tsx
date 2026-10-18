import { useTranslation } from "react-i18next";
import { useNextcloudSettings, useSaveNextcloudSettings } from "@/api/hooks";
import type { NextcloudFeatures } from "@/api/types";
import { NextcloudGate } from "@/components/NextcloudGate";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

const FEATURES = ["monitorTalk", "monitorServer", "tables", "wiki"] as const;

function FeatureToggles() {
  const { t } = useTranslation();
  const settings = useNextcloudSettings();
  const save = useSaveNextcloudSettings();
  const s = settings.data?.settings;

  if (settings.isPending) return <p className="muted">{t("common.loading")}</p>;
  if (!s) return null;

  const toggle = (key: keyof NextcloudFeatures) => (checked: boolean | "indeterminate") => {
    save.mutate({ [key]: checked === true });
  };

  return (
    <div className="stack">
      <h2 className="text-lg">{t("modules.nextcloud.featuresTitle")}</h2>
      <p className="muted">{t("modules.nextcloud.intro")}</p>
      {FEATURES.map((key) => (
        <div key={key} className="row">
          <Checkbox
            id={`nc-feature-${key}`}
            checked={s[key]}
            onCheckedChange={toggle(key)}
            disabled={save.isPending}
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor={`nc-feature-${key}`}>{t(`modules.nextcloud.feature.${key}`)}</Label>
            <span className="muted">{t(`modules.nextcloud.featureHint.${key}`)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function NextcloudPage() {
  return (
    <NextcloudGate>
      <FeatureToggles />
    </NextcloudGate>
  );
}

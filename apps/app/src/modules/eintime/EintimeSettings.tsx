import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useConnectorStatus } from "~/api/hooks";

/** Provider status list — EinTime holds no credential of its own (spec eintime). */
export function EintimeSettings() {
  const { t } = useTranslation();
  const itsaplan = useConnectorStatus("itsaplan");
  return (
    <div className="stack">
      <h2>{t("modules.eintime.settingsProviders")}</h2>
      <ul className="stack">
        <li className="row justify-between">
          <span>itsaplan</span>
          <span className="muted">
            {itsaplan.data?.connected
              ? t("modules.eintime.providerStatusConnected")
              : t("modules.eintime.providerStatusDisconnected")}
          </span>
        </li>
      </ul>
      <p className="muted">{t("modules.eintime.providerHint")}</p>
      <Link to="/itsaplan/settings">{t("modules.eintime.openItsaplan")}</Link>
    </div>
  );
}

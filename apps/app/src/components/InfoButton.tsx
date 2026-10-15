import { Button, Dialog, DialogTrigger, Heading, Popover } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { useInstanceName } from "@/instance";

export function InfoButton() {
  const { t } = useTranslation();
  const name = useInstanceName();
  return (
    <DialogTrigger>
      <Button className="btn btn--icon" aria-label={t("info.open", { name })}>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
          <path
            d="M12 10.5v5"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="2"
          />
          <circle cx="12" cy="7.5" r="1" fill="currentColor" />
        </svg>
      </Button>
      <Popover className="info-popover" placement="bottom end">
        <Dialog>
          <div className="info-popover__header">
            <Heading slot="title">{t("info.title", { name })}</Heading>
            <Button className="btn btn--icon btn--ghost" slot="close" aria-label={t("info.close")}>
              <span aria-hidden="true">×</span>
            </Button>
          </div>
          <p>{t("info.description", { name })}</p>
          <p className="muted">{t("info.version", { version: "0.1.0" })}</p>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

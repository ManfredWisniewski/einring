import { Menu as MenuIcon } from "lucide-react";
import { useState } from "react";
import {
  Button,
  Dialog,
  Heading,
  Menu,
  MenuItem,
  MenuTrigger,
  Modal,
  ModalOverlay,
  Popover,
} from "react-aria-components";
import { useTranslation } from "react-i18next";
import { useModulePrefs, useModuleRegistry, useSaveModulePrefs } from "@/api/hooks";
import { buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useInstanceName } from "@/instance";

type DialogId = "modules" | "info";

function DialogHeader({ title, close }: { title: string; close: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="info-popover__header">
      <Heading slot="title">{title}</Heading>
      <Button
        className={buttonVariants({ variant: "ghost", size: "icon" })}
        onPress={close}
        aria-label={t("info.close")}
      >
        <span aria-hidden="true">×</span>
      </Button>
    </div>
  );
}

/** The "Modules" dialog: per-user activation toggles for every enabled module (D47). */
function ModulesDialog({ close }: { close: () => void }) {
  const { t } = useTranslation();
  const registry = useModuleRegistry();
  const prefs = useModulePrefs();
  const save = useSaveModulePrefs();
  const disabled = new Set(prefs.data?.disabled ?? []);
  // einhub is the index route and locked server-side; settings has no page.
  const modules = (registry.data?.modules ?? []).filter(
    (m) => m.id !== "einhub" && m.id !== "settings",
  );

  const toggle = (id: string) => (checked: boolean | "indeterminate") => {
    const next = new Set(disabled);
    if (checked === true) next.delete(id);
    else next.add(id);
    save.mutate([...next]);
  };

  return (
    <div className="stack">
      <DialogHeader title={t("modulesDialog.title")} close={close} />
      <p className="muted">{t("modulesDialog.hint")}</p>
      {prefs.isPending && <p className="muted">{t("common.loading")}</p>}
      {modules.map((m) => (
        <div key={m.id} className="row">
          <Checkbox
            id={`app-module-${m.id}`}
            checked={!disabled.has(m.id)}
            onCheckedChange={toggle(m.id)}
            disabled={save.isPending}
          />
          <Label htmlFor={`app-module-${m.id}`}>
            {t(`modules.${m.id}.nav`, { defaultValue: m.id })}
          </Label>
        </div>
      ))}
    </div>
  );
}

function InfoDialog({ close }: { close: () => void }) {
  const { t } = useTranslation();
  const name = useInstanceName();
  return (
    <div className="stack">
      <DialogHeader title={t("info.title", { name })} close={close} />
      <p>{t("info.description", { name })}</p>
      <p className="muted">{t("info.version", { version: "0.1.0" })}</p>
    </div>
  );
}

/** Header hamburger: Modules (per-user activation) + Info (was the standalone info button). */
export function AppMenu() {
  const { t } = useTranslation();
  const [open, setOpen] = useState<DialogId | null>(null);
  return (
    <>
      <MenuTrigger>
        <Button
          className={buttonVariants({ variant: "outline", size: "icon" })}
          aria-label={t("menu.open")}
        >
          <MenuIcon className="size-4" aria-hidden />
        </Button>
        <Popover placement="bottom end">
          <Menu className="app-menu" onAction={(key) => setOpen(key as DialogId)}>
            <MenuItem id="modules" className="app-menu__item">
              {t("menu.modules")}
            </MenuItem>
            <MenuItem id="info" className="app-menu__item">
              {t("menu.info")}
            </MenuItem>
          </Menu>
        </Popover>
      </MenuTrigger>
      <ModalOverlay
        className="app-modal-overlay"
        isOpen={open !== null}
        onOpenChange={(o) => {
          if (!o) setOpen(null);
        }}
      >
        <Modal className="app-modal">
          <Dialog>
            {({ close }) =>
              open === "modules" ? <ModulesDialog close={close} /> : <InfoDialog close={close} />
            }
          </Dialog>
        </Modal>
      </ModalOverlay>
    </>
  );
}

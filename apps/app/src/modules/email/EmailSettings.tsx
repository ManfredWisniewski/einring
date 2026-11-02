import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/client";
import { useEmailAccounts, useEmailRemoveAccount } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmailAccountForm } from "./EmailAccountForm";

/** Email settings surface (D59): manage mail accounts — list, add, remove (D60). */
export function EmailSettings() {
  const { t } = useTranslation();
  const accounts = useEmailAccounts();
  const remove = useEmailRemoveAccount();

  if (accounts.isPending) return <p className="muted">{t("common.loading")}</p>;
  if (accounts.isError) {
    const s = accounts.error instanceof ApiError ? accounts.error.status : "?";
    return <div className="alert alert--danger">{t("modules.email.error", { status: s })}</div>;
  }
  const list = accounts.data?.accounts ?? [];

  return (
    <div className="stack">
      <Card>
        <CardHeader>
          <CardTitle>{t("modules.email.accounts")}</CardTitle>
        </CardHeader>
        <CardContent className="stack">
          {!list.length && <p className="muted">{t("modules.email.noAccounts")}</p>}
          {list.map((a) => (
            <div key={a.id} className="row" style={{ justifyContent: "space-between" }}>
              <span>
                {a.username}
                {a.url ? ` · ${a.url.startsWith("http") ? "JMAP" : "IMAP"} · ${a.url}` : ""}
              </span>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => remove.mutate(a.id)}
                disabled={remove.isPending}
              >
                {t("modules.email.removeAccount")}
              </Button>
            </div>
          ))}
          {remove.isError && (
            <div className="alert alert--danger">
              {t("modules.email.error", {
                status: remove.error instanceof ApiError ? remove.error.status : "?",
              })}
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("modules.email.addAccount")}</CardTitle>
          <CardDescription>{t("modules.email.intro")}</CardDescription>
        </CardHeader>
        <CardContent className="stack">
          <EmailAccountForm />
        </CardContent>
      </Card>
    </div>
  );
}

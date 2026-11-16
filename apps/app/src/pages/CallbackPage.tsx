import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { getUserManager } from "~/auth/oidc";

/** Web-only: Authentik redirects here with `?code=…&state=…`. */
export function CallbackPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getUserManager()
      .then((m) => m.signinCallback(window.location.href))
      .then((user) => {
        const returnTo = (user?.state as { returnTo?: string } | undefined)?.returnTo ?? "/";
        navigate(returnTo, { replace: true });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // Replayed callback URL (refresh/back/reopen after the state was already
        // consumed — e.g. after a failed code exchange): go home instead of a dead end.
        if (message.includes("No matching state found in storage")) {
          navigate("/", { replace: true });
          return;
        }
        setError(message);
      });
  }, [navigate]);

  if (error) return <p className="alert alert--danger">{t("auth.failed", { reason: error })}</p>;
  return <p className="muted">{t("auth.completing")}</p>;
}

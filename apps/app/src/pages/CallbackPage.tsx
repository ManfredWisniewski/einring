import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { userManager } from "@/auth/oidc";

/** Web-only: Authentik redirects here with `?code=…&state=…`. */
export function CallbackPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    userManager
      .signinCallback(window.location.href)
      .then((user) => {
        const returnTo = (user?.state as { returnTo?: string } | undefined)?.returnTo ?? "/";
        navigate(returnTo, { replace: true });
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [navigate]);

  if (error) return <p className="alert alert--danger">{t("auth.failed", { reason: error })}</p>;
  return <p className="muted">{t("auth.completing")}</p>;
}

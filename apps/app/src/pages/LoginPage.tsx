import { Button } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation } from "react-router";
import { useAuth } from "@/auth/AuthProvider";
import { missingConfig } from "@/config";
import { useInstanceTagline } from "@/instance";

export function LoginPage() {
  const { t } = useTranslation();
  const tagline = useInstanceTagline();
  const { user, loading, login } = useAuth();
  const location = useLocation();
  const returnTo = (location.state as { from?: string } | null)?.from ?? "/";

  if (loading) return <p className="muted">{t("auth.loading")}</p>;
  if (user) return <Navigate to={returnTo} replace />;

  return (
    <section className="card stack" style={{ maxWidth: "28rem", marginInline: "auto" }}>
      {(tagline === undefined ? t("app.tagline") : tagline) !== "" && (
        <h2>{tagline === undefined ? t("app.tagline") : tagline}</h2>
      )}
      {missingConfig.length > 0 ? (
        <p className="alert alert--danger">
          {t("auth.missingConfig", { keys: missingConfig.join(", ") })}
        </p>
      ) : (
        <div className="row">
          <Button className="btn btn--primary" onPress={() => void login(returnTo)}>
            {t("auth.login")}
          </Button>
        </div>
      )}
    </section>
  );
}

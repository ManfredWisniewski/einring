import { useTranslation } from "react-i18next";
import { Navigate, useLocation } from "react-router";
import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

  const title = tagline === undefined ? t("app.tagline") : tagline;

  return (
    <Card className="mx-auto max-w-md">
      {title !== "" && (
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
      )}
      <CardContent className="stack">
        {missingConfig.length > 0 ? (
          <p className="alert alert--danger">
            {t("auth.missingConfig", { keys: missingConfig.join(", ") })}
          </p>
        ) : (
          <div className="row">
            <Button onClick={() => void login(returnTo)}>{t("auth.login")}</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

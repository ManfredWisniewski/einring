import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, Suspense, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from "react-router";
import { useModuleRegistry } from "@/api/hooks";
import { AuthProvider, useAuth } from "@/auth/AuthProvider";
import { Layout } from "@/components/Layout";
import { NextcloudConnect } from "@/components/NextcloudConnect";
import { Button } from "@/components/ui/button";
import { config } from "@/config";
import { isEmbedded } from "@/embedded";
import { type AppModule, resolveAppModules } from "@/modules";
import { CallbackPage } from "@/pages/CallbackPage";
import { LoginPage } from "@/pages/LoginPage";
import { ThemeProvider } from "@/theme/ThemeProvider";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

function RequireAuth({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <p className="muted">{t("auth.loading")}</p>;
  // Embedded: no /login route — the Nextcloud connect card IS the sign-in.
  if (!user) {
    if (isEmbedded()) return <NextcloudConnect />;
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return children;
}

function NoModules() {
  const { t } = useTranslation();
  return <p className="muted">{t("modules.none")}</p>;
}

function ModuleLoading() {
  const { t } = useTranslation();
  return <p className="muted">{t("common.loading")}</p>;
}

function buildRouter(modules: AppModule[]) {
  const index = modules.find((m) => m.nav && m.routes.length)?.routes[0]?.path;
  return createBrowserRouter([
    {
      element: <Layout />,
      children: [
        { path: "/login", element: <LoginPage /> },
        { path: config.webRedirectPath, element: <CallbackPage /> },
        ...modules.flatMap((m) =>
          m.routes.map((r) => ({
            path: r.path,
            element: (
              <RequireAuth>
                <Suspense fallback={<ModuleLoading />}>
                  <r.Component />
                </Suspense>
              </RequireAuth>
            ),
          })),
        ),
        {
          path: "/",
          element: (
            <RequireAuth>{index ? <Navigate to={index} replace /> : <NoModules />}</RequireAuth>
          ),
        },
        { path: "*", element: <Navigate to="/" replace /> },
      ],
    },
  ]);
}

function Routing() {
  const { t } = useTranslation();
  const { user, loading } = useAuth();
  const registry = useModuleRegistry(!!user);
  const ready = !loading && (!user || !registry.isPending);
  const router = useMemo(
    () => (ready ? buildRouter(resolveAppModules(registry.data?.modules)) : null),
    [ready, registry.data],
  );
  if (user && registry.isError) {
    return (
      <div className="alert alert--danger row">
        <span>{t("modules.error")}</span>
        <Button variant="outline" onClick={() => void registry.refetch()}>
          {t("modules.retry")}
        </Button>
      </div>
    );
  }
  if (!router) return <p className="muted">{t("auth.loading")}</p>;
  return <RouterProvider router={router} />;
}

export function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Routing />
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

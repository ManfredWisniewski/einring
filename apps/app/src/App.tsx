import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from "react-router";
import { AuthProvider, useAuth } from "@/auth/AuthProvider";
import { Layout } from "@/components/Layout";
import { config } from "@/config";
import { CallbackPage } from "@/pages/CallbackPage";
import { LoginPage } from "@/pages/LoginPage";
import { TablesPage } from "@/pages/TablesPage";
import { ThemeProvider } from "@/theme/ThemeProvider";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

function RequireAuth({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <p className="muted">{t("auth.loading")}</p>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/login", element: <LoginPage /> },
      { path: config.webRedirectPath, element: <CallbackPage /> },
      {
        path: "/",
        element: (
          <RequireAuth>
            <TablesPage />
          </RequireAuth>
        ),
      },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);

export function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

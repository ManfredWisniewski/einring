import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useAuth } from "@/auth/AuthProvider";
import { createApi } from "./client";
import type { ConnectionStatus, Me, TableView } from "./types";

export function useApi() {
  const { getAccessToken } = useAuth();
  return useMemo(() => createApi(getAccessToken), [getAccessToken]);
}

export const keys = {
  me: ["me"] as const,
  connection: ["nextcloud", "connection"] as const,
  currentTable: ["tables", "current"] as const,
};

export function useMe() {
  const api = useApi();
  return useQuery({ queryKey: keys.me, queryFn: () => api.get<Me>("/me") });
}

export function useNextcloudConnection() {
  const api = useApi();
  return useQuery({
    queryKey: keys.connection,
    queryFn: () => api.get<ConnectionStatus>("/nextcloud/connection"),
  });
}

export function useStartLoginFlow() {
  const api = useApi();
  return useMutation({ mutationFn: () => api.post<{ login: string }>("/nextcloud/login-flow") });
}

export function usePollLoginFlow() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<ConnectionStatus>("/nextcloud/login-flow/poll"),
    onSuccess: (data) => {
      if (data.status === "connected") {
        qc.setQueryData(keys.connection, data);
        void qc.invalidateQueries({ queryKey: keys.currentTable });
      }
    },
  });
}

export function useDisconnectNextcloud() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>("/nextcloud/connection"),
    onSuccess: () => {
      qc.setQueryData(keys.connection, { status: "disconnected" } satisfies ConnectionStatus);
      qc.removeQueries({ queryKey: keys.currentTable });
    },
  });
}

export function useCurrentTable(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: keys.currentTable,
    queryFn: () => api.get<TableView>("/tables/current"),
    enabled,
  });
}

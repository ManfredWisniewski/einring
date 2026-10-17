import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useAuth } from "@/auth/AuthProvider";
import { createApi } from "./client";
import type {
  ConnectionStatus,
  CsvFile,
  CsvFileMeta,
  CsvRow,
  LoginFlowStart,
  Me,
  ModuleRegistry,
  ServerHealthResponse,
  TableView,
  TalkStatus,
  WikiAskResult,
  WikiIndexResult,
  WikiLlmStatus,
  WikiPage,
  WikiSearchResult,
  WikiSyncResult,
  WikiTree,
} from "./types";

export function useApi() {
  const { getAccessToken } = useAuth();
  return useMemo(() => createApi(getAccessToken), [getAccessToken]);
}

export const keys = {
  me: ["me"] as const,
  connection: ["nextcloud", "connection"] as const,
  currentTable: ["tables", "current"] as const,
  modules: ["modules"] as const,
  serverHealth: ["monitor", "server"] as const,
  talkStatus: ["monitor", "talk-status"] as const,
  wikiTree: ["wiki", "tree"] as const,
  wikiPage: (path: string) => ["wiki", "page", path] as const,
  wikiSearch: (q: string) => ["wiki", "search", q] as const,
  csvFiles: ["csv-manager", "files"] as const,
  csvFile: (id: number) => ["csv-manager", "file", id] as const,
};

/** Enabled modules per the BFF registry — the source of truth for routes and nav (D33). */
export function useModuleRegistry(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.modules,
    // Bounded: a wrong VITE_API_URL must degrade to "no modules" instead of hanging the router.
    queryFn: ({ signal }) =>
      api.get<ModuleRegistry>("/modules", AbortSignal.any([signal, AbortSignal.timeout(10_000)])),
    enabled,
    staleTime: Infinity,
  });
}

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
  return useMutation({ mutationFn: () => api.post<LoginFlowStart>("/nextcloud/login-flow") });
}

export function usePollLoginFlow() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (flow?: string) =>
      api.post<ConnectionStatus>("/nextcloud/login-flow/poll", flow ? { flow } : undefined),
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
    queryFn: () => api.get<TableView>("/tables/current"), // module route: /api/tables/*
    enabled,
  });
}

export function useServerHealth(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: keys.serverHealth,
    queryFn: () => api.get<ServerHealthResponse>("/monitor/server"),
    enabled,
    refetchInterval: 30_000,
  });
}

export function useTalkStatus(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: keys.talkStatus,
    queryFn: () => api.get<TalkStatus>("/monitor/talk-status"),
    enabled,
    refetchInterval: 30_000,
  });
}

export function useWikiSync() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<WikiSyncResult>("/wiki/sync"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wiki"] }),
  });
}

export function useWikiTree(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: keys.wikiTree,
    queryFn: () => api.get<WikiTree>("/wiki/tree"),
    enabled,
  });
}

export function useWikiPage(path: string | null, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: keys.wikiPage(path ?? ""),
    queryFn: () => api.get<WikiPage>(`/wiki/page?path=${encodeURIComponent(path ?? "")}`),
    enabled: enabled && path !== null,
  });
}

export function useWikiSearch(query: string, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: keys.wikiSearch(query),
    queryFn: () =>
      api
        .get<{ results: WikiSearchResult[] }>(`/wiki/search?q=${encodeURIComponent(query)}`)
        .then((r) => r.results),
    enabled: enabled && query.length > 0,
  });
}

export function useWikiLlmStatus(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ["wiki", "llm-status"],
    queryFn: () => api.get<WikiLlmStatus>("/wiki/llm/status"),
    enabled,
    // Poll while a background index run is in flight.
    refetchInterval: (q) => (q.state.data?.indexing ? 2000 : false),
  });
}

export function useWikiLlmIndex() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<WikiIndexResult>("/wiki/llm/index"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["wiki", "llm-status"] }),
  });
}

/** Stateless single-turn ask (D39) — the result stays local to the caller, nothing cached. */
export function useWikiAsk() {
  const api = useApi();
  return useMutation({
    mutationFn: (question: string) => api.post<WikiAskResult>("/wiki/ask", { question }),
  });
}

export function useCsvFiles(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.csvFiles,
    queryFn: () => api.get<{ files: CsvFileMeta[] }>("/csv-manager/files").then((r) => r.files),
    enabled,
  });
}

export function useCsvFile(id: number | null, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.csvFile(id ?? 0),
    queryFn: () => api.get<CsvFile>(`/csv-manager/files/${id}`),
    enabled: enabled && id !== null,
  });
}

export function useCsvImport() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; csv: string }) =>
      api.post<CsvFileMeta>("/csv-manager/files", input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.csvFiles }),
  });
}

export function useCsvDeleteFile() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/csv-manager/files/${id}`),
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: keys.csvFile(id) });
      void qc.invalidateQueries({ queryKey: keys.csvFiles });
    },
  });
}

export function useCsvAddRow(fileId: number) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<CsvRow>(`/csv-manager/files/${fileId}/rows`),
    onSuccess: (row) => {
      qc.setQueryData<CsvFile>(keys.csvFile(fileId), (old) =>
        old ? { ...old, rows: [...old.rows, row], rowCount: old.rowCount + 1 } : old,
      );
    },
  });
}

export function useCsvUpdateRow(fileId: number) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { rowId: number; cells?: string[]; done?: boolean }) =>
      api.patch<CsvRow>(`/csv-manager/files/${fileId}/rows/${input.rowId}`, {
        cells: input.cells,
        done: input.done,
      }),
    // setQueryData (not invalidate): keeps inline editing responsive.
    onSuccess: (row) => {
      qc.setQueryData<CsvFile>(keys.csvFile(fileId), (old) =>
        old ? { ...old, rows: old.rows.map((r) => (r.id === row.id ? row : r)) } : old,
      );
    },
  });
}

export function useCsvDeleteRow(fileId: number) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rowId: number) => api.delete<void>(`/csv-manager/files/${fileId}/rows/${rowId}`),
    onSuccess: (_data, rowId) => {
      qc.setQueryData<CsvFile>(keys.csvFile(fileId), (old) =>
        old
          ? { ...old, rows: old.rows.filter((r) => r.id !== rowId), rowCount: old.rowCount - 1 }
          : old,
      );
    },
  });
}

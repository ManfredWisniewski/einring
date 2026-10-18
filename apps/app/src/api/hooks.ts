import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useAuth } from "@/auth/AuthProvider";
import { config } from "@/config";
import { createApi } from "./client";
import type {
  AuthentikStatus,
  ConnectionStatus,
  ConnectorStatus,
  CsvFile,
  CsvFileMeta,
  CsvRow,
  EinChatMessage,
  EinChatReply,
  EinChatStatus,
  EinChatTools,
  EinHubFeed,
  EinMusicPlaylistDetail,
  EinMusicPlaylists,
  EinMusicTrack,
  EinMusicTracks,
  EmailList,
  EmailMessage,
  GitHubNotifications,
  GitLabTodos,
  GotifyApplication,
  GotifyApplications,
  GotifyMessages,
  GotifyUser,
  LoginFlowStart,
  MatrixMessages,
  MatrixRooms,
  MatrixSelf,
  Me,
  ModulePrefs,
  ModuleRegistry,
  NavidromePlaylistDetail,
  NavidromePlaylists,
  NextcloudFeatures,
  NextcloudSettingsResponse,
  PassmanVaultDetail,
  PassmanVaults,
  ServerHealthResponse,
  TableNode,
  TableNodeType,
  TableRow,
  TablesApplication,
  TableView,
  TalkMessages,
  TalkRooms,
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
  tablesApp: ["tables", "app"] as const,
  tableNode: (type: TableNodeType, id: number) => ["tables", "node", type, id] as const,
  modules: ["modules"] as const,
  serverHealth: ["monitor", "server"] as const,
  talkStatus: ["monitor", "talk-status"] as const,
  wikiTree: ["wiki", "tree"] as const,
  wikiPage: (path: string) => ["wiki", "page", path] as const,
  wikiSearch: (q: string) => ["wiki", "search", q] as const,
  csvFiles: ["csv-manager", "files"] as const,
  csvFile: (id: number) => ["csv-manager", "file", id] as const,
  einchatStatus: ["einchat", "status"] as const,
  einchatTools: ["einchat", "tools"] as const,
  emailList: ["email", "list"] as const,
  emailMessage: (uid: number) => ["email", "message", uid] as const,
  gotifyMessages: ["gotify", "messages"] as const,
  gotifyApps: ["gotify", "applications"] as const,
  gotifyUser: ["gotify", "user"] as const,
  einhub: ["einhub", "notifications"] as const,
  gitlabTodos: ["gitlab", "todos"] as const,
  githubNotifications: ["github", "notifications"] as const,
  authentikHealth: ["authentik", "health"] as const,
  nextcloudSettings: ["nextcloud", "settings"] as const,
  modulePrefs: ["settings", "modules"] as const,
  einmusicTracks: ["einmusic", "tracks"] as const,
  einmusicPlaylists: ["einmusic", "playlists"] as const,
  einmusicPlaylist: (id: number) => ["einmusic", "playlist", id] as const,
  navidromePlaylists: ["einmusic", "navidrome", "playlists"] as const,
  navidromePlaylist: (id: string) => ["einmusic", "navidrome", "playlist", id] as const,
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
        void qc.invalidateQueries({ queryKey: ["tables"] });
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
      qc.removeQueries({ queryKey: ["tables"] });
    },
  });
}

/** The configured Tables application: name + its nodes (views + tables). */
export function useTablesApplication(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: keys.tablesApp,
    queryFn: () => api.get<TablesApplication>("/tables"),
    enabled,
  });
}

/** A node's columns + rows, read view-scoped (Nextcloud-side filters apply). */
export function useTableNode(node: TableNode | null, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.tableNode(node?.type ?? "view", node?.id ?? 0),
    queryFn: () => api.get<TableView>(`/tables/nodes/${node?.type}/${node?.id}`),
    enabled: enabled && node !== null,
  });
}

export function useTablePatchRow(node: TableNode) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { rowId: number; data: Record<string, unknown> }) =>
      api.patch<TableRow>(`/tables/rows/${input.rowId}`, { data: input.data }),
    // setQueryData keeps checkbox toggles snappy; the response is the canonical row.
    onSuccess: (row) => {
      qc.setQueryData<TableView>(keys.tableNode(node.type, node.id), (old) =>
        old ? { ...old, rows: old.rows.map((r) => (r.id === row.id ? row : r)) } : old,
      );
    },
  });
}

export function useTableAddRow() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (node: TableNode) =>
      api.post<TableRow>(`/tables/nodes/${node.type}/${node.id}/rows`, {}),
    // Invalidate: view filters may keep the new (empty) row out of the result.
    onSuccess: (_row, node) =>
      void qc.invalidateQueries({ queryKey: keys.tableNode(node.type, node.id) }),
  });
}

export function useTableDeleteRow() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { node: TableNode; rowId: number }) =>
      api.delete<void>(`/tables/nodes/${input.node.type}/${input.node.id}/rows/${input.rowId}`),
    onSuccess: (_v, input) =>
      void qc.invalidateQueries({ queryKey: keys.tableNode(input.node.type, input.node.id) }),
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

/** EinChat availability + the tool names enabled provider modules expose. */
export function useEinChatStatus(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.einchatStatus,
    queryFn: () => api.get<EinChatStatus>("/einchat/status"),
    enabled,
  });
}

/** Stateless chat turn — the caller owns the history and re-sends it (D41). */
export function useEinChatMessage() {
  const api = useApi();
  return useMutation({
    mutationFn: (messages: EinChatMessage[]) =>
      api.post<EinChatReply>("/einchat/message", { messages }),
  });
}

/** All collected provider tools + the user's enabled flags — the connections UI. */
export function useEinChatTools(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.einchatTools,
    queryFn: () => api.get<EinChatTools>("/einchat/tools"),
    enabled,
  });
}

export function useEinChatSetTools() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (disabled: string[]) =>
      api.put<{ disabled: string[] }>("/einchat/tools", { disabled }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.einchatTools });
      void qc.invalidateQueries({ queryKey: keys.einchatStatus });
    },
  });
}

/** Generic connector-module hooks — the credential routes share one shape (D41). */
export function useConnectorStatus(service: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ["connector", service],
    queryFn: () => api.get<ConnectorStatus>(`/${service}/status`),
    enabled,
  });
}

export function useConnectorConnect(service: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { apiKey?: string; username?: string; password?: string; url?: string }) =>
      api.post<ConnectorStatus>(`/${service}/credentials`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["connector", service] }),
  });
}

export function useConnectorDisconnect(service: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<ConnectorStatus>(`/${service}/credentials`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["connector", service] }),
  });
}

export function useEmailList(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.emailList,
    queryFn: () => api.get<EmailList>("/email/list"),
    enabled,
  });
}

/** Lazy per-message fetch — run only when a mail row is expanded. */
export function useEmailMessage(uid: number | null) {
  const api = useApi();
  return useQuery({
    queryKey: keys.emailMessage(uid ?? 0),
    queryFn: () => api.get<EmailMessage>(`/email/message/${uid}`),
    enabled: uid !== null,
  });
}

export function useEmailDelete() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (uid: number) => api.delete(`/email/message/${uid}`),
    onSuccess: (_d, uid) => {
      void qc.invalidateQueries({ queryKey: keys.emailList });
      void qc.removeQueries({ queryKey: keys.emailMessage(uid) });
    },
  });
}

export function useGotifyMessages(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.gotifyMessages,
    queryFn: () => api.get<GotifyMessages>("/gotify/messages"),
    enabled,
    // Safety net: if the SSE proxy drops, the list still refreshes periodically.
    refetchInterval: 30_000,
  });
}

export function useGotifyUser(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.gotifyUser,
    queryFn: () => api.get<GotifyUser>("/gotify/user"),
    enabled,
  });
}

export function useGotifyApplications(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.gotifyApps,
    queryFn: () => api.get<GotifyApplications>("/gotify/applications"),
    enabled,
  });
}

export function useGotifyDeleteMessage() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/gotify/messages/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.gotifyMessages }),
  });
}

export function useGotifyDeleteAll() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete("/gotify/messages"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.gotifyMessages }),
  });
}

export function useGotifyCreateApp() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; description?: string }) =>
      api.post<{ application: GotifyApplication }>("/gotify/applications", input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.gotifyApps }),
  });
}

export function useGotifyDeleteApp() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/gotify/applications/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.gotifyApps }),
  });
}

/**
 * The einhub notification feed (D42). Each fetch lazily refreshes upstream
 * sources on the BFF (throttled per user) — polling drives the hub.
 */
export function useEinHubNotifications(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.einhub,
    queryFn: () => api.get<EinHubFeed>("/einhub/notifications"),
    enabled,
    refetchInterval: 30_000,
  });
}

export function useEinHubMarkRead() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post(`/einhub/notifications/${id}/read`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.einhub }),
  });
}

export function useEinHubReadAll() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/einhub/read-all"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.einhub }),
  });
}

/** The caller's pending GitLab todos (D43) — new ones also land in EinHub. */
export function useGitLabTodos(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.gitlabTodos,
    queryFn: () => api.get<GitLabTodos>("/gitlab/todos"),
    enabled,
    refetchInterval: 60_000,
  });
}

/** The caller's GitHub notification threads (D44) — they also land in EinHub. */
export function useGitHubNotifications(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.githubNotifications,
    queryFn: () => api.get<GitHubNotifications>("/github/notifications"),
    enabled,
    refetchInterval: 60_000,
  });
}

/** The Authentik instance health snapshot (D45) — shown on /authentik and in Monitor. */
export function useAuthentikHealth(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.authentikHealth,
    queryFn: () => api.get<AuthentikStatus>("/authentik/health"),
    enabled,
    refetchInterval: 60_000,
  });
}

/** Per-user Nextcloud feature toggles (D46) — monitor tabs, nav visibility. */
export function useNextcloudSettings(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.nextcloudSettings,
    queryFn: () => api.get<NextcloudSettingsResponse>("/nextcloud/settings"),
    enabled,
  });
}

/** Merge a partial feature map into the caller's Nextcloud settings. */
export function useSaveNextcloudSettings() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<NextcloudFeatures>) =>
      api.put<NextcloudSettingsResponse>("/nextcloud/settings", patch),
    onSuccess: (res) => qc.setQueryData(keys.nextcloudSettings, res),
  });
}

/** The caller's disabled-module set (D47) — header "Modules" dialog + nav filter. */
export function useModulePrefs(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.modulePrefs,
    queryFn: () => api.get<ModulePrefs>("/settings/modules"),
    enabled,
  });
}

/** Replace the caller's disabled-module set (D47). */
export function useSaveModulePrefs() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (disabled: string[]) => api.put<ModulePrefs>("/settings/modules", { disabled }),
    onSuccess: (res) => qc.setQueryData(keys.modulePrefs, res),
  });
}

/**
 * Live message updates: the BFF proxies Gotify's WS stream as SSE (the client
 * token never leaves the BFF). Fetch-based because EventSource can't send
 * Authorization. Any incoming data means "new message" → refetch the list.
 */
export function useGotifyStream(enabled: boolean) {
  const { getAccessToken } = useAuth();
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      // Reconnect loop: a dropped stream retries with a short backoff instead of
      // silently staying dead until the next page load.
      for (;;) {
        try {
          const token = await getAccessToken();
          const res = await fetch(`${config.apiUrl}/api/gotify/stream`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: ac.signal,
          });
          if (res.ok && res.body) {
            const reader = res.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value?.length && new TextDecoder().decode(value).includes("data:")) {
                void qc.invalidateQueries({ queryKey: keys.gotifyMessages });
              }
            }
          }
        } catch {
          // aborted or network failure — fall through to the retry delay
        }
        if (ac.signal.aborted) return;
        await new Promise((r) => {
          reconnect = setTimeout(r, 5_000);
        });
        if (ac.signal.aborted) return;
      }
    })();
    return () => {
      ac.abort();
      if (reconnect !== undefined) clearTimeout(reconnect);
    };
  }, [enabled, getAccessToken, qc]);
}

// --- EinMusic (D48) -------------------------------------------------------

export function useEinMusicTracks(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.einmusicTracks,
    queryFn: () => api.get<EinMusicTracks>("/einmusic/tracks"),
    enabled,
  });
}

/** Upload one MP3; the file bytes are the request body (`?name=` carries the filename). */
export function useUploadTrack() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) =>
      api.upload<{ track: EinMusicTrack }>(
        `/einmusic/tracks?name=${encodeURIComponent(file.name)}`,
        file,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.einmusicTracks }),
  });
}

export function useDeleteTrack() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/einmusic/tracks/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.einmusicTracks });
      void qc.invalidateQueries({ queryKey: keys.einmusicPlaylists });
    },
  });
}

export function useEinMusicPlaylists(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.einmusicPlaylists,
    queryFn: () => api.get<EinMusicPlaylists>("/einmusic/playlists"),
    enabled,
  });
}

export function useEinMusicPlaylist(id: number | null) {
  const api = useApi();
  return useQuery({
    queryKey: keys.einmusicPlaylist(id ?? 0),
    queryFn: () => api.get<EinMusicPlaylistDetail>(`/einmusic/playlists/${id}`),
    enabled: id !== null,
  });
}

export function useCreatePlaylist() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.post<{ playlist: { id: number; name: string } }>("/einmusic/playlists", { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.einmusicPlaylists }),
  });
}

/** Rename and/or atomically replace a playlist's tracks. */
export function useSavePlaylist() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: number; name?: string; trackIds?: number[] }) =>
      api.put(`/einmusic/playlists/${args.id}`, { name: args.name, trackIds: args.trackIds }),
    onSuccess: (_res, args) => {
      void qc.invalidateQueries({ queryKey: keys.einmusicPlaylists });
      void qc.invalidateQueries({ queryKey: keys.einmusicPlaylist(args.id) });
    },
  });
}

export function useDeletePlaylist() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/einmusic/playlists/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.einmusicPlaylists }),
  });
}

/** Navidrome playlists on the connected server; 424 → not configured (D48). */
export function useNavidromePlaylists(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.navidromePlaylists,
    queryFn: () => api.get<NavidromePlaylists>("/einmusic/navidrome/playlists"),
    enabled,
    retry: false,
  });
}

export function useNavidromePlaylist(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: keys.navidromePlaylist(id ?? ""),
    queryFn: () =>
      api.get<NavidromePlaylistDetail>(
        `/einmusic/navidrome/playlists/${encodeURIComponent(id ?? "")}`,
      ),
    enabled: id !== null,
  });
}

// --- Passman (D50) --------------------------------------------------------

export function usePassmanVaults(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ["passman", "vaults"],
    queryFn: () => api.get<PassmanVaults>("/passman/vaults"),
    enabled,
    retry: false,
  });
}

/** Vault detail — credentials arrive still SJCL-encrypted; the page decrypts. */
export function usePassmanVault(guid: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ["passman", "vault", guid],
    queryFn: () => api.get<PassmanVaultDetail>(`/passman/vaults/${encodeURIComponent(guid ?? "")}`),
    enabled: guid !== null,
  });
}

// --- Talk (D51) -----------------------------------------------------------

export function useTalkRooms(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ["talk", "rooms"],
    queryFn: () => api.get<TalkRooms>("/talk/rooms"),
    enabled,
    refetchInterval: 30_000,
  });
}

/** Message history; polls every 4 s while a room is open. Read marker untouched. */
export function useTalkMessages(token: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ["talk", "messages", token],
    queryFn: () => api.get<TalkMessages>(`/talk/rooms/${encodeURIComponent(token ?? "")}/messages`),
    enabled: token !== null,
    refetchInterval: 4_000,
  });
}

export function useSendTalkMessage() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { token: string; text: string }) =>
      api.post(`/talk/rooms/${encodeURIComponent(args.token)}/messages`, { text: args.text }),
    onSuccess: (_res, args) => qc.invalidateQueries({ queryKey: ["talk", "messages", args.token] }),
  });
}

/** Upload one image into the Talk folder and share it into the room (D51). */
export function useSendTalkImage() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { token: string; file: File }) =>
      api.upload(
        `/talk/rooms/${encodeURIComponent(args.token)}/image?name=${encodeURIComponent(args.file.name)}`,
        args.file,
      ),
    onSuccess: (_res, args) => qc.invalidateQueries({ queryKey: ["talk", "messages", args.token] }),
  });
}

// --- Matrix (D52) ----------------------------------------------------------

export function useMatrixSelf(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ["matrix", "me"],
    queryFn: () => api.get<MatrixSelf>("/matrix/me"),
    enabled,
  });
}

export function useMatrixRooms(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ["matrix", "rooms"],
    queryFn: () => api.get<MatrixRooms>("/matrix/rooms"),
    enabled,
    refetchInterval: 30_000,
  });
}

export function useMatrixMessages(roomId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ["matrix", "messages", roomId],
    queryFn: () =>
      api.get<MatrixMessages>(`/matrix/rooms/${encodeURIComponent(roomId ?? "")}/messages`),
    enabled: roomId !== null,
    refetchInterval: 4_000,
  });
}

export function useSendMatrixMessage() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { roomId: string; text: string }) =>
      api.post(`/matrix/rooms/${encodeURIComponent(args.roomId)}/messages`, { text: args.text }),
    onSuccess: (_res, args) =>
      qc.invalidateQueries({ queryKey: ["matrix", "messages", args.roomId] }),
  });
}

/** Upload a file to the media repo then post the m.image/m.file message (D52). */
export function useSendMatrixFile() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { roomId: string; file: File }) =>
      api.upload(
        `/matrix/rooms/${encodeURIComponent(args.roomId)}/file?name=${encodeURIComponent(args.file.name)}`,
        args.file,
      ),
    onSuccess: (_res, args) =>
      qc.invalidateQueries({ queryKey: ["matrix", "messages", args.roomId] }),
  });
}

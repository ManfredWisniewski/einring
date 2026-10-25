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
  EinDavAddressbook,
  EinDavCalendar,
  EinDavContact,
  EinDavContactInput,
  EinDavEvent,
  EinDavEventInput,
  EinDavFileEntry,
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
  Recipe,
  RecipeListItem,
  SchoolAttendance,
  SchoolConflict,
  SchoolEvent,
  SchoolHoliday,
  SchoolHomework,
  SchoolHomeworkAssignment,
  SchoolHousehold,
  SchoolInstrument,
  SchoolInvoice,
  SchoolInvoiceDetail,
  SchoolLesson,
  SchoolLessonType,
  SchoolMakeupRequest,
  SchoolMe,
  SchoolMessage,
  SchoolPerson,
  SchoolRental,
  SchoolSeries,
  SchoolThread,
  SchoolUser,
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
    mutationFn: (flow: string) =>
      api.post<ConnectionStatus>("/nextcloud/login-flow/poll", { flow }),
    onSuccess: (data) => {
      if (data.status === "connected") {
        qc.setQueryData(keys.connection, data);
        void qc.invalidateQueries({ queryKey: ["tables"] });
      }
    },
  });
}

/** Claim a completed login flow with the code from the user's own Nextcloud files. */
export function useClaimLoginFlow() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { flow: string; code: string }) =>
      api.post<ConnectionStatus>("/nextcloud/login-flow/claim", input),
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

// --- EinDAV (D54) -----------------------------------------------------------

const EINDAV = ["eindav"] as const;

export function useEinDavAddressbooks(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...EINDAV, "addressbooks"],
    queryFn: () => api.get<{ addressbooks: EinDavAddressbook[] }>("/eindav/addressbooks"),
    enabled,
  });
}

export function useEinDavContacts(book: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: [...EINDAV, "contacts", book],
    queryFn: () =>
      api.get<{ contacts: EinDavContact[] }>(
        `/eindav/contacts?book=${encodeURIComponent(book ?? "")}`,
      ),
    enabled: book !== null,
  });
}

export function useSaveEinDavContact() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: EinDavContactInput) => api.put<{ href: string }>("/eindav/contact", c),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...EINDAV, "contacts"] }),
  });
}

export function useDeleteEinDavContact() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (href: string) => api.delete(`/eindav/contact?href=${encodeURIComponent(href)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...EINDAV, "contacts"] }),
  });
}

export function useEinDavCalendars(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...EINDAV, "calendars"],
    queryFn: () => api.get<{ calendars: EinDavCalendar[] }>("/eindav/calendars"),
    enabled,
  });
}

export function useEinDavEvents(cal: string | null, from: string, to: string) {
  const api = useApi();
  return useQuery({
    queryKey: [...EINDAV, "events", cal, from, to],
    queryFn: () =>
      api.get<{ events: EinDavEvent[] }>(
        `/eindav/events?cal=${encodeURIComponent(cal ?? "")}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      ),
    enabled: cal !== null,
  });
}

export function useSaveEinDavEvent() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (e: EinDavEventInput) => api.put<{ href: string }>("/eindav/event", e),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...EINDAV, "events"] }),
  });
}

export function useDeleteEinDavEvent() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (href: string) => api.delete(`/eindav/event?href=${encodeURIComponent(href)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...EINDAV, "events"] }),
  });
}

export function useEinDavFiles(path: string) {
  const api = useApi();
  return useQuery({
    queryKey: [...EINDAV, "files", path],
    queryFn: () =>
      api.get<{ entries: EinDavFileEntry[] }>(`/eindav/files?path=${encodeURIComponent(path)}`),
  });
}

export function useUploadEinDavFile() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { path: string; file: File }) =>
      api.upload(`/eindav/file?path=${encodeURIComponent(args.path)}`, args.file, "PUT"),
    onSuccess: (_res, args) =>
      qc.invalidateQueries({ queryKey: [...EINDAV, "files", dirOf(args.path)] }),
  });
}

export function useDeleteEinDavFile() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => api.delete(`/eindav/file?path=${encodeURIComponent(path)}`),
    onSuccess: (_res, path) =>
      qc.invalidateQueries({ queryKey: [...EINDAV, "files", dirOf(path)] }),
  });
}

export function useMkdirEinDav() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => api.post(`/eindav/folder?path=${encodeURIComponent(path)}`),
    onSuccess: (_res, path) =>
      qc.invalidateQueries({ queryKey: [...EINDAV, "files", dirOf(path)] }),
  });
}

/** Download a file through the authenticated BFF proxy and trigger a save. */
export function useDownloadEinDavFile() {
  const api = useApi();
  return useMutation({
    mutationFn: async (path: string) => {
      const blob = await api.blob(`/eindav/file?path=${encodeURIComponent(path)}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = path.split("/").at(-1) ?? "file";
      a.click();
      URL.revokeObjectURL(url);
    },
  });
}

const dirOf = (path: string) => path.split("/").slice(0, -1).join("/");

// --- Recipes (D55) ----------------------------------------------------------

export function useRecipes(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ["recipes"],
    queryFn: () => api.get<{ recipes: RecipeListItem[] }>("/recipes"),
    enabled,
  });
}

export function useRecipe(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ["recipes", id],
    queryFn: () => api.get<{ recipe: Recipe }>(`/recipes/${encodeURIComponent(id ?? "")}`),
    enabled: id !== null,
  });
}

/** Authenticated blob fetch of the recipe photo for <img src> (D48 pattern). */
export function useRecipeImage(id: string | null, hasImage: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ["recipes", id, "image"],
    queryFn: () => api.blob(`/recipes/${encodeURIComponent(id ?? "")}/image`),
    enabled: id !== null && hasImage,
    staleTime: 5 * 60_000,
  });
}

// --- School (D56) -----------------------------------------------------------

const SCHOOL = ["school"] as const;

/** Roles + linked profile — gates every school view. */
export function useSchoolMe(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...SCHOOL, "me"],
    queryFn: () => api.get<SchoolMe>("/school/me"),
    enabled,
  });
}

export function useSchoolUsers(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...SCHOOL, "users"],
    queryFn: () => api.get<{ users: SchoolUser[] }>("/school/users"),
    enabled,
  });
}

export function useSchoolPersons(kind: SchoolPerson["kind"] | null, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...SCHOOL, "persons", kind],
    queryFn: () =>
      api.get<{ persons: SchoolPerson[] }>(`/school/persons${kind ? `?kind=${kind}` : ""}`),
    enabled,
  });
}

export function useSchoolSavePerson() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id?: string; body: Record<string, unknown> }) =>
      input.id
        ? api.patch(`/school/persons/${input.id}`, input.body)
        : api.post<{ id: string }>("/school/persons", input.body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...SCHOOL, "persons"] }),
  });
}

export function useSchoolDeletePerson() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/school/persons/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...SCHOOL, "persons"] }),
  });
}

export function useSchoolLinkPerson() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; sub: string }) =>
      api.post(`/school/persons/${input.id}/link`, { sub: input.sub }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...SCHOOL] }),
  });
}

export function useSchoolHouseholds(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...SCHOOL, "households"],
    queryFn: () => api.get<{ households: SchoolHousehold[] }>("/school/households"),
    enabled,
  });
}

export function useSchoolSaveHousehold() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id?: string; body: Record<string, unknown> }) =>
      input.id
        ? api.patch(`/school/households/${input.id}`, input.body)
        : api.post<{ id: string }>("/school/households", input.body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...SCHOOL, "households"] }),
  });
}

export function useSchoolSetMembers() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      members: { personId: string; relation: "guardian" | "student" }[];
    }) => api.put(`/school/households/${input.id}/members`, { members: input.members }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...SCHOOL, "households"] }),
  });
}

export function useSchoolLessonTypes(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...SCHOOL, "lesson-types"],
    queryFn: () => api.get<{ lessonTypes: SchoolLessonType[] }>("/school/lesson-types"),
    enabled,
  });
}

export function useSchoolSaveLessonType() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ id: string }>("/school/lesson-types", body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...SCHOOL, "lesson-types"] }),
  });
}

export function useSchoolSeries(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...SCHOOL, "series"],
    queryFn: () => api.get<{ series: SchoolSeries[] }>("/school/series"),
    enabled,
  });
}

export function useSchoolSaveSeries() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id?: string; body: Record<string, unknown> }) =>
      input.id
        ? api.patch(`/school/series/${input.id}`, input.body)
        : api.post<{ id: string }>("/school/series", input.body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...SCHOOL, "series"] });
      void qc.invalidateQueries({ queryKey: [...SCHOOL, "lessons"] });
    },
  });
}

export function useSchoolDeleteSeries() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/school/series/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...SCHOOL, "series"] });
      void qc.invalidateQueries({ queryKey: [...SCHOOL, "lessons"] });
    },
  });
}

/** Lessons in a date range — the BFF materializes the range lazily. */
export function useSchoolLessons(from: string, to: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...SCHOOL, "lessons", from, to],
    queryFn: () => api.get<{ lessons: SchoolLesson[] }>(`/school/lessons?from=${from}&to=${to}`),
    enabled,
  });
}

export function useSchoolCreateLesson() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ id: string }>("/school/lessons", body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...SCHOOL, "lessons"] }),
  });
}

export function useSchoolPatchLesson() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/school/lessons/${input.id}`, input.body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...SCHOOL, "lessons"] }),
  });
}

export function useSchoolCheckConflicts() {
  const api = useApi();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ conflicts: SchoolConflict[] }>("/school/lessons/check", body),
  });
}

export function useSchoolMarkAttendance() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      lessonId: string;
      studentId: string;
      attendance: SchoolAttendance;
      practice?: string;
      publicNote?: string;
      privateNote?: string;
    }) =>
      api.put(`/school/lessons/${input.lessonId}/attendance`, {
        studentId: input.studentId,
        attendance: input.attendance,
        practice: input.practice,
        publicNote: input.publicNote,
        privateNote: input.privateNote,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...SCHOOL, "lessons"] }),
  });
}

export function useSchoolReportAbsence() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      lessonId: string;
      studentId: string;
      reason?: string;
      wantMakeup?: boolean;
    }) =>
      api.post(`/school/lessons/${input.lessonId}/report-absence`, {
        studentId: input.studentId,
        reason: input.reason,
        wantMakeup: input.wantMakeup,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...SCHOOL, "lessons"] });
      void qc.invalidateQueries({ queryKey: [...SCHOOL, "makeup-requests"] });
    },
  });
}

export function useSchoolMakeupRequests(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...SCHOOL, "makeup-requests"],
    queryFn: () => api.get<{ requests: SchoolMakeupRequest[] }>("/school/makeup-requests"),
    enabled,
  });
}

export function useSchoolHolidays(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...SCHOOL, "holidays"],
    queryFn: () => api.get<{ holidays: SchoolHoliday[] }>("/school/holidays"),
    enabled,
  });
}

export function useSchoolSaveHoliday() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; startDate: string; endDate: string; kind?: string }) =>
      api.post<{ id: string }>("/school/holidays", body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...SCHOOL, "holidays"] }),
  });
}

export function useSchoolDeleteHoliday() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/school/holidays/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...SCHOOL, "holidays"] }),
  });
}

export function useSchoolInstruments(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...SCHOOL, "instruments"],
    queryFn: () => api.get<{ instruments: SchoolInstrument[] }>("/school/instruments"),
    enabled,
  });
}

export function useSchoolSaveInstrument() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ id: string }>("/school/instruments", body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...SCHOOL, "instruments"] }),
  });
}

export function useSchoolRentals(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...SCHOOL, "rentals"],
    queryFn: () => api.get<{ rentals: SchoolRental[] }>("/school/rentals"),
    enabled,
  });
}

export function useSchoolSaveRental() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id?: string; body: Record<string, unknown> }) =>
      input.id
        ? api.patch(`/school/rentals/${input.id}`, input.body)
        : api.post<{ id: string }>("/school/rentals", input.body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...SCHOOL, "rentals"] });
      void qc.invalidateQueries({ queryKey: [...SCHOOL, "instruments"] });
    },
  });
}

export function useSchoolInvoices(period: string | null, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...SCHOOL, "invoices", period],
    queryFn: () =>
      api.get<{ invoices: SchoolInvoice[] }>(
        `/school/invoices${period ? `?period=${period}` : ""}`,
      ),
    enabled,
  });
}

export function useSchoolInvoice(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: [...SCHOOL, "invoice", id],
    queryFn: () => api.get<{ invoice: SchoolInvoiceDetail }>(`/school/invoices/${id ?? ""}`),
    enabled: id !== null,
  });
}

export function useSchoolGenerateInvoices() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (period: string) =>
      api.post<{ created: number; skipped: number }>("/school/invoices/generate", { period }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...SCHOOL, "invoices"] }),
  });
}

export function useSchoolPatchInvoice() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/school/invoices/${input.id}`, input.body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...SCHOOL, "invoices"] });
      void qc.invalidateQueries({ queryKey: [...SCHOOL, "invoice"] });
    },
  });
}

export function useSchoolAddPayment() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; amountCents: number; method?: string }) =>
      api.post(`/school/invoices/${input.id}/payments`, {
        amountCents: input.amountCents,
        method: input.method,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...SCHOOL, "invoices"] });
      void qc.invalidateQueries({ queryKey: [...SCHOOL, "invoice"] });
    },
  });
}

/** Authenticated invoice-PDF download (D56). */
export function useSchoolInvoicePdf() {
  const api = useApi();
  return useMutation({
    mutationFn: async (input: { id: string; number: string }) => {
      const blob = await api.blob(`/school/invoices/${input.id}/pdf`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${input.number}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    },
  });
}

export function useSchoolThreads(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...SCHOOL, "threads"],
    queryFn: () => api.get<{ threads: SchoolThread[] }>("/school/threads"),
    enabled,
    refetchInterval: 30_000,
  });
}

export function useSchoolThreadMessages(threadId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: [...SCHOOL, "thread", threadId],
    queryFn: () =>
      api.get<{ messages: SchoolMessage[] }>(`/school/threads/${threadId ?? ""}/messages`),
    enabled: threadId !== null,
    refetchInterval: 5_000,
  });
}

export function useSchoolSendMessage() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      threadId?: string;
      body: string;
      title?: string;
      memberSubs?: string[];
      audience?: string;
    }) =>
      input.threadId
        ? api.post(`/school/threads/${input.threadId}/messages`, { body: input.body })
        : api.post<{ id: string }>("/school/threads", {
            title: input.title,
            memberSubs: input.memberSubs,
            audience: input.audience,
            body: input.body,
          }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...SCHOOL, "threads"] });
      void qc.invalidateQueries({ queryKey: [...SCHOOL, "thread"] });
    },
  });
}

export function useSchoolEvents(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...SCHOOL, "events"],
    queryFn: () => api.get<{ events: SchoolEvent[] }>("/school/events"),
    enabled,
  });
}

export function useSchoolSaveEvent() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id?: string; body: Record<string, unknown> }) =>
      input.id
        ? api.patch(`/school/events/${input.id}`, input.body)
        : api.post<{ id: string }>("/school/events", input.body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...SCHOOL, "events"] }),
  });
}

export function useSchoolEventParticipants() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      eventId: string;
      participants: { studentId: string; piece?: string }[];
    }) =>
      api.put(`/school/events/${input.eventId}/participants`, {
        participants: input.participants,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...SCHOOL, "events"] }),
  });
}

export function useSchoolConfirmParticipation() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { eventId: string; studentId: string; status: string }) =>
      api.patch(`/school/events/${input.eventId}/participants/${input.studentId}`, {
        status: input.status,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...SCHOOL, "events"] }),
  });
}

/* ------------------------------------------------------- school homework */

export function useSchoolHomework(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...SCHOOL, "homework"],
    queryFn: () => api.get<{ homework: SchoolHomework[] }>("/school/homework"),
    enabled,
  });
}

export function useSchoolHomeworkDetail(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: [...SCHOOL, "homework", id],
    queryFn: () => api.get<{ homework: SchoolHomework }>(`/school/homework/${id ?? ""}`),
    enabled: id !== null,
  });
}

export function useSchoolSaveHomework() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id?: string; body: Record<string, unknown> }) =>
      input.id
        ? api.patch(`/school/homework/${input.id}`, input.body)
        : api.post<{ id: string }>("/school/homework", input.body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...SCHOOL, "homework"] }),
  });
}

export function useSchoolDeleteHomework() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/school/homework/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...SCHOOL, "homework"] }),
  });
}

export function useSchoolAssignments(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...SCHOOL, "assignments"],
    queryFn: () =>
      api.get<{ assignments: SchoolHomeworkAssignment[] }>("/school/homework/assignments"),
    enabled,
  });
}

export function useSchoolAssignHomework() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      homeworkId: string;
      studentIds: string[];
      note?: string;
      dueDate?: string;
    }) => api.post("/school/homework/assign", body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...SCHOOL, "assignments"] }),
  });
}

export function useSchoolPatchAssignment() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/school/homework/assignments/${input.id}`, input.body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...SCHOOL, "assignments"] }),
  });
}

/** Submit = POST the message, then PUT the media file (raw bytes, D57). */
export function useSchoolSubmitHomework() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { assignmentId: string; message: string; file: File }) => {
      const { id } = await api.post<{ id: string }>(
        `/school/homework/assignments/${input.assignmentId}/submissions`,
        { message: input.message },
      );
      await api.upload(
        `/school/homework/submissions/${id}/media?name=${encodeURIComponent(input.file.name)}`,
        input.file,
        "PUT",
      );
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...SCHOOL, "assignments"] }),
  });
}

import { XMLParser } from "fast-xml-parser";

export type Fetch = typeof fetch;

export interface LoginFlowStart {
  poll: { token: string; endpoint: string };
  login: string;
}

export interface LoginFlowResult {
  server: string;
  loginName: string;
  appPassword: string;
}

export interface TablesColumn {
  id: number;
  title: string;
  type: string;
  subtype?: string;
  orderWeight?: number;
  selectionOptions?: { id: number; label: string }[] | null;
}

export interface TablesRow {
  id: number;
  tableId: number;
  createdAt?: string;
  lastEditAt?: string;
  data: { columnId: number; value: unknown }[];
}

/** A Tables view (curated filtered/sorted slice of a table). */
export interface TablesViewMeta {
  id: number;
  title: string;
  emoji?: string;
  tableId?: number;
}

/**
 * A node inside a Tables context (application). Serialized `ContextNodeRelation`;
 * `nodeType` is a numeric enum (0 = table, 1 = view), no title included. Field
 * casing varies across releases — snake_case (`node_id`/`node_type`) on older
 * versions, camelCase on newer ones.
 */
export interface TablesContextNode {
  nodeType?: number | string;
  nodeId?: number | string;
  nodeTitle?: string;
  node_type?: number | string;
  node_id?: number | string;
  node_title?: string;
}

/**
 * `GET /api/2/contexts/{id}` payload (OCS `data`). Field layout varies across
 * Tables releases — `nodes`, `content` or `pages[].content` — the module
 * flattens all of them.
 */
export interface TablesContext {
  id?: number;
  name?: string;
  title?: string;
  iconEmoji?: string;
  nodes?: TablesContextNode[];
  content?: TablesContextNode[];
  pages?: { content?: TablesContextNode[] }[];
}

export interface TablesTable {
  id: number;
  title: string;
  emoji?: string;
  description?: string | null;
}

/** OCS envelope; `ocs.meta.statuscode` mirrors the HTTP status. */
export interface OcsResponse<T> {
  ocs: { meta: { status: string; statuscode: number; message?: string }; data: T };
}

/** `GET /ocs/v2.php/apps/serverinfo/api/v1/info` — fields vary across releases, so all optional. */
export interface ServerInfoData {
  nextcloud?: {
    system?: { version?: string; theme?: string; enable_avatars?: string };
    storage?: { num_users?: number; num_files?: number; num_storages?: number };
  };
  server?: {
    webserver?: string;
    php?: { version?: string; memory_limit?: number; upload_max_filesize?: number };
    database?: { type?: string; version?: string; size?: number };
  };
  system?: {
    cpuload?: number[];
    mem_total?: number;
    mem_free?: number;
    swap_total?: number;
    swap_free?: number;
    freespace?: number;
    apps?: { num_installed?: number; num_updates_available?: number };
  };
  activeUsers?: { last5minutes?: number; last1hour?: number; last24hours?: number };
}

/** `GET /ocs/v2.php/apps/user_status/api/v1/statuses` entry. */
export interface UserStatus {
  userId: string;
  message?: string | null;
  icon?: string | null;
  clearAt?: number | null;
  status?: string; // online | away | dnd | invisible | offline
}

/** `GET /ocs/v2.php/cloud/capabilities` — any authenticated user; app capability map. */
export interface CapabilitiesData {
  version?: { string?: string; edition?: string };
  capabilities?: Record<string, unknown> & {
    theming?: { name?: string; productname?: string };
    spreed?: { version?: string };
    user_status?: { enabled?: boolean };
  };
}

/** `GET /apps/spreed/api/v4/room` entry — fields vary across Talk releases. */
export interface TalkRoom {
  token: string;
  type?: number;
  name?: string;
  displayName?: string;
  unreadMessages?: number;
  unreadMention?: boolean;
  lastActivity?: number;
  lastMessage?: TalkMessage;
}

/** A spreed chat message (`/apps/spreed/api/v1/chat/{token}`). */
export interface TalkMessage {
  id: number;
  token?: string;
  actorType?: string;
  actorId?: string;
  actorDisplayName?: string;
  timestamp?: number;
  systemMessage?: string;
  messageType?: string;
  message?: string;
  /** Rich-object parameters keyed by placeholder — attachments carry `file` with `path`. */
  messageParameters?: Record<string, unknown>;
}

/** `GET /ocs/v2.php/cloud/user` — the connected account's own info incl. storage quota. */
export interface OwnUser {
  id?: string;
  displayname?: string;
  quota?: { free?: number; used?: number; total?: number; relative?: number };
}

/** `GET /ocs/v2.php/cloud/users/details` (provisioning API — admin credentials required). */
export interface UsersDetails {
  users: Record<
    string,
    {
      id?: string;
      displayname?: string;
      groups?: string[];
      /** Epoch ms of the last login; 0 = never logged in. Admin-only data. */
      lastLogin?: number;
    }
  >;
}

/** Talk autocomplete entry (`/ocs/v2.php/apps/spreed/api/v4/core/autocomplete`) — usable by regular users. */
export interface AutocompleteResult {
  id: string;
  label: string;
  source: string;
}

/** `GET /ocs/v2.php/cloud/groups` — admins see all, group admins (subadmins) their managed groups. */
export interface GroupsList {
  groups: string[];
}

/** A `PROPFIND` result entry; `href` is the URL-encoded DAV path, `relPath` is decoded and
 * relative to the user's files root (no `remote.php/dav/files/<user>/` prefix). */
export interface DavEntry {
  href: string;
  relPath: string;
  isCollection: boolean;
  etag?: string;
  lastModified?: string;
  size?: number;
  contentType?: string;
}

export class NextcloudError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Minimal Nextcloud client: Login Flow v2 and the Tables app REST API v1.
 * https://docs.nextcloud.com/server/stable/developer_manual/client_apis/LoginFlow/index.html#login-flow-v2
 */
export class NextcloudClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly userAgent = "einring",
  ) {}

  async startLoginFlow(): Promise<LoginFlowStart> {
    const res = await this.fetchImpl(`${this.baseUrl}/index.php/login/v2`, {
      method: "POST",
      headers: { "User-Agent": this.userAgent, Accept: "application/json" },
    });
    if (!res.ok) throw new NextcloudError(res.status, "login flow could not be started");
    return (await res.json()) as LoginFlowStart;
  }

  /** Returns `undefined` while the user has not finished logging in (Nextcloud answers 404). */
  async pollLoginFlow(endpoint: string, token: string): Promise<LoginFlowResult | undefined> {
    const res = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "User-Agent": this.userAgent,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token }),
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new NextcloudError(res.status, "login flow poll failed");
    return (await res.json()) as LoginFlowResult;
  }

  withCredentials(loginName: string, appPassword: string): AuthenticatedNextcloud {
    return new AuthenticatedNextcloud(
      this.baseUrl,
      this.fetchImpl,
      this.userAgent,
      loginName,
      appPassword,
    );
  }
}

export class AuthenticatedNextcloud {
  private readonly authHeader: string;
  private readonly davBase: string;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: Fetch,
    private readonly userAgent: string,
    private readonly loginName: string,
    appPassword: string,
  ) {
    this.authHeader = `Basic ${Buffer.from(`${loginName}:${appPassword}`).toString("base64")}`;
    this.davBase = `${baseUrl}/remote.php/dav/files/${encodeURIComponent(loginName)}`;
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      "OCS-APIRequest": "true",
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    if (!res.ok) throw new NextcloudError(res.status, `${method} ${path} -> ${res.status}`);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private get<T>(path: string): Promise<T> {
    return this.send<T>("GET", path);
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>("POST", path, body);
  }

  private put<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>("PUT", path, body);
  }

  private del<T>(path: string): Promise<T> {
    return this.send<T>("DELETE", path);
  }

  getTable(tableId: number) {
    return this.get<TablesTable>(`/index.php/apps/tables/api/1/tables/${tableId}`);
  }

  getColumns(tableId: number) {
    return this.get<TablesColumn[]>(`/index.php/apps/tables/api/1/tables/${tableId}/columns`);
  }

  getRows(tableId: number) {
    return this.get<TablesRow[]>(`/index.php/apps/tables/api/1/tables/${tableId}/rows`);
  }

  // -- Tables applications (contexts) — OCS v2; v1 has no context endpoints (D40).

  getContext(contextId: number) {
    return this.get<OcsResponse<TablesContext>>(
      `/ocs/v2.php/apps/tables/api/2/contexts/${contextId}`,
    );
  }

  // -- Views — v1 REST.

  getView(viewId: number) {
    return this.get<TablesViewMeta>(`/index.php/apps/tables/api/1/views/${viewId}`);
  }

  getViewColumns(viewId: number) {
    return this.get<TablesColumn[]>(`/index.php/apps/tables/api/1/views/${viewId}/columns`);
  }

  getViewRows(viewId: number) {
    return this.get<TablesRow[]>(`/index.php/apps/tables/api/1/views/${viewId}/rows`);
  }

  // -- Row writes — v1 REST; `data` is [{columnId, value}] like the read shape.

  createRowInTable(tableId: number, data: { columnId: number; value: unknown }[]) {
    return this.post<TablesRow>(`/index.php/apps/tables/api/1/tables/${tableId}/rows`, { data });
  }

  createRowInView(viewId: number, data: { columnId: number; value: unknown }[]) {
    return this.post<TablesRow>(`/index.php/apps/tables/api/1/views/${viewId}/rows`, { data });
  }

  updateRow(rowId: number, data: { columnId: number; value: unknown }[]) {
    return this.put<TablesRow>(`/index.php/apps/tables/api/1/rows/${rowId}`, { data });
  }

  deleteRow(rowId: number) {
    return this.del<void>(`/index.php/apps/tables/api/1/rows/${rowId}`);
  }

  /** View-scoped delete — the only correct way to drop a row inside a shared view. */
  deleteRowByView(viewId: number, rowId: number) {
    return this.del<void>(`/index.php/apps/tables/api/1/views/${viewId}/rows/${rowId}`);
  }

  /** Serverinfo app: CPU/memory/storage/version overview. */
  getServerInfo() {
    return this.get<OcsResponse<ServerInfoData>>("/ocs/v2.php/apps/serverinfo/api/v1/info");
  }

  /** Current user_status entries (presence + custom status) for all users. */
  getUserStatuses() {
    return this.get<OcsResponse<UserStatus[]>>("/ocs/v2.php/apps/user_status/api/v1/statuses");
  }

  /** Server capabilities — version + installed-app feature map; any authenticated user. */
  getCapabilities() {
    return this.get<OcsResponse<CapabilitiesData>>("/ocs/v2.php/cloud/capabilities");
  }

  /** Own account info incl. storage quota — any authenticated user. */
  getOwnUser() {
    return this.get<OcsResponse<OwnUser>>("/ocs/v2.php/cloud/user");
  }

  /** Provisioning API: users incl. display names and groups. Requires admin — throws NextcloudError(401/403). */
  getUsersDetails() {
    return this.get<OcsResponse<UsersDetails>>("/ocs/v2.php/cloud/users/details");
  }

  /**
   * DAV principals lookup — resolves a user or group display name by exact id.
   * Works for regular users and obfuscated (non-searchable) ids.
   */
  async getPrincipalDisplayName(kind: "users" | "groups", id: string): Promise<string | null> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/remote.php/dav/principals/${kind}/${encodeURIComponent(id)}`,
      {
        method: "PROPFIND",
        headers: {
          Authorization: this.authHeader,
          "User-Agent": this.userAgent,
          Depth: "0",
          "Content-Type": "application/xml",
        },
        body: `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:">
  <d:prop><d:displayname/></d:prop>
</d:propfind>`,
      },
    );
    if (!res.ok) {
      throw new NextcloudError(res.status, `PROPFIND principal ${kind}/${id} -> ${res.status}`);
    }
    const doc = new XMLParser({ removeNSPrefix: true }).parse(await res.text()) as {
      multistatus?: { response?: PrincipalResponse | PrincipalResponse[] };
    };
    const raw = doc.multistatus?.response;
    const responses = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
    for (const r of responses) {
      const stats = Array.isArray(r.propstat) ? r.propstat : [r.propstat];
      const ok = stats.find((s) => s && String(s.status).includes(" 200"));
      if (ok?.prop?.displayname != null) return String(ok.prop.displayname);
    }
    return null;
  }

  /** Talk autocomplete for user candidates — resolves display names without admin rights. */
  autocompleteUsers(search: string) {
    const q = new URLSearchParams({ search, itemType: "users" });
    return this.get<OcsResponse<AutocompleteResult[]>>(
      `/ocs/v2.php/apps/spreed/api/v4/core/autocomplete?${q}`,
    );
  }

  /**
   * Passman app REST API v2 — raw JSON pass-through; credential fields stay
   * client-side encrypted (the BFF never sees vault keys, D50).
   */
  getPassman<T>(path: string) {
    return this.get<T>(`/index.php/apps/passman/api/v2${path}`);
  }

  // -- Talk (spreed) OCS API (D51) -----------------------------------------

  /** `GET /apps/spreed/api/v4/room` — conversations. */
  getTalkRooms() {
    return this.get<OcsResponse<TalkRoom[]>>(`/ocs/v2.php/apps/spreed/api/v4/room`);
  }

  /**
   * `GET /apps/spreed/api/v1/chat/{token}` — message history.
   * `setReadMarker=0` so polling never moves the user's read marker.
   */
  getTalkMessages(token: string, lastKnown?: number, limit = 50) {
    const q = new URLSearchParams({
      lookIntoFuture: "0",
      limit: String(limit),
      setReadMarker: "0",
    });
    if (lastKnown !== undefined) q.set("lastKnownMessageId", String(lastKnown));
    return this.get<OcsResponse<TalkMessage[]>>(
      `/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(token)}?${q}`,
    );
  }

  /** `POST /apps/spreed/api/v1/chat/{token}` — send a text message. */
  postTalkMessage(token: string, message: string, referenceId: string) {
    return this.post<OcsResponse<TalkMessage>>(
      `/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(token)}`,
      { message, referenceId },
    );
  }

  /**
   * `POST /ocs/v2.php/apps/files_sharing/api/v1/shares` — share an uploaded
   * file into a conversation (`shareType=10`), producing a `file` rich-object
   * chat message (the same flow the Android app uses).
   */
  shareFileToTalk(token: string, path: string, referenceId: string, caption?: string) {
    const body: Record<string, unknown> = {
      shareType: 10,
      shareWith: token,
      path,
      referenceId,
    };
    if (caption) body.talkMetaData = JSON.stringify({ messageType: "comment", caption });
    return this.post<OcsResponse<unknown>>(`/ocs/v2.php/apps/files_sharing/api/v1/shares`, body);
  }

  /** WebDAV MKCOL — creates a directory under the user's files root. 405 = exists. */
  async davMkcol(relPath: string): Promise<void> {
    const res = await this.fetchImpl(`${this.davBase}${davPath(relPath)}`, {
      method: "MKCOL",
      headers: { Authorization: this.authHeader, "User-Agent": this.userAgent },
    });
    if (!res.ok && res.status !== 405) {
      throw new NextcloudError(res.status, `MKCOL ${relPath} -> ${res.status}`);
    }
  }

  /** WebDAV PUT — upload raw bytes to a file path under the user's files root. */
  async davPutFile(relPath: string, data: Uint8Array, contentType: string): Promise<void> {
    const res = await this.fetchImpl(`${this.davBase}${davPath(relPath)}`, {
      method: "PUT",
      headers: {
        Authorization: this.authHeader,
        "User-Agent": this.userAgent,
        "Content-Type": contentType,
      },
      body: data,
    });
    if (!res.ok) throw new NextcloudError(res.status, `PUT ${relPath} -> ${res.status}`);
  }

  /** WebDAV GET — raw bytes of a file relative to the user's files root. */
  async davGetBytes(relPath: string): Promise<Buffer> {
    const res = await this.fetchImpl(`${this.davBase}${davPath(relPath)}`, {
      headers: { Authorization: this.authHeader, "User-Agent": this.userAgent },
    });
    if (!res.ok) throw new NextcloudError(res.status, `GET ${relPath} -> ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Collectives user setting, e.g. `user_folder` — the per-user path where
   * collectives are mounted in the files tree. Any authenticated user.
   */
  getCollectivesUserSetting(key: string) {
    return this.get<OcsResponse<Record<string, string>>>(
      `/ocs/v2.php/apps/collectives/api/v1.0/settings/user/${encodeURIComponent(key)}`,
    );
  }

  /** Groups visible to the account: all for admins, managed groups for group admins. */
  getGroups() {
    return this.get<OcsResponse<GroupsList>>("/ocs/v2.php/cloud/groups");
  }

  /** Members of a group — admins, or group admins of that group. */
  getGroupUsers(groupId: string) {
    return this.get<OcsResponse<{ users: string[] }>>(
      `/ocs/v2.php/cloud/groups/${encodeURIComponent(groupId)}/users`,
    );
  }

  /**
   * WebDAV PROPFIND on `relPath` (relative to the user's files root).
   * `depth` 1 = directory listing incl. the directory itself.
   */
  async davPropfind(relPath: string, depth: 0 | 1): Promise<DavEntry[]> {
    const res = await this.fetchImpl(`${this.davBase}${davPath(relPath)}`, {
      method: "PROPFIND",
      headers: {
        Authorization: this.authHeader,
        "User-Agent": this.userAgent,
        Depth: String(depth),
        "Content-Type": "application/xml",
      },
      body: `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:">
  <d:prop><d:resourcetype/><d:getetag/><d:getlastmodified/><d:getcontentlength/><d:getcontenttype/></d:prop>
</d:propfind>`,
    });
    if (!res.ok) throw new NextcloudError(res.status, `PROPFIND ${relPath} -> ${res.status}`);
    const prefix = `/remote.php/dav/files/${this.loginName}/`;
    return parseMultistatus(await res.text(), prefix);
  }

  /** WebDAV GET — downloads a file relative to the user's files root. */
  async davGetFile(relPath: string): Promise<string> {
    const res = await this.fetchImpl(`${this.davBase}${davPath(relPath)}`, {
      headers: { Authorization: this.authHeader, "User-Agent": this.userAgent },
    });
    if (!res.ok) throw new NextcloudError(res.status, `GET ${relPath} -> ${res.status}`);
    return res.text();
  }

  /** WebDAV DELETE — removes a file or collection under the user's files root. */
  async davDelete(relPath: string): Promise<void> {
    const res = await this.fetchImpl(`${this.davBase}${davPath(relPath)}`, {
      method: "DELETE",
      headers: { Authorization: this.authHeader, "User-Agent": this.userAgent },
    });
    if (!res.ok) throw new NextcloudError(res.status, `DELETE ${relPath} -> ${res.status}`);
  }

  /** WebDAV GET returning the raw response — for proxied downloads (content-type passthrough). */
  async davGetResponse(relPath: string): Promise<Response> {
    const res = await this.fetchImpl(`${this.davBase}${davPath(relPath)}`, {
      headers: { Authorization: this.authHeader, "User-Agent": this.userAgent },
    });
    if (!res.ok) throw new NextcloudError(res.status, `GET ${relPath} -> ${res.status}`);
    return res;
  }

  // -- EinDAV: generic CardDAV/CalDAV plumbing (D54) -------------------------

  /** DAV home roots that are not the files root (`/remote.php/dav/<kind>/users/<login>`). */
  davHome(kind: "addressbooks" | "calendars"): string {
    return `/remote.php/dav/${kind}/users/${encodeURIComponent(this.loginName)}`;
  }

  /** PROPFIND on an absolute DAV path, returning the raw multistatus XML. */
  async davPropfindAbs(href: string, depth: 0 | 1, propsXml: string): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}${href}`, {
      method: "PROPFIND",
      headers: {
        Authorization: this.authHeader,
        "User-Agent": this.userAgent,
        Depth: String(depth),
        "Content-Type": "application/xml",
      },
      body: `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>${propsXml}</d:prop>
</d:propfind>`,
    });
    if (!res.ok) throw new NextcloudError(res.status, `PROPFIND ${href} -> ${res.status}`);
    return res.text();
  }

  /** REPORT on an absolute DAV path (addressbook-query, calendar-query, multiget). */
  async davReport(href: string, bodyXml: string): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}${href}`, {
      method: "REPORT",
      headers: {
        Authorization: this.authHeader,
        "User-Agent": this.userAgent,
        Depth: "1",
        "Content-Type": "application/xml",
      },
      body: bodyXml,
    });
    if (!res.ok) throw new NextcloudError(res.status, `REPORT ${href} -> ${res.status}`);
    return res.text();
  }

  /** PUT/DELETE on an absolute DAV object href (contact `.vcf`, event `.ics`). */
  async davObjectRequest(
    method: "PUT" | "DELETE",
    href: string,
    body?: string,
    contentType?: string,
  ): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}${href}`, {
      method,
      headers: {
        Authorization: this.authHeader,
        "User-Agent": this.userAgent,
        ...(contentType ? { "Content-Type": contentType } : {}),
      },
      body,
    });
    if (!res.ok) throw new NextcloudError(res.status, `${method} ${href} -> ${res.status}`);
  }
}

const davPath = (relPath: string) =>
  relPath === "" ? "" : `/${relPath.split("/").map(encodeURIComponent).join("/")}`;

/** Parses a DAV multistatus response; strips the `remote.php/dav/files/<user>/` prefix. */
export function parseMultistatus(xml: string, filesPrefix: string): DavEntry[] {
  const doc = new XMLParser({ removeNSPrefix: true }).parse(xml) as {
    multistatus?: { response?: DavResponse | DavResponse[] };
  };
  const raw = doc.multistatus?.response;
  const responses = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const entries: DavEntry[] = [];
  for (const r of responses) {
    const stats: (DavPropstat | undefined)[] = Array.isArray(r.propstat)
      ? r.propstat
      : [r.propstat];
    const ok = stats.find((s) => s && String(s.status).includes(" 200"));
    if (!ok?.prop || typeof r.href !== "string") continue;
    const href = decodeURIComponent(r.href);
    const relPath = href.startsWith(filesPrefix)
      ? href.slice(filesPrefix.length).replace(/\/$/, "")
      : href;
    const { resourcetype, getetag, getlastmodified, getcontentlength, getcontenttype } = ok.prop;
    entries.push({
      href: r.href,
      relPath,
      isCollection:
        typeof resourcetype === "object" && resourcetype !== null && "collection" in resourcetype,
      etag: getetag != null ? String(getetag).replaceAll('"', "") : undefined,
      lastModified: getlastmodified != null ? String(getlastmodified) : undefined,
      size: getcontentlength != null ? Number(getcontentlength) || undefined : undefined,
      contentType: getcontenttype != null ? String(getcontenttype) : undefined,
    });
  }
  return entries;
}

interface DavResponse {
  href?: unknown;
  propstat?: DavPropstat | DavPropstat[];
}
interface DavPropstat {
  status?: unknown;
  prop?: {
    resourcetype?: unknown;
    getetag?: unknown;
    getlastmodified?: unknown;
    getcontentlength?: unknown;
    getcontenttype?: unknown;
  };
}

// -- EinDAV generic propstat parsing (D54) -----------------------------------

/** One `response` element of a multistatus doc, with its 200-propstat props by local name. */
export interface DavPropResponse {
  /** Absolute DAV path as returned by the server (URL-encoded). */
  href: string;
  /** Property map by local element name; values are the parser's raw output. */
  props: Record<string, unknown>;
}

/**
 * Parses a multistatus document into href + raw props — used for CardDAV/CalDAV
 * PROPFIND/REPORT results where the prop set varies per call.
 */
export function parsePropResponses(xml: string): DavPropResponse[] {
  const doc = new XMLParser({ removeNSPrefix: true }).parse(xml) as {
    multistatus?: { response?: DavResponse | DavResponse[] };
  };
  const raw = doc.multistatus?.response;
  const responses = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const out: DavPropResponse[] = [];
  for (const r of responses) {
    if (typeof r.href !== "string") continue;
    const stats: (DavPropstat | undefined)[] = Array.isArray(r.propstat)
      ? r.propstat
      : [r.propstat];
    const ok = stats.find((s) => s && String(s.status).includes(" 200"));
    out.push({ href: r.href, props: (ok?.prop ?? {}) as Record<string, unknown> });
  }
  return out;
}

/** Text content of a parsed XML prop (`{ "#text": v }` when attrs exist, else scalar). */
export function propText(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "object") {
    const t = (v as Record<string, unknown>)["#text"];
    return t == null ? undefined : String(t);
  }
  return String(v);
}
interface PrincipalResponse {
  href?: unknown;
  propstat?:
    | { status?: unknown; prop?: { displayname?: unknown } }
    | { status?: unknown; prop?: { displayname?: unknown } }[];
}

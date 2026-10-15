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

/** `GET /ocs/v2.php/cloud/users/details` (provisioning API — admin credentials required). */
export interface UsersDetails {
  users: Record<string, { id?: string; displayname?: string; groups?: string[] }>;
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

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: Fetch,
    private readonly userAgent: string,
    loginName: string,
    appPassword: string,
  ) {
    this.authHeader = `Basic ${Buffer.from(`${loginName}:${appPassword}`).toString("base64")}`;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: this.authHeader,
        "OCS-APIRequest": "true",
        Accept: "application/json",
        "User-Agent": this.userAgent,
      },
    });
    if (!res.ok) throw new NextcloudError(res.status, `GET ${path} -> ${res.status}`);
    return (await res.json()) as T;
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

  /** Serverinfo app: CPU/memory/storage/version overview. */
  getServerInfo() {
    return this.get<OcsResponse<ServerInfoData>>("/ocs/v2.php/apps/serverinfo/api/v1/info");
  }

  /** Current user_status entries (presence + custom status) for all users. */
  getUserStatuses() {
    return this.get<OcsResponse<UserStatus[]>>("/ocs/v2.php/apps/user_status/api/v1/statuses");
  }

  /** Provisioning API: users incl. display names and groups. Requires admin — throws NextcloudError(401/403). */
  getUsersDetails() {
    return this.get<OcsResponse<UsersDetails>>("/ocs/v2.php/cloud/users/details");
  }

  /** Talk autocomplete for user candidates — resolves display names without admin rights. */
  autocompleteUsers(search: string) {
    const q = new URLSearchParams({ search, itemType: "users" });
    return this.get<OcsResponse<AutocompleteResult[]>>(
      `/ocs/v2.php/apps/spreed/api/v4/core/autocomplete?${q}`,
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
}

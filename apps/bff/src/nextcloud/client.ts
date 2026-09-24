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
}

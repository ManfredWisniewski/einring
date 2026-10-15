import { config } from "@/config";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`API ${status}`);
  }
}

export type TokenProvider = () => Promise<string | null>;

export function createApi(getToken: TokenProvider) {
  async function request<T>(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const token = await getToken();
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const res = await fetch(`${config.apiUrl}/api${path}`, { ...init, headers, signal });
    if (res.status === 204) return undefined as T;
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, body);
    return body as T;
  }
  return {
    get: <T>(path: string, signal?: AbortSignal) => request<T>(path, {}, signal),
    post: <T>(path: string, body?: unknown) =>
      request<T>(path, {
        method: "POST",
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
      }),
    delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  };
}

export type Api = ReturnType<typeof createApi>;

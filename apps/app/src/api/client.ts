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
    /** Binary GET — authenticated blob fetch (einmusic playback, D48). */
    blob: async (path: string) => {
      const token = await getToken();
      const headers = new Headers();
      if (token) headers.set("Authorization", `Bearer ${token}`);
      const res = await fetch(`${config.apiUrl}/api${path}`, { headers });
      if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
      return res.blob();
    },
    /** Raw-body upload — the file bytes are the request body (einmusic D48, eindav D54). */
    upload: async <T>(path: string, file: Blob, method: "POST" | "PUT" = "POST") => {
      const token = await getToken();
      const headers = new Headers({ "Content-Type": "application/octet-stream" });
      if (token) headers.set("Authorization", `Bearer ${token}`);
      const res = await fetch(`${config.apiUrl}/api${path}`, {
        method,
        headers,
        body: file,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new ApiError(res.status, body);
      return body as T;
    },
    post: <T>(path: string, body?: unknown) =>
      request<T>(path, {
        method: "POST",
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
      }),
    put: <T>(path: string, body?: unknown) =>
      request<T>(path, {
        method: "PUT",
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
      }),
    patch: <T>(path: string, body?: unknown) =>
      request<T>(path, {
        method: "PATCH",
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
      }),
    delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  };
}

export type Api = ReturnType<typeof createApi>;

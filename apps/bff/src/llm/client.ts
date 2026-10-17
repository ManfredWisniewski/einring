import type { Fetch } from "../nextcloud/client.js";

export class LlmError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * OpenAI-compatible `/v1` client — covers OpenRouter and every local alternative
 * (llama-server, LM Studio, Ollama's `/v1`). `apiKey` is optional: local servers
 * ignore the Bearer header.
 */
export class LlmClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: Fetch = fetch,
    private readonly timeoutMs = 60_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "einring",
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new LlmError(res.status, `POST ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  /** One non-streaming chat completion; returns the first choice's content. */
  async chat(model: string, messages: ChatMessage[]): Promise<string> {
    const data = await this.post<{ choices?: { message?: { content?: unknown } }[] }>(
      "/chat/completions",
      { model, messages, stream: false },
    );
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new LlmError(200, "chat completion returned no content");
    }
    return content;
  }

  /** Embeds a batch; returns one vector per input, restored to input order. */
  async embed(model: string, input: string[]): Promise<number[][]> {
    const data = await this.post<{ data?: { embedding?: number[]; index?: number }[] }>(
      "/embeddings",
      { model, input },
    );
    const rows = data.data ?? [];
    const out = new Array<number[] | undefined>(input.length);
    rows.forEach((row, i) => {
      const idx = typeof row.index === "number" ? row.index : i;
      if (Array.isArray(row.embedding) && idx >= 0 && idx < out.length) {
        out[idx] = row.embedding;
      }
    });
    if (out.some((v) => !v?.length)) {
      throw new LlmError(200, "embeddings response does not cover all inputs");
    }
    return out as number[][];
  }
}

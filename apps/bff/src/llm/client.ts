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
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Assistant message: tool calls the model wants executed. */
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  /** Tool message: the call id this result answers. */
  tool_call_id?: string;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatToolsResult {
  /** The assistant message verbatim — append it to history before tool results. */
  message: ChatMessage;
  content: string | null;
  toolCalls: ToolCallRequest[];
}

/** Resolved shared LLM config (D41) — null when URL or a needed model is unset. */
export interface LlmService {
  client: LlmClient;
  chatModel: string;
  embedModel: string;
  topK: number;
}

export function createLlmService(
  config: {
    LLM_URL?: string;
    LLM_API_KEY?: string;
    LLM_CHAT_MODEL?: string;
    LLM_EMBED_MODEL?: string;
    LLM_TOP_K?: number;
    LLM_TIMEOUT_S?: number;
  },
  fetchImpl: Fetch = fetch,
): LlmService | null {
  if (!config.LLM_URL || !config.LLM_CHAT_MODEL || !config.LLM_EMBED_MODEL) return null;
  return {
    client: new LlmClient(
      config.LLM_URL,
      config.LLM_API_KEY,
      fetchImpl,
      (config.LLM_TIMEOUT_S ?? 60) * 1000,
    ),
    chatModel: config.LLM_CHAT_MODEL,
    embedModel: config.LLM_EMBED_MODEL,
    topK: config.LLM_TOP_K ?? 8,
  };
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

  /**
   * One non-streaming chat completion with function tools. Returns the raw
   * assistant message plus parsed `tool_calls` — the caller drives the loop.
   */
  async chatWithTools(
    model: string,
    messages: ChatMessage[],
    tools: { name: string; description: string; parameters: unknown }[],
  ): Promise<ChatToolsResult> {
    const data = await this.post<{ choices?: { message?: ChatMessage }[] }>("/chat/completions", {
      model,
      messages,
      stream: false,
      ...(tools.length > 0
        ? {
            tools: tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    });
    const message = data.choices?.[0]?.message ?? { role: "assistant" as const, content: "" };
    const toolCalls = (message.tool_calls ?? []).flatMap((tc) => {
      if (!tc.id || !tc.function?.name) return [];
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(tc.function.arguments ?? "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        /* malformed args -> {} */
      }
      return [{ id: tc.id, name: tc.function.name, arguments: args }];
    });
    return {
      message,
      content: typeof message.content === "string" ? message.content : null,
      toolCalls,
    };
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

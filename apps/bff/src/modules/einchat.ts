import { z } from "zod";
import type { AppContext } from "../app.js";
import type { ChatMessage } from "../llm/client.js";
import { makeRateLimiter } from "../rate-limit.js";
import type { BffModule, ChatTool } from "./types.js";

/** Safety cap on the tool-call loop — a model that never stops gets cut off. */
const MAX_TOOL_ITERATIONS = 5;
const messageLimit = makeRateLimiter(20, 60_000);

const SYSTEM_PROMPT = `You are EinChat, an assistant inside the Einring app (personal data field companion).
You can call tools exposed by the user's connected modules — use them whenever they
can answer part of the question, and never invent data a tool could provide.
Reply concisely in the user's language. When a tool reports not_connected, tell the
user to connect that service in the corresponding module first.`;

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(20_000),
});
const bodySchema = z.object({
  messages: z.array(messageSchema).min(1).max(100),
});
const toolsBodySchema = z.object({
  disabled: z.array(z.string().min(1).max(100)).max(200),
});

interface CollectedTool {
  module: string;
  tool: ChatTool;
}

/** Collects chatTools from all enabled modules (D41). */
function collectTools(ctx: AppContext): CollectedTool[] {
  const tools: CollectedTool[] = [];
  for (const { module, config } of ctx.modules) {
    if (module.id === "einchat" || !module.chatTools) continue;
    for (const tool of module.chatTools(ctx, config)) tools.push({ module: module.id, tool });
  }
  return tools;
}

/** Per-user disabled-tool set, stored as JSON in module_settings (D41). */
function disabledTools(ctx: AppContext, sub: string): Set<string> {
  const raw = ctx.store.getModuleSettings(sub, "einchat");
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    const disabled = (parsed as { disabled?: unknown }).disabled;
    return new Set(Array.isArray(disabled) ? disabled.filter((d) => typeof d === "string") : []);
  } catch {
    return new Set();
  }
}

export const einchatModule: BffModule = {
  id: "einchat",
  register(api, ctx) {
    const llm = ctx.llm;
    const collected = collectTools(ctx);

    api.get("/status", async (req) => {
      const off = disabledTools(ctx, req.user.sub);
      return {
        configured: llm !== null,
        tools: collected.filter((c) => !off.has(c.tool.name)).map((c) => c.tool.name),
      };
    });

    /** All collected tools with per-user enabled flags — drives the connections UI. */
    api.get("/tools", async (req) => {
      const off = disabledTools(ctx, req.user.sub);
      return {
        tools: collected.map((c) => ({
          name: c.tool.name,
          module: c.module,
          enabled: !off.has(c.tool.name),
        })),
      };
    });

    api.put("/tools", async (req, reply) => {
      const parsed = toolsBodySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "expected {disabled: string[]}" });
      ctx.store.saveModuleSettings(
        req.user.sub,
        "einchat",
        JSON.stringify({ disabled: parsed.data.disabled }),
      );
      return { disabled: parsed.data.disabled };
    });

    api.post("/message", async (req, reply) => {
      if (!llm) return reply.code(424).send({ error: "llm not configured" });
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "expected {messages: [{role, content}]}" });
      }
      const sub = req.user.sub;
      if (!messageLimit.allow(sub)) {
        return reply.code(429).send({ error: "too many requests" });
      }
      const off = disabledTools(ctx, sub);
      const active = collected.filter((c) => !off.has(c.tool.name));
      const byName = new Map(active.map((c) => [c.tool.name, c.tool]));
      const toolDefs = active.map(({ tool }) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...parsed.data.messages,
      ];

      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        const res = await llm.client.chatWithTools(llm.chatModel, messages, toolDefs);
        if (res.toolCalls.length === 0) {
          return { reply: res.content ?? "" };
        }
        // Echo the assistant turn (with tool_calls), then one tool message each.
        messages.push(res.message);
        for (const tc of res.toolCalls) {
          const tool = byName.get(tc.name);
          let out: unknown;
          try {
            out = tool ? await tool.call(tc.arguments, sub, req.user) : { error: "unknown_tool" };
          } catch (e) {
            req.log.warn({ err: e, tool: tc.name }, "chat tool call failed");
            out = { error: "tool_failed" };
          }
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(out),
          });
        }
      }
      // Cap hit: one last call without tools so the model sums up what it got.
      const final = await llm.client.chat(llm.chatModel, [
        ...messages,
        { role: "user", content: "Summarize what you found so far." },
      ]);
      return { reply: final };
    });
  },
};

import { createHash, randomBytes } from "node:crypto";
import { Ajv, type ValidateFunction } from "ajv";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { hashToken } from "../auth.js";
import { makeRateLimiter } from "../rate-limit.js";
import { collectTools, disabledTools } from "./chat-tools.js";
import type { BffModule } from "./types.js";

const MCP_PROTOCOL_VERSION = "2025-11-25";
const rpcLimit = makeRateLimiter(60, 60_000);
const createTokenSchema = z.object({ label: z.string().max(100).optional() });

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const rpcResult = (id: JsonRpcRequest["id"], result: unknown) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  result,
});
const rpcError = (id: JsonRpcRequest["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

export const einchatMcpModule: BffModule = {
  id: "einchat-mcp",
  register(api, ctx) {
    api.get("/tokens", async (req) => ({ tokens: ctx.store.listMcpTokens(req.user.sub) }));

    api.post("/tokens", async (req, reply) => {
      const parsed = createTokenSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "expected {label?: string}" });
      const token = randomBytes(32).toString("base64url");
      const tokenHash = hashToken(token);
      const label = parsed.data.label ?? "";
      ctx.store.createMcpToken(req.user.sub, tokenHash, label);
      const row = ctx.store.listMcpTokens(req.user.sub).find((t) => t.tokenHash === tokenHash);
      // The plaintext token is returned exactly once — the store keeps only its hash.
      return { token, tokenHash, label, createdAt: row?.createdAt };
    });

    api.delete("/tokens/:hash", async (req, reply) => {
      const { hash } = req.params as { hash: string };
      if (!/^[a-f0-9]{64}$/i.test(hash))
        return reply.code(400).send({ error: "invalid token hash" });
      if (!ctx.store.revokeMcpToken(req.user.sub, hash)) {
        return reply.code(404).send({ error: "token not found" });
      }
      return { revoked: true };
    });
  },
};

/**
 * The MCP surface (spec einchat-mcp): stateless tools-only JSON-RPC over
 * Streamable HTTP. Mounted in a dedicated scope gated by `verifyMcpToken` —
 * NOT inside the shared Authentik scope, so MCP tokens authenticate this
 * endpoint only. No session lifecycle, no resources/prompts/sampling.
 */
export function registerMcpEndpoint(api: FastifyInstance, ctx: AppContext): void {
  const collected = collectTools(ctx);
  const ajv = new Ajv({ allErrors: false, strict: false });
  const validators = new Map<string, ValidateFunction>();
  for (const c of collected) {
    try {
      validators.set(c.tool.name, ajv.compile(c.tool.parameters ?? { type: "object" }));
    } catch {
      /* un-compilable schema — the tool runs unvalidated, same as EinChat */
    }
  }

  api.get("/mcp", async (_req, reply) => reply.code(405).send({ error: "method not allowed" }));

  api.post("/mcp", async (req, reply) => {
    const sub = req.user.sub;
    if (!rpcLimit.allow(sub)) return reply.code(429).send({ error: "too many requests" });
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply.send(rpcError(null, -32600, "invalid request"));
    }
    const { id, method, params } = body as JsonRpcRequest;
    if (id === undefined) return reply.code(202).send();
    if (typeof method !== "string") return reply.send(rpcError(id, -32600, "invalid request"));

    const off = disabledTools(ctx, sub);
    const active = collected.filter((c) => !off.has(c.tool.name));

    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        return reply.send(
          rpcResult(id, {
            protocolVersion: typeof requested === "string" ? requested : MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "einring-einchat-mcp", version: "1.0.0" },
          }),
        );
      }
      case "ping":
        return reply.send(rpcResult(id, {}));
      case "tools/list":
        return reply.send(
          rpcResult(id, {
            tools: active.map((c) => ({
              name: c.tool.name,
              description: c.tool.description,
              inputSchema: c.tool.parameters,
            })),
          }),
        );
      case "tools/call": {
        const name = params?.name;
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        const argHash = createHash("sha256").update(JSON.stringify(args)).digest("hex");
        const tool = active.find((c) => c.tool.name === name)?.tool;
        if (!tool) {
          req.log.info({ sub, tool: name, argHash, status: "unknown_tool" }, "mcp tools/call");
          return reply.send(rpcError(id, -32602, `unknown tool: ${String(name)}`));
        }
        const validate = validators.get(tool.name);
        if (validate && !validate(args)) {
          req.log.info({ sub, tool: name, argHash, status: "invalid_args" }, "mcp tools/call");
          return reply.send(
            rpcError(id, -32602, `invalid arguments: ${ajv.errorsText(validate.errors)}`),
          );
        }
        try {
          const out = await tool.call(args, sub, req.user);
          req.log.info({ sub, tool: name, argHash, status: "ok" }, "mcp tools/call");
          const result: Record<string, unknown> = {
            content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }],
          };
          if (out && typeof out === "object") result.structuredContent = out;
          return reply.send(rpcResult(id, result));
        } catch (err) {
          req.log.warn({ err, sub, tool: name, argHash, status: "error" }, "mcp tools/call");
          return reply.send(
            rpcResult(id, {
              content: [{ type: "text", text: "tool_failed" }],
              isError: true,
            }),
          );
        }
      }
      default:
        return reply.send(rpcError(id, -32601, "method not found"));
    }
  });
}

import { describe, expect, it } from "vitest";
import { testApp } from "../test-utils.js";

interface TokenBody {
  token: string;
  tokenHash: string;
  label: string;
}

async function createToken(
  app: Awaited<ReturnType<typeof testApp>>["app"],
  auth: Record<string, string>,
  label = "devin",
): Promise<TokenBody> {
  const res = await app.inject({
    method: "POST",
    url: "/api/einchat-mcp/tokens",
    headers: auth,
    payload: { label },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as TokenBody;
}

const rpc = (
  app: Awaited<ReturnType<typeof testApp>>["app"],
  token: string,
  payload: Record<string, unknown>,
) =>
  app.inject({
    method: "POST",
    url: "/api/einchat-mcp/mcp",
    headers: { authorization: `Bearer ${token}` },
    payload,
  });

describe("einchat-mcp", () => {
  it("requires auth on the token routes", async () => {
    const { app } = await testApp();
    expect((await app.inject({ method: "GET", url: "/api/einchat-mcp/tokens" })).statusCode).toBe(
      401,
    );
    expect((await app.inject({ method: "POST", url: "/api/einchat-mcp/tokens" })).statusCode).toBe(
      401,
    );
  });

  it("creates, lists and revokes tokens — listing exposes only the hash", async () => {
    const { app, auth } = await testApp();
    const created = await createToken(app, auth);
    expect(created.token).toBeTruthy();
    expect(created.label).toBe("devin");
    expect(created.tokenHash).toMatch(/^[a-f0-9]{64}$/);

    const listed = (
      await app.inject({ method: "GET", url: "/api/einchat-mcp/tokens", headers: auth })
    ).json() as { tokens: { tokenHash: string; label: string; revokedAt?: string | null }[] };
    expect(listed.tokens).toHaveLength(1);
    expect(listed.tokens.map((t) => t.tokenHash)).toEqual([created.tokenHash]);
    expect(listed.tokens.every((t) => !t.revokedAt)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(created.token);

    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/einchat-mcp/tokens/${created.tokenHash}`,
      headers: auth,
    });
    expect(revoked.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/einchat-mcp/tokens/${created.tokenHash}`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("answers 405 on GET /mcp and 401 without a token", async () => {
    const { app, auth } = await testApp();
    const token = (await createToken(app, auth)).token;
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/einchat-mcp/mcp",
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(405);
    expect((await rpc(app, "nope", { jsonrpc: "2.0", id: 1, method: "ping" })).statusCode).toBe(
      401,
    );
  });

  it("runs the handshake: initialize, notifications/initialized, ping", async () => {
    const { app, auth } = await testApp();
    const token = (await createToken(app, auth)).token;

    const init = await rpc(app, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "devin", version: "1" },
      },
    });
    const initBody = init.json() as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(initBody.result.protocolVersion).toBe("2025-11-25");
    expect(initBody.result.serverInfo.name).toBe("einring-einchat-mcp");

    const notif = await rpc(app, token, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notif.statusCode).toBe(202);

    const pong = (await rpc(app, token, { jsonrpc: "2.0", id: 2, method: "ping" })).json() as {
      result: unknown;
    };
    expect(pong.result).toEqual({});
  });

  it("lists tools and rejects unknown tools/methods per JSON-RPC", async () => {
    const { app, auth } = await testApp();
    const token = (await createToken(app, auth)).token;

    const list = (
      await rpc(app, token, { jsonrpc: "2.0", id: 1, method: "tools/list" })
    ).json() as {
      result: { tools: { name: string; inputSchema: unknown }[] };
    };
    expect(Array.isArray(list.result.tools)).toBe(true);
    for (const t of list.result.tools) expect(t.inputSchema).toBeTruthy();

    const badTool = (
      await rpc(app, token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "no_such_tool", arguments: {} },
      })
    ).json() as { error: { code: number } };
    expect(badTool.error.code).toBe(-32602);

    const badMethod = (
      await rpc(app, token, { jsonrpc: "2.0", id: 3, method: "resources/list" })
    ).json() as { error: { code: number } };
    expect(badMethod.error.code).toBe(-32601);
  });

  it("executes tools/call and validates arguments against the tool schema", async () => {
    const { app, auth } = await testApp();
    const token = (await createToken(app, auth)).token;

    const call = (
      await rpc(app, token, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "einhub_notifications", arguments: { limit: 5 } },
      })
    ).json() as {
      result: { content: { type: string }[]; structuredContent?: { notifications: unknown[] } };
    };
    expect(call.result.content[0]?.type).toBe("text");
    expect(Array.isArray(call.result.structuredContent?.notifications)).toBe(true);

    const invalid = (
      await rpc(app, token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "einhub_notifications", arguments: { limit: "five" } },
      })
    ).json() as { error: { code: number; message: string } };
    expect(invalid.error.code).toBe(-32602);
    expect(invalid.error.message).toContain("invalid arguments");
  });

  it("refuses tools the user disabled in EinChat", async () => {
    const { app, auth } = await testApp();
    const token = (await createToken(app, auth)).token;

    const res = await app.inject({
      method: "PUT",
      url: "/api/einchat/tools",
      headers: auth,
      payload: { disabled: ["einhub_notifications"] },
    });
    expect(res.statusCode).toBe(200);

    const list = (await rpc(app, token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json() as {
      result: { tools: { name: string }[] };
    };
    expect(list.result.tools.map((t) => t.name)).not.toContain("einhub_notifications");

    const call = (
      await rpc(app, token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "einhub_notifications", arguments: {} },
      })
    ).json() as { error: { code: number } };
    expect(call.error.code).toBe(-32602);
  });

  it("keeps MCP tokens off the full API and Authentik tokens off /mcp", async () => {
    const { app, auth } = await testApp();
    const token = (await createToken(app, auth)).token;

    // Least privilege: the MCP token must not authenticate against the shared scope.
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/me",
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(401);

    // And the session token must not authenticate against the MCP scope.
    const res = await rpc(app, "valid-token", { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects revoked tokens with 401", async () => {
    const { app, auth } = await testApp();
    const created = await createToken(app, auth);
    await app.inject({
      method: "DELETE",
      url: `/api/einchat-mcp/tokens/${created.tokenHash}`,
      headers: auth,
    });
    expect(
      (await rpc(app, created.token, { jsonrpc: "2.0", id: 1, method: "ping" })).statusCode,
    ).toBe(401);
  });
});

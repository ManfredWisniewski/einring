import type { AppContext } from "../app.js";
import type { ChatTool } from "./types.js";

export interface CollectedTool {
  module: string;
  tool: ChatTool;
}

/** Collects chatTools from all enabled modules (D41) — shared by einchat and einchat-mcp. */
export function collectTools(ctx: AppContext): CollectedTool[] {
  const tools: CollectedTool[] = [];
  for (const { module, config } of ctx.modules) {
    if (module.id === "einchat" || !module.chatTools) continue;
    for (const tool of module.chatTools(ctx, config)) tools.push({ module: module.id, tool });
  }
  return tools;
}

/** Per-user disabled-tool set, stored as JSON in module_settings (D41). */
export function disabledTools(ctx: AppContext, sub: string): Set<string> {
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

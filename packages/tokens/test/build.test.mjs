import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("tokens build produces light and dark variable sets", () => {
  execFileSync(process.execPath, ["build.mjs"], { cwd: root, stdio: "pipe" });
  const css = readFileSync(resolve(root, "build/css/tokens.css"), "utf8");
  assert.match(css, /:root,\s*\[data-theme="light"\]\s*\{/);
  assert.match(css, /\[data-theme="dark"\]\s*\{/);
  assert.match(css, /--surface-base:\s*var\(--color-neutral-50\);/);
  assert.match(css, /--space-4:\s*1rem;/);
  assert.match(css, /--duration-fast:\s*120ms;/);
  assert.match(css, /--font-family-sans:[^;]*\bInter\b/);
  assert.equal((css.match(/--surface-base:/g) ?? []).length, 2, "semantic token in both themes");
  assert.equal((css.match(/--color-neutral-0:/g) ?? []).length, 1, "primitives only once");
});

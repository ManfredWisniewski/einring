import { defineConfig } from "@terrazzo/cli";
import css from "@terrazzo/plugin-css";

/** `--font-size-lg` style names; token ids are the public API, do not rename casually. */
const kebab = (segment) => segment.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const variableName = (token) => `--${token.id.split(".").map(kebab).join("-")}`;

const block = (selectors, scheme) => (contents) =>
  `${selectors} {\n  color-scheme: ${scheme};\n  ${contents}\n}\n`;

/** Primitive roots — emitted once in the light `:root` file, excluded from the dark overrides. */
const PRIMITIVES = [
  "color.**",
  "chart.**",
  "font-size.**",
  "letter-spacing.**",
  "spacing.**",
  "border-radius.**",
  "box-shadow.**",
  "motion.**",
  "space.**",
  "radius.**",
  "font-family.**",
  "font-weight.**",
  "line-height.**",
  "duration.**",
];

export default defineConfig({
  tokens: ["./einring-tokens.resolver.json"],
  outDir: "./build/css/",
  plugins: [
    css({
      filename: "light.css",
      legacyHex: true,
      variableName,
      permutations: [
        {
          input: { theme: "light" },
          prepare: block(':root,\n[data-theme="light"]', "light"),
        },
      ],
    }),
    css({
      filename: "dark.css",
      legacyHex: true,
      variableName,
      permutations: [
        {
          input: { theme: "dark" },
          prepare: block('[data-theme="dark"]', "dark"),
          exclude: PRIMITIVES,
        },
      ],
    }),
  ],
});

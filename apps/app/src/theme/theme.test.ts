import { applyTheme, readPreference, resolveTheme } from "./theme";

describe("theme", () => {
  it("falls back to system for unknown stored values", () => {
    expect(readPreference({ getItem: () => null })).toBe("system");
    expect(readPreference({ getItem: () => "purple" })).toBe("system");
    expect(readPreference({ getItem: () => "dark" })).toBe("dark");
  });

  it("resolves system preference, explicit choices win", () => {
    expect(resolveTheme("system", "dark")).toBe("dark");
    expect(resolveTheme("light", "dark")).toBe("light");
    expect(resolveTheme("dark", "light")).toBe("dark");
  });

  it("applies the theme as data attribute", () => {
    const el = document.createElement("div");
    applyTheme("dark", el);
    expect(el.dataset.theme).toBe("dark");
  });
});

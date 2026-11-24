import { type AppConfigPlugin, initManagedConfig, normalizeManagedUrl } from "./appconfig";
import { config } from "./config";

const plugin = (value: string | null): AppConfigPlugin => ({
  getApiUrl: async () => ({ value }),
});

describe("appconfig managed configuration (A50)", () => {
  const original = config.apiUrl;
  afterEach(() => {
    config.apiUrl = original;
  });

  it("normalizes managed URLs: scheme-less gets https, scheme kept, slashes stripped", () => {
    expect(normalizeManagedUrl("einring.example.com")).toBe("https://einring.example.com");
    expect(normalizeManagedUrl("http://10.0.2.2:3000")).toBe("http://10.0.2.2:3000");
    expect(normalizeManagedUrl("https://host.tld/")).toBe("https://host.tld");
    expect(normalizeManagedUrl("  ")).toBe("");
  });

  it("a pushed URL overrides the baked VITE_API_URL", async () => {
    await initManagedConfig(plugin("einring.example.com"));
    expect(config.apiUrl).toBe("https://einring.example.com");
  });

  it("absent or blank values keep the build default", async () => {
    config.apiUrl = "https://baked.example.com";
    await initManagedConfig(plugin(null));
    await initManagedConfig(plugin("   "));
    await initManagedConfig(null);
    expect(config.apiUrl).toBe("https://baked.example.com");
  });

  it("a failing plugin keeps the build default", async () => {
    config.apiUrl = "https://baked.example.com";
    await initManagedConfig({
      getApiUrl: async () => {
        throw new Error("not available");
      },
    });
    expect(config.apiUrl).toBe("https://baked.example.com");
  });
});

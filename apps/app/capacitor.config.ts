import type { CapacitorConfig } from "@capacitor/cli";

// CAP_SERVER_URL=http://192.168.x.y:5173 pnpm cap sync android  -> live-reload from the Vite dev server on a device.
// Leave it unset for builds that bundle `dist/`.
const devServerUrl = process.env.CAP_SERVER_URL;

const config: CapacitorConfig = {
  appId: "de.wit.einring",
  appName: "Einring",
  webDir: "dist",
  server: {
    androidScheme: "https",
    ...(devServerUrl ? { url: devServerUrl, cleartext: devServerUrl.startsWith("http:") } : {}),
  },
  android: { allowMixedContent: false },
};

export default config;

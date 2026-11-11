import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 45_000,
  use: {
    baseURL: process.env.BROWSER_BASE_URL || "http://127.0.0.1:3100",
    browserName: "chromium",
    permissions: ["camera", "microphone"],
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
  },
  webServer: process.env.BROWSER_BASE_URL ? undefined : {
    command: "npm start",
    env: { PORT: "3100", ICE_SERVERS: "[]", TOKEN_MINT: "" },
    url: "http://127.0.0.1:3100/healthz",
    timeout: 15_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  },
});

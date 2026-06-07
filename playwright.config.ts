import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry"
  },
  webServer: [
    {
      command: "npm --workspace @vox/api run dev",
      url: "http://localhost:8787/health",
      reuseExistingServer: true,
      timeout: 60_000,
      env: { VOX_PROVIDER_MODE: "mock" }
    },
    {
      command: "npm --workspace @vox/web run dev",
      url: "http://localhost:3000/specialist",
      reuseExistingServer: true,
      timeout: 60_000,
      env: { NEXT_PUBLIC_API_URL: "http://localhost:8787" }
    }
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "Mobile Chrome", use: { ...devices["Pixel 5"] } }
  ]
});

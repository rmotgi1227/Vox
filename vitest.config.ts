import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  },
  resolve: {
    alias: {
      "@vox/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      "@vox/agent-core": new URL("./packages/agent-core/src/index.ts", import.meta.url).pathname,
      "@vox/ai": new URL("./packages/ai/src/index.ts", import.meta.url).pathname
    }
  }
});

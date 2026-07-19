import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.{ts,mjs}", "apps/**/*.test.{ts,tsx,mjs}"],
    coverage: { reporter: ["text", "html"] }
  }
});

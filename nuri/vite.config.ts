import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  server: { port: 5178 },
  preview: { port: 5178 },
  test: { environment: "node" },
});

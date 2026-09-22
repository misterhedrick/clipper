import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // DB tests share one database; run files serially so they don't trample each other.
    fileParallelism: false,
  },
});

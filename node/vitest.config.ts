import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests build the Go dsh binary and drive real sandbox
    // executions (sleep timeouts), so give them generous budgets.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // One shared dsh server per file; files run sequentially to avoid
    // interleaved `go build` invocations racing on the same output path.
    fileParallelism: false,
  },
});

// Generous timeout: each test applies the full migration set against a fresh
// schema, which is comfortably fast on a healthy Postgres but shouldn't flake.
const proc = Bun.spawn([process.execPath, "test", "tests/api-live.test.ts", "--timeout", "20000"], {
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    RUN_LIVE_API_TESTS: "true",
  },
});

process.exit(await proc.exited);

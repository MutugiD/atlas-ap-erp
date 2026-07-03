const proc = Bun.spawn([process.execPath, "test", "tests/api-live.test.ts"], {
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    RUN_LIVE_API_TESTS: "true",
  },
});

process.exit(await proc.exited);

const proc = Bun.spawn([process.execPath, "test", "tests/support-live.test.ts"], {
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    RUN_LIVE_SUPPORT_TESTS: "true",
  },
});

process.exit(await proc.exited);

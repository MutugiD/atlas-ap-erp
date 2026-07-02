import { existsSync, readFileSync } from "node:fs";

const requiredFiles = [
  "docs/support-agent-v2-slo.md",
  "docs/support-agent-v2-release-checklist.md",
  "reports/support-agent-v2-load-smoke.md",
  "ops/grafana/support-agent-dashboard.json",
  "ops/alerts/support-agent-alerts.yml",
  "tests/load/support-agent-k6.js",
  "tests/support-live.test.ts",
];

const failures: string[] = [];
for (const file of requiredFiles) {
  if (!existsSync(file)) failures.push(`${file} is missing`);
}

const checklist = readFileSync("docs/support-agent-v2-release-checklist.md", "utf8");
for (const gate of ["license:audit", "test:live-support", "p95 under 400ms", "Cross-tenant isolation"]) {
  if (!checklist.includes(gate)) failures.push(`release checklist must mention ${gate}`);
}

const slo = readFileSync("docs/support-agent-v2-slo.md", "utf8");
for (const term of ["99.5%", "216 minutes", "APP_ROLE=web", "APP_ROLE=worker", "Rollback"]) {
  if (!slo.includes(term)) failures.push(`SLO doc must mention ${term}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`release check failure: ${failure}`);
  process.exit(1);
}

console.log("support release check passed");

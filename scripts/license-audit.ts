import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const banned = ["AGPL", "GPL-", "GPLv", "LGPL", "SSPL", "BUSL"];
const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { license?: string };
const failures: string[] = [];
const warnings: string[] = [];

if (rootPackage.license !== "Apache-2.0") failures.push("root package.json must declare Apache-2.0");
if (!readFileSync(join(root, "LICENSE"), "utf8").includes("Apache License")) failures.push("LICENSE must contain Apache-2.0 text");
if (!readFileSync(join(root, "NOTICE"), "utf8").includes("Support Agent V2")) failures.push("NOTICE must mention Support Agent V2");

for (const source of ["apps/support-agent/src/admin.ts", "apps/support-agent/src/observability.ts"]) {
  if (!readFileSync(join(root, source), "utf8").startsWith("// SPDX-License-Identifier: Apache-2.0")) {
    failures.push(`${source} must include SPDX-License-Identifier: Apache-2.0`);
  }
}

const nodeModules = join(root, "node_modules");
if (existsSync(nodeModules)) {
  for (const packageDir of listPackageDirs(nodeModules)) {
    const pkgPath = join(packageDir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; license?: string; licenses?: unknown };
    const license = String(pkg.license ?? pkg.licenses ?? "");
    if (!license) {
      warnings.push(`${pkg.name ?? packageDir} has no machine-readable license`);
      continue;
    }
    if (banned.some((token) => license.toUpperCase().includes(token))) {
      failures.push(`${pkg.name ?? packageDir} uses blocked license ${license}`);
    }
  }
}

for (const warning of warnings.slice(0, 20)) console.warn(`license warning: ${warning}`);
if (warnings.length > 20) console.warn(`license warning: ${warnings.length - 20} more packages had no machine-readable license`);

if (failures.length > 0) {
  for (const failure of failures) console.error(`license failure: ${failure}`);
  process.exit(1);
}

console.log("license audit passed");

function listPackageDirs(base: string) {
  const dirs: string[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const full = join(base, entry.name);
    if (entry.name.startsWith("@")) {
      for (const scoped of readdirSync(full, { withFileTypes: true })) {
        if (scoped.isDirectory()) dirs.push(join(full, scoped.name));
      }
    } else {
      dirs.push(full);
    }
  }
  return dirs;
}

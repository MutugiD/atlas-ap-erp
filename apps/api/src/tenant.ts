import { createMiddleware } from "hono/factory";
import { tenantContextSchema, type TenantContext } from "@atlas/contracts";

declare module "hono" {
  interface ContextVariableMap {
    tenant: TenantContext;
  }
}

export const withTenant = createMiddleware(async (c, next) => {
  const fallbackTenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const fallbackUser = "22222222-2222-4222-8222-222222222222";
  const tenant = tenantContextSchema.parse({
    tenantId: c.req.header("x-tenant-id") ?? fallbackTenant,
    userId: c.req.header("x-user-id") ?? fallbackUser,
    role: c.req.header("x-user-role") ?? "ap_clerk",
  });
  c.set("tenant", tenant);
  await next();
});

export function setTenantSql(tenantId: string): string {
  return `select set_config('app.tenant_id', '${tenantId}', true)`;
}


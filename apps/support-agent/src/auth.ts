import type { FastifyReply, FastifyRequest } from "fastify";
import { orgContextSchema, type OrgContext } from "@atlas/support-contracts";

declare module "fastify" {
  interface FastifyRequest {
    org: OrgContext;
  }
}

export async function authenticate(request: FastifyRequest, _reply: FastifyReply) {
  request.org = orgContextSchema.parse({
    orgId: request.headers["x-org-id"] ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    principalId: request.headers["x-principal-id"] ?? "support-agent-demo",
    role: request.headers["x-role"] ?? "admin",
    authType: request.headers["x-api-key"] ? "api_key" : "jwt",
  });
}

export function setOrgSql(orgId: string): string {
  return `select set_config('app.org_id', '${orgId}', true)`;
}


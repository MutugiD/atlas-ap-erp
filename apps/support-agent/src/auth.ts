import type { FastifyReply, FastifyRequest } from "fastify";
import { orgContextSchema, type OrgContext } from "@atlas/support-contracts";
import { createRemoteJWKSet, jwtVerify } from "jose";

declare module "fastify" {
  interface FastifyRequest {
    org: OrgContext;
  }
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const apiKey = request.headers["x-api-key"];
  if (apiKey && process.env.SUPPORT_API_KEY && apiKey === process.env.SUPPORT_API_KEY) {
    request.org = orgContextSchema.parse({
      orgId: request.headers["x-org-id"] ?? process.env.DEFAULT_ORG_ID ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      principalId: request.headers["x-principal-id"] ?? "api-key-client",
      role: request.headers["x-role"] ?? "service",
      authType: "api_key",
    });
    return;
  }

  const auth = request.headers.authorization;
  if (process.env.AUTH_JWT_SECRET && auth?.startsWith("Bearer ")) {
    const secret = new TextEncoder().encode(process.env.AUTH_JWT_SECRET);
    const { payload } = await jwtVerify(auth.slice("Bearer ".length), secret);
    request.org = orgContextSchema.parse({
      orgId: payload.org_id,
      principalId: payload.sub,
      role: payload.role ?? "agent",
      authType: "jwt",
    });
    return;
  }

  if (process.env.AUTH_JWKS_URL && auth?.startsWith("Bearer ")) {
    const jwks = createRemoteJWKSet(new URL(process.env.AUTH_JWKS_URL));
    const { payload } = await jwtVerify(auth.slice("Bearer ".length), jwks, {
      audience: process.env.AUTH_JWT_AUDIENCE,
      issuer: process.env.AUTH_JWT_ISSUER,
    });
    request.org = orgContextSchema.parse({
      orgId: payload.org_id,
      principalId: payload.sub,
      role: payload.role ?? "agent",
      authType: "jwt",
    });
    return;
  }

  if (process.env.NODE_ENV === "production" || process.env.REQUIRE_AUTH === "true") {
    const error = new Error("Authentication required") as Error & { statusCode: number };
    error.statusCode = 401;
    throw error;
  }

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

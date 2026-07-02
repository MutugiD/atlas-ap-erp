// SPDX-License-Identifier: Apache-2.0

import {
  type ApiKeyCreate,
  type ApiKeyRecord,
  type AuditEvent,
  type DlqJob,
  type IngestInput,
  type OrgContext,
  type PiiRedactionEvent,
  type RichTimeline,
  type SupersessionGraph,
} from "@atlas/support-contracts";
import type { IngestQueue } from "./queue";

const now = () => new Date().toISOString();

export class AdminControlPlane {
  private readonly apiKeys: ApiKeyRecord[] = [];
  private readonly auditEvents: AuditEvent[] = [];
  private readonly piiEvents: PiiRedactionEvent[] = [];
  private readonly dlqJobs: DlqJob[] = [];

  async createApiKey(ctx: OrgContext, input: ApiKeyCreate) {
    const secret = `sk_sa_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
    const record: ApiKeyRecord = {
      id: crypto.randomUUID(),
      orgId: ctx.orgId,
      label: input.label,
      role: input.role,
      keyHash: await sha256(secret),
      createdAt: now(),
    };
    this.apiKeys.push(record);
    await this.audit(ctx, "api_key.created", "api_key", record.id, { label: input.label, role: input.role });
    return { apiKey: record, secret };
  }

  listApiKeys(ctx: OrgContext) {
    return this.apiKeys.filter((key) => key.orgId === ctx.orgId);
  }

  async revokeApiKey(ctx: OrgContext, id: string) {
    const key = this.apiKeys.find((candidate) => candidate.orgId === ctx.orgId && candidate.id === id);
    if (!key) return false;
    key.revokedAt = now();
    await this.audit(ctx, "api_key.revoked", "api_key", id, { label: key.label });
    return true;
  }

  recordPii(input: Omit<PiiRedactionEvent, "id" | "createdAt">) {
    this.piiEvents.push({ ...input, id: crypto.randomUUID(), createdAt: now() });
  }

  listPii(ctx: OrgContext, userId?: string) {
    return this.piiEvents.filter((event) => event.orgId === ctx.orgId && (!userId || event.userId === userId));
  }

  async audit(ctx: OrgContext, action: string, targetType: string, targetId?: string, metadata?: Record<string, unknown>) {
    const event: AuditEvent = {
      id: crypto.randomUUID(),
      orgId: ctx.orgId,
      actorId: ctx.principalId,
      action,
      targetType,
      targetId,
      metadata,
      createdAt: now(),
    };
    this.auditEvents.push(event);
    return event;
  }

  listAudit(ctx: OrgContext) {
    return this.auditEvents.filter((event) => event.orgId === ctx.orgId);
  }

  addDlq(input: Omit<DlqJob, "id" | "createdAt">) {
    const job: DlqJob = { ...input, id: crypto.randomUUID(), createdAt: now() };
    this.dlqJobs.push(job);
    return job;
  }

  listDlq(ctx: OrgContext) {
    return this.dlqJobs.filter((job) => job.orgId === ctx.orgId);
  }

  async replayDlq(ctx: OrgContext, jobId: string, queue: IngestQueue) {
    const job = this.dlqJobs.find((candidate) => candidate.orgId === ctx.orgId && candidate.id === jobId);
    if (!job) return null;
    const input: IngestInput = {
      orgId: job.orgId,
      userId: job.userId,
      convId: job.convId,
      sourceRole: "customer",
      message: job.message,
    };
    const result = await queue.enqueue(input);
    job.replayedAt = now();
    await this.audit(ctx, "dlq.replayed", "dlq_job", jobId, { result });
    return { job, result };
  }
}

export function buildSupersessionGraph(timeline: RichTimeline["facts"]): SupersessionGraph {
  const bySlot = new Map<string, RichTimeline["facts"]>();
  for (const fact of timeline) {
    const lane = bySlot.get(fact.slotKey) ?? [];
    lane.push(fact);
    bySlot.set(fact.slotKey, lane);
  }
  const lanes = [...bySlot.entries()].map(([slotKey, facts]) => ({
    slotKey,
    activeFactId: facts.find((fact) => fact.status === "active")?.id,
    nodes: facts.map((fact) => ({
      id: fact.id,
      label: fact.objectValue,
      status: fact.status,
      createdAt: fact.createdAt,
    })),
  }));
  const edges = timeline
    .filter((fact) => fact.supersedes)
    .map((fact) => ({ from: fact.supersedes as string, to: fact.id, label: "superseded_by" }));
  return { lanes, edges };
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

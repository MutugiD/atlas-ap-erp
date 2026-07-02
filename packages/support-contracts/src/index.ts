import { z } from "zod";

export const uuidSchema = z.string().uuid();

export const orgContextSchema = z.object({
  orgId: uuidSchema,
  principalId: z.string().min(1),
  role: z.enum(["agent", "admin", "service"]).default("agent"),
  authType: z.enum(["jwt", "api_key"]).default("jwt"),
});
export type OrgContext = z.infer<typeof orgContextSchema>;

export const factStatusSchema = z.enum(["active", "superseded", "retracted"]);
export type FactStatus = z.infer<typeof factStatusSchema>;

export const memoryTypeSchema = z.enum(["fact", "episode", "artifact"]);
export type MemoryType = z.infer<typeof memoryTypeSchema>;

export const chatModeSchema = z.enum(["with_memory", "stateless"]);

export const chatRequestSchema = z.object({
  userId: z.string().min(1),
  convId: z.string().min(1),
  message: z.string().min(1),
  mode: chatModeSchema.default("with_memory"),
  occurredAt: z.string().datetime().optional(),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const ingestInputSchema = z.object({
  orgId: uuidSchema,
  userId: z.string().min(1),
  convId: z.string().min(1),
  sourceRole: z.enum(["customer", "agent", "system"]),
  message: z.string().min(1),
  occurredAt: z.string().datetime().optional(),
});
export type IngestInput = z.infer<typeof ingestInputSchema>;

export const factSchema = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  userId: z.string(),
  slotKey: z.string(),
  subject: z.string(),
  predicate: z.string(),
  objectValue: z.string(),
  canonicalText: z.string(),
  embedding: z.array(z.number()),
  status: factStatusSchema,
  supersedes: uuidSchema.optional(),
  contentHash: z.string().length(64),
  sourceRole: z.enum(["customer", "agent", "system"]),
  convId: z.string(),
  occurredAt: z.string(),
  createdAt: z.string(),
});
export type Fact = z.infer<typeof factSchema>;

export const timelineEntrySchema = factSchema.extend({
  replacedBy: uuidSchema.optional(),
});
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

export const contextPromptSchema = z.object({
  orgId: uuidSchema,
  userId: z.string(),
  contextPrompt: z.string(),
  facts: z.array(factSchema),
});
export type ContextPrompt = z.infer<typeof contextPromptSchema>;

export const ingestResultSchema = z.object({
  queued: z.boolean(),
  inserted: z.number().int().nonnegative(),
  superseded: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  factIds: z.array(uuidSchema),
});
export type IngestResult = z.infer<typeof ingestResultSchema>;

export const episodeSchema = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  userId: z.string(),
  summary: z.string(),
  factIds: z.array(uuidSchema),
  createdAt: z.string(),
});
export type Episode = z.infer<typeof episodeSchema>;

export const artifactSchema = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  userId: z.string(),
  kind: z.string(),
  content: z.record(z.unknown()),
  sourceFactIds: z.array(uuidSchema),
  createdAt: z.string(),
});
export type Artifact = z.infer<typeof artifactSchema>;

export const richTimelineSchema = z.object({
  facts: z.array(timelineEntrySchema),
  episodes: z.array(episodeSchema),
  artifacts: z.array(artifactSchema),
});
export type RichTimeline = z.infer<typeof richTimelineSchema>;

export const chatResponseSchema = z.object({
  reply: z.string(),
  mode: chatModeSchema,
  contextPrompt: z.string(),
  retrievedFacts: z.number().int().nonnegative(),
  writeResult: ingestResultSchema.pick({ inserted: true, superseded: true, duplicate: true }).extend({ queued: z.boolean() }),
  degraded: z.boolean(),
});
export type ChatResponse = z.infer<typeof chatResponseSchema>;

export const auditEventSchema = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  actorId: z.string(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().optional(),
  createdAt: z.string(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const demoScenarioSchema = z.object({
  name: z.string().default("contradiction-demo"),
  userId: z.string().optional(),
  messages: z.array(z.string()).optional(),
});


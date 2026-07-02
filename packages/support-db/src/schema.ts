import { sql } from "drizzle-orm";
import { index, jsonb, pgPolicy, pgRole, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const supportAppUser = pgRole("support_app_user");
const orgSetting = sql`current_setting('app.org_id', true)::uuid`;

const orgPolicy = (table: { orgId: unknown }) =>
  pgPolicy("org_isolation", {
    as: "permissive",
    for: "all",
    to: supportAppUser,
    using: sql`${table.orgId} = ${orgSetting}`,
    withCheck: sql`${table.orgId} = ${orgSetting}`,
  });

export const supportOrgs = pgTable("support_orgs", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const supportUsers = pgTable(
  "support_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => supportOrgs.id),
    externalUserId: text("external_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("support_users_org_user_idx").on(t.orgId, t.externalUserId), orgPolicy(t)],
).enableRLS();

export const supportFacts = pgTable(
  "support_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => supportOrgs.id),
    userId: text("user_id").notNull(),
    slotKey: text("slot_key").notNull(),
    subject: text("subject").notNull(),
    predicate: text("predicate").notNull(),
    objectValue: text("object_value").notNull(),
    canonicalText: text("canonical_text").notNull(),
    embedding: text("embedding").notNull(),
    status: text("status").notNull().default("active"),
    supersedes: uuid("supersedes"),
    contentHash: text("content_hash").notNull(),
    sourceRole: text("source_role").notNull(),
    convId: text("conv_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("support_facts_org_user_status_idx").on(t.orgId, t.userId, t.status), orgPolicy(t)],
).enableRLS();

export const supportEpisodes = pgTable(
  "support_episodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => supportOrgs.id),
    userId: text("user_id").notNull(),
    summary: text("summary").notNull(),
    factIds: jsonb("fact_ids").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("support_episodes_org_user_idx").on(t.orgId, t.userId), orgPolicy(t)],
).enableRLS();

export const supportArtifacts = pgTable(
  "support_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => supportOrgs.id),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    content: jsonb("content").notNull(),
    sourceFactIds: jsonb("source_fact_ids").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("support_artifacts_org_user_idx").on(t.orgId, t.userId), orgPolicy(t)],
).enableRLS();

export const supportAuditLogs = pgTable(
  "support_audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => supportOrgs.id),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("support_audit_logs_org_idx").on(t.orgId), orgPolicy(t)],
).enableRLS();


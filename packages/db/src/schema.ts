import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  numeric,
  pgPolicy,
  pgRole,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const appUser = pgRole("app_user");
const tenantSetting = sql`current_setting('app.tenant_id', true)::uuid`;

const tenantPolicy = (table: { tenantId: unknown }) =>
  pgPolicy("tenant_isolation", {
    as: "permissive",
    for: "all",
    to: appUser,
    using: sql`${table.tenantId} = ${tenantSetting}`,
    withCheck: sql`${table.tenantId} = ${tenantSetting}`,
  });

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const vendors = pgTable(
  "vendors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    name: text("name").notNull(),
    taxId: text("tax_id"),
  },
  (t) => [index("vendors_tenant_idx").on(t.tenantId), tenantPolicy(t)],
).enableRLS();

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    poNumber: text("po_number").notNull(),
    vendorId: uuid("vendor_id").references(() => vendors.id),
    total: numeric("total", { precision: 14, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("USD"),
  },
  (t) => [index("purchase_orders_tenant_idx").on(t.tenantId), tenantPolicy(t)],
).enableRLS();

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    vendorId: uuid("vendor_id").references(() => vendors.id),
    poId: uuid("po_id").references(() => purchaseOrders.id),
    sourceObjectKey: text("source_object_key"),
    invoiceNumber: text("invoice_number"),
    vendorName: text("vendor_name"),
    status: text("status").notNull().default("received"),
    total: numeric("total", { precision: 14, scale: 2 }).notNull().default("0"),
    currency: text("currency").notNull().default("USD"),
    extracted: jsonb("extracted"),
    confidence: real("confidence"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("invoices_tenant_status_idx").on(t.tenantId, t.status), tenantPolicy(t)],
).enableRLS();

export const agentEvents = pgTable(
  "agent_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
    agent: text("agent").notNull(),
    actor: text("actor").notNull(),
    input: jsonb("input").notNull(),
    output: jsonb("output").notNull(),
    tokens: numeric("tokens").notNull().default("0"),
    latencyMs: numeric("latency_ms").notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_events_invoice_idx").on(t.tenantId, t.invoiceId), tenantPolicy(t)],
).enableRLS();


import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
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
    active: boolean("active").notNull().default(true),
    holdPayments: boolean("hold_payments").notNull().default(false),
    paymentTermsDays: integer("payment_terms_days").notNull().default(30),
    defaultExpenseAccount: text("default_expense_account").notNull().default("6100"),
    currency: text("currency").notNull().default("USD"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
    lines: jsonb("lines").notNull().default([]),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("purchase_orders_tenant_idx").on(t.tenantId), tenantPolicy(t)],
).enableRLS();

export const goodsReceipts = pgTable(
  "goods_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    poId: uuid("po_id").notNull().references(() => purchaseOrders.id),
    description: text("description").notNull(),
    quantityReceived: numeric("quantity_received", { precision: 14, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("goods_receipts_tenant_po_idx").on(t.tenantId, t.poId), tenantPolicy(t)],
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

export const accountingPeriods = pgTable(
  "accounting_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    name: text("name").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("accounting_periods_tenant_idx").on(t.tenantId), tenantPolicy(t)],
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

export const glJournalEntries = pgTable(
  "gl_journal_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    source: text("source").notNull(),
    postingDate: timestamp("posting_date", { withTimezone: true }).notNull(),
    currency: text("currency").notNull(),
    balanced: text("balanced").notNull().default("true"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("gl_journal_entries_tenant_idx").on(t.tenantId), tenantPolicy(t)],
).enableRLS();

export const glJournalLines = pgTable(
  "gl_journal_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    journalEntryId: uuid("journal_entry_id").notNull().references(() => glJournalEntries.id),
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    account: text("account").notNull(),
    debit: numeric("debit", { precision: 14, scale: 2 }).notNull().default("0"),
    credit: numeric("credit", { precision: 14, scale: 2 }).notNull().default("0"),
    memo: text("memo").notNull(),
  },
  (t) => [index("gl_journal_lines_tenant_journal_idx").on(t.tenantId, t.journalEntryId), tenantPolicy(t)],
).enableRLS();

export const paymentRuns = pgTable(
  "payment_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    scheduledDate: timestamp("scheduled_date", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("created"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("payment_runs_tenant_idx").on(t.tenantId), tenantPolicy(t)],
).enableRLS();

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    paymentRunId: uuid("payment_run_id").notNull().references(() => paymentRuns.id),
    invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
    vendorId: uuid("vendor_id").references(() => vendors.id),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currency: text("currency").notNull(),
    status: text("status").notNull().default("scheduled"),
  },
  (t) => [index("payments_tenant_status_idx").on(t.tenantId, t.status), tenantPolicy(t)],
).enableRLS();

export const bankTransactions = pgTable(
  "bank_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currency: text("currency").notNull(),
    valueDate: timestamp("value_date", { withTimezone: true }).notNull(),
    reference: text("reference").notNull(),
    reconciliationId: uuid("reconciliation_id"),
  },
  (t) => [index("bank_transactions_tenant_idx").on(t.tenantId), tenantPolicy(t)],
).enableRLS();

export const reconciliations = pgTable(
  "reconciliations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    status: text("status").notNull().default("open"),
    result: jsonb("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reconciliations_tenant_idx").on(t.tenantId), tenantPolicy(t)],
).enableRLS();

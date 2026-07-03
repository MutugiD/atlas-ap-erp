import { z } from "zod";

export const uuidSchema = z.string().uuid();

export const invoiceStatusSchema = z.enum([
  "received",
  "extracted",
  "validated",
  "matched",
  "coded",
  "awaiting_approval",
  "approved",
  "rejected",
  "posted",
  "queued_for_payment",
  "exception",
]);
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;

export const tenantContextSchema = z.object({
  tenantId: uuidSchema,
  userId: uuidSchema,
  role: z.enum(["ap_clerk", "approver", "admin"]).default("ap_clerk"),
});
export type TenantContext = z.infer<typeof tenantContextSchema>;

export const invoiceLineSchema = z.object({
  description: z.string(),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  total: z.number().nonnegative(),
});

export const invoiceDraftSchema = z.object({
  vendorName: z.string(),
  invoiceNumber: z.string(),
  invoiceDate: z.string(),
  poNumber: z.string().optional(),
  currency: z.string().length(3),
  subtotal: z.number().nonnegative(),
  tax: z.number().nonnegative(),
  total: z.number().nonnegative(),
  lines: z.array(invoiceLineSchema).min(1),
  fieldConfidence: z.record(z.number().min(0).max(1)).default({}),
  confidence: z.number().min(0).max(1),
});
export type InvoiceDraft = z.infer<typeof invoiceDraftSchema>;

export const validationResultSchema = z.object({
  ok: z.boolean(),
  duplicate: z.boolean(),
  reasons: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});
export type ValidationResult = z.infer<typeof validationResultSchema>;

export const matchResultSchema = z.object({
  matched: z.boolean(),
  variance: z.number(),
  withinTolerance: z.boolean(),
  reasons: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});
export type MatchResult = z.infer<typeof matchResultSchema>;

export const glCodingProposalSchema = z.object({
  balanced: z.boolean(),
  splits: z.array(
    z.object({
      glAccount: z.string(),
      costCenter: z.string(),
      amount: z.number().nonnegative(),
    }),
  ),
  confidence: z.number().min(0).max(1),
});
export type GlCodingProposal = z.infer<typeof glCodingProposalSchema>;

export const approvalRouteSchema = z.object({
  autoApproved: z.boolean(),
  approvers: z.array(uuidSchema).default([]),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
});
export type ApprovalRoute = z.infer<typeof approvalRouteSchema>;

export const agentNameSchema = z.enum([
  "supervisor",
  "extraction",
  "validation",
  "matching",
  "gl_coding",
  "approval_routing",
  "comms",
  "posting",
]);

export const agentEventSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  invoiceId: uuidSchema,
  agent: agentNameSchema,
  actor: z.enum(["agent", "human", "system"]),
  input: z.unknown(),
  output: z.unknown(),
  tokens: z.number().int().nonnegative().default(0),
  latencyMs: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
});
export type AgentEvent = z.infer<typeof agentEventSchema>;

export const agentDecisionSchema = z.object({
  agent: agentNameSchema,
  nextStatus: invoiceStatusSchema,
  confidence: z.number().min(0).max(1),
  output: z.unknown(),
  humanRequired: z.boolean().default(false),
  reasons: z.array(z.string()).default([]),
});
export type AgentDecision = z.infer<typeof agentDecisionSchema>;

export const invoiceSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  vendorId: uuidSchema.optional(),
  poId: uuidSchema.optional(),
  sourceObjectKey: z.string().optional(),
  invoiceNumber: z.string().optional(),
  vendorName: z.string().optional(),
  status: invoiceStatusSchema,
  total: z.number().nonnegative(),
  currency: z.string().length(3),
  extracted: invoiceDraftSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Invoice = z.infer<typeof invoiceSchema>;

export const createInvoiceSchema = z.object({
  sourceObjectKey: z.string().optional(),
  vendorName: z.string().optional(),
  invoiceNumber: z.string().optional(),
  total: z.number().nonnegative().default(0),
  currency: z.string().length(3).default("USD"),
  poId: uuidSchema.optional(),
  vendorId: uuidSchema.optional(),
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

export const vendorSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  name: z.string(),
  taxId: z.string().optional(),
  active: z.boolean(),
  holdPayments: z.boolean(),
  paymentTermsDays: z.number().int().nonnegative(),
  defaultExpenseAccount: z.string(),
  currency: z.string().length(3),
  createdAt: z.string(),
});
export type Vendor = z.infer<typeof vendorSchema>;

export const createVendorSchema = z.object({
  name: z.string().min(1),
  taxId: z.string().optional(),
  active: z.boolean().default(true),
  holdPayments: z.boolean().default(false),
  paymentTermsDays: z.number().int().nonnegative().default(30),
  defaultExpenseAccount: z.string().default("6100"),
  currency: z.string().length(3).default("USD"),
});
export type CreateVendorInput = z.infer<typeof createVendorSchema>;

// All fields optional — a partial update of an existing vendor.
export const updateVendorSchema = createVendorSchema.partial();
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;

export const poLineSchema = z.object({
  description: z.string(),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  total: z.number().nonnegative(),
});

export const purchaseOrderSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  poNumber: z.string(),
  vendorId: uuidSchema.optional(),
  currency: z.string().length(3),
  total: z.number().nonnegative(),
  status: z.enum(["open", "closed"]),
  lines: z.array(poLineSchema),
  createdAt: z.string(),
});
export type PurchaseOrder = z.infer<typeof purchaseOrderSchema>;

export const createPurchaseOrderSchema = z.object({
  poNumber: z.string().min(1),
  vendorId: uuidSchema.optional(),
  currency: z.string().length(3).default("USD"),
  lines: z.array(poLineSchema).min(1),
});
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;

export const goodsReceiptSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  poId: uuidSchema,
  description: z.string(),
  quantityReceived: z.number().nonnegative(),
  createdAt: z.string(),
});
export type GoodsReceiptRecord = z.infer<typeof goodsReceiptSchema>;

export const createGoodsReceiptSchema = z.object({
  poId: uuidSchema,
  description: z.string().min(1),
  quantityReceived: z.number().nonnegative(),
});
export type CreateGoodsReceiptInput = z.infer<typeof createGoodsReceiptSchema>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const accountingPeriodSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  name: z.string(),
  startsOn: isoDate,
  endsOn: isoDate,
  status: z.enum(["open", "closed"]),
  createdAt: z.string(),
});
export type AccountingPeriodRecord = z.infer<typeof accountingPeriodSchema>;

export const createAccountingPeriodSchema = z.object({
  name: z.string().min(1),
  startsOn: isoDate,
  endsOn: isoDate,
});
export type CreateAccountingPeriodInput = z.infer<typeof createAccountingPeriodSchema>;

export const transitionSchema = z.object({
  from: invoiceStatusSchema,
  to: invoiceStatusSchema,
});


-- Standalone partial payments against an invoice (distinct from payment-run
-- payments, which are always tied to a run). Same tenant-scoped RLS pattern.

CREATE TABLE IF NOT EXISTS partial_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  amount numeric(14, 2) NOT NULL,
  currency text NOT NULL,
  status text NOT NULL DEFAULT 'paid',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partial_payments_tenant_invoice_idx ON partial_payments(tenant_id, invoice_id);

ALTER TABLE partial_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE partial_payments FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON partial_payments
  AS PERMISSIVE FOR ALL TO app_user
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON partial_payments TO app_user;

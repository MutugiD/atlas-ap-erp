-- Persisted vendor credit memos and their applications against invoices. Same
-- tenant-scoped RLS pattern as the other AP tables.

CREATE TABLE IF NOT EXISTS credit_memos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  vendor_id uuid REFERENCES vendors(id),
  amount numeric(14, 2) NOT NULL,
  currency text NOT NULL,
  status text NOT NULL DEFAULT 'available',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_memo_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  credit_memo_id uuid NOT NULL REFERENCES credit_memos(id),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  amount_applied numeric(14, 2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credit_memos_tenant_vendor_idx ON credit_memos(tenant_id, vendor_id);
CREATE INDEX IF NOT EXISTS credit_memo_applications_tenant_invoice_idx ON credit_memo_applications(tenant_id, invoice_id);

ALTER TABLE credit_memos ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_memos FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_memo_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_memo_applications FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON credit_memos
  AS PERMISSIVE FOR ALL TO app_user
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON credit_memo_applications
  AS PERMISSIVE FOR ALL TO app_user
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON credit_memos, credit_memo_applications TO app_user;

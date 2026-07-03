-- Buyer-issued vendor debit memos (e.g. returns/overcharges). Issuing one posts
-- a balanced GL journal (Dr AP, Cr purchase returns). Tenant-scoped RLS as usual.

CREATE TABLE IF NOT EXISTS debit_memos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  vendor_id uuid REFERENCES vendors(id),
  amount numeric(14, 2) NOT NULL,
  currency text NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'issued',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS debit_memos_tenant_vendor_idx ON debit_memos(tenant_id, vendor_id);

ALTER TABLE debit_memos ENABLE ROW LEVEL SECURITY;
ALTER TABLE debit_memos FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON debit_memos
  AS PERMISSIVE FOR ALL TO app_user
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON debit_memos TO app_user;

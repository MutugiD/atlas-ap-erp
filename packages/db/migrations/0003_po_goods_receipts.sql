-- Purchase order lines/status (for three-way matching) and a goods_receipts
-- table. purchase_orders already has RLS + tenant_isolation + app_user grants
-- from 0000/0001; the new columns inherit them.

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS lines jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open';
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS goods_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  po_id uuid NOT NULL REFERENCES purchase_orders(id),
  description text NOT NULL,
  quantity_received numeric(14, 2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS goods_receipts_tenant_po_idx ON goods_receipts(tenant_id, po_id);

ALTER TABLE goods_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON goods_receipts
  AS PERMISSIVE FOR ALL TO app_user
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON goods_receipts TO app_user;

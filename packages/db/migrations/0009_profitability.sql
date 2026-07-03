-- Profitability dimensions + inputs.
-- 1) Add account / service-line dimensions to GL lines so posted costs can be
--    sliced the same two ways as the P&L (nullable; AP posting leaves them null
--    until a source populates them).
ALTER TABLE gl_journal_lines ADD COLUMN IF NOT EXISTS client_account text;
ALTER TABLE gl_journal_lines ADD COLUMN IF NOT EXISTS service_line text;

-- 2) Per-period profitability inputs (account x service line) that feed the
--    @atlas/profitability engine. Tenant-scoped RLS like the other AP tables.
CREATE TABLE IF NOT EXISTS profitability_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  period text NOT NULL,
  account text NOT NULL,
  service_line text NOT NULL,
  fee_revenue numeric(14, 2) NOT NULL DEFAULT 0,
  labor_hours numeric(14, 2) NOT NULL DEFAULT 0,
  labor_cost_rate numeric(14, 2) NOT NULL DEFAULT 0,
  media_spend numeric(14, 2) NOT NULL DEFAULT 0,
  media_markup_rate numeric(6, 4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS profitability_inputs_tenant_period_idx ON profitability_inputs(tenant_id, period);

ALTER TABLE profitability_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE profitability_inputs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON profitability_inputs
  AS PERMISSIVE FOR ALL TO app_user
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON profitability_inputs TO app_user;

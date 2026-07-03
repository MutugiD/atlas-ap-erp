-- Persisted profitability report artifacts (executive summary + full detail),
-- generated at book close for a period. Tenant-scoped RLS like the other tables.

CREATE TABLE IF NOT EXISTS profitability_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  period text NOT NULL,
  prior_period text,
  summary jsonb NOT NULL,
  detail jsonb NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS profitability_reports_tenant_period_idx ON profitability_reports(tenant_id, period);

ALTER TABLE profitability_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE profitability_reports FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON profitability_reports
  AS PERMISSIVE FOR ALL TO app_user
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON profitability_reports TO app_user;

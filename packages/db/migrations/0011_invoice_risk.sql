-- Tenant-scoped deterministic invoice risk assessments. Findings are immutable
-- scoring snapshots except for the explicit human review fields.
CREATE TABLE IF NOT EXISTS invoice_risk_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  risk_level text NOT NULL CHECK (risk_level IN ('low', 'review', 'high')),
  risk_score numeric(5, 2) NOT NULL,
  findings jsonb NOT NULL,
  features jsonb NOT NULL,
  rule_version text NOT NULL,
  model_version text NOT NULL,
  review_status text NOT NULL CHECK (review_status IN ('open', 'not_required', 'confirmed_issue', 'false_positive', 'accepted_exception')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoice_risk_tenant_idx ON invoice_risk_assessments(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS invoice_risk_invoice_idx ON invoice_risk_assessments(tenant_id, invoice_id, created_at DESC);
ALTER TABLE invoice_risk_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_risk_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice_risk_assessments AS PERMISSIVE FOR ALL TO app_user
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON invoice_risk_assessments TO app_user;

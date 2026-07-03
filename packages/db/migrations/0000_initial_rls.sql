CREATE ROLE app_user NOLOGIN;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  tax_id text
);

CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  po_number text NOT NULL,
  vendor_id uuid REFERENCES vendors(id),
  total numeric(14, 2) NOT NULL,
  currency text NOT NULL DEFAULT 'USD'
);

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  vendor_id uuid REFERENCES vendors(id),
  po_id uuid REFERENCES purchase_orders(id),
  source_object_key text,
  invoice_number text,
  vendor_name text,
  status text NOT NULL DEFAULT 'received',
  total numeric(14, 2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  extracted jsonb,
  confidence real,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  agent text NOT NULL,
  actor text NOT NULL,
  input jsonb NOT NULL,
  output jsonb NOT NULL,
  tokens numeric NOT NULL DEFAULT 0,
  latency_ms numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gl_journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source text NOT NULL,
  posting_date timestamptz NOT NULL,
  currency text NOT NULL,
  balanced text NOT NULL DEFAULT 'true',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gl_journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  journal_entry_id uuid NOT NULL REFERENCES gl_journal_entries(id),
  invoice_id uuid REFERENCES invoices(id),
  account text NOT NULL,
  debit numeric(14,2) NOT NULL DEFAULT 0,
  credit numeric(14,2) NOT NULL DEFAULT 0,
  memo text NOT NULL
);

CREATE TABLE payment_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  scheduled_date timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'created',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  payment_run_id uuid NOT NULL REFERENCES payment_runs(id),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  vendor_id uuid REFERENCES vendors(id),
  amount numeric(14,2) NOT NULL,
  currency text NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
);

CREATE TABLE bank_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  amount numeric(14,2) NOT NULL,
  currency text NOT NULL,
  value_date timestamptz NOT NULL,
  reference text NOT NULL,
  reconciliation_id uuid
);

CREATE TABLE reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  status text NOT NULL DEFAULT 'open',
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX vendors_tenant_idx ON vendors(tenant_id);
CREATE INDEX purchase_orders_tenant_idx ON purchase_orders(tenant_id);
CREATE INDEX invoices_tenant_status_idx ON invoices(tenant_id, status);
CREATE INDEX agent_events_invoice_idx ON agent_events(tenant_id, invoice_id);
CREATE INDEX gl_journal_entries_tenant_idx ON gl_journal_entries(tenant_id);
CREATE INDEX gl_journal_lines_tenant_journal_idx ON gl_journal_lines(tenant_id, journal_entry_id);
CREATE INDEX payment_runs_tenant_idx ON payment_runs(tenant_id);
CREATE INDEX payments_tenant_status_idx ON payments(tenant_id, status);
CREATE INDEX bank_transactions_tenant_idx ON bank_transactions(tenant_id);
CREATE INDEX reconciliations_tenant_idx ON reconciliations(tenant_id);

ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE gl_journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE gl_journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliations ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON vendors
  AS PERMISSIVE FOR ALL TO app_user
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON purchase_orders
  AS PERMISSIVE FOR ALL TO app_user
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON invoices
  AS PERMISSIVE FOR ALL TO app_user
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON agent_events
  AS PERMISSIVE FOR ALL TO app_user
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON gl_journal_entries
  AS PERMISSIVE FOR ALL TO app_user
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON gl_journal_lines
  AS PERMISSIVE FOR ALL TO app_user
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON payment_runs
  AS PERMISSIVE FOR ALL TO app_user
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON payments
  AS PERMISSIVE FOR ALL TO app_user
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON bank_transactions
  AS PERMISSIVE FOR ALL TO app_user
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON reconciliations
  AS PERMISSIVE FOR ALL TO app_user
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON vendors, purchase_orders, invoices, agent_events, gl_journal_entries, gl_journal_lines, payment_runs, payments, bank_transactions, reconciliations TO app_user;

-- Make the AP tenant app-role a LOGIN role and force RLS so the API can connect
-- as a non-superuser and have tenant isolation enforced in-DB (mirrors the
-- Support Agent V2 support_app_user pattern). The base role, RLS enablement,
-- and per-table tenant_isolation policies are created in 0000_initial_rls.sql.
-- (The tenants registry table is intentionally left without RLS, as in 0000.)

ALTER ROLE app_user WITH LOGIN PASSWORD 'app_user';

-- FORCE so the tenant_isolation policy also applies on the table-owner path.
ALTER TABLE vendors FORCE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders FORCE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_events FORCE ROW LEVEL SECURITY;
ALTER TABLE gl_journal_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE gl_journal_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE reconciliations FORCE ROW LEVEL SECURITY;

-- 0000 granted SELECT/INSERT/UPDATE; add DELETE for reset/erasure paths.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  vendors, purchase_orders, invoices, agent_events,
  gl_journal_entries, gl_journal_lines, payment_runs, payments,
  bank_transactions, reconciliations
TO app_user;

-- Enrich the vendors table into a usable vendor master. 0000 created it with
-- only (id, tenant_id, name, tax_id); add the fields the accounting engine and
-- payment runs need. RLS, the tenant_isolation policy, and app_user grants from
-- 0000/0001 already cover this table and apply to the new columns.

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS hold_payments boolean NOT NULL DEFAULT false;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS payment_terms_days integer NOT NULL DEFAULT 30;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS default_expense_account text NOT NULL DEFAULT '6100';
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD';
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

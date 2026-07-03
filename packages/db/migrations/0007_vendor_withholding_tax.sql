-- Per-vendor withholding tax rate, applied when a payment run disburses cash:
-- the withheld portion is credited to a withholding-tax-payable account instead
-- of cash. RLS/policy/grants from 0000/0001 already cover the vendors table.

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS withholding_tax_rate numeric(6, 4) NOT NULL DEFAULT 0;

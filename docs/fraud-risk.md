# Invoice Control Review

Atlas AP ERP provides optional, tenant-scoped invoice controls for the invoice-to-pay workflow. The feature is
an accounting review aid, not an automated fraud determination, audit opinion, or replacement for investigation.

## Workflow

```text
receive -> extract -> validate -> three-way match -> control review -> approval -> posting -> payment -> reconciliation
```

Assessment is available through `POST /v1/invoices/:id/risk-assessment` and runs automatically after
`POST /v1/invoices/:id/reprocess`. Findings are available through `/v1/risk-findings` and the `/risk` web page.

## Deterministic controls

The default rules check for:

- Duplicate invoice numbers for the same vendor.
- Subtotal, tax, and total arithmetic mismatches.
- Missing or payment-held vendor master records.
- PO currency or amount variance.
- Purchase orders without recorded goods receipts.
- Round invoice totals.
- Amounts materially above the vendor's recent observed average.

Each assessment stores its score, risk level, feature snapshot, triggered rules, rule version, model version,
and review state. A high score creates a review finding; it does not automatically reject, post, or pay an invoice.

## Review and export

Reviewers can mark a finding as `confirmed_issue`, `false_positive`, or `accepted_exception`. The decision is
tenant-scoped and records the acting user and review time. The Control Review page shows invoice, vendor, amount,
payment-control context, queue status, and the leading explanation together.

Reports are available as JSON or Excel-compatible CSV:

```text
POST /v1/risk-reports
GET  /v1/risk-reports?format=csv
```

CSV exports contain invoice ID, risk level, score, review status, rule version, and human-readable reasons.

## ML provider boundary

The deterministic engine is the default and requires no Python service or external model. A future anomaly-model
provider may implement the normalized risk contract, but Atlas must retain rules-only behavior when that provider
is unavailable. Model artifacts must be versioned and accompanied by a model card; training data must not be
committed unless redistribution rights are clear.

## Privacy and limitations

- Do not upload customer financial records to public issue trackers, sample folders, or shared environments.
- Use synthetic or explicitly licensed records for tests and public examples.
- Do not log raw invoice documents, bank details, tax identifiers, or model inputs containing personal data.
- Investigate material findings using source documents, vendor confirmation, approval evidence, and accounting records.
- Thresholds are starting points and must be calibrated to each tenant's policies and operating history.

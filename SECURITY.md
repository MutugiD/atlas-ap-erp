# Security Policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or exposed credential. Contact the repository
maintainer privately with the affected component, reproduction steps, impact, and a safe contact method.

Immediately revoke any credential that may have been pasted into chat, logs, issues, commits, or pull requests.

## Data handling

- Treat invoices, vendor records, bank transactions, tax identifiers, and model inputs as sensitive financial data.
- Keep tenant IDs and user IDs scoped through the existing authorization and Postgres RLS boundaries.
- Redact sensitive values from logs and test output.
- Use synthetic fixtures for public examples.
- Review dependency-audit findings before each release.

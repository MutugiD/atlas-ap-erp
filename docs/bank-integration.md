# Bank Integration (Kenya)

The API depends only on the `BankConnector` interface (`apps/api/src/bank.ts`), so a bank can be swapped in
without touching the reconciliation flow. Live HTTP happens only when `BANK_PROVIDER` is configured; the
default `ManualBankConnector` keeps local/dev and tests hermetic (reconciliation still works via the manual
`POST /v1/reconciliations` path where the caller supplies transactions).

```
BankConnector
  fetchStatement(query) -> BankTransaction[]   // normalized; debits negative, credits positive
  disburse(request)     -> { bankReference, status, rail }
```

- **Inbound (reconciliation):** `POST /v1/bank/statement-reconcile` pulls a statement via the connector,
  normalizes it, and calls the same `reconcilePayments` the end-to-end tests exercise.
- **Outbound (disbursement):** `disburse` selects a rail by amount/instrument (see below). Wiring payment
  runs to `disburse` and adding vendor payment instruments (account/bank code/mobile number) is the planned
  follow-up.

## Verified provider facts

### Equity Bank — Jenga API (Finserve Africa) — implemented (`BANK_PROVIDER=jenga`)
- **Statements:** `POST https://api.finserve.africa/v3-apis/account-api/v3.0/accounts/fullStatement` with
  `{accountNumber, countryCode, fromDate, toDate, limit?}`; response transactions carry
  `reference, date, amount, type (Debit|Credit), runningBalance{currency,amount}, postedDateTime`.
- **Payments:** send money to Equity, M-Pesa, Airtel, Equitel, PesaLink (mobile & bank), and RTGS.
- **Auth (verified):** a Bearer `access_token` **plus** a per-request `Signature` header — base64 RSA over
  concatenated request fields (statements sign `accountNumber+countryCode+toDate`). Configure with
  `JENGA_BASE_URL`, `JENGA_ACCESS_TOKEN` (or a token provider), and `JENGA_PRIVATE_KEY`.

### KCB — Buni platform (WSO2 API gateway) — connector TBD
- **Account services:** balance, statement, forex, account/customer validation.
- **Payments:** money movement across all banks + M-PESA, Airtel Money, T-Kash, VOOMA; P2P/C2B/B2B/B2C.
- **IPN (verified):** a webhook KCB POSTs to your callback on account credits (sandbox
  `POST https://sandbox.buni.kcbgroup.com/ipn/1.0.0/v1/instant-payment-notification`), using a **shared
  signature, not a token** — the real-time complement to pulling statements.
- **Auth:** Buni runs on WSO2 API Manager (OAuth2 consumer key/secret → Bearer for account/payment APIs);
  exact token endpoint is confirmed in the Buni portal after onboarding.

## Rails (how a payment run should pay)
- **PesaLink** (IPSL): real-time interbank, 24/7, **≤ KES 999,999 per transaction**, ISO 20022-based.
- **RTGS = KEPSS** (CBK): high value, typically **≥ KES 1,000,000**, weekday window ~08:30–15:00.
- **M-Pesa (Safaricom Daraja):** B2B/B2C for mobile-money vendors; requires Safaricom shortcode whitelisting.
  Both banks also bridge to M-Pesa via their own APIs.

`EquityJengaConnector.disburse` routes `mobile → sendtomobile`, `< RTGS threshold → PesaLink`,
`≥ threshold → RTGS`.

## Confirm at onboarding
Exact Jenga token endpoint and send-money paths, KCB Buni OAuth token endpoint, live per-transaction limits
and fees, and sandbox credentials / M-Pesa whitelisting all require a developer account with each provider.

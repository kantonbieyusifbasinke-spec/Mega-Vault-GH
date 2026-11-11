# Production go-live checklist

## Firebase
- [ ] Replace Firebase web configuration values.
- [ ] Enable Email/Password authentication and authorized domain.
- [ ] Create Firestore database and deploy `firestore.rules` and indexes.
- [ ] Deploy Node.js 22 Cloud Functions to the selected region.
- [ ] Verify the first admin custom claim; separate owner/operator accounts from customer accounts.
- [ ] Confirm Functions, Secret Manager and scheduled jobs are enabled on the billing plan.

## Commercial catalogue and supplier
- [ ] Obtain a supplier business account, written pricing and live API specification.
- [ ] Verify MTN, Telecel and AT identifiers and every bundle code.
- [ ] Review the generic adapter against the real API; do not assume schema compatibility.
- [ ] Verify HTTPS endpoint host, exact allowlist, API balance and supplier delivery status semantics.
- [ ] Test timeout, duplicate, pending, rejection, low-balance and refund scenarios in sandbox.
- [ ] Add real supplier costs and retail prices; publish only verified packages.

## Payments
- [ ] Complete Paystack and/or Hubtel merchant onboarding.
- [ ] Add production secrets in Firebase Secret Manager.
- [ ] Configure Paystack webhook and verify both modern and legacy signature paths.
- [ ] For Hubtel, configure callback, authenticated status verification and a fixed/allowlisted outbound IP.
- [ ] Confirm actual Mobile Money channels available to the merchant account.
- [ ] Verify exact amount and currency checks using live-mode provider tests before public launch.

## Operations and safety
- [ ] Change `APP_MODE` to `live` only after every integration test passes.
- [ ] Set the correct customer support WhatsApp line and contact information.
- [ ] Publish business identity, terms, privacy, refund and complaint-handling policies.
- [ ] Configure Firebase/Google Cloud budget alerts, log monitoring and database backups.
- [ ] Establish a manual support route for pending provider orders and payment disputes.
- [ ] Review data protection, consumer, tax and payment obligations applicable to the operating business in Ghana with qualified advisers.

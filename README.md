# MEGA VAULT GH

A Ghana-focused MTN, Telecel and AT data-bundle storefront with Firebase Authentication, Firestore, Cloud Functions, customer dashboard, protected admin centre, wallet ledger, Paystack/Hubtel wallet funding, referral rewards and a pluggable data-provider adapter.

> **Important deployment status:** this is a complete, configurable application codebase, but it is intentionally delivered in **TEST MODE**. It cannot process real money or deliver live data until you connect your own Firebase project, approved payment merchant credentials and the exact API documentation/credentials for your data wholesaler. The project does not invent those credentials or claim that a test order was delivered. The Auth profile bootstrap uses the second-generation Firebase Authentication `onUserCreated` trigger; the included Functions SDK is pinned to a release where that trigger is generally available.

## What is included

- Responsive public site, network cards, live Firestore catalogue, order form and FAQs.
- Firebase email/password registration and login, email verification, password reset and customer profile.
- Customer dashboard for orders, wallet, ledger history, notifications, referrals and support tickets.
- Callable Functions for order creation, server-side wallet ledger posting, referral credits, support cases and admin operations.
- Admin dashboard protected by a Firebase Authentication custom claim (`admin: true`).
- Server-side Paystack initialize/verify/webhook implementation and Hubtel Online Checkout/status-check implementation.
- Generic data-provider adapter, provider status reconciliation schedule and strict HTTPS host allowlist.
- Firestore rules, indexes, emulator ports and deployment instructions.

## 1. Prerequisites

1. A Firebase project that you own.
2. Node.js 22 and npm.
3. Firebase CLI: `npm install -g firebase-tools`.
4. A data supplier/aggregator account and its current API documentation.
5. Paystack and/or Hubtel merchant accounts before enabling those payment methods.

Cloud Functions, Secret Manager and scheduled reconciliation require a Firebase project on a billing-enabled plan. Review the charges and quotas for your project before deployment.

## 2. Configure Firebase

1. In the Firebase Console, create a project and register a **Web App**.
2. Enable **Authentication → Sign-in method → Email/Password**.
3. Create a Cloud Firestore database.
4. Add your Hosting domain (`YOUR_PROJECT_ID.web.app`) to Authentication → Settings → Authorized domains if it is not already present.
5. Copy `.firebaserc.example` to `.firebaserc` and replace `YOUR_FIREBASE_PROJECT_ID`.
6. Open `public/firebase-config.js` and replace the six `REPLACE_` / `YOUR_` values with the Firebase Web App configuration. The Firebase web API key is a public client identifier; security is enforced by Authentication and Firestore rules. **Never add payment or supplier API secrets to this file.**

Example:

```bash
cp .firebaserc.example .firebaserc
firebase login
firebase use YOUR_FIREBASE_PROJECT_ID
npm install --prefix functions
```

## 3. Deploy the TEST MODE application

Create `functions/.env.YOUR_FIREBASE_PROJECT_ID` using `functions/.env.example` as a guide. Keep this file private and out of source control. Set:

```dotenv
APP_MODE=test
PUBLIC_APP_URL=https://YOUR_FIREBASE_PROJECT_ID.web.app
FUNCTIONS_BASE_URL=https://africa-south1-YOUR_FIREBASE_PROJECT_ID.cloudfunctions.net
PROVIDER_ALLOWED_HOSTS=
```

Before the first Functions deployment, create the six Secret Manager entries referenced by the Functions code. They are required at deployment even in TEST MODE. For the test installation, set each value to a harmless placeholder such as `TEST_DISABLED_DO_NOT_USE`; do not use real merchant or supplier credentials here:

```bash
firebase functions:secrets:set PAYSTACK_SECRET_KEY
firebase functions:secrets:set PAYSTACK_WEBHOOK_SECRET
firebase functions:secrets:set HUBTEL_API_ID
firebase functions:secrets:set HUBTEL_API_KEY
firebase functions:secrets:set HUBTEL_COLLECTION_ACCOUNT
firebase functions:secrets:set DATA_PROVIDER_API_KEY
```

Then deploy:

```bash
firebase deploy --only firestore:rules,firestore:indexes,functions,hosting
```

Open `https://YOUR_FIREBASE_PROJECT_ID.web.app`.

In TEST MODE:

- The page displays a permanent test-mode banner.
- A test wallet credit can be added (GH₵5–GH₵500) to exercise the dashboard.
- Test orders are stored with status `test_mode`.
- Test orders do **not** debit the wallet, charge a payment method, or send data to a telco/provider.
- Paystack and Hubtel live top-ups are disabled.

## 4. Create your first administrator

1. Register your own customer account through the website.
2. Verify the email address.
3. Use a secure machine with Application Default Credentials or a service-account JSON stored **outside this project folder**.
4. Run this from the `functions` folder:

```bash
FIREBASE_PROJECT_ID=YOUR_FIREBASE_PROJECT_ID \
GOOGLE_APPLICATION_CREDENTIALS=/secure/path/admin-service-account.json \
node scripts/set-admin.js your-registered-email@example.com
```

5. Sign out and sign in again. The **Admin centre** tab will appear.

Do not give the admin custom claim to ordinary customers. Do not commit the service-account JSON.

## 5. Add your data packages

In **Admin centre → Manage data packages**, enter the network, data size, retail price, provider cost and exact provider bundle code. Keep **Publish this package** unchecked until the price and bundle mapping have been verified with your supplier. The estimated gross margin is calculated from retail price minus the recorded provider cost. Saving a package with the same network and size updates that package's record.

Only packages that are active and have a positive price appear publicly.

## 6. Connect a data supplier API

The provider name and endpoints are configurable in Admin centre. The API key itself is stored separately in Firebase Secret Manager.

The generic adapter expects the supplier to support this contract:

**Submit order** — `POST {baseUrl}{orderPath}`

```json
{
  "network": "MTN",
  "recipient": "233241234567",
  "bundleCode": "SUPPLIER_BUNDLE_CODE",
  "bundleSizeGb": 5,
  "amount": 20.00,
  "clientReference": "FIRESTORE_ORDER_ID"
}
```

The backend sends `Authorization: Bearer <DATA_PROVIDER_API_KEY>`, JSON content type and an `Idempotency-Key` header. The supplier must treat `clientReference` as an idempotency key. Admin recheck/retry first calls the status endpoint and resubmits only after an explicit HTTP 404 or `not_found` status. The retry reuses the exact original order ID as both `clientReference` and `Idempotency-Key`; do not enable retries against a provider that does not guarantee this idempotency behaviour.

Expected response examples:

```json
{"status":"successful","reference":"SUPPLIER-REF-123","message":"Delivered"}
```

```json
{"status":"pending","reference":"SUPPLIER-REF-123","message":"Processing"}
```

```json
{"status":"failed","message":"Invalid recipient"}
```

**Check order** — `GET {baseUrl}{statusPath}`, where `{reference}` is replaced with the Firestore order ID. The backend checks unresolved provider orders every five minutes. A supplier that uses a different request/response shape needs a small adapter mapping in `functions/index.js`; do not assume that a random reseller API is compatible with this generic format.

**Check balance** — `GET {baseUrl}{balancePath}`.

Before enabling the provider:

1. Verify the supplier is legitimate and obtain a sandbox account.
2. Confirm their network identifiers, bundle codes, request fields, response states, timeout rules, refund policy and idempotency support.
3. Update the adapter if required and test each network/size with a non-customer sandbox number.
4. Add the supplier hostname to `PROVIDER_ALLOWED_HOSTS` (host only, comma-separated, exact match) in the project-specific Functions environment file.
5. Set the provider API key as a Functions secret:

```bash
firebase functions:secrets:set DATA_PROVIDER_API_KEY
```

6. Deploy Functions again. Configure the provider in Admin centre, test the balance check, and only then enable live API dispatch.

The backend rejects non-HTTPS URLs and hosts not included in `PROVIDER_ALLOWED_HOSTS` to reduce server-side request forgery risk.

## 7. Configure Paystack and Hubtel wallet funding

Set secrets only after creating and verifying your merchant account:

```bash
firebase functions:secrets:set PAYSTACK_SECRET_KEY
firebase functions:secrets:set PAYSTACK_WEBHOOK_SECRET
firebase functions:secrets:set HUBTEL_API_ID
firebase functions:secrets:set HUBTEL_API_KEY
firebase functions:secrets:set HUBTEL_COLLECTION_ACCOUNT
```

Deploy Functions after setting secrets. For Paystack, configure the webhook URL in your Paystack dashboard:

```text
https://africa-south1-YOUR_FIREBASE_PROJECT_ID.cloudfunctions.net/paystackWebhook
```

The code supports the timestamped `Paystack-Signature` header using the webhook signing secret and the legacy `x-paystack-signature` header using the Paystack secret key. It then independently verifies the transaction with Paystack and checks the exact amount, currency and stored reference before a wallet credit is posted. See the official [Paystack webhooks](https://paystack.com/docs/payments/webhooks/) and [Verify Payments](https://paystack.com/docs/payments/verify-payments/) guides.

Hubtel checkout sends customers to a Hubtel-hosted page. The return URL is **not** considered proof of payment. The callback handler checks the transaction status using Hubtel's authenticated status endpoint and validates the client reference and amount before crediting the wallet. Hubtel's current production callback contract does not define a callback signature; its documentation says to confirm status through the API and use allowlisted server egress. For a production launch, arrange a fixed outbound IP (for example through an appropriately configured Cloud NAT path) and have Hubtel allowlist it. See [Hubtel Online Checkout](https://code.hubtel.com/docs/guides/online-checkout), [Callbacks](https://code.hubtel.com/docs/callbacks) and [Reconciliation](https://code.hubtel.com/docs/guides/reconciliation).

For actual MTN MoMo, Telecel Cash and AT Money acceptance, confirm which channels are enabled on your Paystack/Hubtel merchant account and test each channel with the provider. The application does not claim that every wallet/channel is automatically enabled by adding credentials.

## 8. Switch to LIVE MODE — only after testing

Edit the project-specific Functions environment file:

```dotenv
APP_MODE=live
PUBLIC_APP_URL=https://YOUR_FIREBASE_PROJECT_ID.web.app
FUNCTIONS_BASE_URL=https://africa-south1-YOUR_FIREBASE_PROJECT_ID.cloudfunctions.net
PROVIDER_ALLOWED_HOSTS=api.your-approved-data-provider.com
```

Then deploy Functions again:

```bash
firebase deploy --only functions
```

Before switching to live, confirm all of the following:

- Email verification and password reset work on the deployed domain.
- Firestore rules are deployed and reviewed.
- Admin custom claims are restricted to trusted operators.
- Every package is enabled only after its wholesale code, retail price and cost are checked.
- Paystack/Hubtel live credentials and webhook/callback paths are verified.
- The exact supplier adapter has passed successful, rejected, pending, duplicate and timeout tests.
- Supplier idempotency and status checks work; unknown outcomes remain pending rather than being blindly refunded or resubmitted.
- Refund and support processes have been tested.
- Monitoring, backups, abuse protection, incident contacts and privacy/terms pages have been prepared for your business.

**Do not change `APP_MODE` to `live` merely to remove the banner.** Live mode enables real wallet-funded orders and payment initialization. If the provider is not configured, data orders remain disabled.

## 9. Local emulators

```bash
firebase emulators:start
```

The emulator ports are Auth `9099`, Functions `5001`, Firestore `8080`, Hosting `5000` and Emulator UI `4000`. For a full local auth/data workflow, add emulator connection calls to `public/app.js` in your own development branch and use fictional users only.

## 10. Data model and security

See [docs/database.md](docs/database.md), [docs/architecture.md](docs/architecture.md) and [docs/go-live-checklist.md](docs/go-live-checklist.md).

- The browser can read its own profile, wallet, ledger, orders, referrals and notifications; it cannot write financial records.
- Wallet balance changes, payment verification, order creation, refunds and referral rewards are performed by trusted Cloud Functions.
- Firestore rules deny direct client writes to all protected collections.
- Payment and supplier credentials are Functions secrets; they are never shipped to the browser.
- Amounts are integer pesewas, not floating-point values.

## 11. What still requires your business/provider details

A production system cannot be truthfully connected to a wholesale data API until the actual supplier is selected and its API contract and keys are supplied. Payment merchant approvals, supplier account balances, real bundle prices, WhatsApp support number, business terms and privacy notice are also owner-specific. These are configuration/operational prerequisites, not credentials the project can invent.

## 8. Project files and common edits

The Hosting folder is `public/`. Keep the main page and its assets together:

```text
public/
  index.html
  styles.css
  app.js
  firebase-config.js
```

The stylesheet and module script use relative paths (`./styles.css` and `./app.js`) so they work from the Hosting root and in ordinary folder-based previews. Do not change the stylesheet path to `/css/styles.css` unless you actually create `public/css/styles.css`.

The login and registration dialog is already included in `public/index.html`; the buttons are wired in `public/app.js`. Do not paste a second login modal into the page. Firebase Email/Password authentication must be enabled and the real web configuration must be entered in `public/firebase-config.js` before login or registration can connect to Firebase.

To change an existing bundle price, sign in with the administrator account, open **Admin centre → Manage data packages**, select **Edit** beside the package, change its retail price and cost, then save. The package's network and size identify its catalogue record. Wholesale cost and supplier bundle code are returned only to the administrator and are not exposed in the public catalogue.

## 9. Verification performed on this source bundle

The source bundle has been checked for JavaScript syntax, JSON syntax, duplicate HTML IDs, app.js references to missing HTML IDs, mismatched callable-function names, and missing local CSS/JavaScript files. Those static checks pass. Firebase deployment, live authentication, payment-provider checkout, and real supplier delivery still require your own Firebase project, deployed Functions, approved merchant credentials, and the supplier's exact API documentation. Keep `APP_MODE=test` until those external integrations have been tested end to end.

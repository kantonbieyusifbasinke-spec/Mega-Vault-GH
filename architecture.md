# Application architecture

```text
Customer browser
  ├─ Firebase Authentication (email/password + verification)
  ├─ Firestore (read own account data; callable public catalogue response)
  └─ Callable Cloud Functions (trusted operations)
       ├─ Account/profile bootstrap and referral tracking
       ├─ Wallet ledger + Paystack / Hubtel initialization and verification
       ├─ Idempotent order creation and wallet reservation
       ├─ Generic data-supplier adapter and status reconciliation
       ├─ Support tickets and notifications
       └─ Admin-only catalogue, customer, refund, settings and reporting tools
```

## Trust boundaries

- Browser code is public and untrusted. Prices, user IDs, totals, payment status and provider replies are revalidated in Functions.
- Firebase Auth identifies the current user. Admin access is based on the verified `admin` custom claim, not a client-side role flag.
- Firestore rules are deny-by-default for writes. Wallet and payment records are never directly updated by the customer client; reads of personal records are blocked when the account is suspended.
- Paystack and Hubtel secrets, plus the supplier bearer key, live in Firebase Secret Manager.
- Payment confirmations are checked through provider APIs before wallet credit. A browser redirect is not a proof of payment.
- Provider URLs must use HTTPS and their exact hostname must be included in `PROVIDER_ALLOWED_HOSTS` to reduce SSRF exposure.

## External service adapters

Paystack and Hubtel are wallet-funding adapters. The data provider is a separate fulfilment adapter. This separation allows the business to take a customer payment through one gateway and fulfil data through a selected wholesaler without exposing credentials to the page.

The generic provider adapter implements the documented MEGA VAULT GH contract in `README.md`. If a selected supplier uses different fields, auth headers, endpoint names, status names or response wrapping, implement and test a provider-specific adapter before setting `APP_MODE=live`.

## Current scope boundaries

The app implements Firebase email/password authentication and email verification. Phone numbers are stored as optional profile/recipient data; Firebase Phone Auth / SMS OTP is not enabled in this version. Referral rewards are one-time per referred member and are triggered by that member's first successful provider-confirmed data delivery. The payment integrations fund the wallet; customer orders are then paid from that wallet.

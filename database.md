# Firestore data model

All monetary values use integer pesewas (`pricePesewas`, `balancePesewas`, `amountPesewas`). Timestamps are Firestore server timestamps. A negative wallet balance is possible only when a payment provider later confirms a refund of a top-up that was already credited; new purchases are blocked until additional funds clear that reversal. Admin SDK writes bypass Firestore rules; every callable Function must validate the caller and payload.

| Path | Purpose | Browser access |
|---|---|---|
| `users/{uid}` | Profile, status, role label, referral code, referred-by relationship | Owner/admin read; Functions write |
| `wallets/{uid}` | Current available balance and currency | Owner/admin read; Functions write |
| `transactions/{uid}/entries/{entryId}` | Append-only wallet ledger: credits, purchase debits, refunds, referral rewards | Owner/admin read; Functions write |
| `orders/{orderId}` | Recipient, network, package, amount, provider reference, lifecycle state | Owner/admin read; Functions write |
| `catalog/packages/items/{packageId}` | Bundle catalogue, supplier code, cost, retail price and active flag | Admin-only direct read; customers receive a sanitized active catalogue through `getPublicCatalog` |
| `payments/{reference}` | Payment provider, owner, requested amount, verified/credited state | Owner/admin read; Functions write |
| `referrals/{code}` | Referral-code owner | Owner/admin read; Functions write |
| `referrals/{code}/members/{uid}` | Referral join records | Referred user or code owner/admin read; Functions write |
| `notifications/{uid}/items/{notificationId}` | Customer account and order notifications | Owner/admin read; Functions write |
| `supportTickets/{ticketId}` | Customer complaints and order disputes | Owner/admin read; Functions write |
| `settings/public` | Non-secret public configuration | Public read; admin SDK write |
| `settings/provider` | Provider endpoint configuration (no API key) | Admin through callable Functions |
| `settings/business` | Referral reward and business settings | Admin through callable Functions |
| `idempotency/{hash}` | Prevent duplicate order creation for the same user/request key | No browser access |

## Key lifecycle rules

1. Auth user creation creates a profile, zero-balance wallet and unique referral code.
2. A live wallet top-up creates a pending `payments/{reference}` document first. The payment provider is initialized server-side. A webhook/callback is independently verified server-side. A Firestore transaction then credits the wallet and writes one immutable ledger entry, only if `credited` is not already true.
3. A live wallet purchase verifies the package and account, reserves the wallet amount atomically with the order and debit ledger entry, then sends the order to the supplier using the order ID as an idempotency reference.
4. A provider success marks the order successful. A confirmed provider failure credits the reserved amount back through a single refund ledger entry. An unknown provider result stays pending and is reconciled; it is not blindly refunded or resubmitted.
5. A referral reward is posted once, after the referred customer has their first successfully delivered order, and only when an admin-configured reward amount is greater than zero.

## Status vocabulary

- `test_mode`: order record created in test mode; no charge, wallet debit or delivery.
- `queued`: wallet debit and order were created; provider dispatch is next.
- `processing`: provider request was accepted by the backend.
- `pending_provider`: supplier response is not final and needs reconciliation.
- `retrying`: an administrator is checking supplier status and may resubmit only after an explicit not-found response.
- `successful`: supplier explicitly confirmed delivery.
- `refunded`: confirmed supplier failure and an idempotent wallet refund have been recorded.

Payment records use `initializing`, `pending`, `successful`, `initialization_failed` or `refunded`.

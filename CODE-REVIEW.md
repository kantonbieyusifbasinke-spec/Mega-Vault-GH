# MEGA VAULT GH — source review

Reviewed files: public HTML, CSS and JavaScript; Firebase Hosting configuration; Firestore rules and indexes; Cloud Functions; deployment examples and setup documentation.

## Corrections applied

- Standardized local stylesheet and script references to `./styles.css` and `./app.js`.
- Changed the Firebase configuration import to a relative path so it matches the `public/` folder layout.
- Removed duplicate manual signed-in initialization after login/registration. The Firebase auth-state observer now performs account initialization once per UID and cleans up snapshot listeners on sign-out.
- Made profile/wallet creation idempotent and also bootstrapped it from the profile-completion callable, so registration does not depend solely on the timing of the background Auth event.
- Prevented a real failed-order refund from being marked complete when the customer's wallet document is unexpectedly missing.
- Added an administrator **Edit** action for existing catalogue packages, including retail price, provider cost, supplier code and publication state.

## Static checks

- `node --check public/app.js`: passed.
- `node --check functions/index.js`: passed.
- `npm --prefix functions run lint`: passed.
- All JSON configuration files parse successfully.
- 114 HTML IDs are unique; every ID queried by `public/app.js` exists.
- All 15 callable function names used by the browser code have matching Cloud Function exports.
- Local CSS and script references point to files present under `public/`.

## Not verified

No Firebase project credentials, payment merchant keys, supplier API credentials or supplier API specification were supplied for this review. Therefore the project has not been deployed or live-tested. Paystack, Hubtel and data-supplier operations must be verified in their approved sandbox/test environments. Keep the backend in TEST MODE; do not accept real customer money or claim that bundles are being delivered until the live integrations have been validated.

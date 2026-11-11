/*
 * Promote an account to admin with a Firebase custom claim.
 * Run from functions/: GOOGLE_APPLICATION_CREDENTIALS=/secure/service-account.json \
 *   FIREBASE_PROJECT_ID=your-project node scripts/set-admin.js user@example.com
 * Keep the service-account file outside this repository.
 */
const admin = require('firebase-admin');
const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/set-admin.js user@example.com');
  process.exit(1);
}
admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });
(async () => {
  const user = await admin.auth().getUserByEmail(email);
  await admin.auth().setCustomUserClaims(user.uid, { ...(user.customClaims || {}), admin: true });
  console.log(`Admin claim added to ${email} (${user.uid}). Ask the user to sign out and back in.`);
  process.exit(0);
})().catch((err) => { console.error(err.message); process.exit(1); });

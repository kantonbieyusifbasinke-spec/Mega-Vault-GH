'use strict';

const crypto = require('node:crypto');
const admin = require('firebase-admin');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onUserCreated } = require('firebase-functions/v2/identity');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');

admin.initializeApp();
setGlobalOptions({ region: 'africa-south1', maxInstances: 10 });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const PAYSTACK_SECRET_KEY = defineSecret('PAYSTACK_SECRET_KEY');
const PAYSTACK_WEBHOOK_SECRET = defineSecret('PAYSTACK_WEBHOOK_SECRET');
const HUBTEL_API_ID = defineSecret('HUBTEL_API_ID');
const HUBTEL_API_KEY = defineSecret('HUBTEL_API_KEY');
const HUBTEL_COLLECTION_ACCOUNT = defineSecret('HUBTEL_COLLECTION_ACCOUNT');
const DATA_PROVIDER_API_KEY = defineSecret('DATA_PROVIDER_API_KEY');
const APP_MODE = () => (process.env.APP_MODE || 'test').toLowerCase();
const isLive = () => APP_MODE() === 'live';
const ghs = (pesewas) => Number((Number(pesewas || 0) / 100).toFixed(2));
const cents = (ghsAmount) => Math.round(Number(ghsAmount) * 100);
const now = () => FieldValue.serverTimestamp();
const randomRef = (prefix = 'MV') => `${prefix}${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
const safeString = (value, max = 120) => String(value ?? '').trim().slice(0, max);
const normalizePhone = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  if (/^0[235]\d{8}$/.test(digits)) return `233${digits.slice(1)}`;
  if (/^233[235]\d{8}$/.test(digits)) return digits;
  return null;
};
const requireAuth = (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Please sign in to continue.');
  return request.auth;
};
const requireAdmin = (request) => {
  const auth = requireAuth(request);
  if (auth.token.admin !== true) throw new HttpsError('permission-denied', 'Administrator access is required.');
  return auth;
};
const fail = (code, message) => { throw new HttpsError(code, message); };
async function notifyUser(uid, title, message, type = 'info', reference = null) {
  if (!uid) return;
  await db.collection('notifications').doc(uid).collection('items').add({ title: safeString(title, 100), message: safeString(message, 300), type, reference, read: false, createdAt: now() });
}
async function ensureActive(uid) {
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists || snap.data().active === false) fail('permission-denied', 'This account is not active. Contact support.');
  return snap.data();
}

async function ensureUserRecords(user) {
  const profileRef = db.doc(`users/${user.uid}`);
  const walletRef = db.doc(`wallets/${user.uid}`);
  let createdProfile = false;
  await db.runTransaction(async (tx) => {
    createdProfile = false;
    const [profileSnap, walletSnap] = await Promise.all([tx.get(profileRef), tx.get(walletRef)]);
    if (!profileSnap.exists) {
      const referralCode = crypto.randomBytes(4).toString('hex').toUpperCase();
      tx.create(profileRef, {
        uid: user.uid, email: user.email || null, displayName: user.displayName || '',
        phoneNumber: user.phoneNumber || '', role: 'customer', active: true, referralCode,
        referrerUid: null, referralRewarded: false, createdAt: now(), updatedAt: now()
      });
      tx.create(db.doc(`referrals/${referralCode}`), { ownerUid: user.uid, code: referralCode, createdAt: now() });
      createdProfile = true;
    }
    if (!walletSnap.exists) tx.create(walletRef, { uid: user.uid, balancePesewas: 0, currency: 'GHS', updatedAt: now() });
  });
  return createdProfile;
}

exports.createUserProfile = onUserCreated(async (event) => {
  const user = event.data;
  if (!user) return;
  const createdProfile = await ensureUserRecords(user);
  if (createdProfile) await notifyUser(user.uid, 'Welcome to MEGA VAULT GH', 'Your account is ready. Explore the available data packages to get started.', 'welcome');
});

exports.completeProfile = onCall(async (request) => {
  const auth = requireAuth(request);
  const displayName = safeString(request.data?.displayName, 80);
  const phone = normalizePhone(request.data?.phone || '');
  const referralCode = safeString(request.data?.referralCode, 16).toUpperCase();
  if (displayName.length < 2) fail('invalid-argument', 'Enter your full name.');
  if (request.data?.phone && !phone) fail('invalid-argument', 'Enter a valid Ghana mobile number.');

  // Bootstrap the profile and wallet here as well as in the Auth event trigger.
  // This makes registration resilient if the background trigger is delayed.
  const authUser = await admin.auth().getUser(auth.uid);
  await ensureUserRecords(authUser);
  const userRef = db.doc(`users/${auth.uid}`);
  const userSnap = await userRef.get();
  if (!userSnap.exists) fail('failed-precondition', 'Your profile could not be created. Please retry.');
  const existing = userSnap.data();
  const patch = { displayName, phoneNumber: phone || existing.phoneNumber || '', updatedAt: now() };
  if (referralCode && !existing.referrerUid && referralCode !== existing.referralCode) {
    const refSnap = await db.doc(`referrals/${referralCode}`).get();
    if (!refSnap.exists) fail('invalid-argument', 'That referral code was not found.');
    const referrerUid = refSnap.data().ownerUid;
    if (referrerUid && referrerUid !== auth.uid) {
      patch.referrerUid = referrerUid;
      await db.doc(`referrals/${referralCode}/members/${auth.uid}`).set({ uid: auth.uid, joinedAt: now() });
    }
  }
  await userRef.set(patch, { merge: true });
  return { ok: true };
});

exports.getPublicCatalog = onCall(async () => {
  const snap = await db.collection('catalog').doc('packages').collection('items').where('active', '==', true).orderBy('displayOrder', 'asc').get();
  // Return only safe display fields. Supplier codes, wholesale costs and margins stay private.
  return { mode: APP_MODE(), packages: snap.docs.map((d) => {
    const p = d.data();
    return { id: d.id, name: safeString(p.name, 70), network: p.network, sizeGb: p.sizeGb, pricePesewas: p.pricePesewas, active: p.active, displayOrder: p.displayOrder };
  }) };
});

function validateProviderUrl(baseUrl, path) {
  let url;
  try { url = new URL(baseUrl); } catch { fail('failed-precondition', 'The provider URL is invalid.'); }
  const allowlist = (process.env.PROVIDER_ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (url.protocol !== 'https:' || !allowlist.includes(url.hostname.toLowerCase()) || url.username || url.password || (url.port && url.port !== '443') || url.search || url.hash) {
    fail('failed-precondition', 'Provider host is not HTTPS and allowlisted. Configure PROVIDER_ALLOWED_HOSTS before live sales.');
  }
  if (path && !String(path).startsWith('/')) fail('failed-precondition', 'Provider API paths must start with /.');
  return url;
}

async function providerRequest(config, apiKey, path, method = 'GET', body = undefined) {
  const base = validateProviderUrl(config.baseUrl, path);
  const url = new URL(path, base);
  if (url.hostname !== base.hostname) fail('failed-precondition', 'Provider URL host mismatch.');
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Idempotency-Key': body?.clientReference || ''
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw: raw.slice(0, 500) }; }
  if (!response.ok) {
    const error = new Error(`Provider HTTP ${response.status}`);
    error.statusCode = response.status;
    error.providerResponse = data;
    throw error;
  }
  return data;
}

async function markOrderSuccess(orderRef, providerData = {}) {
  let uidForReward = null;
  await db.runTransaction(async (tx) => {
    uidForReward = null;
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) return;
    const order = orderSnap.data();
    if (['successful', 'refunded'].includes(order.status)) return;
    tx.update(orderRef, {
      status: 'successful',
      providerReference: safeString(providerData.providerReference || providerData.reference || '', 100),
      deliveredAt: now(),
      updatedAt: now(),
      providerMessage: safeString(providerData.message || 'Provider confirmed delivery.', 240)
    });
    uidForReward = order.uid;
  });
  if (uidForReward) {
    await notifyUser(uidForReward, 'Data order successful', `Your ${orderRef.id.slice(0, 10)} order has been confirmed by the data provider.`, 'order_success', orderRef.id);
    await maybeRewardReferrer(uidForReward, orderRef.id);
  }
}

async function maybeRewardReferrer(referredUid, orderId) {
  const profileRef = db.doc(`users/${referredUid}`);
  const profileSnap = await profileRef.get();
  if (!profileSnap.exists) return;
  const profile = profileSnap.data();
  if (!profile.referrerUid || profile.referralRewarded) return;
  const businessSnap = await db.doc('settings/business').get();
  const reward = Number(businessSnap.data()?.referralRewardPesewas || 0);
  if (!Number.isInteger(reward) || reward <= 0) return;
  const inviterUid = profile.referrerUid;
  const inviterWallet = db.doc(`wallets/${inviterUid}`);
  const rewardEntry = db.doc(`transactions/${inviterUid}/entries/referral_${referredUid}_${orderId}`);
  await db.runTransaction(async (tx) => {
    const [freshProfile, walletSnap, entrySnap] = await Promise.all([
      tx.get(profileRef), tx.get(inviterWallet), tx.get(rewardEntry)
    ]);
    if (!freshProfile.exists || freshProfile.data().referralRewarded || entrySnap.exists) return;
    if (!walletSnap.exists) return;
    tx.update(inviterWallet, { balancePesewas: Number(walletSnap.data().balancePesewas || 0) + reward, updatedAt: now() });
    tx.create(rewardEntry, { type: 'referral_reward', amountPesewas: reward, currency: 'GHS', reference: `referral_${referredUid}_${orderId}`, description: 'Referral reward', createdAt: now() });
    tx.update(profileRef, { referralRewarded: true, referralRewardedAt: now() });
  });
}

async function refundFailedOrder(orderRef, reason, providerConfirmedFailure = false) {
  let refundedUid = null;
  await db.runTransaction(async (tx) => {
    refundedUid = null;
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) return;
    const order = orderSnap.data();
    if (order.status === 'refunded' || order.refundedAt) return;
    if (order.status === 'successful') fail('failed-precondition', 'This order is already confirmed as delivered and cannot be automatically refunded.');
    if (order.testMode || order.paymentMethod === 'test_mode') fail('failed-precondition', 'Test-mode orders do not involve real funds and cannot be refunded.');
    if (!providerConfirmedFailure) fail('failed-precondition', 'A confirmed supplier failure is required before issuing a wallet refund.');
    if (order.paymentMethod !== 'wallet') fail('failed-precondition', 'This order payment method is not eligible for automatic wallet refunds.');
    refundedUid = order.uid;
    const walletRef = db.doc(`wallets/${order.uid}`);
    const entryRef = db.doc(`transactions/${order.uid}/entries/refund_${orderRef.id}`);
    const [walletSnap, entrySnap] = await Promise.all([tx.get(walletRef), tx.get(entryRef)]);
    if (entrySnap.exists) {
      tx.update(orderRef, { status: 'refunded', refundedAt: now(), updatedAt: now() });
      return;
    }
    if (!walletSnap.exists) fail('failed-precondition', 'The customer wallet is missing; the refund was not marked complete.');
    if (order.paymentMethod === 'wallet' && Number(order.pricePesewas) > 0) {
      tx.update(walletRef, { balancePesewas: Number(walletSnap.data().balancePesewas || 0) + Number(order.pricePesewas), updatedAt: now() });
      tx.create(entryRef, { type: 'order_refund', amountPesewas: Number(order.pricePesewas), currency: 'GHS', reference: `refund_${orderRef.id}`, description: `Refund for failed order ${orderRef.id}`, createdAt: now() });
    }
    tx.update(orderRef, { status: 'refunded', failureReason: safeString(reason, 240), refundedAt: now(), updatedAt: now() });
  });
  if (refundedUid) await notifyUser(refundedUid, 'Order refund processed', `A refund update was recorded for order ${orderRef.id.slice(0, 10)}.`, 'refund', orderRef.id);
}

exports.placeDataOrder = onCall({ secrets: [DATA_PROVIDER_API_KEY] }, async (request) => {
  const auth = requireAuth(request);
  const userSnap = await db.doc(`users/${auth.uid}`).get();
  if (!userSnap.exists || userSnap.data().active === false) fail('permission-denied', 'This account is not active. Contact support.');
  if (isLive() && auth.token.email && auth.token.email_verified !== true) fail('failed-precondition', 'Verify your email before placing a live order.');
  const packageId = safeString(request.data?.packageId, 90);
  const phone = normalizePhone(request.data?.recipient);
  const idempotencyKey = safeString(request.data?.idempotencyKey, 80);
  if (!packageId || !phone || !/^[a-zA-Z0-9_-]{12,80}$/.test(idempotencyKey)) fail('invalid-argument', 'Select a bundle, enter a valid Ghana number and retry.');
  const packageRef = db.doc(`catalog/packages/items/${packageId}`);
  const packageSnap = await packageRef.get();
  if (!packageSnap.exists || packageSnap.data().active !== true) fail('failed-precondition', 'This data package is not available.');
  const pack = packageSnap.data();
  const price = Number(pack.pricePesewas);
  if (!Number.isInteger(price) || price <= 0) fail('failed-precondition', 'This package has not been priced by the administrator.');
  const mode = APP_MODE();
  if (mode === 'live' && !safeString(pack.providerCode || pack.code, 100)) fail('failed-precondition', 'This package has no verified supplier bundle code. Ask the administrator to correct the catalogue.');
  const providerSnap = await db.doc('settings/provider').get();
  const provider = providerSnap.exists ? providerSnap.data() : null;
  if (mode === 'live') {
    if (!provider?.enabled || !provider.baseUrl || !provider.orderPath || !DATA_PROVIDER_API_KEY.value()) fail('failed-precondition', 'Live data delivery is not configured. Orders are disabled until the provider is connected.');
    validateProviderUrl(provider.baseUrl, provider.orderPath);
  }

  const hash = crypto.createHash('sha256').update(`${auth.uid}:${idempotencyKey}`).digest('hex');
  const idemRef = db.doc(`idempotency/${hash}`);
  const orderRef = db.collection('orders').doc();
  const walletRef = db.doc(`wallets/${auth.uid}`);
  let outputOrderId = orderRef.id;
  let alreadyExisted = false;
  await db.runTransaction(async (tx) => {
    outputOrderId = orderRef.id;
    alreadyExisted = false;
    const [idemSnap, walletSnap] = await Promise.all([tx.get(idemRef), tx.get(walletRef)]);
    if (idemSnap.exists) { outputOrderId = idemSnap.data().orderId; alreadyExisted = true; return; }
    const orderData = {
      uid: auth.uid,
      network: safeString(pack.network, 20),
      packageId,
      packageName: safeString(pack.name || `${pack.sizeGb} GB`, 70),
      sizeGb: Number(pack.sizeGb),
      recipient: phone,
      pricePesewas: price,
      costPesewas: Number(pack.costPesewas || 0),
      currency: 'GHS',
      paymentMethod: mode === 'test' ? 'test_mode' : 'wallet',
      status: mode === 'test' ? 'test_mode' : 'queued',
      testMode: mode !== 'live',
      createdAt: now(),
      updatedAt: now()
    };
    if (mode === 'live') {
      if (!walletSnap.exists || Number(walletSnap.data().balancePesewas || 0) < price) fail('failed-precondition', 'Your wallet balance is too low. Top up first.');
      tx.update(walletRef, { balancePesewas: Number(walletSnap.data().balancePesewas || 0) - price, updatedAt: now() });
      tx.create(db.doc(`transactions/${auth.uid}/entries/order_${orderRef.id}`), {
        type: 'data_purchase', amountPesewas: -price, currency: 'GHS', reference: orderRef.id,
        description: `${pack.network} ${pack.sizeGb} GB data purchase`, createdAt: now()
      });
    }
    tx.create(orderRef, orderData);
    tx.create(idemRef, { uid: auth.uid, orderId: orderRef.id, createdAt: now() });
  });

  if (alreadyExisted) {
    const existing = await db.doc(`orders/${outputOrderId}`).get();
    return { orderId: outputOrderId, status: existing.data()?.status || 'pending', message: 'This request was already recorded.' };
  }
  if (mode !== 'live') {
    await notifyUser(auth.uid, 'Test order recorded', 'This was a test-only order. No money was charged and no data was sent.', 'test_order', outputOrderId);
    return { orderId: outputOrderId, status: 'test_mode', message: 'TEST MODE: no money was charged and no data was delivered.' };
  }
  const orderDoc = db.doc(`orders/${outputOrderId}`);
  try {
    const orderSnap = await orderDoc.get();
    if (!orderSnap.exists || orderSnap.data().status !== 'queued') return { orderId: outputOrderId, status: orderSnap.data()?.status || 'pending' };
    await orderDoc.update({ status: 'processing', updatedAt: now() });
    const data = await providerRequest(provider, DATA_PROVIDER_API_KEY.value(), provider.orderPath, 'POST', {
      network: orderSnap.data().network,
      recipient: orderSnap.data().recipient,
      bundleCode: safeString(pack.providerCode || pack.code || packageId, 100),
      bundleSizeGb: Number(pack.sizeGb),
      amount: ghs(price),
      clientReference: outputOrderId
    });
    const state = String(data.status || data.data?.status || '').toLowerCase();
    if (['success', 'successful', 'delivered', 'completed'].includes(state)) {
      await markOrderSuccess(orderDoc, { providerReference: data.reference || data.data?.reference || data.transactionId, message: data.message });
      return { orderId: outputOrderId, status: 'successful' };
    }
    if (['failed', 'rejected', 'cancelled'].includes(state)) {
      await refundFailedOrder(orderDoc, data.message || 'Provider rejected the order.', true);
      return { orderId: outputOrderId, status: 'refunded', message: 'The provider rejected the request. Your wallet has been refunded.' };
    }
    await orderDoc.update({ status: 'pending_provider', providerReference: safeString(data.reference || data.data?.reference || '', 100), providerMessage: safeString(data.message || 'Waiting for provider confirmation.', 240), updatedAt: now() });
    return { orderId: outputOrderId, status: 'pending_provider', message: 'Order submitted. Waiting for provider confirmation.' };
  } catch (error) {
    // Unknown network outcomes remain pending for reconciliation; do not refund blindly.
    await orderDoc.set({ status: 'pending_provider', failureReason: safeString(error.message, 220), updatedAt: now() }, { merge: true });
    return { orderId: outputOrderId, status: 'pending_provider', message: 'The provider response is not confirmed yet. Check order history before retrying.' };
  }
});

exports.createTestWalletTopup = onCall(async (request) => {
  const auth = requireAuth(request);
  await ensureActive(auth.uid);
  if (isLive()) fail('failed-precondition', 'Test wallet credits are disabled in live mode.');
  const amount = Number(request.data?.amountPesewas);
  if (!Number.isInteger(amount) || amount < 500 || amount > 50000) fail('invalid-argument', 'Test credit must be between GH₵5 and GH₵500.');
  const walletRef = db.doc(`wallets/${auth.uid}`);
  const entryRef = db.collection(`transactions/${auth.uid}/entries`).doc();
  await db.runTransaction(async (tx) => {
    const walletSnap = await tx.get(walletRef);
    if (!walletSnap.exists) fail('failed-precondition', 'Wallet is not ready.');
    tx.update(walletRef, { balancePesewas: Number(walletSnap.data().balancePesewas || 0) + amount, updatedAt: now() });
    tx.create(entryRef, { type: 'test_credit', amountPesewas: amount, currency: 'GHS', reference: entryRef.id, description: 'TEST MODE wallet credit — not real money', testMode: true, createdAt: now() });
  });
  return { ok: true, testMode: true, balanceCreditPesewas: amount };
});

exports.initializePaystackTopup = onCall({ secrets: [PAYSTACK_SECRET_KEY] }, async (request) => {
  const auth = requireAuth(request);
  await ensureActive(auth.uid);
  if (!isLive()) fail('failed-precondition', 'Paystack is disabled in test mode.');
  const amountPesewas = Number(request.data?.amountPesewas);
  if (!Number.isInteger(amountPesewas) || amountPesewas < 500 || amountPesewas > 500000) fail('invalid-argument', 'Enter an amount between GH₵5 and GH₵5,000.');
  const user = await admin.auth().getUser(auth.uid);
  if (!user.email || !user.emailVerified) fail('failed-precondition', 'A verified email is required for payment receipts.');
  const reference = randomRef('MVP');
  const paymentRef = db.doc(`payments/${reference}`);
  await paymentRef.create({ uid: auth.uid, provider: 'paystack', reference, amountPesewas, currency: 'GHS', status: 'initializing', credited: false, createdAt: now() });
  const response = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY.value()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, amount: amountPesewas, currency: 'GHS', reference, callback_url: `${process.env.PUBLIC_APP_URL || ''}/?payment=paystack` }),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json();
  if (!response.ok || !data.status || !data.data?.authorization_url) {
    await paymentRef.update({ status: 'initialization_failed', providerMessage: safeString(data.message || 'Paystack initialization failed.', 220), updatedAt: now() });
    fail('unavailable', 'Could not start Paystack checkout. Please try again.');
  }
  await paymentRef.update({ status: 'pending', updatedAt: now() });
  return { authorizationUrl: data.data.authorization_url, reference };
});

async function verifyPaystack(reference, secret) {
  const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15000)
  });
  const body = await response.json();
  if (!response.ok || !body.status || !body.data) throw new Error('Paystack verification request failed.');
  return body.data;
}

async function creditPayment(reference, provider, verifiedAmountPesewas, currency, transactionId) {
  let newlyCreditedUid = null;
  const paymentRef = db.doc(`payments/${reference}`);
  await db.runTransaction(async (tx) => {
    newlyCreditedUid = null;
    const paymentSnap = await tx.get(paymentRef);
    if (!paymentSnap.exists) throw new Error('Unknown payment reference.');
    const payment = paymentSnap.data();
    if (payment.provider !== provider || Number(payment.amountPesewas) !== Number(verifiedAmountPesewas) || currency !== 'GHS') throw new Error('Payment details do not match our records.');
    if (payment.credited) return;
    newlyCreditedUid = payment.uid;
    const walletRef = db.doc(`wallets/${payment.uid}`);
    const walletSnap = await tx.get(walletRef);
    if (!walletSnap.exists) throw new Error('Wallet is unavailable.');
    const entryRef = db.doc(`transactions/${payment.uid}/entries/topup_${reference}`);
    const entrySnap = await tx.get(entryRef);
    if (!entrySnap.exists) {
      tx.create(entryRef, { type: 'wallet_topup', amountPesewas: Number(payment.amountPesewas), currency: 'GHS', reference, provider, providerTransactionId: safeString(transactionId, 120), description: `${provider} wallet top-up`, createdAt: now() });
      tx.update(walletRef, { balancePesewas: Number(walletSnap.data().balancePesewas || 0) + Number(payment.amountPesewas), updatedAt: now() });
    }
    tx.update(paymentRef, { status: 'successful', credited: true, providerTransactionId: safeString(transactionId, 120), paidAt: now(), updatedAt: now() });
  });
  if (newlyCreditedUid) await notifyUser(newlyCreditedUid, 'Wallet funded', `${provider} confirmed a wallet top-up of GH₵ ${ghs(verifiedAmountPesewas).toFixed(2)}.`, 'wallet_topup', reference);
}

exports.verifyPaystackPayment = onCall({ secrets: [PAYSTACK_SECRET_KEY] }, async (request) => {
  const auth = requireAuth(request);
  const reference = safeString(request.data?.reference, 80);
  const paymentRef = db.doc(`payments/${reference}`);
  const paymentSnap = await paymentRef.get();
  if (!paymentSnap.exists || paymentSnap.data().uid !== auth.uid || paymentSnap.data().provider !== 'paystack') fail('permission-denied', 'Payment reference not found.');
  const data = await verifyPaystack(reference, PAYSTACK_SECRET_KEY.value());
  if (data.status !== 'success') return { status: data.status || 'pending', credited: false };
  await creditPayment(reference, 'paystack', Number(data.amount), String(data.currency || '').toUpperCase(), data.id);
  return { status: 'successful', credited: true };
});

exports.paystackWebhook = onRequest({ secrets: [PAYSTACK_SECRET_KEY, PAYSTACK_WEBHOOK_SECRET], cors: false }, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  try {
    const modernHeader = req.get('paystack-signature') || '';
    const legacyHeader = req.get('x-paystack-signature') || '';
    let valid = false;
    if (modernHeader) {
      const parts = modernHeader.split(',');
      const timePart = parts.find((part) => part.trim().startsWith('t='));
      const timestamp = timePart ? Number(timePart.trim().slice(2)) : NaN;
      const v1Parts = parts.filter((part) => part.trim().startsWith('v1='));
      if (Number.isFinite(timestamp) && Math.abs(Math.floor(Date.now() / 1000) - timestamp) <= 300 && PAYSTACK_WEBHOOK_SECRET.value()) {
        const digest = crypto.createHmac('sha512', PAYSTACK_WEBHOOK_SECRET.value()).update(`${timestamp}.`).update(req.rawBody).digest();
        valid = v1Parts.some((part) => {
          const value = part.trim().slice(3);
          const colon = value.indexOf(':');
          const hex = colon >= 0 ? value.slice(colon + 1) : '';
          if (!/^[0-9a-f]{128}$/.test(hex)) return false;
          const supplied = Buffer.from(hex, 'hex');
          return supplied.length === digest.length && crypto.timingSafeEqual(supplied, digest);
        });
      }
    } else if (legacyHeader) {
      const expected = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY.value()).update(req.rawBody).digest();
      const supplied = /^[0-9a-f]{128}$/.test(legacyHeader) ? Buffer.from(legacyHeader, 'hex') : Buffer.alloc(0);
      valid = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    }
    if (!valid) return res.status(401).send('Invalid signature');
    const event = req.body;
    if (event?.event === 'charge.success' && event.data?.reference) {
      const verified = await verifyPaystack(event.data.reference, PAYSTACK_SECRET_KEY.value());
      if (verified.status === 'success') {
        await creditPayment(String(verified.reference), 'paystack', Number(verified.amount), String(verified.currency || '').toUpperCase(), verified.id);
      }
    }
    return res.status(200).send('ok');
  } catch (error) {
    console.error('Paystack webhook error', error.message);
    return res.status(500).send('Webhook processing failed');
  }
});

exports.initializeHubtelTopup = onCall({ secrets: [HUBTEL_API_ID, HUBTEL_API_KEY, HUBTEL_COLLECTION_ACCOUNT] }, async (request) => {
  const auth = requireAuth(request);
  await ensureActive(auth.uid);
  if (!isLive()) fail('failed-precondition', 'Hubtel is disabled in test mode.');
  const amountPesewas = Number(request.data?.amountPesewas);
  if (!Number.isInteger(amountPesewas) || amountPesewas < 500 || amountPesewas > 500000) fail('invalid-argument', 'Enter an amount between GH₵5 and GH₵5,000.');
  const user = await admin.auth().getUser(auth.uid);
  const reference = randomRef('MVH').slice(0, 30);
  const paymentRef = db.doc(`payments/${reference}`);
  await paymentRef.create({ uid: auth.uid, provider: 'hubtel', reference, amountPesewas, currency: 'GHS', status: 'initializing', credited: false, createdAt: now() });
  const baseUrl = process.env.FUNCTIONS_BASE_URL;
  if (!baseUrl) fail('failed-precondition', 'Set FUNCTIONS_BASE_URL to the deployed functions base URL.');
  const credentials = Buffer.from(`${HUBTEL_API_ID.value()}:${HUBTEL_API_KEY.value()}`).toString('base64');
  const response = await fetch('https://payproxyapi.hubtel.com/items/initiate', {
    method: 'POST', headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      totalAmount: ghs(amountPesewas), description: 'MEGA VAULT GH wallet top-up',
      callbackUrl: `${baseUrl}/hubtelCallback`, returnUrl: `${process.env.PUBLIC_APP_URL || ''}/?payment=hubtel&ref=${reference}`,
      cancellationUrl: `${process.env.PUBLIC_APP_URL || ''}/?payment=cancelled`,
      merchantAccountNumber: HUBTEL_COLLECTION_ACCOUNT.value(), clientReference: reference,
      payeeName: safeString(user.displayName || 'MEGA VAULT GH customer', 60),
      payeeEmail: user.email || undefined, payeeMobileNumber: user.phoneNumber || undefined
    }), signal: AbortSignal.timeout(15000)
  });
  const body = await response.json();
  if (!response.ok || body.responseCode !== '0000' || !body.data?.checkoutUrl) {
    await paymentRef.update({ status: 'initialization_failed', providerMessage: safeString(body.message || 'Hubtel checkout could not be initialized.', 220), updatedAt: now() });
    fail('unavailable', 'Could not start Hubtel checkout. Please try again.');
  }
  await paymentRef.update({ status: 'pending', updatedAt: now() });
  return { checkoutUrl: body.data.checkoutUrl, reference };
});

async function verifyHubtel(reference) {
  const account = HUBTEL_COLLECTION_ACCOUNT.value();
  const credentials = Buffer.from(`${HUBTEL_API_ID.value()}:${HUBTEL_API_KEY.value()}`).toString('base64');
  const url = `https://api-txnstatus.hubtel.com/transactions/${encodeURIComponent(account)}/status?clientReference=${encodeURIComponent(reference)}`;
  const response = await fetch(url, { headers: { Authorization: `Basic ${credentials}` }, signal: AbortSignal.timeout(15000) });
  const body = await response.json();
  if (!response.ok || body.responseCode !== '0000' || !body.data) throw new Error('Hubtel status could not be confirmed.');
  return body.data;
}

async function reverseHubtelRefund(reference) {
  const paymentRef = db.doc(`payments/${reference}`);
  let notifiedUid = null;
  let reversedAmount = 0;
  await db.runTransaction(async (tx) => {
    notifiedUid = null;
    reversedAmount = 0;
    const paymentSnap = await tx.get(paymentRef);
    if (!paymentSnap.exists || paymentSnap.data().provider !== 'hubtel') throw new Error('Unknown Hubtel reference.');
    const payment = paymentSnap.data();
    if (payment.reversed) return;
    const walletRef = db.doc(`wallets/${payment.uid}`);
    const entryRef = db.doc(`transactions/${payment.uid}/entries/topup_reversal_${reference}`);
    const walletSnap = payment.credited ? await tx.get(walletRef) : null;
    const entrySnap = payment.credited ? await tx.get(entryRef) : null;
    if (payment.credited) {
      if (!walletSnap?.exists) throw new Error('Wallet is unavailable for payment reversal.');
      const amount = Number(payment.amountPesewas || 0);
      if (!Number.isInteger(amount) || amount <= 0) throw new Error('The original wallet top-up amount is invalid.');
      if (!entrySnap.exists) {
        // A negative wallet balance locks further purchases until fresh funds clear the reversal.
        tx.update(walletRef, { balancePesewas: Number(walletSnap.data().balancePesewas || 0) - amount, updatedAt: now() });
        tx.create(entryRef, { type: 'wallet_topup_reversal', amountPesewas: -amount, currency: 'GHS', reference, provider: 'hubtel', description: 'Reversal of a Hubtel-refunded wallet top-up', createdAt: now() });
      }
      reversedAmount = amount;
      notifiedUid = payment.uid;
    }
    tx.update(paymentRef, { status: 'refunded', reversed: true, reversedAt: now(), updatedAt: now() });
  });
  if (notifiedUid) await notifyUser(notifiedUid, 'Wallet top-up reversed', `Hubtel confirmed a refund for top-up ${reference}. The wallet credit was reversed by GH₵ ${ghs(reversedAmount).toFixed(2)}.`, 'wallet_reversal', reference);
}

async function settleHubtel(reference) {
  const status = await verifyHubtel(reference);
  const paymentSnap = await db.doc(`payments/${reference}`).get();
  if (!paymentSnap.exists || paymentSnap.data().provider !== 'hubtel') throw new Error('Unknown Hubtel reference.');
  if (status.clientReference !== reference) throw new Error('Hubtel reference mismatch.');
  if (status.status === 'Paid') {
    await creditPayment(reference, 'hubtel', cents(status.amount), String(status.currencyCode || 'GHS').toUpperCase(), status.transactionId);
    const settled = await db.doc(`payments/${reference}`).get();
    return settled.data()?.status === 'successful' ? 'successful' : 'refunded';
  }
  if (status.status === 'Refunded') {
    await reverseHubtelRefund(reference);
    return 'refunded';
  }
  return 'pending';
}

exports.refreshHubtelPayment = onCall({ secrets: [HUBTEL_API_ID, HUBTEL_API_KEY, HUBTEL_COLLECTION_ACCOUNT] }, async (request) => {
  const auth = requireAuth(request);
  const reference = safeString(request.data?.reference, 80);
  const paymentSnap = await db.doc(`payments/${reference}`).get();
  if (!paymentSnap.exists || paymentSnap.data().uid !== auth.uid || paymentSnap.data().provider !== 'hubtel') fail('permission-denied', 'Payment reference not found.');
  const status = await settleHubtel(reference);
  return { status, credited: status === 'successful' };
});

exports.hubtelCallback = onRequest({ secrets: [HUBTEL_API_ID, HUBTEL_API_KEY, HUBTEL_COLLECTION_ACCOUNT], cors: false }, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  try {
    const reference = safeString(req.body?.Data?.ClientReference || req.body?.data?.clientReference || '', 80);
    if (!reference) return res.status(400).send('Missing client reference');
    // Hubtel v1 callbacks have no production signature contract. Always confirm
    // the reference, amount and Paid status against the authenticated status API.
    await settleHubtel(reference);
    return res.status(200).send('ok');
  } catch (error) {
    console.error('Hubtel callback error', error.message);
    return res.status(500).send('Callback processing failed');
  }
});

exports.adminDashboard = onCall(async (request) => {
  requireAdmin(request);
  const [usersCount, ordersCount, paymentsCount, ledgerCount, users, orders, failed, pending, successful] = await Promise.all([
    db.collection('users').count().get(), db.collection('orders').count().get(), db.collection('payments').count().get(),
    db.collectionGroup('entries').count().get(),
    db.collection('users').orderBy('createdAt', 'desc').limit(100).get(),
    db.collection('orders').orderBy('createdAt', 'desc').limit(100).get(),
    db.collection('orders').where('status', 'in', ['failed', 'refunded']).count().get(),
    db.collection('orders').where('status', 'in', ['queued', 'processing', 'pending_provider', 'retrying']).count().get(),
    db.collection('orders').where('status', '==', 'successful').get()
  ]);
  const revenue = successful.docs.reduce((sum, doc) => sum + Number(doc.data().pricePesewas || 0), 0);
  const cost = successful.docs.reduce((sum, doc) => sum + Number(doc.data().costPesewas || 0), 0);
  const [tickets, packageSnap, providerSnap, businessSnap, ledgerRows, paymentRows] = await Promise.all([
    db.collection('supportTickets').orderBy('createdAt', 'desc').limit(50).get(),
    db.collection('catalog').doc('packages').collection('items').orderBy('displayOrder', 'asc').get(),
    db.doc('settings/provider').get(), db.doc('settings/business').get(),
    db.collectionGroup('entries').orderBy('createdAt', 'desc').limit(100).get(),
    db.collection('payments').orderBy('createdAt', 'desc').limit(100).get()
  ]);
  return {
    metrics: { users: usersCount.data().count, orders: ordersCount.data().count, transactions: ledgerCount.data().count, payments: paymentsCount.data().count, revenuePesewas: revenue, profitPesewas: revenue - cost, failed: failed.data().count, pending: pending.data().count, successful: successful.size },
    users: users.docs.map(d => ({ uid: d.id, ...d.data() })),
    orders: orders.docs.map(d => ({ id: d.id, ...d.data() })),
    transactions: ledgerRows.docs.map(d => ({ id: d.id, uid: d.ref.parent.parent?.id || '', ...d.data() })),
    paymentRecords: paymentRows.docs.map(d => {
      const p = d.data();
      return { id: d.id, uid: p.uid, provider: p.provider, amountPesewas: p.amountPesewas, currency: p.currency, status: p.status, credited: p.credited, providerTransactionId: p.providerTransactionId || '', createdAt: p.createdAt, paidAt: p.paidAt || null };
    }),
    tickets: tickets.docs.map(d => ({ id: d.id, ...d.data() })),
    packages: packageSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    provider: providerSnap.exists ? providerSnap.data() : { enabled: false, mode: 'not_configured' },
    business: businessSnap.exists ? businessSnap.data() : { referralRewardPesewas: 0 }
  };
});

exports.adminSavePackage = onCall(async (request) => {
  requireAdmin(request);
  const p = request.data || {};
  const id = safeString(p.id || `${safeString(p.network, 18).toLowerCase()}_${Number(p.sizeGb)}gb`, 90).replace(/[^a-zA-Z0-9_-]/g, '_');
  const network = safeString(p.network, 18).toUpperCase();
  const sizeGb = Number(p.sizeGb);
  const pricePesewas = Number(p.pricePesewas);
  const costPesewas = Number(p.costPesewas || 0);
  const providerCode = safeString(p.providerCode || p.code || '', 100);
  if (p.active === true && !providerCode) fail('invalid-argument', 'Enter the exact supplier bundle code before publishing this package.');
  if (!['MTN', 'TELECEL', 'AT'].includes(network) || !Number.isFinite(sizeGb) || sizeGb <= 0 || sizeGb > 1000 || !Number.isInteger(pricePesewas) || pricePesewas <= 0 || pricePesewas > 1000000 || !Number.isInteger(costPesewas) || costPesewas < 0 || costPesewas > pricePesewas) fail('invalid-argument', 'Enter valid network, size, retail price and cost (cost cannot exceed retail price).');
  const data = {
    network, sizeGb, pricePesewas, costPesewas, profitPesewas: pricePesewas - costPesewas, currency: 'GHS',
    name: `${sizeGb} GB ${network}`, code: providerCode, providerCode,
    active: p.active === true, displayOrder: Number(p.displayOrder || 100), updatedAt: now()
  };
  await db.doc(`catalog/packages/items/${id}`).set(data, { merge: true });
  return { ok: true, id };
});

exports.adminDeletePackage = onCall(async (request) => {
  requireAdmin(request);
  const id = safeString(request.data?.id, 90);
  if (!id) fail('invalid-argument', 'Package ID is required.');
  await db.doc(`catalog/packages/items/${id}`).set({ active: false, updatedAt: now() }, { merge: true });
  return { ok: true };
});

exports.adminSetPackageActive = onCall(async (request) => {
  requireAdmin(request);
  const id = safeString(request.data?.id, 90);
  const active = request.data?.active === true;
  if (!id) fail('invalid-argument', 'Package ID is required.');
  const ref = db.doc(`catalog/packages/items/${id}`);
  const snap = await ref.get();
  if (!snap.exists) fail('not-found', 'Package was not found.');
  if (active && !safeString(snap.data().providerCode || snap.data().code, 100)) fail('failed-precondition', 'Add the exact supplier bundle code before publishing this package.');
  await ref.update({ active, updatedAt: now() });
  return { ok: true, active };
});

exports.adminSaveProvider = onCall(async (request) => {
  requireAdmin(request);
  const p = request.data || {};
  const provider = {
    name: safeString(p.name || 'Generic Ghana data provider', 80),
    baseUrl: safeString(p.baseUrl, 200),
    orderPath: safeString(p.orderPath || '/orders', 100),
    statusPath: safeString(p.statusPath || '/orders/{reference}', 120),
    balancePath: safeString(p.balancePath || '/balance', 100),
    enabled: p.enabled === true,
    updatedAt: now()
  };
  if (provider.enabled) validateProviderUrl(provider.baseUrl, provider.orderPath);
  await db.doc('settings/provider').set(provider, { merge: true });
  return { ok: true, note: 'API keys are configured separately in Firebase Secret Manager.' };
});

exports.adminCheckProviderBalance = onCall({ secrets: [DATA_PROVIDER_API_KEY] }, async (request) => {
  requireAdmin(request);
  const snap = await db.doc('settings/provider').get();
  if (!snap.exists || !snap.data().enabled || !DATA_PROVIDER_API_KEY.value()) fail('failed-precondition', 'Provider settings or secret key are missing.');
  const config = snap.data();
  const result = await providerRequest(config, DATA_PROVIDER_API_KEY.value(), config.balancePath || '/balance');
  return { result };
});

exports.adminRetryProviderOrder = onCall({ secrets: [DATA_PROVIDER_API_KEY] }, async (request) => {
  requireAdmin(request);
  const orderId = safeString(request.data?.orderId, 128);
  if (!orderId) fail('invalid-argument', 'Order ID is required.');
  if (!DATA_PROVIDER_API_KEY.value()) fail('failed-precondition', 'The supplier API key is not configured.');
  const orderRef = db.doc(`orders/${orderId}`);
  let order;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) fail('not-found', 'Order was not found.');
    const data = snap.data();
    if (data.testMode || ['successful', 'refunded'].includes(data.status)) fail('failed-precondition', 'This order is not eligible for a live provider retry.');
    const leaseTime = data.retryStartedAt?.toMillis ? data.retryStartedAt.toMillis() : 0;
    if (data.status === 'retrying' && Date.now() - leaseTime < 120000) fail('aborted', 'This order is already being retried. Check again shortly.');
    if (!['queued', 'processing', 'pending_provider', 'retrying'].includes(data.status)) fail('failed-precondition', 'Only unresolved provider orders can be retried.');
    order = data;
    tx.update(orderRef, { status: 'retrying', retryStartedAt: admin.firestore.Timestamp.now(), retryCount: Number(data.retryCount || 0) + 1, updatedAt: now() });
  });

  const providerSnap = await db.doc('settings/provider').get();
  if (!providerSnap.exists || !providerSnap.data().enabled) {
    await orderRef.update({ status: 'pending_provider', retryError: 'Supplier is not enabled.', updatedAt: now() });
    fail('failed-precondition', 'The supplier is not enabled.');
  }
  const provider = providerSnap.data();
  try {
    // First query the supplier. Never re-submit when an accepted/pending order exists.
    const statusPath = String(provider.statusPath || '/orders/{reference}').replace('{reference}', encodeURIComponent(orderId));
    let knownStatus = null;
    try {
      knownStatus = await providerRequest(provider, DATA_PROVIDER_API_KEY.value(), statusPath);
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }
    const state = String(knownStatus?.status || knownStatus?.data?.status || '').toLowerCase();
    if (['success', 'successful', 'delivered', 'completed'].includes(state)) {
      await markOrderSuccess(orderRef, knownStatus);
      return { orderId, status: 'successful', message: 'The supplier confirmed delivery.' };
    }
    if (['failed', 'rejected', 'cancelled'].includes(state)) {
      await refundFailedOrder(orderRef, knownStatus.message || 'Supplier confirmed failure.', true);
      return { orderId, status: 'refunded', message: 'The supplier confirmed failure and the wallet was refunded.' };
    }
    const notFound = !knownStatus || ['not_found', 'not found', 'does_not_exist'].includes(state);
    if (!notFound) {
      await orderRef.update({ status: 'pending_provider', providerMessage: safeString(knownStatus?.message || 'Supplier still reports this order as pending.', 240), updatedAt: now() });
      return { orderId, status: 'pending_provider', message: 'The supplier already knows this order. It was not submitted again.' };
    }

    // The supplier explicitly reports no order (404/not_found). Re-submit using
    // the original order ID as both clientReference and Idempotency-Key.
    const packageSnap = await db.doc(`catalog/packages/items/${order.packageId}`).get();
    if (!packageSnap.exists) throw new Error('The original package mapping is missing; provider retry was stopped.');
    const pack = packageSnap.data();
    const submitted = await providerRequest(provider, DATA_PROVIDER_API_KEY.value(), provider.orderPath || '/orders', 'POST', {
      network: order.network, recipient: order.recipient,
      bundleCode: safeString(pack.providerCode || pack.code || order.packageId, 100),
      bundleSizeGb: Number(order.sizeGb), amount: ghs(Number(order.pricePesewas)), clientReference: orderId
    });
    const submittedState = String(submitted.status || submitted.data?.status || '').toLowerCase();
    if (['success', 'successful', 'delivered', 'completed'].includes(submittedState)) {
      await markOrderSuccess(orderRef, { ...submitted, providerReference: submitted.reference || submitted.data?.reference || '' });
      return { orderId, status: 'successful', message: 'The supplier confirmed delivery.' };
    }
    if (['failed', 'rejected', 'cancelled'].includes(submittedState)) {
      await refundFailedOrder(orderRef, submitted.message || 'Supplier rejected the retried order.', true);
      return { orderId, status: 'refunded', message: 'The supplier rejected the order and the wallet was refunded.' };
    }
    await orderRef.update({ status: 'pending_provider', providerReference: safeString(submitted.reference || submitted.data?.reference || '', 100), providerMessage: safeString(submitted.message || 'Retry accepted; awaiting supplier confirmation.', 240), updatedAt: now() });
    return { orderId, status: 'pending_provider', message: 'Retry accepted. Delivery confirmation is pending.' };
  } catch (error) {
    await orderRef.update({ status: 'pending_provider', retryError: safeString(error.message, 220), updatedAt: now() });
    throw new HttpsError('unavailable', 'Supplier status is still uncertain. The order remains pending; no additional charge was made.');
  }
});

exports.adminSetCustomerStatus = onCall(async (request) => {
  const adminAuth = requireAdmin(request);
  const uid = safeString(request.data?.uid, 128);
  if (!uid) fail('invalid-argument', 'Customer UID is required.');
  const active = request.data?.active === true;
  if (uid === adminAuth.uid && !active) fail('failed-precondition', 'You cannot suspend your own administrator account.');
  const profileRef = db.doc(`users/${uid}`);
  const profileSnap = await profileRef.get();
  if (!profileSnap.exists) fail('not-found', 'Customer profile was not found.');
  // Disable the Firebase Auth account as well as blocking app-level operations.
  await admin.auth().updateUser(uid, { disabled: !active });
  await profileRef.update({ active, updatedAt: now() });
  return { ok: true, active };
});

exports.adminUpdateBusinessSettings = onCall(async (request) => {
  requireAdmin(request);
  const reward = Number(request.data?.referralRewardPesewas || 0);
  if (!Number.isInteger(reward) || reward < 0 || reward > 50000) fail('invalid-argument', 'Referral reward must be between GH₵0 and GH₵500.');
  await db.doc('settings/business').set({ referralRewardPesewas: reward, updatedAt: now() }, { merge: true });
  return { ok: true };
});

exports.adminResolveTicket = onCall(async (request) => {
  requireAdmin(request);
  const ticketId = safeString(request.data?.ticketId, 128);
  const status = safeString(request.data?.status, 20);
  if (!ticketId || !['open', 'in_review', 'resolved'].includes(status)) fail('invalid-argument', 'Invalid ticket update.');
  await db.doc(`supportTickets/${ticketId}`).update({ status, adminNote: safeString(request.data?.adminNote, 500), updatedAt: now() });
  return { ok: true };
});

exports.adminRefundOrder = onCall({ secrets: [DATA_PROVIDER_API_KEY] }, async (request) => {
  requireAdmin(request);
  const orderId = safeString(request.data?.orderId, 128);
  if (!orderId) fail('invalid-argument', 'Order ID is required.');
  const orderRef = db.doc(`orders/${orderId}`);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) fail('not-found', 'Order was not found.');
  const order = orderSnap.data();
  if (order.testMode || ['successful', 'refunded'].includes(order.status)) fail('failed-precondition', 'Only unresolved live orders can be reviewed for a refund.');
  const providerSnap = await db.doc('settings/provider').get();
  if (!providerSnap.exists || !providerSnap.data().enabled || !DATA_PROVIDER_API_KEY.value()) fail('failed-precondition', 'Connect the supplier API before verifying a refund.');
  const provider = providerSnap.data();
  const statusPath = String(provider.statusPath || '/orders/{reference}').replace('{reference}', encodeURIComponent(orderId));
  const providerStatus = await providerRequest(provider, DATA_PROVIDER_API_KEY.value(), statusPath);
  const state = String(providerStatus.status || providerStatus.data?.status || '').toLowerCase();
  if (!['failed', 'rejected', 'cancelled'].includes(state)) fail('failed-precondition', 'The supplier has not confirmed that this order failed. No refund was issued.');
  await refundFailedOrder(orderRef, safeString(request.data?.reason || providerStatus.message || 'Supplier-confirmed failure.', 220), true);
  return { ok: true };
});

exports.submitSupportTicket = onCall(async (request) => {
  const auth = requireAuth(request);
  await ensureActive(auth.uid);
  const subject = safeString(request.data?.subject, 100);
  const message = safeString(request.data?.message, 1500);
  const orderId = safeString(request.data?.orderId, 128);
  if (subject.length < 4 || message.length < 10) fail('invalid-argument', 'Enter a subject and a message of at least 10 characters.');
  if (orderId) {
    const order = await db.doc(`orders/${orderId}`).get();
    if (!order.exists || order.data().uid !== auth.uid) fail('permission-denied', 'That order does not belong to your account.');
  }
  const ref = db.collection('supportTickets').doc();
  await ref.set({ uid: auth.uid, subject, message, orderId: orderId || null, status: 'open', createdAt: now(), updatedAt: now() });
  return { ok: true, ticketId: ref.id };
});

exports.reconcilePendingOrders = onSchedule({ schedule: 'every 5 minutes', secrets: [DATA_PROVIDER_API_KEY], timeZone: 'Africa/Accra' }, async () => {
  if (!isLive() || !DATA_PROVIDER_API_KEY.value()) return;
  const providerSnap = await db.doc('settings/provider').get();
  if (!providerSnap.exists || !providerSnap.data().enabled) return;
  const provider = providerSnap.data();
  const pending = await db.collection('orders').where('status', 'in', ['queued', 'processing', 'pending_provider', 'retrying']).limit(50).get();
  for (const doc of pending.docs) {
    const row = doc.data();
    const latestAttempt = row.retryStartedAt?.toMillis ? row.retryStartedAt.toMillis() : (row.updatedAt?.toMillis ? row.updatedAt.toMillis() : 0);
    if (['queued', 'processing', 'retrying'].includes(row.status) && Date.now() - latestAttempt < 120000) continue;
    try {
      const path = String(provider.statusPath || '/orders/{reference}').replace('{reference}', encodeURIComponent(doc.id));
      const result = await providerRequest(provider, DATA_PROVIDER_API_KEY.value(), path);
      const state = String(result.status || result.data?.status || '').toLowerCase();
      if (['success', 'successful', 'delivered', 'completed'].includes(state)) await markOrderSuccess(doc.ref, result);
      else if (['failed', 'rejected', 'cancelled'].includes(state)) await refundFailedOrder(doc.ref, result.message || 'Provider confirmed failure.', true);
      else await doc.ref.update({ status: 'pending_provider', lastCheckedAt: now(), updatedAt: now() });
    } catch (error) {
      console.error(`Order reconciliation ${doc.id}:`, error.message);
      await doc.ref.update({ lastCheckedAt: now(), reconciliationError: safeString(error.message, 180), updatedAt: now() });
    }
  }
});

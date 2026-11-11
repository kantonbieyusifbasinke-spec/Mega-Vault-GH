import { firebaseConfig, appConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, sendEmailVerification, sendPasswordResetEmail
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, collection, query, where, orderBy, limit, getDocs, onSnapshot
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-functions.js';

const $ = (id) => document.getElementById(id);
const money = (pesewas) => `GH₵ ${(Number(pesewas || 0) / 100).toFixed(2)}`;
const escapeHTML = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const phoneLocal = (value) => String(value || '').replace(/\D/g, '').replace(/^233/, '0');
const niceDate = (value) => {
  const date = value?.toDate ? value.toDate() : (value ? new Date(value) : null);
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString('en-GH', { dateStyle: 'medium', timeStyle: 'short' }) : 'Just now';
};
const makeKey = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID().replaceAll('-', '') : `${Date.now()}${Math.random().toString(16).slice(2)}`);

let app, auth, db, functions;
let currentUser = null;
let userProfile = null;
let isAdmin = false;
let packages = [];
let currentMode = 'test';
let pendingOrderAttempt = null;
let unsubWallet = null;
let unsubOrders = null;
let toastTimer;
let authTab = 'login';
let authStateUid = undefined;

function showToast(message, kind = 'ok') {
  const toast = $('toast');
  toast.textContent = message;
  toast.className = `toast show${kind === 'error' ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 4200);
}
function setButtonBusy(button, busy, label) {
  if (!button) return;
  if (busy) { button.dataset.originalText = button.innerHTML; button.disabled = true; button.textContent = label || 'Please wait…'; }
  else { button.disabled = false; if (button.dataset.originalText) button.innerHTML = button.dataset.originalText; }
}
function call(name, payload = {}) {
  if (!functions) throw new Error('Firebase is not configured yet. Add your Firebase Web App settings in public/firebase-config.js.');
  return httpsCallable(functions, name)(payload).then((r) => r.data);
}
function isConfigured() {
  return firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith('REPLACE_') && firebaseConfig.projectId && !String(firebaseConfig.projectId).startsWith('YOUR_');
}
function formatError(error) {
  const messages = {
    'auth/email-already-in-use': 'An account with that email already exists.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/weak-password': 'Use a stronger password with at least 8 characters.',
    'auth/invalid-credential': 'Your email or password is incorrect.',
    'auth/user-disabled': 'This account has been disabled. Contact support.',
    'auth/too-many-requests': 'Too many attempts. Please wait and try again.'
  };
  return messages[error?.code] || error?.message || 'Something went wrong. Please try again.';
}
function showAuth(tab = 'login', message = '') {
  $('authModal').classList.remove('hidden');
  switchAuth(tab);
  $('authMessage').textContent = message;
  document.body.style.overflow = 'hidden';
}
function hideAuth() {
  $('authModal').classList.add('hidden');
  document.body.style.overflow = '';
}
function switchAuth(tab) {
  authTab = tab;
  document.querySelectorAll('[data-auth-tab]').forEach((button) => button.classList.toggle('active', button.dataset.authTab === tab));
  $('loginForm').classList.toggle('hidden', tab !== 'login');
  $('registerForm').classList.toggle('hidden', tab !== 'register');
  $('authTitle').textContent = tab === 'login' ? 'Welcome back.' : 'Create your account.';
  $('authSubtitle').textContent = tab === 'login' ? 'Sign in to access your account and orders.' : 'Your MEGA VAULT GH account starts here.';
  $('authMessage').textContent = '';
}
function activateTab(tab) {
  document.querySelectorAll('.account-tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
  document.querySelectorAll('.account-view').forEach((view) => view.classList.toggle('active', view.id === `view-${tab}`));
  if (tab === 'admin' && isAdmin) loadAdmin();
  if (tab === 'referrals') loadReferralHistory();
  $('accountPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function openAccount(tab = 'overview') {
  if (!currentUser) { showAuth('login'); return; }
  $('accountPanel').classList.remove('hidden');
  activateTab(tab);
}

function renderCatalog(list = packages) {
  const grid = $('catalogGrid');
  const active = list.filter((p) => p.active === true && Number(p.pricePesewas) > 0);
  if (!active.length) {
    grid.innerHTML = `<div class="empty-catalog"><span>◌</span><b>Bundles are being prepared</b><small>Our team is setting up approved package prices. Please check back soon.</small></div>`;
    $('catalogMode').textContent = currentMode === 'test' ? 'TEST ENVIRONMENT' : 'LIVE CATALOGUE';
    return;
  }
  grid.innerHTML = active.slice(0, 6).map((p) => `
    <button type="button" class="bundle-card" data-package-card="${escapeHTML(p.id)}">
      <span class="bundle-network">${escapeHTML(p.network)} DATA</span>
      <strong>${Number(p.sizeGb)} <small>GB</small></strong>
      <span class="bundle-price">${money(p.pricePesewas)}</span>
      <span class="bundle-select">Select this bundle ↗</span>
    </button>`).join('');
  $('catalogMode').textContent = currentMode === 'test' ? 'TEST CATALOGUE' : 'AVAILABLE NOW';
  grid.querySelectorAll('[data-package-card]').forEach((button) => button.addEventListener('click', () => choosePackage(button.dataset.packageCard)));
}
function renderPackageOptions(network = '') {
  const select = $('packageSelect');
  const options = packages.filter((p) => p.active === true && Number(p.pricePesewas) > 0 && (!network || p.network === network));
  select.innerHTML = '<option value="">Choose a data bundle</option>' + options.map((p) => `<option value="${escapeHTML(p.id)}">${Number(p.sizeGb)} GB — ${money(p.pricePesewas)}</option>`).join('');
  select.disabled = options.length === 0;
  if (!options.length) select.innerHTML = `<option value="">${network ? 'No bundles available for this network' : 'Choose network first'}</option>`;
  updateOrderPrice();
}
function choosePackage(id) {
  const pack = packages.find((p) => p.id === id);
  if (!pack) return;
  $('networkSelect').value = pack.network;
  renderPackageOptions(pack.network);
  $('packageSelect').value = id;
  updateOrderPrice();
  $('buy').scrollIntoView({ behavior: 'smooth' });
  document.querySelectorAll('.network-card').forEach((c) => c.classList.toggle('selected', c.dataset.network === pack.network));
}
function selectedPack() { return packages.find((p) => p.id === $('packageSelect').value); }
function updateOrderPrice() {
  const p = selectedPack();
  $('orderPrice').textContent = p ? money(p.pricePesewas) : 'GH₵ —';
  $('orderPriceNote').textContent = p ? `${p.sizeGb} GB · ${p.network}` : 'Select a bundle';
}
async function loadCatalog() {
  if (!functions) {
    $('catalogMode').textContent = 'SETUP REQUIRED';
    $('catalogGrid').innerHTML = `<div class="empty-catalog"><span>◇</span><b>Connect your Firebase project</b><small>Add your Firebase web configuration to enable the live catalogue.</small></div>`;
    return;
  }
  try {
    const data = await call('getPublicCatalog');
    packages = data.packages || [];
    currentMode = data.mode || currentMode;
    updateModeUI();
    renderCatalog();
    renderPackageOptions($('networkSelect').value);
  } catch (error) {
    $('catalogGrid').innerHTML = `<div class="empty-catalog"><span>!</span><b>Catalogue unavailable</b><small>${escapeHTML(error.message)}</small></div>`;
  }
}
function updateModeUI() {
  $('testRibbon').classList.toggle('hidden', currentMode === 'live');
  $('walletModeText').textContent = currentMode === 'live' ? 'Live account balance' : 'Simulated test balance';
  $('walletStatusLabel').textContent = currentMode === 'live' ? 'Live wallet' : 'TEST MODE wallet';
  $('testTopupButton').classList.toggle('hidden', currentMode === 'live');
  $('paystackTopupButton').classList.toggle('hidden', currentMode !== 'live');
  $('hubtelTopupButton').classList.toggle('hidden', currentMode !== 'live');
  $('walletExplain').textContent = currentMode === 'live'
    ? 'Wallet funding is confirmed by the payment provider on the server. Never share your MoMo PIN or approve a request you did not initiate.'
    : 'Test credits are simulated and are not real money. Test orders are recorded for workflow checks only; no real data is delivered and no wallet is debited.';
  $('orderNote').textContent = currentMode === 'live'
    ? 'Live orders debit your wallet and are sent to the configured data provider.'
    : 'Test mode: you can try the order flow, but no real payment or data delivery will occur.';
}

async function waitForProfile(name, phone, referral) {
  let lastError;
  for (let i = 0; i < 5; i++) {
    try { return await call('completeProfile', { displayName: name, phone, referralCode: referral }); }
    catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 700)); }
  }
  throw lastError;
}

async function handleRegister(event) {
  event.preventDefault();
  if (!auth) return showToast('Connect Firebase Authentication first.', 'error');
  const button = $('registerForm').querySelector('button[type="submit"]');
  setButtonBusy(button, true, 'Creating account…');
  try {
    const name = $('registerName').value.trim();
    const email = $('registerEmail').value.trim();
    const password = $('registerPassword').value;
    const phone = $('registerPhone').value.trim();
    const referral = $('registerReferral').value.trim().toUpperCase();
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    try { await sendEmailVerification(cred.user); } catch (e) { console.warn('Email verification could not be sent:', e.message); }
    try { await waitForProfile(name, phone, referral); }
    catch (error) { console.warn('Profile completion:', error.message); }
    $('registerForm').reset();
    hideAuth();
    showToast('Account created. Check your email for a verification link.');
    // The onAuthStateChanged observer performs the signed-in setup once.
  } catch (error) { $('authMessage').textContent = formatError(error); }
  finally { setButtonBusy(button, false); }
}
async function handleLogin(event) {
  event.preventDefault();
  if (!auth) return showToast('Connect Firebase Authentication first.', 'error');
  const button = $('loginForm').querySelector('button[type="submit"]');
  setButtonBusy(button, true, 'Signing in…');
  try {
    const cred = await signInWithEmailAndPassword(auth, $('loginEmail').value.trim(), $('loginPassword').value);
    $('loginForm').reset(); hideAuth(); showToast('You are signed in.');
  } catch (error) { $('authMessage').textContent = formatError(error); }
  finally { setButtonBusy(button, false); }
}
async function afterSignIn(user) {
  currentUser = user;
  $('guestActions').classList.add('hidden'); $('signedActions').classList.remove('hidden');
  $('accountPanel').classList.remove('hidden');
  await loadUserProfile();
  await checkAdminClaim();
  attachWalletListener();
  attachOrderListener();
  await loadNotifications();
  await checkPaymentReturn();
  activateTab('overview');
  $('accountPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function loadUserProfile() {
  if (!currentUser) return;
  try {
    const snap = await getDoc(doc(db, 'users', currentUser.uid));
    userProfile = snap.exists() ? snap.data() : {};
    const name = userProfile.displayName || currentUser.displayName || currentUser.email?.split('@')[0] || 'Customer';
    $('accountName').textContent = name.split(' ')[0];
    $('sideUserName').textContent = name;
    $('accountEmail').textContent = currentUser.email || '';
    $('accountAvatar').textContent = name.slice(0, 2).toUpperCase();
    $('avatarButton').textContent = name.slice(0, 2).toUpperCase();
    $('profileName').value = userProfile.displayName || name;
    $('profilePhone').value = phoneLocal(userProfile.phoneNumber || '');
    $('profileEmail').value = currentUser.email || '';
    $('overviewReferral').textContent = userProfile.referralCode || '—';
    $('referralCodeLarge').textContent = userProfile.referralCode || '—';
    $('verificationNote').classList.toggle('hidden', Boolean(currentUser.emailVerified));
  } catch (error) { console.error(error); }
}
async function checkAdminClaim() {
  try {
    const token = await currentUser.getIdTokenResult(true);
    isAdmin = token.claims.admin === true;
  } catch { isAdmin = false; }
  $('adminTabButton').classList.toggle('hidden', !isAdmin);
}
function attachWalletListener() {
  if (unsubWallet) unsubWallet();
  unsubWallet = onSnapshot(doc(db, 'wallets', currentUser.uid), (snap) => {
    const balance = snap.exists() ? snap.data().balancePesewas || 0 : 0;
    $('walletBalance').textContent = money(balance);
    $('walletBalanceLarge').textContent = money(balance);
  }, (error) => console.warn('Wallet listener', error.message));
  getDocs(query(collection(db, 'transactions', currentUser.uid, 'entries'), orderBy('createdAt', 'desc'), limit(30)))
    .then((snap) => renderTransactions(snap.docs.map((d) => ({ id: d.id, ...d.data() }))))
    .catch((error) => console.warn('Transaction history', error.message));
}
function attachOrderListener() {
  if (unsubOrders) unsubOrders();
  const q = query(collection(db, 'orders'), where('uid', '==', currentUser.uid), orderBy('createdAt', 'desc'), limit(50));
  unsubOrders = onSnapshot(q, (snap) => {
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    $('totalOrders').textContent = String(rows.length);
    renderOrders(rows, $('recentOrders'), true);
    renderOrders(rows, $('allOrders'), false);
  }, (error) => {
    console.warn('Orders listener', error.message);
    $('allOrders').innerHTML = `<div class="empty-state">Could not load orders: ${escapeHTML(error.message)}</div>`;
  });
}
function renderOrders(rows, target, compact) {
  if (!rows.length) { target.innerHTML = '<div class="empty-state">No orders yet. Your orders will appear here after you place one.</div>'; return; }
  const subset = compact ? rows.slice(0, 5) : rows;
  target.innerHTML = `<table class="data-table"><thead><tr><th>ORDER</th><th>NETWORK</th><th>RECIPIENT</th><th>PRICE</th><th>STATUS</th><th>DATE</th>${compact ? '' : '<th></th>'}</tr></thead><tbody>${subset.map((o) => `<tr><td>${escapeHTML(o.id.slice(0, 10).toUpperCase())}</td><td>${escapeHTML(o.network)}</td><td>${escapeHTML(phoneLocal(o.recipient))}</td><td>${money(o.pricePesewas)}</td><td><span class="status-badge status-${escapeHTML(o.status)}">${escapeHTML(String(o.status).replaceAll('_',' '))}</span></td><td>${escapeHTML(niceDate(o.createdAt))}</td>${compact ? '' : `<td><button class="subtle-link" data-dispute="${escapeHTML(o.id)}">Dispute</button></td>`}</tr>`).join('')}</tbody></table>`;
  target.querySelectorAll('[data-dispute]').forEach((button) => button.addEventListener('click', () => {
    activateTab('support'); $('supportOrder').value = button.dataset.dispute; $('supportSubject').value = 'Order dispute'; $('supportMessage').focus();
  }));
}
async function loadNotifications() {
  if (!currentUser) return;
  try {
    const snap = await getDocs(query(collection(db, 'notifications', currentUser.uid, 'items'), orderBy('createdAt', 'desc'), limit(30)));
    $('notificationsList').innerHTML = snap.empty ? '<div class="empty-state">No account notifications yet.</div>' : snap.docs.map((d) => {
      const n = d.data();
      return `<div class="compact-row"><span><b>${escapeHTML(n.title || 'Account update')}</b><small>${escapeHTML(n.message || '')}</small></span><small>${escapeHTML(niceDate(n.createdAt))}</small></div>`;
    }).join('');
  } catch (error) { $('notificationsList').textContent = error.message; }
}
function renderTransactions(rows) {
  const target = $('walletHistory');
  if (!rows.length) { target.innerHTML = '<div class="empty-state">No wallet activity yet.</div>'; return; }
  target.innerHTML = `<table class="data-table"><thead><tr><th>DESCRIPTION</th><th>TYPE</th><th>AMOUNT</th><th>DATE</th></tr></thead><tbody>${rows.map((t) => `<tr><td>${escapeHTML(t.description || t.reference)}</td><td>${escapeHTML(String(t.type || '').replaceAll('_',' '))}</td><td>${money(t.amountPesewas)}</td><td>${escapeHTML(niceDate(t.createdAt))}</td></tr>`).join('')}</tbody></table>`;
}
async function handleOrder(event) {
  event.preventDefault();
  const pack = selectedPack();
  if (!pack) return showToast('Choose an available data package first.', 'error');
  const recipient = $('recipientInput').value.trim();
  const digits = recipient.replace(/\D/g, '');
  if (!/^(0[235]\d{8}|233[235]\d{8})$/.test(digits)) return showToast('Enter a valid Ghana mobile number.', 'error');
  if (!currentUser) return showAuth('login', 'Sign in or create an account before placing your order.');
  const orderSummary = `Confirm ${pack.sizeGb} GB ${pack.network} data for ${phoneLocal(recipient)} at ${money(pack.pricePesewas)}?`;
  if (!window.confirm(orderSummary)) return;
  const button = $('placeOrderButton'); setButtonBusy(button, true, 'Submitting order…');
  try {
    const signature = `${currentUser.uid}:${pack.id}:${digits}`;
    const storageKey = `mvgh_order_attempt_${currentUser.uid}`;
    let savedAttempt = pendingOrderAttempt?.signature === signature ? pendingOrderAttempt : null;
    try { savedAttempt = JSON.parse(sessionStorage.getItem(storageKey) || 'null') || savedAttempt; } catch { /* Session storage may be unavailable in private browsing. */ }
    if (!savedAttempt || savedAttempt.signature !== signature) savedAttempt = { signature, idempotencyKey: makeKey() };
    pendingOrderAttempt = savedAttempt;
    try { sessionStorage.setItem(storageKey, JSON.stringify(savedAttempt)); } catch { /* Keep the key in memory for this page session. */ }
    const result = await call('placeDataOrder', { packageId: pack.id, recipient, idempotencyKey: savedAttempt.idempotencyKey });
    try { sessionStorage.removeItem(storageKey); } catch { /* Ignore unavailable session storage. */ }
    pendingOrderAttempt = null;
    const label = result.status === 'test_mode'
      ? `TEST MODE order recorded (${result.orderId.slice(0, 9)}). No money was charged and no data was delivered.`
      : result.status === 'successful' ? 'Your data order was confirmed by the provider.'
      : result.status === 'refunded' ? 'The provider rejected the order. Your wallet was refunded.'
      : 'Order submitted. Delivery is awaiting provider confirmation.';
    showToast(label, result.status === 'refunded' ? 'error' : 'ok');
    $('orderForm').reset(); renderPackageOptions(''); updateOrderPrice();
    activateTab('orders');
  } catch (error) { showToast(formatError(error), 'error'); }
  finally { setButtonBusy(button, false); }
}
async function topupTest() {
  const amount = prompt('Enter test credit amount in GH₵ (5 to 500). This is simulated, not real money:');
  if (amount === null) return;
  const ghsAmount = Number(amount);
  if (!Number.isFinite(ghsAmount) || ghsAmount < 5 || ghsAmount > 500) return showToast('Enter an amount from GH₵5 to GH₵500.', 'error');
  try { await call('createTestWalletTopup', { amountPesewas: Math.round(ghsAmount * 100) }); showToast('Test credit added to your simulated wallet.'); }
  catch (error) { showToast(formatError(error), 'error'); }
}
async function startTopup(provider) {
  const value = prompt('Enter wallet top-up amount in GH₵ (5 to 5,000):');
  if (value === null) return;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 5 || amount > 5000) return showToast('Enter an amount from GH₵5 to GH₵5,000.', 'error');
  try {
    const result = await call(provider === 'paystack' ? 'initializePaystackTopup' : 'initializeHubtelTopup', { amountPesewas: Math.round(amount * 100) });
    window.location.href = provider === 'paystack' ? result.authorizationUrl : result.checkoutUrl;
  } catch (error) { showToast(formatError(error), 'error'); }
}
async function checkPaymentReturn() {
  const params = new URLSearchParams(location.search);
  const ref = params.get('reference') || params.get('ref');
  const kind = params.get('payment');
  if (!ref || !kind || !['paystack','hubtel'].includes(kind)) return;
  try {
    showToast('Checking payment with the provider…');
    const result = await call(kind === 'paystack' ? 'verifyPaystackPayment' : 'refreshHubtelPayment', { reference: ref });
    showToast(result.credited ? 'Wallet funded successfully.' : `Payment status: ${result.status}.`);
    history.replaceState({}, '', location.pathname + location.hash);
  } catch (error) { showToast(`Payment confirmation is still pending: ${formatError(error)}`, 'error'); }
}
async function loadReferralHistory() {
  if (!userProfile?.referralCode) return;
  try {
    const snap = await getDocs(collection(db, 'referrals', userProfile.referralCode, 'members'));
    $('referralHistory').innerHTML = snap.empty ? 'No referrals have joined yet.' : `<div class="compact-list">${snap.docs.map((d) => `<div class="compact-row"><span>Member ${escapeHTML(d.id.slice(0, 8))}</span><small>${escapeHTML(niceDate(d.data().joinedAt))}</small></div>`).join('')}</div>`;
  } catch (error) { $('referralHistory').textContent = error.message; }
}
async function handleProfileSave(event) {
  event.preventDefault();
  try {
    await call('completeProfile', { displayName: $('profileName').value.trim(), phone: $('profilePhone').value.trim() });
    await loadUserProfile(); showToast('Your profile has been updated.');
  } catch (error) { showToast(formatError(error), 'error'); }
}
async function handleSupport(event) {
  event.preventDefault();
  const button = $('supportForm').querySelector('button[type="submit"]'); setButtonBusy(button, true, 'Sending…');
  try {
    const result = await call('submitSupportTicket', { subject: $('supportSubject').value, message: $('supportMessage').value, orderId: $('supportOrder').value.trim() });
    $('ticketNote').textContent = `Your support request has been received. Ticket: ${result.ticketId}`;
    $('supportForm').reset(); showToast('Support request submitted.');
  } catch (error) { showToast(formatError(error), 'error'); }
  finally { setButtonBusy(button, false); }
}
async function loadAdmin() {
  if (!isAdmin) return;
  $('adminMetrics').innerHTML = '<div class="empty-state">Loading administrative data…</div>';
  try {
    const data = await call('adminDashboard');
    const m = data.metrics;
    const metrics = [
      ['REGISTERED USERS', m.users], ['ALL ORDERS', m.orders], ['SUCCESSFUL ORDERS', m.successful], ['GROSS SALES', money(m.revenuePesewas)],
      ['ESTIMATED GROSS PROFIT', money(m.profitPesewas)], ['TOTAL TRANSACTIONS', m.transactions], ['PENDING', m.pending], ['FAILED / REFUNDED', m.failed], ['PAYMENT RECORDS', m.payments]
    ];
    $('adminMetrics').innerHTML = metrics.map(([label,value]) => `<div class="admin-metric"><small>${label}</small><b>${escapeHTML(value)}</b></div>`).join('');
    $('adminPackages').innerHTML = data.packages.length ? data.packages.map((p) => `<div class="compact-row"><span><b>${escapeHTML(p.name || p.network)}</b><small>${escapeHTML(p.id)} · ${money(p.pricePesewas)} · ${p.active ? 'Published' : 'Hidden'}</small></span><div class="row-actions"><button class="btn btn-outline" type="button" data-package-edit="${escapeHTML(p.id)}">Edit</button><button class="btn btn-outline" type="button" data-package-toggle="${escapeHTML(p.id)}" data-next-active="${p.active ? 'false' : 'true'}">${p.active ? 'Hide' : 'Publish'}</button></div></div>`).join('') : '<div class="empty-state">No package records yet.</div>';
    $('adminPackages').querySelectorAll('[data-package-toggle]').forEach((button) => button.addEventListener('click', async () => {
      const active = button.dataset.nextActive === 'true';
      try { await call('adminSetPackageActive', { id: button.dataset.packageToggle, active }); showToast(active ? 'Package published.' : 'Package hidden from customers.'); await loadAdmin(); await loadCatalog(); }
      catch (error) { showToast(formatError(error), 'error'); }
    }));
    $('adminPackages').querySelectorAll('[data-package-edit]').forEach((button) => button.addEventListener('click', () => {
      const pack = data.packages.find((item) => item.id === button.dataset.packageEdit);
      if (!pack) return showToast('Package details could not be loaded. Refresh and try again.', 'error');
      $('adminNetwork').value = pack.network;
      $('adminSize').value = pack.sizeGb;
      $('adminPrice').value = (Number(pack.pricePesewas || 0) / 100).toFixed(2);
      $('adminCost').value = (Number(pack.costPesewas || 0) / 100).toFixed(2);
      $('adminCode').value = pack.providerCode || pack.code || '';
      $('adminActive').checked = pack.active === true;
      $('packageAdminForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('adminPrice').focus();
      showToast(`Editing ${pack.name || pack.id}. Save the form to update it.`);
    }));
    renderAdminOrders(data.orders || []);
    renderAdminTransactions(data.transactions || []);
    renderAdminPayments(data.paymentRecords || []);
    renderAdminCustomers(data.users || []);
    renderAdminTickets(data.tickets || []);
    $('providerName').value = data.provider.name || '';
    $('providerBase').value = data.provider.baseUrl || '';
    $('providerOrderPath').value = data.provider.orderPath || '/orders';
    $('providerStatusPath').value = data.provider.statusPath || '/orders/{reference}';
    $('providerBalancePath').value = data.provider.balancePath || '/balance';
    $('providerEnabled').checked = data.provider.enabled === true;
    $('referralReward').value = (Number(data.business.referralRewardPesewas || 0) / 100).toFixed(2);
  } catch (error) {
    $('adminMetrics').innerHTML = `<div class="empty-state">Could not load admin data: ${escapeHTML(formatError(error))}</div>`;
  }
}
function renderAdminTransactions(rows) {
  const target = $('adminTransactions');
  target.innerHTML = rows.length ? `<table class="data-table"><thead><tr><th>DATE</th><th>CUSTOMER</th><th>TYPE</th><th>AMOUNT</th><th>REFERENCE</th></tr></thead><tbody>${rows.map((t) => `<tr><td>${escapeHTML(niceDate(t.createdAt))}</td><td>${escapeHTML(String(t.uid || '').slice(0, 9))}</td><td>${escapeHTML(String(t.type || '').replaceAll('_',' '))}</td><td>${money(t.amountPesewas)}</td><td>${escapeHTML(String(t.reference || t.id).slice(0, 14))}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-state">No wallet transactions recorded yet.</div>';
}
function renderAdminPayments(rows) {
  const target = $('adminPayments');
  target.innerHTML = rows.length ? `<table class="data-table"><thead><tr><th>DATE</th><th>PROVIDER</th><th>AMOUNT</th><th>STATUS</th><th>REFERENCE</th></tr></thead><tbody>${rows.map((p) => `<tr><td>${escapeHTML(niceDate(p.createdAt))}</td><td>${escapeHTML(p.provider || '—')}</td><td>${money(p.amountPesewas)}</td><td><span class="status-badge status-${escapeHTML(p.status || 'pending')}">${escapeHTML(p.status || 'pending')}</span></td><td>${escapeHTML(String(p.id).slice(0, 14))}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-state">No payment records yet.</div>';
}
function renderAdminOrders(rows) {
  const target = $('adminOrders');
  target.innerHTML = rows.length ? `<table class="data-table"><thead><tr><th>ORDER ID</th><th>CUSTOMER</th><th>NETWORK</th><th>AMOUNT</th><th>STATUS</th><th></th></tr></thead><tbody>${rows.map((o) => `<tr><td>${escapeHTML(o.id.slice(0,12))}</td><td>${escapeHTML(o.uid.slice(0,9))}</td><td>${escapeHTML(o.network)}</td><td>${money(o.pricePesewas)}</td><td><span class="status-badge status-${escapeHTML(o.status)}">${escapeHTML(o.status)}</span></td><td>${['queued','processing','pending_provider','retrying'].includes(o.status) ? `<button class="subtle-link" data-retry="${escapeHTML(o.id)}">Check / retry</button><button class="subtle-link" data-refund="${escapeHTML(o.id)}">Refund review</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-state">No orders found.</div>';
  target.querySelectorAll('[data-retry]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('Check supplier status first. A new submission is made only if the supplier explicitly says the order was not found. Continue?')) return;
    try { const result = await call('adminRetryProviderOrder', { orderId: button.dataset.retry }); showToast(result.message || 'Supplier status checked.'); await loadAdmin(); }
    catch (error) { showToast(formatError(error), 'error'); await loadAdmin(); }
  }));
  target.querySelectorAll('[data-refund]').forEach((button) => button.addEventListener('click', async () => {
    const reason = prompt('Reason for refund review:'); if (reason === null) return;
    try { await call('adminRefundOrder', { orderId: button.dataset.refund, reason }); showToast('Supplier-confirmed refund processed.'); await loadAdmin(); }
    catch (error) { showToast(formatError(error), 'error'); }
  }));
}
function renderAdminCustomers(rows) {
  $('adminCustomers').innerHTML = rows.length ? rows.slice(0, 25).map((u) => `<div class="compact-row"><span><b>${escapeHTML(u.displayName || u.email || u.uid.slice(0,8))}</b><small>${escapeHTML(u.email || u.uid)} · ${u.active === false ? 'Suspended' : 'Active'}</small></span><button class="btn btn-outline" data-user-status="${escapeHTML(u.uid)}" data-next-status="${u.active === false ? 'true' : 'false'}">${u.active === false ? 'Activate' : 'Suspend'}</button></div>`).join('') : '<div class="empty-state">No customers found.</div>';
  $('adminCustomers').querySelectorAll('[data-user-status]').forEach((button) => button.addEventListener('click', async () => {
    const active = button.dataset.nextStatus === 'true';
    try { await call('adminSetCustomerStatus', { uid: button.dataset.userStatus, active }); showToast(active ? 'Customer activated.' : 'Customer suspended.'); loadAdmin(); }
    catch (error) { showToast(formatError(error), 'error'); }
  }));
}
function renderAdminTickets(rows) {
  $('adminTickets').innerHTML = rows.length ? rows.map((t) => `<div class="compact-row"><span><b>${escapeHTML(t.subject)}</b><small>${escapeHTML(t.status)} · ${escapeHTML(t.uid.slice(0,8))}</small></span><button class="btn btn-outline" data-ticket="${escapeHTML(t.id)}" data-status="${escapeHTML(t.status)}">${t.status === 'resolved' ? 'Reopen' : 'Resolve'}</button></div>`).join('') : '<div class="empty-state">No customer complaints yet.</div>';
  $('adminTickets').querySelectorAll('[data-ticket]').forEach((button) => button.addEventListener('click', async () => {
    const status = button.dataset.status === 'resolved' ? 'open' : 'resolved';
    try { await call('adminResolveTicket', { ticketId: button.dataset.ticket, status }); showToast('Support ticket updated.'); loadAdmin(); }
    catch (error) { showToast(formatError(error), 'error'); }
  }));
}
async function saveAdminPackage(event) {
  event.preventDefault();
  try {
    await call('adminSavePackage', {
      network: $('adminNetwork').value, sizeGb: Number($('adminSize').value), pricePesewas: Math.round(Number($('adminPrice').value) * 100),
      costPesewas: Math.round(Number($('adminCost')?.value || 0) * 100), code: $('adminCode').value.trim(), active: $('adminActive').checked
    });
    $('packageAdminForm').reset(); showToast('Data package saved.'); await loadAdmin(); await loadCatalog();
  } catch (error) { showToast(formatError(error), 'error'); }
}
async function saveProvider(event) {
  event.preventDefault();
  try {
    const result = await call('adminSaveProvider', {
      name: $('providerName').value, baseUrl: $('providerBase').value, orderPath: $('providerOrderPath').value,
      statusPath: $('providerStatusPath').value, balancePath: $('providerBalancePath').value, enabled: $('providerEnabled').checked
    });
    showToast(result.note || 'Provider settings saved.');
  } catch (error) { showToast(formatError(error), 'error'); }
}
async function checkProviderBalance() {
  $('providerResult').classList.remove('hidden'); $('providerResult').textContent = 'Checking…';
  try { const data = await call('adminCheckProviderBalance'); $('providerResult').textContent = JSON.stringify(data.result, null, 2); }
  catch (error) { $('providerResult').textContent = formatError(error); }
}
async function saveReferralSettings(event) {
  event.preventDefault();
  try { await call('adminUpdateBusinessSettings', { referralRewardPesewas: Math.round(Number($('referralReward').value || 0) * 100) }); showToast('Referral reward settings saved.'); }
  catch (error) { showToast(formatError(error), 'error'); }
}

function setupEvents() {
  document.querySelectorAll('[data-open-auth]').forEach((b) => b.addEventListener('click', () => showAuth(b.dataset.openAuth)));
  document.querySelectorAll('[data-auth-tab]').forEach((b) => b.addEventListener('click', () => switchAuth(b.dataset.authTab)));
  $('closeAuth').addEventListener('click', hideAuth);
  $('authModal').addEventListener('click', (e) => { if (e.target === $('authModal')) hideAuth(); });
  $('loginForm').addEventListener('submit', handleLogin);
  $('registerForm').addEventListener('submit', handleRegister);
  $('forgotPassword').addEventListener('click', async () => {
    const email = $('loginEmail').value.trim();
    if (!email) return $('authMessage').textContent = 'Enter your email address first.';
    try { await sendPasswordResetEmail(auth, email); $('authMessage').textContent = 'Password reset link sent. Check your inbox.'; }
    catch (error) { $('authMessage').textContent = formatError(error); }
  });
  $('logoutButton').addEventListener('click', async () => { if (auth) await signOut(auth); showToast('You have signed out.'); });
  $('goAccount').addEventListener('click', () => openAccount());
  $('avatarButton').addEventListener('click', () => openAccount());
  $('dashboardBuy').addEventListener('click', () => $('buy').scrollIntoView({ behavior:'smooth' }));
  $('ordersBuy').addEventListener('click', () => $('buy').scrollIntoView({ behavior:'smooth' }));
  $('networkSelect').addEventListener('change', () => { renderPackageOptions($('networkSelect').value); document.querySelectorAll('.network-card').forEach((c) => c.classList.toggle('selected', c.dataset.network === $('networkSelect').value)); });
  $('packageSelect').addEventListener('change', updateOrderPrice);
  $('orderForm').addEventListener('submit', handleOrder);
  document.querySelectorAll('.network-card').forEach((b) => b.addEventListener('click', () => { $('networkSelect').value = b.dataset.network; renderPackageOptions(b.dataset.network); document.querySelectorAll('.network-card').forEach((c) => c.classList.toggle('selected', c === b)); $('offers').scrollIntoView({ behavior:'smooth' }); }));
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => activateTab(b.dataset.tab)));
  document.querySelectorAll('[data-switch-tab]').forEach((b) => b.addEventListener('click', () => activateTab(b.dataset.switchTab)));
  $('testTopupButton').addEventListener('click', topupTest);
  $('paystackTopupButton').addEventListener('click', () => startTopup('paystack'));
  $('hubtelTopupButton').addEventListener('click', () => startTopup('hubtel'));
  $('profileForm').addEventListener('submit', handleProfileSave);
  $('supportForm').addEventListener('submit', handleSupport);
  $('resendVerification').addEventListener('click', async () => { try { await sendEmailVerification(currentUser); showToast('Verification email sent.'); } catch (e) { showToast(formatError(e), 'error'); } });
  $('copyReferral').addEventListener('click', async () => { const code = userProfile?.referralCode || ''; if (!code) return; try { await navigator.clipboard.writeText(code); showToast('Referral code copied.'); } catch { showToast(`Your referral code is ${code}`); } });
  $('refreshAdmin').addEventListener('click', loadAdmin);
  $('packageAdminForm').addEventListener('submit', saveAdminPackage);
  $('providerAdminForm').addEventListener('submit', saveProvider);
  $('providerBalanceCheck').addEventListener('click', checkProviderBalance);
  $('referralSettingsForm').addEventListener('submit', saveReferralSettings);
  $('menuToggle').addEventListener('click', () => { const open = $('mainNav').classList.toggle('open'); $('menuToggle').setAttribute('aria-expanded', String(open)); });
  $('mainNav').querySelectorAll('a').forEach((a) => a.addEventListener('click', () => $('mainNav').classList.remove('open')));
  const supportNumber = String(appConfig.supportWhatsApp || '').replace(/\D/g, '');
  if (/^233[235]\d{8}$/.test(supportNumber)) {
    $('whatsappLink').href = `https://wa.me/${supportNumber}`;
  } else {
    $('whatsappLink').href = '#support';
    $('whatsappLink').title = 'Add your verified WhatsApp number in public/firebase-config.js';
    $('whatsappLink').addEventListener('click', (event) => {
      event.preventDefault();
      showToast('WhatsApp support is not configured yet. Add your verified number in public/firebase-config.js.', 'error');
    });
  }
  $('yearNow').textContent = new Date().getFullYear();
}

async function init() {
  setupEvents();
  // The backend catalogue response is the authority for TEST/LIVE mode.
  // Never allow a browser-side setting to expose live payment buttons.
  updateModeUI();
  if (!isConfigured()) {
    $('catalogMode').textContent = 'SETUP REQUIRED';
    $('catalogGrid').innerHTML = '<div class="empty-catalog"><span>◇</span><b>Firebase setup required</b><small>This website is ready for Firebase. Add your web app credentials to public/firebase-config.js.</small></div>';
    $('orderNote').textContent = 'Connect your Firebase project to enable registration, orders and the database.';
    return;
  }
  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app); db = getFirestore(app); functions = getFunctions(app, 'africa-south1');
    await loadCatalog();
    onAuthStateChanged(auth, async (user) => {
      const nextUid = user ? user.uid : null;
      if (nextUid === authStateUid) return;
      authStateUid = nextUid;
      if (user) {
        await afterSignIn(user);
      } else {
        currentUser = null; userProfile = null; isAdmin = false;
        if (unsubWallet) { unsubWallet(); unsubWallet = null; }
        if (unsubOrders) { unsubOrders(); unsubOrders = null; }
        $('guestActions').classList.remove('hidden'); $('signedActions').classList.add('hidden');
        $('accountPanel').classList.add('hidden'); $('adminTabButton').classList.add('hidden');
      }
    });
  } catch (error) {
    console.error(error);
    showToast('Firebase could not initialize. Check the project configuration.', 'error');
  }
}

init();

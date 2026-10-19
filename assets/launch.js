/* global document, window */
// Launch form: client-side validation (same rules as the server), an optional brief for the agent and an optional boost, then
//   nothing to pay (network cost 0 and no boost, e.g. the fake chain):  POST /api/launch, redirect on success;
//   something to pay: connect a Wallet Standard wallet (or, on the fake chain, the dev wallet), POST /api/launch/quote with the
//                     brief and boost, have the wallet sign and send the server-built transaction (network cost + boost), wait for
//                     /api/launch/payment, POST /api/launch with the signature and exactly the quoted fields.
// A payment that went out but did not launch yet is kept in localStorage, so a reload or a new tab carries that launch on by itself
// instead of paying again. When POST /api/launch gets no answer (a proxy's time limit, a restart), the page follows the payment to
// its coin instead of reporting an error. A connected wallet's launches that did not finish (GET /api/launch/unfinished) are listed
// above the button, each linking to its coin page; a paid launch with the same ticker is refused before any payment.
import {
  LIMITS,
  boostWorkLine,
  coinPath,
  formatSol,
  formatUsd,
  isAddress,
  launchButtonLabel,
  launchErrorMessage,
  launchRules,
  launchTotal,
  lamportsUsd,
  normalizeTicker,
  parseBoost,
  readLaunchTerms,
  readUnfinished,
  solWithUsd,
  unfinishedLine,
  unfinishedWithTicker,
  validateLaunch,
} from './lib.js';
import { el, getJson, icon, setText } from './ui.js';
import {
  base58Encode,
  connectWallet,
  signAndSend,
  walletErrorKind,
  walletIcon,
  walletName,
  watchWallets,
} from './wallet.js';

const form = document.getElementById('launch-form');
const fields = ['name', 'ticker', 'tagline', 'brief', 'wallet'];
const input = (id) => document.getElementById(id);
const submit = input('submit');
const retry = input('retry');
const progress = input('progress');
const formError = input('form-error');
const PENDING_KEY = 'startuppad.pendingLaunch';
const PENDING_MAX_AGE_MS = (7 * 24 - 1) * 3_600_000; // the server keeps a paid quote for 7 days
const LAST_WALLET_KEY = 'startuppad.lastWallet'; // the last connected wallet's public address, to look up its launches on load
const UNFINISHED_TIMEOUT_MS = 5000; // the lookup never holds up a launch for longer
const CONFIRM_POLLS = 30;
const CONFIRM_EVERY_MS = 2000;
const FOLLOW_POLLS = 40; // after POST /api/launch got no answer: about two minutes of following its payment
const FOLLOW_EVERY_MS = 3000;
const LAUNCH_REASKS = 2; // POST /api/launch asked again after no answer, when the payment shows it never got through
const WALLET_HINT = input('wallet-hint').textContent.trim();
let busy = false;
let terms = null; // readLaunchTerms(GET /api/launch/terms)
let avgSessionUsd = null; // GET /api/stats, for "what the boost buys"
let wallets = []; // usable Wallet Standard wallets
let connected = null; // { name, account, wallet } or { name, account, dev: true }
let retryAction = null;
let unfinished = []; // readUnfinished(GET /api/launch/unfinished) for unfinishedWallet
let unfinishedWallet = '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chain = () => (terms && terms.walletChain) || 'solana:mainnet';
const briefMax = () => (terms ? terms.briefMaxChars : LIMITS.briefMax);

// ---- the boost --------------------------------------------------------------------------------------------------------

const boostChoice = () => {
  const r = form.querySelector('input[name="boost"]:checked');
  return r ? r.value : 'none';
};
/** The boost as picked right now: { ok, lamports, error } (see lib.js parseBoost). */
const boost = () =>
  parseBoost(
    boostChoice(),
    input('boost-custom').value,
    terms ? terms.boostMaxLamports : undefined,
  );
const total = () => launchTotal(terms, boost().ok ? boost().lamports : 0);
/** Is there anything to pay? Only known once the terms are in. */
const feeMode = () => !!terms && !total().free;

function showBoostError(text) {
  const box = input('boost-err');
  box.hidden = !text;
  box.textContent = text || '';
  if (text) input('boost-custom').setAttribute('aria-invalid', 'true');
  else input('boost-custom').removeAttribute('aria-invalid');
}

/** One ticket per suggested boost, between "No boost" and "Custom". */
function renderBoostChips() {
  const box = input('boost-chips');
  for (const old of box.querySelectorAll('[data-boost="preset"]')) old.remove();
  const custom = box.querySelector('[data-boost="custom"]');
  for (const lamports of terms.boostSuggestedLamports) {
    const usd = lamportsUsd(lamports, terms.solUsd);
    box.insertBefore(
      el(
        'label',
        { class: 'boost-chip', 'data-boost': 'preset' },
        el('input', { type: 'radio', name: 'boost', value: String(lamports) }),
        el('span', { class: 'boost-chip__main' }, formatSol(lamports)),
        el(
          'span',
          { class: 'boost-chip__sub' },
          usd === null ? 'to the agent' : `about ${formatUsd(usd)}`,
        ),
      ),
      custom,
    );
  }
  setText('boost-custom-hint', `Any amount up to ${formatSol(terms.boostMaxLamports)}.`);
}

/** Pick the boost ticket for `lamports` (a preset when one matches, else Custom with the amount filled in). */
function selectBoost(lamports) {
  const n = Number.isSafeInteger(lamports) && lamports > 0 ? lamports : 0;
  const preset = n && form.querySelector(`input[name="boost"][value="${n}"]`);
  const value = !n ? 'none' : preset ? String(n) : 'custom';
  for (const r of form.querySelectorAll('input[name="boost"]')) r.checked = r.value === value;
  input('boost-custom').value = value === 'custom' ? String(n / 1_000_000_000) : '';
}

// ---- the tally, the button, the wallet field: everything that follows the total ---------------------------------------

function renderTally() {
  input('boost-custom-row').hidden = boostChoice() !== 'custom';
  if (!terms) return;
  const b = boost();
  const t = total();
  setText('cost-network', solWithUsd(t.networkCostLamports, terms.solUsd));
  setText('cost-boost', t.boostLamports ? solWithUsd(t.boostLamports, terms.solUsd) : 'none');
  input('cost-boost').parentElement.toggleAttribute('data-on', t.boostLamports > 0);
  setText('cost-total', formatSol(t.totalLamports));
  const usd = lamportsUsd(t.totalLamports, terms.solUsd);
  setText('cost-total-usd', usd && t.totalLamports ? `about ${formatUsd(usd)}` : '');
  const work = boostWorkLine(t.boostLamports, terms.solUsd, avgSessionUsd);
  input('boost-work').hidden = !work;
  setText('boost-work', work);
  input('fee').hidden = false;
  if (!busy) submit.textContent = launchButtonLabel(t.totalLamports);
  if (b.ok) showBoostError('');
  applyPayMode();
}

/** Paying: the wallet field is the connected wallet's address and the wallet picker shows. Free: an optional address field. */
function applyPayMode() {
  const paying = feeMode();
  input('pay').hidden = !paying;
  const w = input('wallet');
  const optional = document.querySelector('label[for="wallet"] .optional');
  if (optional) optional.hidden = paying;
  w.readOnly = busy || paying;
  if (paying) {
    w.placeholder = 'Filled in from the wallet you connect';
    w.value = connected ? connected.account.address : '';
    setText('wallet-hint', 'The wallet that pays. Connect it below.');
    renderWallets();
  } else {
    w.placeholder = '';
    setText('wallet-hint', WALLET_HINT);
  }
}

form.addEventListener('change', (e) => {
  if (e.target && e.target.name === 'boost') {
    showBoostError('');
    renderTally();
    if (e.target.value === 'custom') input('boost-custom').focus();
  }
});
input('boost-custom').addEventListener('input', () => {
  showBoostError('');
  renderTally();
});
input('boost-custom').addEventListener('blur', () => {
  const b = boost();
  if (!b.ok) showBoostError(b.error);
});

// ---- the brief's counter --------------------------------------------------------------------------------------------

function renderBriefCount() {
  const n = [...input('brief').value].length;
  const max = briefMax();
  setText('brief-count', String(n));
  setText('brief-max', String(max));
  input('brief-counter').setAttribute(
    'data-level',
    n > max ? 'over' : n >= max * 0.9 ? 'near' : 'ok',
  );
}
input('brief').addEventListener('input', renderBriefCount);

function showFieldErrors(errors) {
  for (const f of fields) {
    const box = input(`${f}-err`);
    const msg = errors[f];
    box.hidden = !msg;
    box.textContent = msg || '';
    if (msg) input(f).setAttribute('aria-invalid', 'true');
    else input(f).removeAttribute('aria-invalid');
  }
}

// Typing in a field clears that field's old error right away instead of leaving it up until the next submit.
for (const f of fields)
  input(f).addEventListener('input', () => {
    input(`${f}-err`).hidden = true;
    input(f).removeAttribute('aria-invalid');
  });

// Coming back with the Back button can restore this page from the browser's cache exactly as we left it (button disabled,
// "Taking you to its page" showing). Start clean instead.
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  setBusy(false);
  form.reset();
  setText('tagline-count', '0');
  renderBriefCount();
  showError('');
  showBoostError('');
  showSteps(null);
  showFieldErrors({});
  renderTally();
  if (connected) {
    input('wallet').value = connected.account.address;
    checkUnfinished(connected.account.address);
  }
});

function values() {
  const b = boost();
  return {
    name: input('name').value,
    ticker: input('ticker').value,
    tagline: input('tagline').value,
    brief: input('brief').value,
    wallet: input('wallet').value,
    boostLamports: b.ok ? b.lamports : 0,
  };
}

input('ticker').addEventListener('input', (e) => {
  const t = e.target;
  const next = normalizeTicker(t.value).slice(0, LIMITS.tickerMax);
  if (next !== t.value) t.value = next;
});
input('tagline').addEventListener('input', () =>
  setText('tagline-count', String([...input('tagline').value].length)),
);

function setBusy(on, message) {
  busy = on;
  submit.disabled = on;
  progress.hidden = !on;
  progress.textContent = on ? message : '';
  for (const f of fields) input(f).readOnly = on || (f === 'wallet' && feeMode());
  input('boost-custom').readOnly = on;
  for (const r of form.querySelectorAll('input[name="boost"]')) r.disabled = on;
  for (const b of document.querySelectorAll('#wallets button')) b.disabled = on;
  if (on) retry.hidden = true;
  else if (terms) submit.textContent = launchButtonLabel(total().totalLamports);
}

/** Show an error (text only), optionally with the "Check again" style button that runs `action`. */
function showError(text, action, label) {
  formError.hidden = !text;
  formError.textContent = text || '';
  retryAction = action || null;
  retry.hidden = !action;
  if (action) retry.textContent = label || 'Check again';
}

retry.addEventListener('click', () => {
  const action = retryAction;
  if (!action || busy) return;
  showError('');
  action();
});

// ---- progress steps ------------------------------------------------------------------------------------------------------

const STEP_ORDER = ['connect', 'approve', 'confirm', 'launch'];

/** Mark the steps before `current` done, `current` in progress and the rest upcoming; null hides the list. */
function showSteps(current) {
  const list = input('steps');
  list.hidden = !current;
  const at = STEP_ORDER.indexOf(current);
  for (const li of list.querySelectorAll('li')) {
    const i = STEP_ORDER.indexOf(li.dataset.step);
    const state = i < at ? 'done' : i === at ? 'current' : 'upcoming';
    li.setAttribute('data-state', state);
    li.querySelector('.progress-steps__state').textContent =
      state === 'done' ? '(done)' : state === 'current' ? '(now)' : '';
    if (state === 'current') li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  }
}

// ---- HTTP ---------------------------------------------------------------------------------------------------------------

async function postJson(url, payload) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw Object.assign(new Error(''), { status: 0 });
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok)
    throw Object.assign(new Error((body && body.error) || ''), {
      status: res.status,
      retrying: !!(body && body.retrying),
      slug: body && typeof body.slug === 'string' ? body.slug : null, // the coin it is about: still launching, or a used payment's
    });
  return { status: res.status, body: body || {} };
}

function goToCoin(slug, message) {
  const path = coinPath(slug);
  if (!path) throw Object.assign(new Error(''), { status: 500 });
  setBusy(true, message || 'Coin created. Taking you to its page…');
  window.location.assign(path);
}

// ---- pending payments (survive a reload or a closed tab) -------------------------------------------------------------------

function savePending(p) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {
    /* storage blocked: the flow still works in this tab */
  }
}
function loadPending() {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
    if (p && p.requestId && p.signature && p.value && Date.now() - p.at < PENDING_MAX_AGE_MS)
      return p;
  } catch {
    /* unreadable: ignore */
  }
  clearPending();
  return null;
}
function clearPending() {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * What a refused payment check or launch (err) means for the pending payment p. Still launching (retrying, with its coin): p is
 * kept, now with that coin's slug. Used, or too old (409 without retrying, 410): retrying cannot help, so it is dropped.
 * Returns { pending: what is kept (null when dropped), usedBy: the coin a used payment went to, when the server names it }.
 */
function settlePending(p, err) {
  if (err.retrying && coinPath(err.slug)) {
    const kept = { ...p, slug: err.slug };
    savePending(kept);
    return { pending: kept, usedBy: null };
  }
  if ((err.status === 409 && !err.retrying) || err.status === 410) {
    clearPending();
    return { pending: null, usedBy: err.status === 409 && coinPath(err.slug) ? err.slug : null };
  }
  return { pending: p, usedBy: null };
}

/** A coin's status ('live', 'launching', 'failed'), or null when it cannot be read right now. */
async function coinStatus(slug) {
  try {
    const body = await getJson(`/api/coins/${encodeURIComponent(slug)}`);
    return body && body.coin && typeof body.coin.status === 'string' ? body.coin.status : null;
  } catch {
    return null;
  }
}

/**
 * A payment that went out but did not launch yet (a reload, a closed tab, a new tab): carry that launch on from where it is, with
 * no click and never a second payment. Live: nothing left to do. Still launching: the server finishes it by itself (the wallet's
 * unfinished launches link to it). Paid: the same paid request again, which launches it, or finishes the coin it already made.
 * A payment the chain does not show yet is the one case that waits for the launcher.
 */
async function offerPending(saved) {
  let p = saved;
  let paid = true;
  if (coinPath(p.slug)) {
    const status = await coinStatus(p.slug);
    if (status === 'live') return clearPending();
    if (status === 'launching') return;
  } else {
    // Its launch may have finished without this page seeing it (a tab closed mid-launch): one payment check tells, and a
    // payment that is used or too old is dropped instead of carried on.
    try {
      const { body } = await postJson('/api/launch/payment', {
        requestId: p.requestId,
        paymentSignature: p.signature,
      });
      paid = body.paid === true;
    } catch (err) {
      if (err.retrying) return void settlePending(p, err); // its coin is launching
      p = settlePending(p, err).pending;
      if (!p) return;
    }
  }
  if (busy) return;
  input('name').value = p.value.name;
  input('ticker').value = p.value.ticker;
  input('tagline').value = p.value.tagline || '';
  input('brief').value = p.value.brief || '';
  selectBoost(p.value.boostLamports);
  setText('tagline-count', String([...input('tagline').value].length));
  renderBriefCount();
  renderTally();
  input('wallet').value = p.value.launcherWallet || '';
  if (paid) return confirmAndLaunch(p).catch(failed);
  showError(
    'Your last payment is not visible on chain yet. If your wallet shows it as sent, check again in a few seconds. Do not pay a second time.',
    () => confirmAndLaunch(p).catch(failed),
  );
}

// ---- a wallet's launches that did not finish --------------------------------------------------------------------------------

function rememberWallet(address) {
  try {
    localStorage.setItem(LAST_WALLET_KEY, address);
  } catch {
    /* ignore */
  }
}
function rememberedWallet() {
  try {
    const a = localStorage.getItem(LAST_WALLET_KEY);
    return isAddress(a) ? a : '';
  } catch {
    return '';
  }
}

/** The link to an unfinished coin's page: it shows a launch in progress, and finishes one that stopped with no new payment. */
function finishLink(coin) {
  return el('a', { href: coin.path }, coin.status === 'launching' ? 'Follow it' : 'Finish it, no new payment');
}

/** One line per unfinished coin, above the button. Coin text is untrusted: el() renders it as text. */
function renderUnfinished() {
  const box = input('unfinished');
  box.replaceChildren(
    ...unfinished.map((c) =>
      el('p', { class: 'unfinished__line' }, unfinishedLine(c), ' ', finishLink(c)),
    ),
  );
  box.hidden = unfinished.length === 0;
}

/**
 * GET /api/launch/unfinished for `address` and list what it returns above the button. Resolves to that list. The lookup never
 * blocks a launch: when it fails (or takes too long) it resolves to what is already known for this wallet, else [].
 */
async function checkUnfinished(address) {
  if (!isAddress(address)) return [];
  if (address !== unfinishedWallet) {
    unfinishedWallet = address;
    unfinished = [];
    renderUnfinished();
  }
  const known = () => (unfinishedWallet === address ? unfinished : []);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UNFINISHED_TIMEOUT_MS);
  let coins;
  try {
    const r = await fetch(`/api/launch/unfinished?wallet=${encodeURIComponent(address)}`, {
      headers: { accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!r.ok) return known();
    coins = readUnfinished(await r.json());
  } catch {
    return known();
  } finally {
    clearTimeout(timer);
  }
  if (unfinishedWallet === address) {
    // a lookup for a wallet connected later wins
    unfinished = coins;
    renderUnfinished();
  }
  return coins;
}

// ---- wallets ------------------------------------------------------------------------------------------------------------

/** A random address for the dev wallet, stable for this tab (it pays nothing real: the fake chain does not debit it). */
function devAddress() {
  try {
    const kept = sessionStorage.getItem('startuppad.devWallet');
    if (kept) return kept;
  } catch {
    /* ignore */
  }
  const a = base58Encode(crypto.getRandomValues(new Uint8Array(32)));
  try {
    sessionStorage.setItem('startuppad.devWallet', a);
  } catch {
    /* ignore */
  }
  return a;
}

function walletButton(attrs, iconNode, name, onClick) {
  const b = el(
    'button',
    { class: 'wallet-btn', type: 'button', ...attrs },
    el('span', { class: 'wallet-btn__icon' }, iconNode),
    el('span', { class: 'wallet-btn__name' }, name),
  );
  b.addEventListener('click', onClick);
  return b;
}

function renderWallets() {
  if (!feeMode()) return;
  input('pay').hidden = false;
  const box = input('wallets');
  box.replaceChildren();
  for (const w of wallets) {
    const src = walletIcon(w);
    const name = walletName(w);
    box.append(
      walletButton(
        {
          'data-wallet': name,
          'aria-pressed': String(!!connected && !connected.dev && connected.wallet === w),
        },
        src ? el('img', { src, alt: '', width: 28, height: 28 }) : icon('wallet'),
        name,
        () => connect(w),
      ),
    );
  }
  if (terms.devWallet)
    box.append(
      walletButton(
        { id: 'dev-wallet', 'aria-pressed': String(!!connected && !!connected.dev) },
        icon('spark'),
        'Dev wallet (fake chain)',
        () => useDevWallet(),
      ),
    );
  input('no-wallet').hidden = wallets.length > 0 || !!(connected && connected.dev);
  input('fake-note').hidden = terms.chain !== 'fake';
  for (const b of box.querySelectorAll('button')) b.disabled = busy;
}

function setConnected(c) {
  connected = c;
  input('wallet').value = c ? c.account.address : '';
  input('wallet-err').hidden = true;
  const status = input('wallet-status');
  status.hidden = !c;
  status.textContent = c ? `Paying with ${c.name}.` : '';
  renderWallets();
  if (c) {
    rememberWallet(c.account.address);
    checkUnfinished(c.account.address);
  }
}

async function connect(wallet) {
  if (busy) return;
  showError('');
  setBusy(true, `Connecting to ${walletName(wallet)}…`);
  showSteps('connect');
  try {
    const account = await connectWallet(wallet, chain());
    setConnected({ name: walletName(wallet), account, wallet });
    showSteps(null);
    setBusy(false);
  } catch (err) {
    setBusy(false);
    showSteps(null);
    showError(walletMessage(err, walletName(wallet), 'connect'));
  }
}

function useDevWallet() {
  if (busy) return;
  showError('');
  setConnected({
    name: 'the dev wallet (fake chain)',
    account: { address: devAddress() },
    dev: true,
  });
}

function walletMessage(err, name, what) {
  const kind = walletErrorKind(err);
  if (kind === 'rejected')
    return what === 'connect'
      ? `You declined the connection in ${name}.`
      : `You rejected the payment in ${name}. Nothing was paid.`;
  if (kind === 'expired')
    return 'The payment request expired before it was sent. Press the button again for a fresh one.';
  if (kind === 'funds')
    return `${name} does not have enough SOL for this payment plus the transaction fee.`;
  return `${name} reported a problem: ${String((err && err.message) || err).slice(0, 200)}`;
}

// ---- the flow -----------------------------------------------------------------------------------------------------------

async function launchFree(value) {
  setBusy(
    true,
    'Creating your coin on pump.fun. This can take up to a minute, please keep this page open.',
  );
  const { body } = await postJson('/api/launch', value);
  goToCoin(body && body.coin && body.coin.slug);
}

/** Pay through the connected wallet (or the dev wallet) and return the signature. */
async function payQuote(quote) {
  if (connected.dev) {
    try {
      return (await postJson('/sim/pay', { transaction: quote.transaction })).body.signature;
    } catch (err) {
      throw new Error(err.message || 'the fake chain did not answer', { cause: err }); // reported like a wallet's own error
    }
  }
  return signAndSend(connected.wallet, connected.account, chain(), quote.transaction);
}

/** The payment is out: wait until the server sees it, then launch. Safe to run again (it never pays). */
async function confirmAndLaunch(p) {
  setBusy(true, 'Waiting for your payment to confirm on chain…');
  showSteps('confirm');
  let paid = false;
  for (let i = 0; i < CONFIRM_POLLS && !paid; i++) {
    if (i) await sleep(CONFIRM_EVERY_MS);
    try {
      paid =
        (
          await postJson('/api/launch/payment', {
            requestId: p.requestId,
            paymentSignature: p.signature,
          })
        ).body.paid === true;
    } catch (err) {
      if (err.status !== 503 && err.status !== 0) return refused(p, err); // 503 and network trouble: keep waiting
    }
  }
  if (!paid) {
    setBusy(false);
    showSteps(null);
    showError(
      'Your payment is not visible on chain yet. If your wallet shows it as sent, wait a few seconds and check again. Do not pay a second time.',
      () => confirmAndLaunch(p).catch(failed),
    );
    return;
  }
  setBusy(true, 'Payment confirmed. Creating your coin on pump.fun, this can take up to a minute…');
  showSteps('launch');
  let lagging = 2;
  let unanswered = LAUNCH_REASKS;
  for (;;) {
    try {
      const { body } = await postJson('/api/launch', {
        ...p.value,
        requestId: p.requestId,
        paymentSignature: p.signature,
      });
      clearPending();
      return goToCoin(body && body.coin && body.coin.slug);
    } catch (err) {
      // The payment check just said paid: a 402 now is a read that lagged behind it. Asked again, twice, before saying anything.
      if (err.status === 402 && lagging-- > 0) {
        await sleep(CONFIRM_EVERY_MS);
        continue;
      }
      if (err.status === 402) {
        setBusy(false);
        showSteps(null);
        showError(
          'The payment is not confirmed yet. Wait a few seconds and check again. Do not pay a second time.',
          () => confirmAndLaunch(p).catch(failed),
        );
        return;
      }
      // No answer (a dropped connection, a proxy's time limit, a restart): the launch may well be running. Follow its payment.
      if (!err.retrying && (err.status === 0 || err.status >= 500)) {
        if (unanswered-- > 0) {
          if (await followPayment(p)) continue;
          return; // on to the coin's page
        }
        setBusy(false);
        showSteps(null);
        showError(
          'The server is not answering right now. Your launch is paid for and you will not pay again: check again in a moment.',
          () => confirmAndLaunch(p).catch(failed),
        );
        return;
      }
      return refused(p, err);
    }
  }
}

/**
 * POST /api/launch got no answer, but the server may well be launching the coin. The payment check says where that launch is:
 * claimed by its coin (409: still launching, or launched) goes to the coin's page through refused(), and resolves false; free
 * again (paid: true), or no answer to FOLLOW_POLLS checks either, resolves true: the launch is asked for again.
 */
async function followPayment(p) {
  setBusy(true, 'Still creating your coin on chain. Please keep this page open…');
  for (let i = 0; i < FOLLOW_POLLS; i++) {
    await sleep(FOLLOW_EVERY_MS);
    try {
      const { body } = await postJson('/api/launch/payment', {
        requestId: p.requestId,
        paymentSignature: p.signature,
      });
      if (body.paid === true) return true;
    } catch (err) {
      if (err.status === 0 || err.status >= 500) continue; // the server is still out of reach
      refused(p, err); // goes to the coin's page, or throws (to failed(), which follows a launching coin)
      return false;
    }
  }
  return true;
}

/**
 * confirmAndLaunch's answer to a refused payment check or launch. Still launching (retried automatically): the payment is kept
 * with its coin, and failed() follows that coin on its page. Used, or too old: it is dropped, and a payment that already went
 * to a coin shows that coin. Anything else goes to failed().
 */
function refused(p, err) {
  const { usedBy } = settlePending(p, err);
  if (usedBy) return goToCoin(usedBy, 'This payment already went to its coin. Taking you to its page…');
  throw err;
}

async function launchPaid(value) {
  if (!connected) {
    showError('Connect a wallet first: it pays the network cost and your boost.');
    const first = document.querySelector('#wallets button');
    if (first) first.focus();
    return;
  }
  const payer = connected.account.address;
  setBusy(true, 'Getting the payment details…');
  showSteps('connect');
  // This wallet already launched this ticker and that launch did not finish: follow or finish that one, never pay a second time.
  const open = unfinishedWithTicker(await checkUnfinished(payer), value.ticker);
  if (open) {
    setBusy(false);
    showSteps(null);
    showError(`${unfinishedLine(open)} Launching it again would mean paying for a second coin.`);
    formError.append(' ', finishLink(open));
    return;
  }
  const shown = total().totalLamports;
  const { body: quote } = await postJson('/api/launch/quote', { ...value, launcherWallet: payer });
  if (!quote.transaction) {
    if (value.boostLamports > 0) {
      // A boost must be paid: a quote without a payment would launch without it.
      setBusy(false);
      showSteps(null);
      showError(
        'This server could not prepare the boost payment. Nothing was paid; try again shortly.',
      );
      return;
    }
    return launchFree({ ...value, launcherWallet: payer }); // nothing to pay after all: launch directly
  }
  const quoted = typeof quote.totalLamports === 'number' ? quote.totalLamports : quote.feeLamports;
  if (quoted !== shown) {
    // The server's network cost changed since this page loaded: never ask the wallet for an amount the page did not show.
    setBusy(false);
    showSteps(null);
    await loadTerms(true);
    showError(
      `The total is now ${formatSol(quoted)}. Check it above and press the button again. Nothing was paid.`,
    );
    return;
  }
  setBusy(true, `Approve the payment of ${formatSol(quoted)} in ${connected.name}…`);
  showSteps('approve');
  let signature;
  try {
    signature = await payQuote(quote);
  } catch (err) {
    setBusy(false);
    showSteps(null);
    showError(walletMessage(err, connected.name, 'pay'));
    return;
  }
  const p = {
    value: { ...value, launcherWallet: payer },
    requestId: quote.requestId,
    signature,
    at: Date.now(),
  };
  savePending(p);
  await confirmAndLaunch(p);
}

function failed(err) {
  showSteps(null);
  // The coin exists and is still being launched (retried automatically): follow it on its page, never launch it again.
  if (err && err.retrying && coinPath(err.slug))
    return goToCoin(err.slug, 'Your coin is still being created on chain. Taking you to its page…');
  setBusy(false);
  const status = err && typeof err.status === 'number' ? err.status : 0;
  const msg = (err && err.message) || '';
  if (status === 402)
    showError('This launch has not been paid yet. Connect a wallet and try again.');
  else if (status === 410) showError('That payment request is too old. Start the launch again.');
  else showError(launchErrorMessage(status, msg === 'Failed to fetch' ? '' : msg));
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  showError('');
  const result = validateLaunch(values(), { briefMax: briefMax() });
  showFieldErrors(result.errors);
  const b = boost();
  showBoostError(b.ok ? '' : b.error);
  if (!result.ok || !b.ok) {
    const first = fields.find((f) => result.errors[f]);
    input(first || 'boost-custom').focus();
    return;
  }
  try {
    if (!terms) await loadTerms(); // never launch without knowing whether there is something to pay
    if (!terms && result.value.boostLamports > 0) {
      showError(
        'Could not load the launch terms, so the boost cannot be paid. Reload the page and try again.',
      );
      return;
    }
    if (feeMode()) await launchPaid(result.value);
    else await launchFree(result.value);
  } catch (err) {
    failed(err);
  }
});

// ---- boot ---------------------------------------------------------------------------------------------------------------

function showTerms(raw) {
  terms = readLaunchTerms(raw);
  input('brief').setAttribute('maxlength', String(terms.briefMaxChars));
  renderBriefCount();
  const keep = boost().ok ? boost().lamports : 0;
  renderBoostChips();
  selectBoost(terms.boostEnabled ? keep : 0);
  // A server that takes no boosts (boost.maxLamports 0): no boost step at all.
  input('boost').hidden = !terms.boostEnabled;
  input('boost-step').hidden = !terms.boostEnabled;
  setText('launch-step-no', terms.boostEnabled ? '04' : '03');
  const rules = input('pay-rules');
  rules.textContent = launchRules(terms);
  rules.hidden = false;
  renderTally();
  const pending = loadPending();
  if (pending) offerPending(pending);
}

watchWallets('solana:mainnet', (list) => {
  wallets = list;
  renderWallets();
});

let termsLoading = null;
/** Load (or with `again`, reload) the terms. Resolves once they are shown, or failed quietly. */
function loadTerms(again) {
  if (termsLoading && !again) return termsLoading;
  termsLoading = fetch('/api/launch/terms', { headers: { accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((t) => {
      if (t && (typeof t.networkCostLamports === 'number' || typeof t.feeLamports === 'number'))
        showTerms(t);
    })
    .catch(() => {})
    .finally(() => {
      termsLoading = null;
    });
  return termsLoading;
}
loadTerms();

// What a boost buys: the average work session's cost, when the server has one. Optional: the tally works without it.
fetch('/api/stats', { headers: { accept: 'application/json' } })
  .then((r) => (r.ok ? r.json() : null))
  .then((st) => {
    if (st && typeof st.avgSessionUsd === 'number' && st.avgSessionUsd > 0) {
      avgSessionUsd = st.avgSessionUsd;
      renderTally();
    }
  })
  .catch(() => {});
renderBriefCount();
renderTally();
// A wallet this browser paid or connected with before: list its launches that did not finish before anything is paid again.
const pendingAtLoad = loadPending();
checkUnfinished((pendingAtLoad && pendingAtLoad.value.launcherWallet) || rememberedWallet());

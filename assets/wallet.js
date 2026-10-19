/* global window */
// The app side of the Wallet Standard (https://github.com/wallet-standard/wallet-standard), with no SDK: the page's CSP allows only
// same-origin scripts, and the standard is small. Phantom, Solflare and Backpack all register themselves this way.
//   - the app dispatches `wallet-standard:app-ready` with an API object { register } that wallets call,
//   - wallets that load later dispatch `wallet-standard:register-wallet` with a callback the app calls with the same API.
// We keep wallets that can connect and signAndSendTransaction on our chain. Wallet objects are untrusted input: only their
// name, icon (data:image URLs) and the two features are used, and every call into them is awaited inside try/catch by callers.

export const CONNECT = 'standard:connect';
export const SIGN_AND_SEND = 'solana:signAndSendTransaction';

export const INSTALL_LINKS = [
  { name: 'Phantom', url: 'https://phantom.com/' },
  { name: 'Solflare', url: 'https://solflare.com/' },
  { name: 'Backpack', url: 'https://backpack.app/' },
];

const isObj = (v) => typeof v === 'object' && v !== null;

/** Can this wallet connect and pay on `chain`? */
export function isUsable(wallet, chain) {
  try {
    const f = isObj(wallet) && isObj(wallet.features) ? wallet.features : null;
    return (
      !!f &&
      isObj(f[CONNECT]) &&
      typeof f[CONNECT].connect === 'function' &&
      isObj(f[SIGN_AND_SEND]) &&
      typeof f[SIGN_AND_SEND].signAndSendTransaction === 'function' &&
      Array.isArray(wallet.chains) &&
      wallet.chains.includes(chain)
    );
  } catch {
    return false;
  }
}

export function walletName(wallet) {
  const n = isObj(wallet) && typeof wallet.name === 'string' ? wallet.name.trim() : '';
  return n ? n.slice(0, 40) : 'Wallet';
}

/** The wallet's icon if it is an inline image (the only kind the page's CSP and we accept), else null. */
export function walletIcon(wallet) {
  const i = isObj(wallet) ? wallet.icon : null;
  return typeof i === 'string' &&
    /^data:image\/(svg\+xml|png|webp|gif|jpeg);/.test(i) &&
    i.length < 200_000
    ? i
    : null;
}

/**
 * Start collecting wallets. `onChange(list)` gets every usable wallet so far, in registration order, whenever it changes.
 * Returns { list, stop }.
 */
export function watchWallets(chain, onChange) {
  const all = [];
  const usable = () => all.filter((w) => isUsable(w, chain));
  const notify = () => {
    try {
      onChange(usable());
    } catch {
      /* the page's handler failed: keep discovering */
    }
  };
  const api = Object.freeze({
    register(...wallets) {
      const added = wallets.filter((w) => isObj(w) && !all.includes(w));
      all.push(...added);
      if (added.length) notify();
      return () => {
        for (const w of added) {
          const i = all.indexOf(w);
          if (i >= 0) all.splice(i, 1);
        }
        notify();
      };
    },
  });
  const onRegister = (event) => {
    try {
      if (typeof event.detail === 'function') event.detail(api);
    } catch {
      /* a broken wallet must not break the page */
    }
  };
  window.addEventListener('wallet-standard:register-wallet', onRegister);
  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  } catch {
    /* a wallet's app-ready listener threw */
  }
  return {
    list: usable,
    stop: () => window.removeEventListener('wallet-standard:register-wallet', onRegister),
  };
}

/** Ask the wallet to connect; returns the account to pay from ({ address, ... }). */
export async function connectWallet(wallet, chain) {
  const out = await wallet.features[CONNECT].connect();
  const accounts =
    (isObj(out) && Array.isArray(out.accounts) ? out.accounts : wallet.accounts) || [];
  const ok = (a) =>
    isObj(a) && typeof a.address === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a.address);
  const account =
    accounts.find((a) => ok(a) && Array.isArray(a.chains) && a.chains.includes(chain)) ||
    accounts.find(ok);
  if (!account)
    throw Object.assign(new Error('the wallet did not share an account'), { kind: 'no-account' });
  return account;
}

/** Have the wallet sign and send the server-built transaction (base64). Returns the transaction signature in base58. */
export async function signAndSend(wallet, account, chain, transactionBase64) {
  const transaction = base64ToBytes(transactionBase64);
  const out = await wallet.features[SIGN_AND_SEND].signAndSendTransaction({
    account,
    chain,
    transaction,
    options: { commitment: 'confirmed' },
  });
  const first = Array.isArray(out) ? out[0] : out;
  const sig = isObj(first) ? first.signature : null;
  if (!(sig instanceof Uint8Array) || sig.length !== 64)
    throw Object.assign(new Error('the wallet did not return a signature'), { kind: 'other' });
  return base58Encode(sig);
}

/** What went wrong in the wallet, as one of: rejected, expired, funds, other. */
export function walletErrorKind(err) {
  const code = isObj(err) ? err.code : undefined;
  const msg = String((isObj(err) && err.message) || err || '');
  if (code === 4001 || /reject|denied|declined|cancel|closed/i.test(msg)) return 'rejected';
  if (/blockhash|expired/i.test(msg)) return 'expired';
  if (/insufficient|not enough|0x1\b/i.test(msg)) return 'funds';
  return 'other';
}

// ---- encoding ---------------------------------------------------------------------------------------------------------

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes) {
  const digits = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

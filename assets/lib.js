// Pure helpers for the watch site: formatting, validation, view models, event labelling.
// No DOM access here, and no clock: callers pass `now` in, so everything is unit-testable (see ../lib.test.ts).
// All strings that come from the API are untrusted; these helpers only clip and classify them. Pages render with textContent.

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const LIMITS = {
  nameMin: 2,
  nameMax: 32,
  tickerMin: 2,
  tickerMax: 10,
  taglineMax: 140,
  /** The launcher's brief (what the agent should build); the server's BRIEF_MAX_CHARS overrides it via /api/launch/terms. */
  briefMax: 500,
};
/**
 * What the launch page assumes until GET /api/launch/terms answers (and fills in for any field the server leaves out).
 * Network cost 0 here: the page never quotes a price it did not get from the server.
 */
export const LAUNCH_DEFAULTS = Object.freeze({
  networkCostLamports: 0,
  boostMaxLamports: 10_000_000_000,
  boostSuggestedLamports: Object.freeze([20_000_000, 50_000_000, 100_000_000]),
  briefMaxChars: 500,
  creatorFeeAgentPercent: 90,
  platformPercent: 10,
});
export const FILTERS = ['all', 'agent', 'money', 'product'];

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isNil = (v) => v === null || v === undefined;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Coerce anything to a short display string. */
export function clip(value, max = 280) {
  const s = typeof value === 'string' ? value : isNil(value) ? '' : String(value);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ---------------------------------------------------------------------------------------------- formatting

export function formatSol(lamports) {
  if (!isNum(lamports)) return '—';
  if (lamports === 0) return '0 SOL';
  const sol = lamports / LAMPORTS_PER_SOL;
  if (Math.abs(sol) < 0.0001) return '<0.0001 SOL';
  return `${Number(sol.toFixed(sol < 1 ? 4 : 3))} SOL`;
}

export function formatUsd(usd) {
  if (!isNum(usd)) return '—';
  if (usd === 0) return '$0.00';
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatInt(n) {
  return isNum(n) ? Math.round(n).toLocaleString('en-US') : '—';
}

export function formatBytes(n) {
  if (!isNum(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function relTime(ts, now) {
  if (!isNum(ts) || !isNum(now)) return '';
  const s = Math.round((now - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function absTime(ts) {
  if (!isNum(ts)) return '';
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export function shortAddr(s) {
  const v = clip(s, 100);
  return v.length > 13 ? `${v.slice(0, 5)}…${v.slice(-5)}` : v;
}

// ---------------------------------------------------------------------------------------------- urls and routing

/** Only plain http(s) URLs may become an href or an iframe src. */
export function safeHttpUrl(u) {
  if (typeof u !== 'string' || u.length > 2048) return null;
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function isMint(s) {
  return typeof s === 'string' && BASE58.test(s);
}

export function pumpUrl(mint) {
  return isMint(mint) ? `https://pump.fun/coin/${mint}` : null;
}

/**
 * The origin the live timeline streams from. When the site is served on its own host (Vercel) and the server on another
 * (api.<domain>), the build puts `<meta name="pad-api" content="https://api.<domain>">` in every page and the coin page's
 * EventSource connects there directly (proxies may cut or buffer a long stream). Anything else, including no tag: '' (this
 * page's own origin, as in development). https only, or http on loopback.
 */
export function apiBase(meta) {
  if (typeof meta !== 'string' || !meta || meta.length > 200) return '';
  try {
    const u = new URL(meta);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    const okScheme = u.protocol === 'https:' || (u.protocol === 'http:' && loopback);
    if (!okScheme || u.pathname !== '/' || u.search || u.hash || u.username || u.password)
      return '';
    return u.origin;
  } catch {
    return '';
  }
}

/** The SSE URL of one coin's timeline (see apiBase). */
export function streamUrl(slug, meta) {
  return `${apiBase(meta)}/api/coins/${encodeURIComponent(String(slug))}/stream`;
}

export function slugFromPath(pathname) {
  const m = /^\/c\/([^/]+)\/?$/.exec(pathname || '');
  if (!m) return null;
  let slug;
  try {
    slug = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  return /^[A-Za-z0-9_-]{1,64}$/.test(slug) ? slug : null;
}

/** /c/<slug>, or null for anything that is not a usable slug (a missing one included: never /c/undefined). */
export function coinPath(slug) {
  return typeof slug === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(slug) ? `/c/${slug}` : null;
}

// ---------------------------------------------------------------------------------------------- coin view models

export function statusChip(coin) {
  switch (coin.status) {
    case 'live':
      return { label: 'live', tone: 'ok' };
    case 'launching':
      return { label: 'launching', tone: 'warn' };
    case 'failed':
      return { label: 'launch failed', tone: 'bad' };
    default:
      return { label: clip(coin.status, 20) || 'unknown', tone: 'idle' };
  }
}

/**
 * The agent's chip. The operator's switches win over the agent's own state: a paused or stopped agent says so, whatever it was
 * doing. state: none | working | error | sleeping | paused | stopped.
 */
export function agentChip(coin) {
  const a = coin.agent;
  if (!a) return { label: 'no agent yet', tone: 'idle', state: 'none' };
  if (coin.agentStopped)
    return { label: 'agent stopped by the operator', tone: 'bad', state: 'stopped' };
  if (coin.agentPaused)
    return { label: 'agent paused by the operator', tone: 'warn', state: 'paused' };
  const phase = clip(a.phase, 20);
  if (a.state === 'working') return { label: `working · ${phase}`, tone: 'work', state: 'working' };
  if (a.state === 'error') return { label: `error · ${phase}`, tone: 'bad', state: 'error' };
  return { label: `between sessions · ${phase}`, tone: 'sleep', state: 'sleeping' };
}

/**
 * One short line about what the agent does next: the operator's switch when one is on, else when a between-sessions agent
 * works next. '' while it is working (or has no agent).
 */
export function sleepNote(coin) {
  if (!coin.agent) return '';
  if (coin.agentStopped) return 'Stopped by the operator. It will not work again.';
  if (coin.agentPaused)
    return 'Paused by the operator. It starts no new work session until resumed.';
  if (coin.agent.state !== 'sleeping') return '';
  const empty = !coin.balance || coin.balance.lamports <= 0;
  return empty
    ? 'Its next work session starts as soon as creator fees arrive.'
    : `Its next work session starts automatically. Budget: ${formatUsd(coin.balance.usd)}.`;
}

/** Extra chips for the operator's coin-level switches (the agent's switches are in agentChip). */
export function operatorChips(coin) {
  const out = [];
  if (coin.hidden) out.push({ label: 'hidden by the operator', tone: 'bad', key: 'hidden' });
  if (coin.productTakenDown)
    out.push({ label: 'product taken down', tone: 'bad', key: 'productTakenDown' });
  return out;
}

/** A stable colour slot (0-5) for a coin's placeholder artwork, from its slug. */
export function thumbTone(seed) {
  const s = clip(seed, 64);
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 6;
}

/** The first character (a whole emoji or letter, upper-cased) of the startup's name, else the coin's: the artwork's monogram. */
export function monogram(coin) {
  const a = coin && coin.agent;
  const text = clip((a && a.startupName) || (coin && coin.name), 64).trim();
  const first = [...text][0];
  return first ? first.toUpperCase() : '?';
}

/** The public product URL, or null when there is none or the operator took it down. */
export function productLink(coin) {
  return coin && coin.productTakenDown !== true ? safeHttpUrl(coin.productUrl) : null;
}

/** Numbers the home page shows that /api/stats does not carry, computed from the listed coins. */
export function directoryStats(coins) {
  const list = Array.isArray(coins) ? coins : [];
  let productsLive = 0;
  let sessions = 0;
  let working = 0;
  for (const c of list) {
    if (productLink(c)) productsLive++;
    if (c.agent && isNum(c.agent.sessions)) sessions += c.agent.sessions;
    if (c.agent && c.agent.state === 'working' && !c.agentPaused && !c.agentStopped) working++;
  }
  return { productsLive, sessions, working };
}

/** Coins with a live product, newest first (the API lists newest first), at most `max`. */
export function latestProducts(coins, max = 4) {
  return (Array.isArray(coins) ? coins : []).filter((c) => productLink(c)).slice(0, max);
}

/** USD per lamport implied by the coin's own balance, or null when the balance is zero. */
export function impliedRate(coin) {
  const b = coin.balance;
  return b && b.lamports > 0 && isNum(b.usd) ? b.usd / b.lamports : null;
}

export function budgetView(coin) {
  const rate = impliedRate(coin);
  const usd = (l) => (isNil(rate) ? null : l * rate);
  const t = coin.totals || { feesCreditedLamports: 0, spentLamports: 0, platformFeeLamports: 0 };
  return {
    balance: { sol: formatSol(coin.balance.lamports), usd: formatUsd(coin.balance.usd) },
    fees: {
      sol: formatSol(t.feesCreditedLamports),
      usd: isNil(rate) ? '' : formatUsd(usd(t.feesCreditedLamports)),
    },
    spent: {
      sol: formatSol(t.spentLamports),
      usd: isNil(rate) ? '' : formatUsd(usd(t.spentLamports)),
    },
    platform: {
      sol: formatSol(t.platformFeeLamports),
      usd: isNil(rate) ? '' : formatUsd(usd(t.platformFeeLamports)),
    },
  };
}

/**
 * Where the coin's money went, for the budget card's bar: spent on work sessions, left in the budget, and the platform's share.
 * Each part has a percent of the whole (0-100, one decimal); `empty` is true before any money arrived.
 */
export function moneyFlow(coin) {
  const t = (coin && coin.totals) || {};
  const n = (v) => (isNum(v) && v > 0 ? v : 0);
  const parts = [
    { key: 'spent', label: 'Spent on work sessions', lamports: n(t.spentLamports) },
    {
      key: 'left',
      label: 'Budget left',
      lamports: n(coin && coin.balance && coin.balance.lamports),
    },
    { key: 'platform', label: 'Platform share', lamports: n(t.platformFeeLamports) },
  ];
  const total = parts.reduce((s, p) => s + p.lamports, 0);
  for (const p of parts) {
    p.percent = total ? Math.round((p.lamports / total) * 1000) / 10 : 0;
    p.sol = formatSol(p.lamports);
  }
  return { total, empty: total === 0, parts };
}

// ---------------------------------------------------------------------------------------------- events

/**
 * Describe one event for display. category: agent | money | product | system.
 * agentWritten is true when `text` came from the agent (untrusted, shown as a labelled quote).
 */
export function describeEvent(ev) {
  const d = ev && ev.data && typeof ev.data === 'object' ? ev.data : {};
  const summary = clip(ev && ev.summary, 400);
  const facts = [];
  const fact = (k, v) => {
    if (v !== '' && !isNil(v)) facts.push([k, clip(v, 120)]);
  };
  let out;
  switch (ev && ev.type) {
    case 'launch.requested':
      out = { category: 'system', icon: 'launch', label: 'Launch requested', tone: 'plain' };
      break;
    case 'launch.created':
      out = {
        category: 'system',
        icon: 'launch',
        label: 'Coin created on pump.fun',
        tone: 'plain',
      };
      fact('mint', shortAddr(d.mint));
      break;
    case 'launch.live':
      out = {
        category: 'system',
        icon: 'check',
        label: 'Fee split locked, agent created',
        tone: 'ok',
      };
      fact('mint', shortAddr(d.mint));
      fact('treasury', shortAddr(d.treasury));
      break;
    case 'launch.failed':
      out = { category: 'system', icon: 'alert', label: 'Launch failed', tone: 'bad' };
      break;
    case 'fees.credited':
      out = { category: 'money', icon: 'coin', label: 'Creator fees credited', tone: 'ok' };
      if (isNum(d.lamports)) fact('to the coin', `+${formatSol(d.lamports)}`);
      if (isNum(d.platformLamports)) fact('platform 10%', formatSol(d.platformLamports));
      if (d.signature) fact('tx', shortAddr(d.signature));
      break;
    case 'agent.woke':
      out = { category: 'agent', icon: 'sun', label: 'Work session started', tone: 'work' };
      if (isNum(d.session)) fact('session', `#${d.session}`);
      if (isNum(d.balanceLamports)) fact('budget', formatSol(d.balanceLamports));
      break;
    case 'agent.decision':
      out = { category: 'agent', icon: 'compass', label: 'Agent chose a startup', tone: 'work' };
      fact('startup', clip(d.name, 80));
      break;
    case 'agent.file':
      out = { category: 'product', icon: 'file', label: 'Agent wrote a file', tone: 'plain' };
      fact('path', clip(d.path, 80));
      if (isNum(d.bytes)) fact('size', formatBytes(d.bytes));
      break;
    case 'agent.deploy':
      out = { category: 'product', icon: 'deploy', label: 'Product published', tone: 'ok' };
      if (isNum(d.version)) fact('version', `v${d.version}`);
      if (isNum(d.files)) fact('files', formatInt(d.files));
      if (isNum(d.bytes)) fact('size', formatBytes(d.bytes));
      break;
    case 'agent.update':
      out = { category: 'agent', icon: 'quote', label: 'Agent update', tone: 'work' };
      break;
    case 'agent.spend':
      out = { category: 'money', icon: 'receipt', label: 'Session cost', tone: 'plain' };
      if (isNum(d.usd)) fact('cost', formatUsd(d.usd));
      if (isNum(d.lamports)) fact('debited', formatSol(d.lamports));
      if (isNum(d.session)) fact('session', `#${d.session}`);
      if (isNum(d.inputTokens) || isNum(d.outputTokens))
        fact('tokens', `${formatInt(d.inputTokens)} in / ${formatInt(d.outputTokens)} out`);
      break;
    case 'agent.slept':
      out = { category: 'agent', icon: 'check', label: 'Session finished', tone: 'sleep' };
      if (isNum(d.session)) fact('session', `#${d.session}`);
      fact('reason', clip(d.reason, 80));
      break;
    case 'agent.error':
      out = { category: 'agent', icon: 'alert', label: 'Agent error', tone: 'bad' };
      break;
    case 'admin.action':
      out = { category: 'system', icon: 'shield', label: 'Operator action', tone: 'operator' };
      fact('action', clip(d.action, 40));
      break;
    case 'product.rejected': {
      out = {
        category: 'product',
        icon: 'shield',
        label: 'Deployment refused by the host',
        tone: 'bad',
      };
      const findings = Array.isArray(d.findings) ? d.findings : [];
      fact('findings', findings.length ? formatInt(findings.length) : '');
      for (const f of findings.slice(0, 3)) {
        if (f && typeof f === 'object') fact(clip(f.rule, 30) || 'rule', clip(f.message, 100));
      }
      break;
    }
    default:
      out = {
        category: 'system',
        icon: 'dot',
        label: clip(ev && ev.type, 40) || 'Event',
        tone: 'plain',
      };
  }
  out.facts = facts;
  out.headline = '';
  out.text = summary;
  out.agentWritten = false;
  out.operator = false;
  const type = ev && ev.type;
  if (type === 'agent.decision') {
    out.headline = clip(d.name, 80);
    out.text = clip(d.pitch, 400) || summary;
    out.agentWritten = true;
    out.facts = [];
  } else if (typeof type === 'string' && type.startsWith('agent.')) {
    out.agentWritten = true;
    // For woke/file/spend/slept the structured facts say everything; the free-text summary adds nothing.
    if (
      out.facts.length &&
      ['agent.woke', 'agent.file', 'agent.spend', 'agent.slept'].includes(type)
    )
      out.text = '';
  } else if (type === 'fees.credited' && out.facts.length) {
    out.text = '';
  } else if (type === 'admin.action') {
    out.operator = true; // the operator's public reason: platform text, shown distinctly from the agent's
  }
  return out;
}

export function eventMatchesFilter(desc, filter) {
  return filter === 'all' || desc.category === filter;
}

/** Merge events by id (deduped, ascending). Later copies of an id win. */
export function mergeEvents(existing, incoming) {
  const byId = new Map();
  for (const e of existing) byId.set(e.id, e);
  for (const e of incoming) if (e && isNum(e.id)) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * Group a timeline by work session. Returns Map(event id -> { session, role }) for every event inside a session: role is
 * 'start' (agent.woke), 'end' (agent.slept) or 'in' (anything that happened in between, fees included). Events outside any
 * session are not in the map.
 * `events` must be ascending.
 */
export function sessionMarks(events) {
  const marks = new Map();
  let current = null;
  let last = 0;
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || !isNum(ev.id)) continue;
    const d = ev.data && typeof ev.data === 'object' ? ev.data : {};
    if (ev.type === 'agent.woke') {
      current = isNum(d.session) ? d.session : last + 1;
      last = current;
      marks.set(ev.id, { session: current, role: 'start' });
    } else if (current !== null && ev.type === 'agent.slept') {
      marks.set(ev.id, { session: current, role: 'end' });
      current = null;
    } else if (current !== null) {
      marks.set(ev.id, { session: current, role: 'in' });
    }
  }
  return marks;
}

// ---------------------------------------------------------------------------------------------- launch form

export function normalizeTicker(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase();
}

/**
 * Validate the launch form. `opts.briefMax` is the server's limit for the brief (default LIMITS.briefMax).
 * `input.boostLamports` is the boost the page already parsed (an integer, see parseBoost); it is copied through as is, and the
 * page shows boost problems itself, next to the boost picker.
 * value always carries `boostLamports` (0 without a boost) and carries `brief` only when the launcher wrote one.
 */
export function validateLaunch(input, opts = {}) {
  const name = String(input.name || '').trim();
  const ticker = normalizeTicker(input.ticker);
  const tagline = String(input.tagline || '').trim();
  const wallet = String(input.wallet || '').trim();
  const brief = String(input.brief || '').trim();
  const briefMax =
    isNum(opts.briefMax) && opts.briefMax > 0 ? Math.floor(opts.briefMax) : LIMITS.briefMax;
  const errors = {};
  const nameLen = [...name].length;
  if (nameLen < LIMITS.nameMin || nameLen > LIMITS.nameMax)
    errors.name = `Name must be ${LIMITS.nameMin}-${LIMITS.nameMax} characters (now ${nameLen}).`;
  // The chain counts bytes, not characters (as the server does): an emoji or accented letter takes 2 to 4 of the 32.
  else if (new TextEncoder().encode(name).length > LIMITS.nameMax)
    errors.name = `Name is too long for the chain: emoji and accented letters take 2 to 4 of its ${LIMITS.nameMax} bytes. Shorten it.`;
  if (
    !/^[A-Z0-9]+$/.test(ticker) ||
    ticker.length < LIMITS.tickerMin ||
    ticker.length > LIMITS.tickerMax
  )
    errors.ticker = `Ticker must be ${LIMITS.tickerMin}-${LIMITS.tickerMax} characters, A-Z and 0-9 only.`;
  const tagLen = [...tagline].length;
  if (tagLen > LIMITS.taglineMax)
    errors.tagline = `Tagline can be at most ${LIMITS.taglineMax} characters (now ${tagLen}).`;
  if (wallet && !BASE58.test(wallet))
    errors.wallet = 'That does not look like a Solana address. Leave it empty to skip.';
  const briefLen = [...brief].length;
  if (briefLen > briefMax)
    errors.brief = `The brief can be at most ${formatInt(briefMax)} characters (now ${formatInt(briefLen)}).`;
  const boost = input.boostLamports;
  const value = {
    name,
    ticker,
    tagline,
    boostLamports: Number.isSafeInteger(boost) && boost > 0 ? boost : 0,
  };
  if (brief) value.brief = brief;
  if (wallet) value.launcherWallet = wallet;
  return { ok: Object.keys(errors).length === 0, errors, value };
}

// ---------------------------------------------------------------------------------------------- launch: cost and boost

/**
 * GET /api/launch/terms, normalised: every field the page needs, from the server where it has it and LAUNCH_DEFAULTS where it
 * does not. An older server that only sends feeLamports is read as that network cost.
 */
export function readLaunchTerms(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const lamports = (v) => Number.isSafeInteger(v) && v >= 0;
  const networkCostLamports = lamports(t.networkCostLamports)
    ? t.networkCostLamports
    : lamports(t.feeLamports)
      ? t.feeLamports
      : LAUNCH_DEFAULTS.networkCostLamports;
  const b = t.boost && typeof t.boost === 'object' ? t.boost : {};
  // maxLamports 0: this server takes no boosts (the page then hides the boost step).
  const boostMaxLamports = lamports(b.maxLamports)
    ? b.maxLamports
    : LAUNCH_DEFAULTS.boostMaxLamports;
  const suggested = (
    Array.isArray(b.suggestedLamports)
      ? b.suggestedLamports
      : LAUNCH_DEFAULTS.boostSuggestedLamports
  )
    .filter((v) => lamports(v) && v > 0 && v <= boostMaxLamports)
    .slice(0, 6);
  const solUsd = isNum(t.solUsd) && t.solUsd > 0 ? t.solUsd : null;
  const pct = (v, d) => (isNum(v) && v >= 0 && v <= 100 ? v : d);
  const agentPct = pct(t.creatorFeeAgentPercent, LAUNCH_DEFAULTS.creatorFeeAgentPercent);
  return {
    networkCostLamports,
    boostMaxLamports,
    boostEnabled: boostMaxLamports > 0,
    boostSuggestedLamports: [...new Set(suggested)].sort((x, y) => x - y),
    briefMaxChars:
      isNum(t.briefMaxChars) && t.briefMaxChars > 0
        ? Math.floor(t.briefMaxChars)
        : LAUNCH_DEFAULTS.briefMaxChars,
    solUsd,
    chain: t.chain === 'real' || t.chain === 'fake' ? t.chain : null,
    walletChain:
      typeof t.walletChain === 'string' && t.walletChain ? t.walletChain : 'solana:mainnet',
    devWallet: t.devWallet === true,
    creatorFeeAgentPercent: agentPct,
    platformPercent: pct(t.platformPercent, 100 - agentPct),
  };
}

/** Lamports in USD at `solUsd`, or null without a price. */
export function lamportsUsd(lamports, solUsd) {
  return isNum(lamports) && isNum(solUsd) && solUsd > 0
    ? (lamports / LAMPORTS_PER_SOL) * solUsd
    : null;
}

/** "0.05 SOL (about $7.50)", or just the SOL without a price. */
export function solWithUsd(lamports, solUsd) {
  const usd = lamportsUsd(lamports, solUsd);
  return usd === null || lamports === 0
    ? formatSol(lamports)
    : `${formatSol(lamports)} (about ${formatUsd(usd)})`;
}

/**
 * Parse a SOL amount someone typed ("0.05", "1", ".5", "1,5" is refused) into whole lamports. Returns null for anything that is
 * not a plain non-negative decimal with at most 9 decimal places.
 */
export function parseSolToLamports(raw) {
  const s = typeof raw === 'string' ? raw.trim() : isNum(raw) ? String(raw) : '';
  const m = /^(\d{0,7})(?:\.(\d{0,9}))?$/.exec(s);
  if (!s || !m || (!m[1] && !m[2])) return null;
  const lamports = Number(m[1] || '0') * LAMPORTS_PER_SOL + Number((m[2] || '').padEnd(9, '0'));
  return Number.isSafeInteger(lamports) ? lamports : null;
}

/**
 * The boost the launcher picked. `choice` is 'none', 'custom' or a preset's lamports (number or numeric string); `customRaw` is
 * the custom field's text (in SOL). Returns { ok, lamports, error }: error is a sentence for the page, '' when ok.
 */
export function parseBoost(choice, customRaw, maxLamports = LAUNCH_DEFAULTS.boostMaxLamports) {
  const max = Number.isSafeInteger(maxLamports) && maxLamports > 0 ? maxLamports : 0;
  const bad = (error) => ({ ok: false, lamports: 0, error });
  if (choice === 'none' || choice === undefined || choice === null || choice === '')
    return { ok: true, lamports: 0, error: '' };
  let lamports;
  if (choice === 'custom') {
    const text = typeof customRaw === 'string' ? customRaw.trim() : '';
    if (!text) return { ok: true, lamports: 0, error: '' };
    lamports = parseSolToLamports(text);
    if (lamports === null)
      return bad('Enter the boost in SOL, for example 0.05. Use a dot for decimals.');
  } else {
    lamports = Number(choice);
    if (!Number.isSafeInteger(lamports) || lamports < 0) return bad('Pick a boost amount.');
  }
  if (lamports > max) return bad(`The boost can be at most ${formatSol(max)}.`);
  return { ok: true, lamports, error: '' };
}

/** Network cost + boost = total, all integer lamports. `free` is true when there is nothing to pay. */
export function launchTotal(terms, boostLamports) {
  const network =
    terms && Number.isSafeInteger(terms.networkCostLamports) && terms.networkCostLamports > 0
      ? terms.networkCostLamports
      : 0;
  const boost = Number.isSafeInteger(boostLamports) && boostLamports > 0 ? boostLamports : 0;
  const total = network + boost;
  return {
    networkCostLamports: network,
    boostLamports: boost,
    totalLamports: total,
    free: total === 0,
  };
}

/** The launch button: "Launch for 0.05 SOL", or "Launch for free" when there is nothing to pay. */
export function launchButtonLabel(totalLamports) {
  return isNum(totalLamports) && totalLamports > 0
    ? `Launch for ${formatSol(totalLamports)}`
    : 'Launch for free';
}

/** Whole work sessions a boost pays for at the average session cost, or null when either number is unknown. */
export function boostSessions(boostLamports, solUsd, avgSessionUsd) {
  const usd = lamportsUsd(boostLamports, solUsd);
  if (usd === null || !isNum(avgSessionUsd) || avgSessionUsd <= 0) return null;
  return Math.floor(usd / avgSessionUsd + 1e-9);
}

/** What the boost buys, in one line for the launch receipt. '' without a boost. */
export function boostWorkLine(boostLamports, solUsd, avgSessionUsd) {
  if (!isNum(boostLamports) || boostLamports <= 0) return '';
  const n = boostSessions(boostLamports, solUsd, avgSessionUsd);
  if (n === null || n < 1)
    return 'Your agent starts its first work session as soon as the coin is live.';
  return `Enough for about ${formatInt(n)} work ${n === 1 ? 'session' : 'sessions'}, starting as soon as the coin is live.`;
}

/** The one line under the launch button: where the money goes, and the holders disclosure (stated once on the page). */
export function launchRules(terms) {
  const t = terms || readLaunchTerms(null);
  const network =
    t.networkCostLamports > 0
      ? "You pay only the network cost of creating the coin and locking its fee split, with no platform margin; any of it the chain does not use goes to your agent's budget. "
      : '';
  return `${network}100% of a boost goes to your agent's budget. After launch, ${t.creatorFeeAgentPercent}% of the coin's creator fees fund its agent and ${t.platformPercent}% go to the platform. Holders get no claim on the product, the budget or any profit.`;
}

/** The launcher's brief on a coin (untrusted text, rendered as text), clipped; null when there is none. */
export function coinBrief(coin) {
  const b = coin && typeof coin.brief === 'string' ? coin.brief.trim() : '';
  return b ? clip(b, 600) : null;
}

/** The launch money on a coin's budget card: boost and network cost at launch, each null when unknown or zero. */
export function launchMoney(coin) {
  const pos = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
  const boost = pos(coin && coin.boostLamports);
  const network = pos(coin && coin.networkCostLamports);
  const actual = pos(coin && coin.actualLaunchCostLamports);
  return {
    boostLamports: boost,
    boost: boost === null ? null : formatSol(boost),
    networkCostLamports: network,
    networkCost: network === null ? null : formatSol(network),
    actualCostLamports: actual,
    actualCost: actual === null ? null : formatSol(actual),
  };
}

/** A human message for a failed POST /api/launch. `serverMessage` is the API's { error } text (untrusted, shown as text). */
export function launchErrorMessage(status, serverMessage) {
  const detail = clip(serverMessage, 200);
  const tail = detail ? ` (${detail})` : '';
  if (status === 400)
    return `The server rejected those details${tail}. Fix the form and try again.`;
  if (status === 429)
    return `Too many launches from here right now${tail}. Wait a while and try again.`;
  if (status === 409) return `This launch cannot go ahead${tail}.`; // retrying it the same way cannot help
  if (status === 502)
    return `The launch did not go through on the chain${tail}. Try again in a minute.`;
  if (status === 0) return 'Could not reach the server. Check your connection and try again.';
  return `Something went wrong (HTTP ${status})${tail}. Try again.`;
}

// ---------------------------------------------------------------------------------------------- unfinished launches

/** A Solana address as the API takes it: base58, 32 to 44 characters. */
export function isAddress(s) {
  return typeof s === 'string' && BASE58.test(s);
}

/**
 * GET /api/launch/unfinished, normalised: the coins a wallet launched that are still launching or can be finished with no new
 * payment, newest first, each { slug, name, ticker, status, path }. Untrusted API data: an entry without a usable slug is
 * dropped and the text is clipped (the page renders it as text). At most 10; [] for anything unreadable.
 */
export function readUnfinished(raw) {
  const list = raw && Array.isArray(raw.coins) ? raw.coins : [];
  const out = [];
  for (const c of list) {
    const path = c && typeof c.slug === 'string' ? coinPath(c.slug) : null;
    if (!path) continue;
    out.push({
      slug: c.slug,
      name: clip(c.name, 40),
      ticker: clip(c.ticker, 12),
      status: c.status === 'launching' ? 'launching' : 'failed',
      path,
    });
    if (out.length === 10) break;
  }
  return out;
}

/** The unfinished coin with this ticker (case-insensitive), or null. Launching it again would mean paying a second time. */
export function unfinishedWithTicker(coins, ticker) {
  const t = normalizeTicker(ticker);
  if (!t || !Array.isArray(coins)) return null;
  return coins.find((c) => c && normalizeTicker(c.ticker) === t) || null;
}

/** The launch page's line for one unfinished coin (see readUnfinished): still being created on chain, or stopped. */
export function unfinishedLine(coin) {
  const what = `${clip(coin && coin.name, 40)} ($${clip(coin && coin.ticker, 12)})`;
  return coin && coin.status === 'launching'
    ? `Your launch of ${what} is still being created on chain.`
    : `Your launch of ${what} did not finish.`;
}

/**
 * The coin page's launch panel, from the coin and the page's own finish state: null (nothing pressed yet), 'working' (POST
 * /api/coins/:slug/finish in flight), 'retrying' (the server keeps retrying it on chain) or { error } (the server's message).
 * null when there is nothing to show, else { tone, title, text, button, busy, progress, error }:
 *   failed, finishable (coin.finishable) -> a button finishes the launch with no new payment;
 *   launching                            -> it is in progress on chain, and retried automatically.
 */
export function finishPanel(coin, state) {
  if (!coin) return null;
  // Free only when its recorded price is 0: any other finishable launch (an older one with no price on record too) was paid for.
  const free = coin.networkCostLamports === 0 && !(Number(coin.boostLamports) > 0);
  const finish = {
    tone: 'warn',
    title: 'This launch did not finish',
    text: free
      ? 'Finish it now: there is nothing to pay.'
      : 'It is already paid for. Finish it now: no new payment needed.',
    button: true,
    busy: false,
    progress: '',
    error: '',
  };
  if (state === 'working')
    return { ...finish, busy: true, progress: 'Finishing on chain, this can take up to a minute…' };
  if (coin.status === 'failed' && coin.finishable === true)
    return { ...finish, error: state && typeof state === 'object' ? clip(state.error, 300) : '' };
  if (coin.status === 'launching')
    return {
      tone: 'info',
      title: 'Launch in progress',
      text: '',
      button: false,
      busy: false,
      progress:
        state === 'retrying'
          ? 'Still finishing on chain. This page updates by itself.'
          : 'The coin is being created on chain. An interrupted launch is retried automatically, and this page updates by itself.',
      error: '',
    };
  return null;
}

/** A human message for a failed POST /api/coins/:slug/finish: the server's own sentence (untrusted, shown as text). */
export function finishErrorMessage(status, serverMessage) {
  if (status === 0) return 'Could not reach the server. Check your connection and try again.';
  const detail = clip(serverMessage, 200).trim();
  if (!detail) return `Something went wrong (HTTP ${status}). Try again.`;
  const sentence = detail[0].toUpperCase() + detail.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

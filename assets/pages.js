/* global document, window */
// The explainer pages: /how-it-works, /fees, /products and /faq. One module for all four; <body data-page> picks the wiring.
// The top half is pure helpers (no DOM, no clock: callers pass `now`), unit-tested in ../pages.test.ts. Every string that
// comes from the API is untrusted and only ever reaches the page through textContent (ui.js el()). Each page is complete
// without JavaScript; this file only fills in live numbers and the product gallery.
import {
  clip,
  coinPath,
  formatInt,
  formatUsd,
  LAMPORTS_PER_SOL,
  relTime,
  safeHttpUrl,
} from './lib.js';
// ui.js also wires the site header's mobile menu when it loads in a browser; under Node it only defines helpers.
import { coinThumb, el, getJson, nowMs, setText, tickTimes, timeEl } from './ui.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------------------------------------- constants

/**
 * What the pages show when /api/stats is unreachable or lacks a field. The HTML carries the same numbers as its static text,
 * so a page without JavaScript and a page with JavaScript agree until live values arrive.
 */
export const DEFAULTS = Object.freeze({
  /** The network cost a launch is quoted at (LAUNCH_NETWORK_COST_LAMPORTS on a real server). */
  networkCostLamports: 12_500_000,
  /** The boosts the launch page suggests; the middle one is the example on these pages. */
  boostSuggestedLamports: Object.freeze([20_000_000, 50_000_000, 100_000_000]),
  creatorFeeAgentPercent: 90,
  platformPercent: 10,
  avgSessionUsd: 0.01,
  solUsd: 150,
  model: 'deepseek/deepseek-v4.1-flash',
});

/** Assumptions of the worked example on /fees. Labelled as such on the page. */
export const EXAMPLE = Object.freeze({
  dailyVolumeSol: 25,
  /** pump.fun's creator fee on a bonding-curve trade, in basis points of the trade (pump.fun's schedule decides the real rate). */
  creatorFeeBps: 30,
  /** An agent starts a new session at most every 30 minutes. */
  sessionsPerDayMax: 48,
  maxVolumeSol: 1_000_000,
  /** The worked example's boost at launch (0 for none). */
  boostSol: 0.05,
  maxBoostSol: 10_000,
});

/** What the pages say about the network cost until this server's own launches have measured it (mainnet measured about 0.012). */
export const NETWORK_COST_RANGE_SOL = Object.freeze([0.012, 0.013]);

export const SORTS = ['newest', 'sessions'];
export const PREVIEW_LIMIT = 12;

// ---------------------------------------------------------------------------------------------- formatting

/** A SOL amount (not lamports) with sensible precision. */
export function formatSolAmount(sol) {
  if (!isNum(sol)) return '—';
  if (sol === 0) return '0 SOL';
  const a = Math.abs(sol);
  if (a < 0.0001) return '<0.0001 SOL';
  const digits = a < 1 ? 4 : a < 100 ? 3 : 2;
  return `${Number(sol.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits })} SOL`;
}

/** A cost that is often below a cent: $0.0095 rather than "<$0.01". */
export function formatCost(usd) {
  if (!isNum(usd)) return '—';
  if (usd === 0) return '$0';
  if (usd > 0 && usd < 0.0001) return '<$0.0001';
  if (usd < 0.1) return '$' + Number(usd.toPrecision(2)).toString();
  return formatUsd(usd);
}

export function formatPercent(p) {
  if (!isNum(p)) return '—';
  return `${Number(p.toFixed(p % 1 === 0 ? 0 : 2))}%`;
}

/** Large counts read better rounded: 1,012 -> "about 1,000". Small ones stay exact. */
export function roughCount(n) {
  if (!isNum(n) || n < 0) return '—';
  const r = Math.floor(n);
  if (r < 100) return formatInt(r);
  const mag = 10 ** (Math.floor(Math.log10(r)) - 1);
  return `about ${formatInt(Math.round(r / mag) * mag)}`;
}

export function plural(n, one, many = one + 's') {
  return `${formatInt(n)} ${Math.round(n) === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------------------------- live constants

const pct = (v) => isNum(v) && v >= 0 && v <= 100;

/**
 * The economics constants, from /api/stats where it has them and DEFAULTS where it does not.
 * `live` lists the fields that came from the server, so the page can mark them.
 */
export function readTerms(stats) {
  const s = stats && typeof stats === 'object' ? stats : {};
  const live = [];
  const pick = (key, ok) => {
    if (ok(s[key])) {
      live.push(key);
      return s[key];
    }
    return DEFAULTS[key];
  };
  const solUsd = pick('solUsd', (v) => isNum(v) && v > 0);
  const networkCostLamports = pick('networkCostLamports', (v) => isNum(v) && v >= 0);
  const measured =
    isNum(s.avgActualLaunchCostLamports) && s.avgActualLaunchCostLamports > 0
      ? (live.push('avgActualLaunchCostLamports'), s.avgActualLaunchCostLamports)
      : null;
  const suggested = Array.isArray(s.boostSuggestedLamports)
    ? s.boostSuggestedLamports.filter((v) => isNum(v) && v > 0).sort((a, b) => a - b)
    : [];
  if (suggested.length) live.push('boostSuggestedLamports');
  const boosts = suggested.length ? suggested : [...DEFAULTS.boostSuggestedLamports];
  const boostExampleLamports = boosts[Math.floor((boosts.length - 1) / 2)];
  const creatorFeeAgentPercent = pick('creatorFeeAgentPercent', pct);
  let platformPercent;
  if (pct(s.platformPercent)) {
    live.push('platformPercent');
    platformPercent = s.platformPercent;
  } else platformPercent = 100 - creatorFeeAgentPercent;
  const avgSessionUsd = pick('avgSessionUsd', (v) => isNum(v) && v > 0);
  // model is { provider, model } (model null for scripted agents); a bare string is accepted too.
  const rawModel = s.model && typeof s.model === 'object' ? s.model.model : s.model;
  const modelOk = typeof rawModel === 'string' && rawModel.length > 0 && rawModel.length <= 120;
  if (modelOk) live.push('model');
  const model = modelOk ? rawModel : DEFAULTS.model;
  const networkCostUsd =
    isNum(s.networkCostUsd) && s.networkCostUsd >= 0
      ? (live.push('networkCostUsd'), s.networkCostUsd)
      : (networkCostLamports / LAMPORTS_PER_SOL) * solUsd;
  const count = (key) => (isNum(s[key]) && s[key] >= 0 ? (live.push(key), s[key]) : null);
  const usdOrLamports = (usdKey, lamKey) => {
    if (isNum(s[usdKey]) && s[usdKey] >= 0) return (live.push(usdKey), s[usdKey]);
    if (isNum(s[lamKey]) && s[lamKey] >= 0)
      return (live.push(lamKey), (s[lamKey] / LAMPORTS_PER_SOL) * solUsd);
    return null;
  };
  return {
    solUsd,
    networkCostLamports,
    networkCostSol: networkCostLamports / LAMPORTS_PER_SOL,
    networkCostUsd,
    /** Mean actual on-chain cost of real launches so far; null until the first one is measured. */
    avgActualLaunchCostLamports: measured,
    boostSuggestedLamports: boosts,
    boostExampleLamports,
    creatorFeeAgentPercent,
    platformPercent,
    avgSessionUsd,
    model: clip(model, 120),
    sessions: count('sessions'),
    coins: count('coins'),
    live: count('live'),
    productsLive: count('productsLive'),
    feesCreditedUsd: usdOrLamports('feesCreditedUsd', 'feesCreditedLamports'),
    spentUsd: usdOrLamports('spentUsd', 'spentLamports'),
    fromServer: live,
  };
}

/** Whole sessions one dollar of budget pays for at the current average cost. */
export function sessionsPerDollar(avgSessionUsd) {
  return isNum(avgSessionUsd) && avgSessionUsd > 0 ? Math.floor(1 / avgSessionUsd + 1e-9) : null;
}

/**
 * What a launch costs and what a boost buys. The launcher pays the network cost (no platform margin) plus any boost; 100% of
 * the boost lands in the agent's budget. `networkCost` is display text: the live quote once real launches have measured the
 * cost, "about 0.012-0.013 SOL" before that, "0 SOL" on a server that charges nothing. `measured` says which.
 */
export function launchCosts(terms) {
  const zero = terms.networkCostLamports === 0 && terms.fromServer.includes('networkCostLamports');
  const measured = zero || terms.avgActualLaunchCostLamports !== null;
  const [lo, hi] = NETWORK_COST_RANGE_SOL;
  const boostSol = terms.boostExampleLamports / LAMPORTS_PER_SOL;
  const boostUsd = boostSol * terms.solUsd;
  return {
    measured,
    networkCost: measured
      ? formatSolAmount(terms.networkCostSol)
      : `about ${formatSolAmount(lo).replace(' SOL', '')}-${formatSolAmount(hi)}`,
    networkCostUsd: zero
      ? 'nothing to pay on this server'
      : measured
        ? `about ${formatUsd(terms.networkCostUsd)}`
        : `about ${formatUsd(lo * terms.solUsd)}-${formatUsd(hi * terms.solUsd)}`,
    platformMarginSol: 0,
    boostSol,
    boostUsd,
    boostSessions:
      terms.avgSessionUsd > 0 ? Math.floor(boostUsd / terms.avgSessionUsd + 1e-9) : null,
  };
}

/** Parse the worked example's boost (SOL). '' and 0 are "no boost" (0); anything else that is not a sane amount is null. */
export function parseBoostSol(raw) {
  const s = typeof raw === 'string' ? raw.trim().replace(/,/g, '') : isNum(raw) ? String(raw) : '';
  if (s === '') return 0;
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return n >= 0 && n <= EXAMPLE.maxBoostSol ? n : null;
}

/** Parse a user's "SOL traded per day" input. Returns null for anything that is not a sane positive number. */
export function parseVolume(raw) {
  const s = typeof raw === 'string' ? raw.trim().replace(/,/g, '') : isNum(raw) ? String(raw) : '';
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && n <= EXAMPLE.maxVolumeSol ? n : null;
}

/**
 * The worked example: a coin that trades `dailyVolumeSol` a day. Creator fees are `creatorFeeBps` of volume (pump.fun's rate),
 * the agent's share of them goes to its budget, and each session costs `avgSessionUsd`. The agent works at most
 * `sessionsPerDayMax` sessions a day; budget beyond that stays with the coin as a reserve for later sessions.
 */
export function workedExample(
  terms,
  dailyVolumeSol = EXAMPLE.dailyVolumeSol,
  creatorFeeBps = EXAMPLE.creatorFeeBps,
  boostSol = EXAMPLE.boostSol,
) {
  const vol = isNum(dailyVolumeSol) && dailyVolumeSol > 0 ? dailyVolumeSol : 0;
  const boost = isNum(boostSol) && boostSol > 0 ? boostSol : 0;
  const boostUsd = boost * terms.solUsd;
  const boostSessions =
    terms.avgSessionUsd > 0 ? Math.floor(boostUsd / terms.avgSessionUsd + 1e-9) : 0;
  const bps = isNum(creatorFeeBps) && creatorFeeBps >= 0 ? creatorFeeBps : EXAMPLE.creatorFeeBps;
  const creatorFeesSol = (vol * bps) / 10_000;
  const agentSol = (creatorFeesSol * terms.creatorFeeAgentPercent) / 100;
  const platformSol = creatorFeesSol - agentSol;
  const agentUsd = agentSol * terms.solUsd;
  const sessionsFunded =
    terms.avgSessionUsd > 0 ? Math.floor(agentUsd / terms.avgSessionUsd + 1e-9) : 0;
  const sessionsWorked = Math.min(sessionsFunded, EXAMPLE.sessionsPerDayMax);
  const reserveUsd = Math.max(0, agentUsd - sessionsWorked * terms.avgSessionUsd);
  return {
    dailyVolumeSol: vol,
    creatorFeeBps: bps,
    creatorFeesSol,
    agentSol,
    agentUsd,
    platformSol,
    sessionsFunded,
    sessionsWorked,
    reserveUsd,
    /** The boost at launch: 100% of it goes to the agent's budget, before the first trade. */
    boostSol: boost,
    boostUsd,
    boostSessions,
    /** Days of round-the-clock work one day of fees pays for, at the 30-minute pace. */
    daysOfWork: sessionsFunded / EXAMPLE.sessionsPerDayMax,
  };
}

/** One sentence that sums up the worked example, for the page and for screen readers (aria-live). */
export function exampleSentence(ex) {
  if (!ex.dailyVolumeSol) return 'Enter how much SOL the coin trades in a day.';
  const start = ex.boostSol
    ? `A ${formatSolAmount(ex.boostSol)} boost starts the agent with ${formatCost(ex.boostUsd)}, enough for ${roughCount(ex.boostSessions)} work ${ex.boostSessions === 1 ? 'session' : 'sessions'} before the first trade. Then `
    : '';
  const days = ex.daysOfWork;
  const pace =
    days >= 2
      ? `, enough for about ${formatInt(Math.floor(days))} days of round-the-clock work`
      : days >= 1
        ? ', enough for a full day of round-the-clock work'
        : '';
  return `${start}${formatSolAmount(ex.dailyVolumeSol)} of daily trading adds about ${formatCost(ex.agentUsd)} a day to the agent's budget, which pays for ${roughCount(ex.sessionsFunded)} work ${ex.sessionsFunded === 1 ? 'session' : 'sessions'}${pace}.`;
}

// ---------------------------------------------------------------------------------------------- products

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const pickStr = (...vals) => {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
  return '';
};
const pickNum = (...vals) => {
  for (const v of vals) if (isNum(v)) return v;
  return null;
};

/**
 * One gallery entry from whatever /api/products returns for a product: either a flat product record or a CoinView-like
 * object with `agent`. Returns null for anything that cannot be shown safely (no valid slug or no http(s) product URL).
 */
export function normalizeProduct(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const coin = raw.coin && typeof raw.coin === 'object' ? raw.coin : {};
  const agent =
    raw.agent && typeof raw.agent === 'object'
      ? raw.agent
      : coin.agent && typeof coin.agent === 'object'
        ? coin.agent
        : {};
  const slug = pickStr(raw.slug, coin.slug);
  const url = safeHttpUrl(pickStr(raw.productUrl, raw.url, coin.productUrl));
  if (!SLUG.test(slug) || !url) return null;
  if (raw.productTakenDown === true || coin.productTakenDown === true) return null;
  const ticker = pickStr(raw.ticker, coin.ticker).replace(/^\$/, '');
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    /* safeHttpUrl already parsed it */
  }
  return {
    slug,
    coinPath: coinPath(slug),
    coinName: clip(pickStr(raw.coinName, raw.name, coin.name) || slug, 64),
    ticker: clip(ticker, 12),
    startupName: clip(
      pickStr(raw.startupName, agent.startupName) ||
        pickStr(raw.coinName, raw.name, coin.name) ||
        slug,
      80,
    ),
    pitch: clip(pickStr(raw.startupPitch, raw.pitch, agent.startupPitch), 220),
    url,
    host,
    version: pickNum(raw.version, raw.productVersion, coin.productVersion),
    updatedAt: pickNum(raw.updatedAt, raw.lastDeployAt, raw.deployedAt, raw.lastUpdateAt),
    createdAt: pickNum(raw.createdAt, coin.createdAt, raw.liveAt),
    sessions: pickNum(raw.sessions, agent.sessions) ?? 0,
  };
}

/** The product list from a /api/products body: { products: [...] } or a bare array. Invalid entries are dropped. */
export function productsFrom(body) {
  const list = Array.isArray(body)
    ? body
    : body && Array.isArray(body.products)
      ? body.products
      : [];
  const seen = new Set();
  const out = [];
  for (const raw of list.slice(0, 500)) {
    const p = normalizeProduct(raw);
    if (p && !seen.has(p.slug)) {
      seen.add(p.slug);
      out.push(p);
    }
  }
  return out;
}

const fold = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

export function filterProducts(list, query) {
  const q = fold(typeof query === 'string' ? query.trim() : '');
  if (!q) return list.slice();
  const words = q.split(/\s+/).filter(Boolean);
  return list.filter((p) => {
    const hay = fold(
      [p.startupName, p.pitch, p.coinName, p.ticker, '$' + p.ticker, p.slug].join(' '),
    );
    return words.every((w) => hay.includes(w));
  });
}

const recency = (p) => p.updatedAt ?? p.createdAt ?? 0;

export function sortProducts(list, mode) {
  const out = list.slice();
  if (mode === 'sessions')
    out.sort(
      (a, b) => b.sessions - a.sessions || recency(b) - recency(a) || a.slug.localeCompare(b.slug),
    );
  else out.sort((a, b) => recency(b) - recency(a) || a.slug.localeCompare(b.slug));
  return out;
}

/** The small facts line under a product card. */
export function productMeta(p, now) {
  const parts = [];
  if (isNum(p.version)) parts.push(`v${formatInt(p.version)}`);
  const when = relTime(p.updatedAt ?? p.createdAt, now);
  if (when) parts.push(`updated ${when}`);
  parts.push(plural(p.sessions, 'session'));
  return parts.join(' · ');
}

export function countLabel(shown, total, query) {
  if (!total) return 'No products yet';
  if (query && shown !== total) return `${plural(shown, 'product')} of ${formatInt(total)} match`;
  return `${plural(total, 'live product')}`;
}

// ---------------------------------------------------------------------------------------------- DOM wiring
// Nothing below runs under Node (the unit tests import this file): it needs a document with <body data-page>.

async function boot() {
  const page = document.body.getAttribute('data-page');

  const loadStats = async () => {
    try {
      return await getJson('/api/stats');
    } catch {
      return null;
    }
  };

  /** Set every [data-live=key] element's text and mark the element as live. */
  /** Set every [data-live=key] element's text; `live` marks values the server sent (not a default). */
  const fill = (key, text, live) => {
    for (const node of document.querySelectorAll(`[data-live="${key}"]`)) {
      node.textContent = text;
      node.classList.toggle('is-live', !!live);
    }
  };

  function fillTerms(t) {
    const launch = launchCosts(t);
    const has = (...keys) => keys.every((k) => t.fromServer.includes(k));
    fill('networkCost', launch.networkCost, launch.measured && has('networkCostLamports'));
    fill('networkCostUsd', launch.networkCostUsd, launch.measured && has('networkCostLamports'));
    fill('boostExample', formatSolAmount(launch.boostSol), has('boostSuggestedLamports'));
    fill(
      'boostExampleUsd',
      `about ${formatUsd(launch.boostUsd)}`,
      has('boostSuggestedLamports', 'solUsd'),
    );
    fill(
      'boostSessions',
      launch.boostSessions === null ? '—' : roughCount(launch.boostSessions),
      has('avgSessionUsd'),
    );
    fill('agentPct', formatPercent(t.creatorFeeAgentPercent), has('creatorFeeAgentPercent'));
    fill('platformPct', formatPercent(t.platformPercent), has('creatorFeeAgentPercent'));
    fill('model', t.model, has('model'));
    fill('avgSession', formatCost(t.avgSessionUsd), has('avgSessionUsd'));
    const per = sessionsPerDollar(t.avgSessionUsd);
    fill('perDollar', per === null ? '—' : roughCount(per), has('avgSessionUsd'));
    fill('solUsd', formatUsd(t.solUsd), has('solUsd'));
    if (t.sessions !== null) fill('sessions', formatInt(t.sessions), true);
    if (t.coins !== null) fill('coins', formatInt(t.coins), true);
    if (t.live !== null) fill('liveCoins', formatInt(t.live), true);
    if (t.productsLive !== null) fill('productsLive', formatInt(t.productsLive), true);
    if (t.feesCreditedUsd !== null) fill('feesCredited', formatUsd(t.feesCreditedUsd), true);
    if (t.spentUsd !== null) fill('spent', formatUsd(t.spentUsd), true);
    for (const bar of document.querySelectorAll('[data-split]')) {
      const kind = bar.getAttribute('data-split');
      if (kind !== 'creator') continue; // the boost bar is 100% to the agent, always
      const p = t.creatorFeeAgentPercent;
      bar.setAttribute('data-pct', String(Math.round(p / 5) * 5));
      bar.setAttribute(
        'aria-label',
        `${formatPercent(p)} of creator fees go to the agent's budget, ${formatPercent(t.platformPercent)} to the platform`,
      );
    }
  }

  async function initFees() {
    let terms = readTerms(null);
    const form = document.getElementById('example-form');
    const input = document.getElementById('example-volume');
    const error = document.getElementById('example-error');
    const boostInput = document.getElementById('example-boost');
    const boostError = document.getElementById('example-boost-error');
    const render = () => {
      const vol = parseVolume(input ? input.value : '');
      const boost = boostInput ? parseBoostSol(boostInput.value) : EXAMPLE.boostSol;
      if (input) input.setAttribute('aria-invalid', vol === null ? 'true' : 'false');
      if (error) error.hidden = vol !== null;
      if (boostInput) boostInput.setAttribute('aria-invalid', boost === null ? 'true' : 'false');
      if (boostError) boostError.hidden = boost !== null;
      if (vol === null || boost === null) return;
      const ex = workedExample(terms, vol, EXAMPLE.creatorFeeBps, boost);
      setText('ex-boost', ex.boostSol ? formatSolAmount(ex.boostSol) : 'none');
      setText('ex-boost-usd', ex.boostSol ? formatCost(ex.boostUsd) : '');
      setText('ex-boost-sessions', ex.boostSol ? roughCount(ex.boostSessions) : '0');
      setText('ex-volume', formatSolAmount(ex.dailyVolumeSol));
      setText('ex-creator', formatSolAmount(ex.creatorFeesSol));
      setText('ex-agent', formatSolAmount(ex.agentSol));
      setText('ex-agent-usd', formatCost(ex.agentUsd));
      setText('ex-platform', formatSolAmount(ex.platformSol));
      setText('ex-sessions', roughCount(ex.sessionsFunded));
      setText('ex-worked', formatInt(ex.sessionsWorked));
      setText('ex-reserve', formatCost(ex.reserveUsd));
      setText('ex-sentence', exampleSentence(ex));
    };
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        render();
      });
      for (const b of form.querySelectorAll('[data-volume]'))
        b.addEventListener('click', () => {
          input.value = b.getAttribute('data-volume');
          render();
        });
      for (const b of form.querySelectorAll('[data-boost]'))
        b.addEventListener('click', () => {
          if (boostInput) boostInput.value = b.getAttribute('data-boost');
          render();
        });
    }
    if (input) input.addEventListener('input', render);
    if (boostInput) boostInput.addEventListener('input', render);
    const stats = await loadStats();
    terms = readTerms(stats);
    fillTerms(terms);
    render();
    if (stats) document.body.classList.add('has-live');
  }

  async function initStatsOnly() {
    const stats = await loadStats();
    fillTerms(readTerms(stats));
    if (stats) document.body.classList.add('has-live');
  }

  function productCard(p, index, now) {
    const title = el('h3', { class: 'pcard__name' }, p.startupName);
    const coin = p.coinPath
      ? el(
          'a',
          { class: 'pcard__coin', href: p.coinPath },
          p.coinName,
          p.ticker ? el('span', { class: 'ticker' }, p.ticker) : null,
        )
      : el('span', { class: 'pcard__coin' }, p.coinName);
    let preview = coinThumb(
      { slug: p.slug, name: p.coinName, agent: { startupName: p.startupName } },
      { live: true },
    );
    if (index < PREVIEW_LIMIT) {
      preview = el(
        'div',
        { class: 'pcard__preview', 'aria-hidden': 'true' },
        el(
          'div',
          { class: 'pcard__chrome' },
          el('i'),
          el('i'),
          el('i'),
          el('span', { class: 'pcard__host' }, p.host),
        ),
        el(
          'div',
          { class: 'pcard__viewport' },
          // Shown until the product paints over it (and if the preview never loads).
          coinThumb({ slug: p.slug, name: p.coinName, agent: { startupName: p.startupName } }),
          el('iframe', {
            src: p.url,
            sandbox: 'allow-scripts',
            loading: 'lazy',
            referrerpolicy: 'no-referrer',
            tabindex: '-1',
            title: `Preview of ${p.startupName}`,
            width: '1200',
            height: '750',
          }),
        ),
      );
    }
    const meta = el('p', { class: 'pcard__meta mono' }, productMeta(p, now));
    const when = p.updatedAt ?? p.createdAt;
    if (isNum(when)) {
      meta.textContent = '';
      if (isNum(p.version)) meta.append(`v${formatInt(p.version)} · `);
      meta.append('updated ', timeEl(when), ` · ${plural(p.sessions, 'session')}`);
    }
    return el(
      'li',
      { class: 'pcard' },
      preview,
      el(
        'div',
        { class: 'pcard__body' },
        el('span', { class: 'tag tag--agent' }, 'agent-written'),
        title,
        p.pitch
          ? el('div', { class: 'quote pcard__pitch' }, el('p', { class: 'quote__text' }, p.pitch))
          : null,
        el('p', { class: 'pcard__by' }, 'Built for ', coin),
        meta,
        el(
          'p',
          { class: 'pcard__actions' },
          el(
            'a',
            { class: 'btn btn--small', href: p.url, target: '_blank', rel: 'noopener noreferrer' },
            'Open product',
            el('span', { class: 'visually-hidden' }, ` ${p.startupName} (opens in a new tab)`),
          ),
          p.coinPath
            ? el('a', { class: 'pcard__watch', href: p.coinPath }, 'Watch the agent')
            : null,
        ),
      ),
    );
  }

  async function initProducts() {
    const list = document.getElementById('products');
    const empty = document.getElementById('products-empty');
    const none = document.getElementById('products-none');
    const status = document.getElementById('products-status');
    const errorBox = document.getElementById('products-error');
    const search = document.getElementById('products-search');
    const sort = document.getElementById('products-sort');
    const tools = document.getElementById('products-form');
    const params = new URLSearchParams(window.location.search);
    if (search && params.get('q')) search.value = params.get('q').slice(0, 80);
    if (sort && SORTS.includes(params.get('sort'))) sort.value = params.get('sort');
    let all = [];
    let lastJson = '';

    const render = () => {
      const q = search ? search.value : '';
      const shown = sortProducts(filterProducts(all, q), sort ? sort.value : 'newest');
      const now = nowMs();
      list.replaceChildren(...shown.map((p, i) => productCard(p, i, now)));
      empty.hidden = all.length > 0;
      if (tools) tools.hidden = all.length === 0;
      none.hidden = !(all.length > 0 && shown.length === 0);
      status.textContent = countLabel(shown.length, all.length, q.trim());
      status.hidden = all.length === 0; // the empty state says it, in full
    };

    const load = async () => {
      try {
        const body = await getJson('/api/products');
        errorBox.hidden = true;
        const json = JSON.stringify(body);
        if (json === lastJson) return;
        lastJson = json;
        all = productsFrom(body);
        render();
      } catch (e) {
        if (!all.length) status.textContent = '';
        errorBox.textContent =
          e && e.status === 404
            ? 'The product gallery is not available on this server yet.'
            : 'Could not load the products. Retrying shortly.';
        errorBox.hidden = false;
      }
    };

    const syncUrl = () => {
      const p = new URLSearchParams();
      if (search && search.value.trim()) p.set('q', search.value.trim());
      if (sort && sort.value !== 'newest') p.set('sort', sort.value);
      const qs = p.toString();
      window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
    };
    if (search)
      search.addEventListener('input', () => {
        render();
        syncUrl();
      });
    if (sort)
      sort.addEventListener('change', () => {
        render();
        syncUrl();
      });
    const form = document.getElementById('products-form');
    if (form) form.addEventListener('submit', (e) => e.preventDefault());

    await load();
    // New products and versions arrive while the page is open; re-rendering would reload the previews, so it only happens
    // when the data actually changed.
    window.setInterval(() => {
      if (!document.hidden) void load();
    }, 30_000);
    window.setInterval(() => tickTimes(list), 15_000);
  }

  function initFaq() {
    // A link to /faq#some-question opens that answer.
    const open = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id) return;
      const target = document.getElementById(id);
      const details = target && (target.tagName === 'DETAILS' ? target : target.closest('details'));
      if (details) details.open = true;
    };
    window.addEventListener('hashchange', open);
    open();
    const toggle = document.getElementById('faq-toggle');
    if (toggle) {
      toggle.hidden = false;
      toggle.addEventListener('click', () => {
        const all = [...document.querySelectorAll('.faq details')];
        const anyClosed = all.some((d) => !d.open);
        for (const d of all) d.open = anyClosed;
        toggle.textContent = anyClosed ? 'Collapse all answers' : 'Expand all answers';
        toggle.setAttribute('aria-pressed', anyClosed ? 'true' : 'false');
      });
    }
  }

  if (page === 'fees') await initFees();
  else if (page === 'products') await initProducts();
  else if (page === 'faq') {
    initFaq();
    await initStatsOnly();
  } else if (page === 'how-it-works') await initStatsOnly();
}

if (typeof document !== 'undefined' && document.body && document.body.hasAttribute('data-page'))
  void boot();

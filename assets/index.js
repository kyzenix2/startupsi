/* global document */
// Home page: live stats, the latest products row and the directory of coins, refreshed every 10 seconds.
import {
  agentChip,
  budgetView,
  clip,
  coinPath,
  directoryStats,
  formatInt,
  formatSol,
  latestProducts,
  operatorChips,
  productLink,
  relTime,
  sleepNote,
  statusChip,
} from './lib.js';
import { chip, coinThumb, el, getJson, nowMs, setText, tickTimes, timeEl } from './ui.js';

const POLL_MS = 10_000;
const list = document.getElementById('coins');
const empty = document.getElementById('empty');
const errorBox = document.getElementById('error');
const latest = document.getElementById('latest');
const latestEmpty = document.getElementById('latest-empty');
let lastCoinsJson = '';
let lastOkAt = null;

const external = { target: '_blank', rel: 'noopener noreferrer' };

/** The agent's startup (agent-written) as the card's lead, or a quiet line while it is still choosing. */
function startupBlock(coin) {
  const a = coin.agent;
  if (a && a.startupName)
    return el(
      'div',
      { class: 'coin-card__startup' },
      el('span', { class: 'tag tag--agent' }, 'agent-written'),
      el('p', { class: 'quote__title' }, clip(a.startupName, 80)),
    );
  return el(
    'div',
    { class: 'coin-card__startup' },
    el('p', { class: 'coin-card__pending' }, !a ? 'Agent arrives at launch' : 'Choosing a startup'),
  );
}

function coinCard(coin) {
  const path = coinPath(coin.slug);
  const status = statusChip(coin);
  const agent = agentChip(coin);
  const budget = budgetView(coin);
  const product = productLink(coin);
  const operatorNote = agent.state === 'paused' || agent.state === 'stopped';
  const pitch = coin.agent && coin.agent.startupName ? clip(coin.agent.startupPitch, 240) : '';

  return el(
    'li',
    { class: 'card coin-card' },
    el(
      'div',
      { class: 'coin-card__media' },
      coinThumb(coin, { live: !!product }),
      startupBlock(coin),
    ),
    pitch
      ? el('p', { class: 'coin-card__pitch' }, pitch)
      : el(
          'p',
          { class: 'coin-card__hint' },
          coin.agent
            ? 'Its pick and pitch land here after its first work session.'
            : 'The agent is created when the launch completes.',
        ),
    el(
      'div',
      { class: 'coin-card__body' },
      el(
        'div',
        { class: 'coin-card__id' },
        el(
          'h3',
          { class: 'card__name' },
          path
            ? el('a', { href: path, class: 'card__link' }, clip(coin.name, 64))
            : clip(coin.name, 64),
        ),
        el('span', { class: 'ticker' }, clip(coin.ticker, 12)),
      ),
      el(
        'p',
        { class: 'chips' },
        chip(status.label, status.tone),
        chip(agent.label, agent.tone, agent.state === 'working' ? 'chip--pulse' : ''),
        operatorChips(coin).map((c) => chip(c.label, c.tone)),
      ),
      coin.tagline ? el('p', { class: 'card__tagline' }, clip(coin.tagline, 160)) : null,
      operatorNote
        ? el(
            'p',
            { class: 'card__sleep card__sleep--operator' },
            `${sleepNote(coin)} The reason is on its timeline.`,
          )
        : null,
      el(
        'dl',
        { class: 'card__budget mono' },
        el(
          'div',
          {},
          el('dt', {}, 'budget'),
          el('dd', {}, `${budget.balance.usd} · ${budget.balance.sol}`),
        ),
      ),
    ),
    el(
      'p',
      { class: 'card__foot' },
      el('span', { class: 'muted' }, 'launched ', timeEl(coin.createdAt)),
      product
        ? el('a', { class: 'link-ext card__product', href: product, ...external }, 'Live product')
        : el(
            'span',
            { class: 'muted' },
            coin.productTakenDown ? 'product taken down by the operator' : 'product in the works',
          ),
    ),
  );
}

function productTile(coin) {
  const path = coinPath(coin.slug);
  const product = productLink(coin);
  const name = (coin.agent && coin.agent.startupName) || coin.name;
  return el(
    'li',
    { class: 'product-tile' },
    coinThumb(coin, { live: true }),
    el(
      'div',
      { class: 'product-tile__body' },
      el('p', { class: 'product-tile__name' }, clip(name, 80)),
      el(
        'p',
        { class: 'product-tile__coin' },
        `by the agent of ${clip(coin.name, 48)} `,
        el('span', { class: 'ticker' }, clip(coin.ticker, 12)),
      ),
      el(
        'p',
        { class: 'product-tile__links' },
        el('a', { class: 'link-ext', href: product, ...external }, 'Open product'),
        path ? el('a', { href: path }, 'How it was built') : null,
      ),
    ),
  );
}

function renderCoins(coins) {
  const json = JSON.stringify(coins);
  if (json === lastCoinsJson) return; // do not rebuild the DOM (and drop keyboard focus) when nothing changed
  lastCoinsJson = json;
  list.replaceChildren(...coins.map(coinCard));
  empty.hidden = coins.length > 0;
  const recent = latestProducts(coins, 4);
  latest.replaceChildren(...recent.map(productTile));
  latest.hidden = recent.length === 0;
  latestEmpty.hidden = recent.length > 0;
  tickTimes(list);
}

/** Show "0.0533 SOL" with the unit set small, so the number stays on one line in a narrow cell. */
function setStat(id, text) {
  const node = setText(id, text);
  if (node && text.endsWith(' SOL'))
    node.replaceChildren(text.slice(0, -4), el('span', { class: 'unit' }, ' SOL'));
}

function renderStats(s, coins) {
  const d = directoryStats(coins);
  setStat('stat-coins', formatInt(s.coins));
  setStat('stat-live', formatInt(s.live));
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  setStat('stat-products', formatInt(num(s.productsLive, d.productsLive)));
  setStat('stat-fees', formatSol(s.feesCreditedLamports));
  setStat('stat-spent', formatSol(s.spentLamports));
  const working = num(s.agentsWorking, d.working);
  const sessions = num(s.sessions, d.sessions);
  setText(
    'stat-working',
    working === 1 ? '1 agent working right now' : `${formatInt(working)} agents working right now`,
  );
  setText(
    'stat-sessions',
    sessions === 1 ? '1 work session so far' : `${formatInt(sessions)} work sessions so far`,
  );
}

function renderSync() {
  if (lastOkAt !== null) setText('sync', `Updated ${relTime(lastOkAt, nowMs())} · every 10 s`);
}

async function refresh() {
  try {
    const [stats, data] = await Promise.all([getJson('/api/stats'), getJson('/api/coins')]);
    const coins = Array.isArray(data.coins) ? data.coins : [];
    renderStats(stats, coins);
    renderCoins(coins);
    errorBox.hidden = true;
    lastOkAt = nowMs();
    renderSync();
  } catch {
    errorBox.hidden = false;
    errorBox.textContent =
      lastOkAt === null
        ? 'Could not load coins from the server. Retrying every 10 s.'
        : `Could not reach the server. Showing data from ${relTime(lastOkAt, nowMs())}. Retrying every 10 s.`;
    if (lastOkAt === null) setText('sync', 'Not loaded.');
  }
}

refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});
setInterval(() => {
  tickTimes();
  renderSync();
}, 30_000);

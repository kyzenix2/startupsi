/* global document, window, EventSource */
// Coin page: header, agent, budget, product and a live timeline (initial fetch + EventSource, deduped by id).
import {
  FILTERS,
  agentChip,
  budgetView,
  clip,
  coinBrief,
  describeEvent,
  eventMatchesFilter,
  finishErrorMessage,
  finishPanel,
  formatInt,
  isMint,
  launchMoney,
  mergeEvents,
  moneyFlow,
  operatorChips,
  pumpUrl,
  safeHttpUrl,
  sessionMarks,
  shortAddr,
  sleepNote,
  slugFromPath,
  statusChip,
  streamUrl,
} from './lib.js';
import {
  chip,
  coinThumb,
  copyText,
  el,
  getJson,
  icon,
  setText,
  svgEl,
  tickTimes,
  timeEl,
} from './ui.js';

const slug = slugFromPath(window.location.pathname);
const $ = (id) => document.getElementById(id);
const REFRESH_MS = 10_000;
const FINISH_POLL_MS = 15_000; // while a launch finished from this page is still being retried on chain
const PHASES = [
  ['ideation', 'Idea'],
  ['building', 'Build'],
  ['live', 'Live'],
  ['operating', 'Operate'],
];

let coin = null;
let events = [];
let filter = 'all';
const nodes = new Map(); // event id -> <li>
let stream = null;
let productKey = '';
let thumbKey = '';
let finishState = null; // lib.js finishPanel's state: null | 'working' | 'retrying' | { error }
let finishPoll = null;

// ------------------------------------------------------------------------------------------------ operator states

/** "Reason: ..." for a switch the operator turned on, or '' when the reason is not known. Operator text: rendered as text. */
const reasonOf = (key) => {
  const r = coin.operatorReasons && coin.operatorReasons[key];
  return r ? `Reason: ${clip(r, 300)}` : '';
};

/** Notices under the coin header for every switch the operator turned on (the timeline holds the full history). */
function renderOperator() {
  const box = $('operator-notices');
  const notice = (title, key, more) =>
    el(
      'p',
      { class: 'notice notice--operator', 'data-operator': key },
      el('strong', {}, title),
      ' ',
      more,
      reasonOf(key) ? ` ${reasonOf(key)}` : null,
    );
  const list = [];
  if (coin.hidden)
    list.push(
      notice(
        'Hidden by the operator.',
        'hidden',
        'This coin is not listed on startupSI. Its page and timeline stay public.',
      ),
    );
  if (coin.productTakenDown)
    list.push(
      notice('Product taken down by the operator.', 'productTakenDown', 'Its site is offline.'),
    );
  if (coin.agentStopped)
    list.push(notice('Agent stopped by the operator.', 'agentStopped', 'It will not work again.'));
  else if (coin.agentPaused)
    list.push(
      notice('Agent paused by the operator.', 'agentPaused', 'It does not work until resumed.'),
    );
  box.replaceChildren(...list);
  box.hidden = list.length === 0;
}

// ------------------------------------------------------------------------------------------------ finishing a launch

function setFinishState(state) {
  finishState = state;
  if (state === 'retrying' && !finishPoll) finishPoll = setInterval(refresh, FINISH_POLL_MS);
  if (state !== 'retrying' && finishPoll) {
    clearInterval(finishPoll);
    finishPoll = null;
  }
}

/** Set a node's text only when it changed, so a status region is not announced again on every refresh. */
function putText(id, text) {
  const node = $(id);
  if (node.textContent !== text) node.textContent = text;
  node.hidden = !text;
}

/**
 * The launch panel (lib.js finishPanel): a paid launch that did not finish is finished from here, by anyone, with no new
 * payment; a coin that is still launching says so.
 */
function renderFinish() {
  if (finishState && finishState !== 'working') {
    // After a press here: a launching coin is still being finished on chain (the server retries it), so keep polling until it
    // is not; then show whatever it is now (live: no panel; failed and finishable again: the button).
    if (coin.status === 'launching') setFinishState('retrying');
    else if (finishState === 'retrying') setFinishState(null);
  }
  const view = finishPanel(coin, finishState);
  const box = $('finish');
  box.hidden = !view;
  if (!view) return;
  box.className = `callout finish callout--${view.tone}`;
  putText('finish-title', view.title);
  putText('finish-text', view.text);
  putText('finish-progress', view.progress);
  putText('finish-error', view.error);
  const btn = $('finish-btn');
  btn.hidden = !view.button;
  btn.disabled = view.busy;
}

/** POST /api/coins/:slug/finish: resumes this same coin (never a second mint, never a new payment). */
async function finishLaunch() {
  if (finishState === 'working') return;
  setFinishState('working');
  renderFinish();
  let status = 0;
  let body = null;
  try {
    const res = await fetch(`/api/coins/${encodeURIComponent(slug)}/finish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{}',
    });
    status = res.status;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body (a proxy's error page) */
    }
  } catch {
    /* the server could not be reached: status stays 0 */
  }
  if (status >= 200 && status < 300) {
    setFinishState(null);
    if (body && body.coin && body.coin.slug === coin.slug) {
      coin = body.coin;
      renderAll();
    }
    await refresh(); // its new events and its agent
    return;
  }
  // Not finished yet. With retrying: true the coin is launching and the server keeps at it on chain. A proxy timeout or a
  // dropped connection can hide that, so after any failure the coin's own status decides (renderFinish: still launching means
  // still finishing).
  if (body && body.retrying) {
    setFinishState('retrying');
    coin = { ...coin, status: 'launching' }; // what the server just said; the refresh below brings the rest
  } else {
    setFinishState({ error: finishErrorMessage(status, body && body.error) });
  }
  renderAll();
  await refresh();
}

// ------------------------------------------------------------------------------------------------ rendering

function renderHead() {
  document.title = `${clip(coin.name, 40)} (${clip(coin.ticker, 12)}) - startupSI`;
  setText('coin-name', clip(coin.name, 64));
  setText('coin-ticker', clip(coin.ticker, 12));
  setText('coin-tagline', clip(coin.tagline, 160));
  $('coin-tagline').hidden = !coin.tagline;
  const live = !!safeHttpUrl(coin.productUrl) && !coin.productTakenDown;
  const key = `${coin.slug}#${coin.agent ? coin.agent.startupName : ''}#${live}`;
  if (key !== thumbKey) {
    thumbKey = key;
    $('coin-thumb').replaceChildren(coinThumb(coin, { live, size: 'lg' }));
  }
  const status = statusChip(coin);
  const agent = agentChip(coin);
  $('coin-chips').replaceChildren(
    chip(status.label, status.tone),
    chip(agent.label, agent.tone, agent.state === 'working' ? 'chip--pulse' : ''),
    ...operatorChips(coin).map((c) => chip(c.label, c.tone)),
  );

  const mint = isMint(coin.mint) ? coin.mint : null;
  $('mint-code').textContent =
    mint || (coin.status === 'launching' ? 'not minted yet' : 'no mint address');
  $('mint-copy').hidden = !mint;
  const pump = pumpUrl(mint);
  $('pump-link').hidden = !pump;
  if (pump) $('pump-link').setAttribute('href', pump);
}

function stat(label, value, sub) {
  return el(
    'div',
    { class: 'stat' },
    el('dt', {}, label),
    el('dd', {}, value, sub ? el('span', { class: 'stat__sub' }, sub) : null),
  );
}

function phaseTrack(phase) {
  const at = PHASES.findIndex(([p]) => p === phase);
  return el(
    'ol',
    { class: 'phase-track', 'aria-label': 'Phase' },
    PHASES.map(([, label], i) =>
      el(
        'li',
        {
          'data-state': i < at ? 'done' : i === at ? 'current' : 'upcoming',
          'aria-current': i === at ? 'step' : null,
        },
        label,
      ),
    ),
  );
}

/** The launcher's brief, when there is one: the launcher's own words (untrusted), rendered as text in their own labelled block. */
function renderBrief() {
  const brief = coinBrief(coin);
  $('brief-panel').hidden = !brief;
  if (brief && $('brief-text').textContent !== brief) $('brief-text').textContent = brief;
}

function renderAgent() {
  const a = coin.agent;
  const body = $('agent-body');
  if (!a) {
    body.replaceChildren(
      el(
        'p',
        { class: 'muted' },
        coin.status === 'failed' && coin.finishable !== true
          ? 'The launch failed, so there is no agent.'
          : 'The agent is created when the launch completes.',
      ),
    );
    return;
  }
  const chipInfo = agentChip(coin);
  const operator = chipInfo.state === 'paused' || chipInfo.state === 'stopped';
  const reason = coin.agentStopped
    ? reasonOf('agentStopped')
    : coin.agentPaused
      ? reasonOf('agentPaused')
      : '';
  const note = `${sleepNote(coin)}${reason ? ` ${reason}` : ''}`;
  body.replaceChildren(
    el(
      'p',
      { class: 'chips' },
      chip(chipInfo.label, chipInfo.tone, chipInfo.state === 'working' ? 'chip--pulse' : ''),
    ),
    a.startupName
      ? el(
          'div',
          { class: 'quote' },
          el('span', { class: 'tag tag--agent' }, 'agent-written'),
          el('p', { class: 'quote__title' }, clip(a.startupName, 80)),
          a.startupPitch ? el('p', { class: 'quote__text' }, clip(a.startupPitch, 400)) : null,
        )
      : el(
          'p',
          { class: 'muted' },
          'Choosing a startup. Its pick shows up here and on the timeline.',
        ),
    note
      ? el('p', { class: operator ? 'card__sleep card__sleep--operator' : 'card__sleep' }, note)
      : null,
    phaseTrack(a.phase),
    el(
      'dl',
      { class: 'stats-grid' },
      stat('Work sessions', formatInt(a.sessions)),
      stat(
        'Product',
        coin.productVersion !== null && coin.productVersion !== undefined
          ? `v${coin.productVersion}`
          : 'not yet',
      ),
    ),
  );
}

/** A stacked bar of where the money went, drawn as SVG rects (widths are attributes: the page CSP forbids inline styles). */
function flowFigure() {
  const flow = moneyFlow(coin);
  const b = budgetView(coin);
  const usdOf = { spent: b.spent.usd, left: b.balance.usd, platform: b.platform.usd };
  let x = 0;
  const rects = [];
  for (const p of flow.parts) {
    if (!p.percent) continue;
    rects.push(
      svgEl('rect', {
        class: `flow__${p.key}`,
        x: String(x),
        y: '0',
        width: String(p.percent),
        height: '10',
      }),
    );
    x += p.percent;
  }
  const label = flow.empty
    ? 'No money yet'
    : flow.parts.map((p) => `${p.label} ${p.percent}%`).join(', ');
  return el(
    'figure',
    { class: 'flow' },
    el('figcaption', { class: 'flow__cap' }, 'Where the money went'),
    el(
      'div',
      { class: 'flow__track' },
      svgEl(
        'svg',
        { viewBox: '0 0 100 10', preserveAspectRatio: 'none', role: 'img', 'aria-label': label },
        rects,
      ),
    ),
    el(
      'dl',
      { class: 'flow__legend' },
      flow.parts.map((p) =>
        el(
          'div',
          {},
          el('span', { class: `swatch swatch--${p.key}`, 'aria-hidden': 'true' }),
          el('dt', {}, p.label),
          el(
            'dd',
            {},
            usdOf[p.key] || p.sol,
            usdOf[p.key] ? el('span', { class: 'stat__sub' }, p.sol) : null,
          ),
        ),
      ),
    ),
  );
}

function renderBudget() {
  const b = budgetView(coin);
  const launch = launchMoney(coin);
  const pair = (v) => [v.usd || v.sol, v.usd ? v.sol : ''];
  $('budget-body').replaceChildren(
    el(
      'p',
      { class: 'balance mono' },
      el('span', { class: 'balance__usd' }, b.balance.usd),
      el('span', { class: 'balance__sol' }, b.balance.sol),
    ),
    el('p', { class: 'muted' }, 'The agent’s budget. Every work session is paid from it.'),
    flowFigure(),
    el(
      'dl',
      { class: 'stats-grid' },
      stat('Fees credited', ...pair(b.fees)),
      launch.boost ? stat('Boost at launch', launch.boost, '100% to this budget') : null,
      launch.networkCost
        ? stat(
            'Launch cost',
            launch.networkCost,
            launch.actualCost ? `${launch.actualCost} used on chain` : 'network, paid at launch',
          )
        : null,
    ),
    el(
      'p',
      { class: 'reserve' },
      'Creator fees split 90% to this budget and 10% to the platform, locked at launch. What the agent does not spend stays in its budget.',
    ),
  );
}

function renderProduct() {
  const url = safeHttpUrl(coin.productUrl);
  const down = coin.productTakenDown === true;
  const key = `${url || ''}#${coin.productVersion ?? ''}#${down ? reasonOf('productTakenDown') || 'down' : ''}`;
  if (key === productKey) return;
  productKey = key;
  const body = $('product-body');
  const actions = $('product-actions');
  if (down) {
    actions.replaceChildren(chip('offline', 'bad'));
    body.replaceChildren(
      el(
        'p',
        { class: 'notice notice--operator', 'data-operator': 'productTakenDown' },
        el('strong', {}, 'Taken down by the operator.'),
        ' This product is offline. ',
        reasonOf('productTakenDown'),
      ),
    );
    return;
  }
  if (!url) {
    actions.replaceChildren(chip('in the works', 'idle'));
    body.replaceChildren(
      el(
        'div',
        { class: 'empty empty--small' },
        el('p', { class: 'empty__title' }, 'Not deployed yet'),
        el(
          'p',
          { class: 'muted' },
          'The agent builds its product in a private workspace. A live preview appears here the moment it publishes.',
        ),
      ),
    );
    return;
  }
  const frame = el('iframe', {
    class: 'preview',
    src: url,
    title: `Live preview of ${clip(coin.name, 40)}'s product`,
    sandbox: 'allow-scripts allow-forms', // forms need allow-forms to fire submit at all; the product CSP's form-action 'none' still blocks any real submission
    loading: 'lazy',
    referrerpolicy: 'no-referrer',
  });
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep the full url */
  }
  actions.replaceChildren(
    coin.productVersion !== null && coin.productVersion !== undefined
      ? chip(`v${coin.productVersion} live`, 'ok')
      : null,
    el(
      'a',
      { class: 'btn btn--small', href: url, target: '_blank', rel: 'noopener noreferrer' },
      'Open live product',
    ),
  );
  body.replaceChildren(
    el(
      'div',
      { class: 'browser' },
      el(
        'div',
        { class: 'browser__bar' },
        el('span', { class: 'browser__dots', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')),
        el('span', { class: 'browser__url' }, host),
      ),
      frame,
    ),
    el(
      'p',
      { class: 'muted' },
      'Built and published by the agent on its own address. Previewed here in a sandbox.',
    ),
  );
}

function eventNode(ev, mark) {
  const d = describeEvent(ev);
  const head = el(
    'div',
    { class: 'ev__head' },
    el(
      'span',
      {},
      mark && mark.role === 'start'
        ? el('span', { class: 'session-badge' }, `Session #${mark.session}`)
        : null,
      el('span', { class: 'ev__label' }, d.label),
    ),
    timeEl(ev.ts),
  );
  const parts = [head];
  if (d.operator) {
    parts.push(el('span', { class: 'tag tag--operator' }, 'platform operator'));
    if (d.text) parts.push(el('p', { class: 'ev__note' }, d.text));
  } else {
    if (d.headline) parts.push(el('p', { class: 'ev__headline' }, d.headline));
    if (d.text) {
      parts.push(
        d.agentWritten
          ? el(
              'blockquote',
              { class: 'ev__quote' },
              el('span', { class: 'tag tag--agent' }, 'agent-written'),
              el('p', {}, d.text),
            )
          : el('p', { class: 'ev__text' }, d.text),
      );
    }
  }
  if (d.facts.length) {
    parts.push(
      el(
        'dl',
        { class: 'facts mono' },
        d.facts.map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v))),
      ),
    );
    if (!d.agentWritten && !d.operator)
      parts.push(el('span', { class: 'tag tag--fact' }, 'recorded'));
  }
  const session =
    mark && mark.role === 'start'
      ? ' ev--session-start'
      : mark && mark.role === 'end'
        ? ' ev--session-end'
        : mark
          ? ' ev--in-session'
          : '';
  const li = el(
    'li',
    {
      class: `ev ev--${d.category} ev--${d.tone}${d.agentWritten ? ' ev--agent' : ''}${d.operator ? ' ev--operator' : ''}${session}`,
      'data-id': ev.id,
      'data-session': mark ? mark.session : null,
    },
    el('span', { class: 'ev__icon' }, icon(d.icon)),
    el('div', { class: 'ev__body' }, parts),
  );
  li._desc = d;
  li._mark = mark ? `${mark.session}:${mark.role}` : '';
  return li;
}

function renderTimeline(forceRebuild) {
  const list = $('timeline');
  const scroller = $('timeline-scroll');
  const wasAtEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
  const marks = sessionMarks(events);
  for (const ev of events) {
    const mark = marks.get(ev.id);
    const key = mark ? `${mark.session}:${mark.role}` : '';
    const node = nodes.get(ev.id);
    // An event that arrived out of order can change its session grouping: rebuild just that node.
    if (!node || node._mark !== key) nodes.set(ev.id, eventNode(ev, mark));
  }
  const shown = events.filter((ev) => eventMatchesFilter(nodes.get(ev.id)._desc, filter));
  if (
    forceRebuild ||
    list.children.length !== shown.length ||
    shown.some((ev, i) => list.children[i] !== nodes.get(ev.id))
  ) {
    list.replaceChildren(...shown.map((ev) => nodes.get(ev.id)));
  }
  const emptyMsg = $('timeline-empty');
  emptyMsg.hidden = shown.length > 0;
  emptyMsg.textContent = events.length
    ? 'No events match this filter.'
    : 'The story starts with the launch.';
  if ($('follow').checked && (wasAtEnd || forceRebuild)) scroller.scrollTop = scroller.scrollHeight;
  renderFilters();
}

function renderFilters() {
  const counts = {};
  for (const ev of events) {
    const n = nodes.get(ev.id);
    if (!n) continue;
    for (const f of FILTERS) if (eventMatchesFilter(n._desc, f)) counts[f] = (counts[f] || 0) + 1;
  }
  const box = $('filters');
  if (box.children.length === 0) {
    for (const f of FILTERS) {
      const b = el('button', {
        type: 'button',
        class: 'filter',
        'data-filter': f,
        'aria-pressed': String(f === filter),
      });
      b.addEventListener('click', () => {
        filter = f;
        renderTimeline(true);
      });
      box.append(b);
    }
  }
  for (const b of box.children) {
    const f = b.getAttribute('data-filter');
    b.textContent = `${f} (${counts[f] || 0})`;
    b.setAttribute('aria-pressed', String(f === filter));
  }
}

function renderAll() {
  renderHead();
  renderFinish();
  renderOperator();
  renderBrief();
  renderAgent();
  renderBudget();
  renderProduct();
  renderTimeline(false);
}

function addEvents(incoming) {
  const before = events.length;
  events = mergeEvents(events, incoming);
  return events.length !== before;
}

// ------------------------------------------------------------------------------------------------ data

function showNotFound(message) {
  $('loading').hidden = true;
  $('coin').hidden = true;
  $('notfound').hidden = false;
  if (message) setText('notfound-msg', message);
  document.title = 'Coin not found - startupSI';
}

async function load() {
  const data = await getJson(`/api/coins/${encodeURIComponent(slug)}`);
  coin = data.coin;
  addEvents(Array.isArray(data.events) ? data.events : []);
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    await load();
    renderAll();
  } catch {
    /* keep showing what we have; the stream state line tells the story */
  } finally {
    refreshing = false;
  }
}

function setStreamState(text, tone) {
  const s = $('stream-state');
  s.textContent = text;
  s.className = `stream-state stream-state--${tone}`;
}

function connect() {
  if (typeof EventSource === 'undefined') {
    setStreamState(
      'Live updates are not supported in this browser. Refreshing every 10 s.',
      'warn',
    );
    return;
  }
  const meta = document.querySelector('meta[name="pad-api"]');
  stream = new EventSource(streamUrl(slug, meta ? meta.getAttribute('content') : null));
  stream.addEventListener('open', () => setStreamState('Live', 'ok'));
  stream.addEventListener('event', (msg) => {
    let ev;
    try {
      ev = JSON.parse(msg.data);
    } catch {
      return;
    }
    if (!ev || typeof ev.id !== 'number') return;
    if (addEvents([ev])) {
      renderTimeline(false);
      if (/^(fees|agent\.(deploy|spend|decision|woke|slept)|launch|admin)/.test(String(ev.type)))
        refresh(); // totals and agent card changed
    }
  });
  stream.addEventListener('error', () => {
    if (stream.readyState === EventSource.CLOSED) {
      setStreamState('Disconnected. Retrying in 5 s…', 'bad');
      setTimeout(connect, 5000);
    } else {
      setStreamState('Connection lost, reconnecting…', 'warn');
    }
  });
}

async function main() {
  if (!slug) return showNotFound('That address is not a valid coin address.');
  try {
    await load();
  } catch (err) {
    if (err.status === 404) return showNotFound(`There is no coin called "${slug}".`);
    $('loading').textContent =
      'Could not load this coin. Check your connection and reload the page.';
    return;
  }
  $('loading').hidden = true;
  $('coin').hidden = false;
  renderAll();
  connect();
  setInterval(() => {
    if (!document.hidden) refresh();
  }, REFRESH_MS);
  setInterval(() => tickTimes(), 30_000);

  $('finish-btn').addEventListener('click', finishLaunch);
  $('mint-copy').addEventListener('click', async () => {
    const btn = $('mint-copy');
    const ok = coin && isMint(coin.mint) && (await copyText(coin.mint));
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    setText('copy-status', ok ? `Mint address ${shortAddr(coin.mint)} copied` : 'Could not copy');
    setTimeout(() => (btn.textContent = 'Copy'), 2000);
  });
  $('follow').addEventListener('change', () => {
    if ($('follow').checked) $('timeline-scroll').scrollTop = $('timeline-scroll').scrollHeight;
  });
}

main();

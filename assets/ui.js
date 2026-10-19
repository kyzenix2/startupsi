/* global document, window, Node */
// Small DOM helpers shared by the pages. Everything is built with createElement and textContent, never from HTML strings.
// Importing this module also wires the site header's mobile menu (see initSiteNav), so a page that needs nothing else can
// load it on its own: <script type="module" src="/assets/ui.js"></script>.
import { absTime, monogram, relTime, thumbTone } from './lib.js';

const isNil = (v) => v === null || v === undefined;

export const nowMs = () => Date.now(); // the browser's clock; pure helpers in lib.js take it as an argument

export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || isNil(value)) continue;
    if (/^on/i.test(key) || key === 'style' || /^(inner|outer)html$/i.test(key))
      throw new Error(`el: attribute ${key} is not allowed`);
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (isNil(child) || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function setText(id, text) {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
  return node;
}

export async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch {
    const err = new Error('network');
    err.status = 0;
    throw err;
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export function chip(label, tone, extra) {
  return el('span', { class: `chip chip--${tone}${extra ? ' ' + extra : ''}` }, label);
}

/** A <time> that tickTimes() keeps fresh; hover shows the absolute time. */
export function timeEl(ts) {
  return el(
    'time',
    { datetime: new Date(ts).toISOString(), title: absTime(ts), 'data-ts': String(ts) },
    relTime(ts, nowMs()),
  );
}

export function tickTimes(root = document) {
  const now = nowMs();
  for (const t of root.querySelectorAll('time[data-ts]'))
    t.textContent = relTime(Number(t.getAttribute('data-ts')), now);
}

const ICONS = {
  launch: 'M12 3l4 8-4-1-4 1 4-8zM8 14l4 7 4-7M12 10v5',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  alert: 'M12 4l9 16H3L12 4zM12 10v4.5M12 17.5v.5',
  coin: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 8v8M9.5 10.5c0-1 1-1.5 2.5-1.5s2.5.5 2.5 1.5-1 1.3-2.5 1.5-2.5.6-2.5 1.6 1 1.4 2.5 1.4 2.5-.5 2.5-1.4',
  sun: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
  compass: 'M12 3a9 9 0 100 18 9 9 0 000-18zM15.5 8.5l-2 5-5 2 2-5 5-2z',
  file: 'M7 3h7l4 4v14H7V3zM14 3v4h4M9.5 12h5M9.5 15.5h5',
  deploy: 'M12 20V8M7 12l5-5 5 5M5 4h14',
  quote: 'M5 5h14v10H10l-4 4v-4H5V5zM8.5 9h7M8.5 12h4',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6',
  moon: 'M19 14.5A7.5 7.5 0 019.5 5a7.5 7.5 0 109.5 9.5z',
  shield: 'M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6l7-3zM9.5 9.5l5 5M14.5 9.5l-5 5',
  dot: 'M12 9a3 3 0 100 6 3 3 0 000-6z',
  stop: 'M12 3a9 9 0 100 18 9 9 0 000-18zM9 9h6v6H9z',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5H5V6h5',
  wallet: 'M4 7h15v12H4zM4 7l11-3v3M15 13h1.5',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An SVG element with plain attributes (never style or on* handlers). */
export function svgEl(tag, attrs, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || isNil(value)) continue;
    if (/^on/i.test(key) || key === 'style')
      throw new Error(`svgEl: attribute ${key} is not allowed`);
    node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (isNil(child) || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function icon(name, extraClass) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', extraClass ? `icon ${extraClass}` : 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name] || ICONS.dot);
  svg.append(path);
  return svg;
}

/** Copy text to the clipboard; resolves false when the browser refuses. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * A coin's placeholder artwork: its startup's monogram on one of six tones picked from the slug, drawn as a tiny browser
 * window when the product is live. Decorative (aria-hidden): the name next to it says the same thing.
 */
export function coinThumb(coin, opts = {}) {
  const live = !!opts.live;
  return el(
    'span',
    {
      class: `thumb thumb--${thumbTone(coin && coin.slug)}${live ? ' thumb--live' : ''}${opts.size ? ` thumb--${opts.size}` : ''}`,
      'aria-hidden': 'true',
    },
    live ? el('span', { class: 'thumb__bar' }, el('i'), el('i'), el('i')) : null,
    el('span', { class: 'thumb__mark' }, monogram(coin)),
  );
}

// ---- the site header's mobile menu --------------------------------------------------------------------------------------

/**
 * Wire the menu button of `.site-header[data-nav]`. Without JavaScript the links simply show (the button stays hidden);
 * with it, narrow screens get a Menu button that opens and closes the panel. Escape and a click outside close it.
 */
export function initSiteNav(root = document) {
  const header = root.querySelector('.site-header[data-nav]');
  const toggle = header && header.querySelector('.nav-toggle');
  const nav = header && header.querySelector('.site-nav');
  if (!header || !toggle || !nav || header.hasAttribute('data-nav-ready')) return;
  header.setAttribute('data-nav-ready', '');
  toggle.hidden = false;
  const set = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    header.classList.toggle('is-open', open);
  };
  set(false);
  toggle.addEventListener('click', () => set(toggle.getAttribute('aria-expanded') !== 'true'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && header.classList.contains('is-open')) {
      set(false);
      toggle.focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (header.classList.contains('is-open') && !header.contains(e.target)) set(false);
  });
  // Coming back to a wide window closes the panel, so it never stays open behind the inline links.
  if (window.matchMedia) {
    const wide = window.matchMedia('(min-width: 60em)');
    const onChange = () => wide.matches && set(false);
    if (wide.addEventListener) wide.addEventListener('change', onChange);
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => initSiteNav());
  else initSiteNav();
}

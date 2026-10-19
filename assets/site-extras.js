import { PUMP_MINT, PUMP_URL, X_HANDLE, X_URL } from './site-config.js';

function injectCaBar() {
  if (document.querySelector('.site-ca')) return;
  const header = document.querySelector('.site-header');
  if (!header) return;

  const bar = document.createElement('div');
  bar.className = 'site-ca';
  bar.innerHTML = `
    <div class="site-ca__inner">
      <span class="site-ca__label">CA</span>
      <code class="site-ca__code" id="site-ca-mint">${PUMP_MINT}</code>
      <span class="site-ca__actions">
        <button type="button" class="btn btn--small btn--ghost btn--tiny" id="site-ca-copy">Copy</button>
        <a class="btn btn--small btn--ghost btn--tiny link-ext" href="${PUMP_URL}" target="_blank" rel="noopener noreferrer">pump.fun</a>
        <a class="btn btn--small btn--ghost btn--tiny link-ext" href="${X_URL}" target="_blank" rel="noopener noreferrer">${X_HANDLE}</a>
      </span>
    </div>`;
  header.before(bar);

  const copyBtn = bar.querySelector('#site-ca-copy');
  copyBtn?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(PUMP_MINT);
      copyBtn.textContent = 'Copied';
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
      }, 1500);
    } catch {
      copyBtn.textContent = 'Select CA';
    }
  });
}

function injectFooterSocial() {
  const nav = document.querySelector('.site-footer__nav ul');
  if (!nav || nav.querySelector('[data-site-x]')) return;
  const x = document.createElement('li');
  x.innerHTML = `<a href="${X_URL}" data-site-x target="_blank" rel="noopener noreferrer">X (${X_HANDLE})</a>`;
  const pump = document.createElement('li');
  pump.innerHTML = `<a href="${PUMP_URL}" target="_blank" rel="noopener noreferrer">pump.fun</a>`;
  nav.append(x, pump);
}

injectCaBar();
injectFooterSocial();

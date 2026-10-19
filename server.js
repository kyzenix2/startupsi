import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4173;
const UPSTREAM = 'https://startupsi.org';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

const PAGES = new Map([
  ['/', 'index.html'],
  ['/how-it-works', 'how-it-works/index.html'],
  ['/products', 'products/index.html'],
  ['/fees', 'fees/index.html'],
  ['/faq', 'faq/index.html'],
  ['/launch', 'launch/index.html'],
]);

function safeFile(rel) {
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

function sendFile(res, rel, method) {
  const abs = safeFile(rel);
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(method === 'HEAD' ? undefined : 'Not found');
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  if (method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(abs).pipe(res);
}

function proxy(req, res) {
  const target = new URL(req.url, UPSTREAM);
  const headers = {
    accept: req.headers.accept || '*/*',
    'user-agent': req.headers['user-agent'] || 'startupsi-local',
    host: target.host,
  };
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];

  const preq = https.request(
    {
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    (pres) => {
      const hop = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding']);
      const out = {};
      for (const [key, value] of Object.entries(pres.headers)) {
        if (!hop.has(key.toLowerCase()) && value !== undefined) out[key] = value;
      }
      res.writeHead(pres.statusCode || 502, out);
      pres.pipe(res);
    },
  );
  preq.on('error', () => {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Could not reach startupsi.org' }));
  });
  req.pipe(preq);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

  if (pathname.startsWith('/api/')) {
    proxy(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }

  if (PAGES.has(pathname)) {
    sendFile(res, PAGES.get(pathname), req.method);
    return;
  }

  if (/^\/c\/[A-Za-z0-9_-]{1,64}$/.test(pathname)) {
    sendFile(res, 'c/coin.html', req.method);
    return;
  }

  const rel = pathname.replace(/^\/+/, '');
  if (!rel || rel.includes('\0')) {
    sendFile(res, 'index.html', req.method);
    return;
  }
  sendFile(res, rel, req.method);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`startupSI clone at http://127.0.0.1:${PORT}`);
});

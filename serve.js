/* The whole site, served from this directory for local development:
   `node serve.js [port]` puts the portfolio at / and Random Engine at /random/. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 5173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',  // Random Engine's reference links to its README
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webm': 'video/webm', '.mp4': 'video/mp4',
  '.pdf': 'application/pdf', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  // a directory means its index, the way GitHub Pages serves one
  const rel = url.endsWith('/') ? url + 'index.html' : url;
  const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));

  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}).listen(PORT, () => console.log('site on http://localhost:' + PORT + '  (Random Engine at /random/)'));

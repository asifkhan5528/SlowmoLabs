// Serves a built folder like GitHub Pages does: under a sub-path and WITHOUT special headers.
// Usage: node scripts/serve-dist.mjs <dir> [port] [basePath]
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
const dir = resolve(process.argv[2] || 'dist'), port = Number(process.argv[3] || 5200);
const base = (process.argv[4] || '/slowmo-lab/').replace(/\/?$/, '/');
const T = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp4': 'video/mp4', '.webm': 'video/webm', '.webmanifest': 'application/manifest+json', '.onnx': 'application/octet-stream' };
http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!u.startsWith(base)) { res.writeHead(404); return res.end('not under ' + base); }
  let f = resolve(dir, u.slice(base.length) || 'index.html');
  if (!f.startsWith(dir + sep) && f !== dir) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('404'); }
  const st = statSync(f), range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  const h = { 'Content-Type': T[extname(f)] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  if (range) { const a = +range[1], b = range[2] ? +range[2] : st.size - 1; res.writeHead(206, { ...h, 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Content-Length': b - a + 1 }); return createReadStream(f, { start: a, end: b }).pipe(res); }
  res.writeHead(200, { ...h, 'Content-Length': st.size }); createReadStream(f).pipe(res);
}).listen(port, () => console.log(`Serving ${dir} at http://localhost:${port}${base} (no COOP/COEP headers, like GitHub Pages)`));

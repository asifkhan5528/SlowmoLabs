// Tiny static server for the prototype.
//  - serves /public, and maps /vendor/* to the installed npm packages
//  - sets COOP/COEP so onnxruntime-web can use WebAssembly threads
//  - /models/rife49.onnx: served from ./models, downloaded once from Hugging Face if it is missing
import http from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const MODEL_URL = process.env.RIFE_MODEL_URL || 'https://huggingface.co/edgetools/rife/resolve/main/rife49.onnx';
const MODEL_DIR = join(ROOT, 'models');
const MODEL_PATH = process.env.RIFE_MODEL_PATH || join(MODEL_DIR, 'rife49.onnx');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.webm': 'video/webm', '.png': 'image/png', '.mp4': 'video/mp4', '.map': 'application/json', '.svg': 'image/svg+xml',
};

// URL prefix -> directory on disk
const MOUNTS = [
  ['/vendor/ort/', join(ROOT, 'node_modules/onnxruntime-web/dist')],
  ['/vendor/mediabunny.mjs', join(ROOT, 'node_modules/mediabunny/dist/bundles/mediabunny.mjs')],
  ['/samples/', join(ROOT, 'samples')],
  ['/', join(ROOT, 'public')],
];

const baseHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-cache',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { ...baseHeaders, 'Content-Type': type });
  res.end(body);
}

function sendFile(req, res, file) {
  const st = statSync(file);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    res.writeHead(206, { ...baseHeaders, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...baseHeaders, 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

let downloading = null;
async function ensureModel() {
  if (existsSync(MODEL_PATH)) return;
  downloading ??= (async () => {
    mkdirSync(MODEL_DIR, { recursive: true });
    console.log(`Downloading RIFE model (one time) from ${MODEL_URL} ...`);
    const r = await fetch(MODEL_URL, { redirect: 'follow' });
    if (!r.ok) throw new Error(`Hugging Face answered HTTP ${r.status}`);
    const tmp = MODEL_PATH + '.part';
    try {
      await pipeline(Readable.fromWeb(r.body), createWriteStream(tmp));
      if (statSync(tmp).size < 1_000_000) throw new Error('Downloaded file is too small to be the model');
      renameSync(tmp, MODEL_PATH);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* nothing to clean */ }
      throw e;
    }
    console.log('Model saved to', MODEL_PATH);
  })().finally(() => { downloading = null; });
  await downloading;
}

function resolveStatic(urlPath) {
  for (const [prefix, target] of MOUNTS) {
    if (!urlPath.startsWith(prefix) && !(prefix === '/' )) continue;
    if (!prefix.endsWith('/')) { if (urlPath === prefix) return target; continue; } // single-file mount
    const raw = decodeURIComponent(urlPath.slice(prefix.length));
    const rel = raw === '' ? 'index.html' : normalize(raw).replace(/^([/\\])+/, '');
    const full = resolve(target, rel);
    if (full !== target && !full.startsWith(target + sep)) return null; // path traversal guard
    if (existsSync(full) && statSync(full).isFile()) return full;
    if (prefix !== '/') continue;
  }
  return null;
}

http
  .createServer(async (req, res) => {
    try {
      const urlPath = new URL(req.url, 'http://localhost').pathname;
      if (urlPath === '/models/rife49.onnx') {
        try {
          await ensureModel();
        } catch (e) {
          console.error('Model download failed:', e.message);
          return send(res, 502, `Could not download the model automatically (${e.message}).\nDownload rife49.onnx manually from ${MODEL_URL} and put it in the "models" folder, or pick the file in the app.`);
        }
        return sendFile(req, res, MODEL_PATH);
      }
      const file = resolveStatic(urlPath);
      if (!file) return send(res, 404, 'Not found');
      sendFile(req, res, file);
    } catch (e) {
      console.error(e);
      send(res, 500, 'Server error');
    }
  })
  .listen(PORT, () => console.log(`\n  Slow-Mo Lab running at  http://localhost:${PORT}\n  Open it in Chrome or Edge (WebGPU + WebCodecs needed).\n`));

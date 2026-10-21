// Builds a self-contained static site in ./dist (or the folder given as the first argument).
// It needs no server features: all paths are relative, so it works from a sub-path such as
// https://name.github.io/slowmo-lab/ . Run: node scripts/build.mjs [outDir]
import { cpSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] || join(root, 'dist'));
const mb = (f) => (statSync(f).size / 1e6).toFixed(1) + ' MB';

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'vendor/ort'), { recursive: true });
mkdirSync(join(out, 'samples'), { recursive: true });
mkdirSync(join(out, 'models'), { recursive: true });

cpSync(join(root, 'public'), out, { recursive: true });

const copy = (from, to) => { copyFileSync(join(root, from), join(out, to)); console.log('  ' + to.padEnd(52) + mb(join(out, to))); };
copy('node_modules/mediabunny/dist/bundles/mediabunny.mjs', 'vendor/mediabunny.mjs');
for (const f of ['ort.webgpu.min.mjs', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  copy('node_modules/onnxruntime-web/dist/' + f, 'vendor/ort/' + f);
}
for (const f of ['motion_720p30.mp4', 'cut_720p30.mp4']) copy('samples/' + f, 'samples/' + f);

// The model is optional here: the GitHub workflow downloads it at deploy time, and the app falls back to Hugging Face.
const model = join(root, 'models/rife49.onnx');
if (existsSync(model)) copy('models/rife49.onnx', 'models/rife49.onnx');
else console.log('  (no models/rife49.onnx found: the deploy step or the browser will fetch it)');

// Hosts that support a _headers file (Netlify, Cloudflare Pages) get cross-origin isolation, which lets the CPU
// fallback use several threads. GitHub Pages ignores this file; the app works either way.
writeFileSync(join(out, '_headers'), '/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n  Cross-Origin-Resource-Policy: same-origin\n');
writeFileSync(join(out, '.nojekyll'), '');
console.log('Built', out);

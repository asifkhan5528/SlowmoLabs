// RIFE v4.9 (ONNX) via onnxruntime-web. WebGPU when available, WASM otherwise.
// Model I/O (from the model card): img0, img1 float32 [1,3,H,W] in 0..1, timestep float32 [1] -> output [1,3,H,W].
import * as ort from 'onnxruntime-web';

const CACHE_NAME = 'slowmo-models-v1';

async function fetchWithProgress(url, onProgress) {
  const cache = 'caches' in self ? await caches.open(CACHE_NAME).catch(() => null) : null;
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      onProgress?.({ phase: 'cached' });
      return new Uint8Array(await hit.arrayBuffer());
    }
  }
  onProgress?.({ phase: 'download', received: 0, total: 0 });
  const res = await fetch(url);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    throw new Error(`Model download failed (HTTP ${res.status}). ${detail}`);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.({ phase: 'download', received, total });
  }
  const bytes = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }
  if (cache) await cache.put(url, new Response(bytes)).catch(() => {});
  return bytes;
}

export class Rife {
  constructor(session, backend, bytesLength) {
    this.session = session;
    this.backend = backend; // 'webgpu' | 'wasm'
    this.modelBytes = bytesLength;
    [this.in0, this.in1, this.in2] = session.inputNames;
    this.outName = session.outputNames[0];
    this.msPerFrame = null; // set by bench()
  }

  /**
   * @param {{url?: string, bytes?: Uint8Array, onProgress?: Function, forceWasm?: boolean}} opts
   */
  static async load({ url = new URL('../models/rife49.onnx', import.meta.url).href, bytes, onProgress, forceWasm = false } = {}) {
    ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

    const modelBytes = bytes ?? (await fetchWithProgress(url, onProgress));
    onProgress?.({ phase: 'init' });

    const attempts = [];
    if (!forceWasm && 'gpu' in navigator) attempts.push('webgpu');
    attempts.push('wasm');

    let lastErr;
    for (const ep of attempts) {
      try {
        const session = await ort.InferenceSession.create(modelBytes, {
          executionProviders: [ep],
          graphOptimizationLevel: 'all',
        });
        return new Rife(session, ep, modelBytes.length);
      } catch (e) {
        lastErr = e;
        console.warn(`Execution provider "${ep}" failed:`, e);
      }
    }
    throw new Error('Could not start the model: ' + (lastErr?.message ?? lastErr));
  }

  /** Interpolated frame at timestep t (0..1) between planar tensors a and b. Returns a Float32Array [3*padH*padW]. */
  async run(a, b, t, padW, padH) {
    const dims = [1, 3, padH, padW];
    const feeds = {
      [this.in0]: new ort.Tensor('float32', a, dims),
      [this.in1]: new ort.Tensor('float32', b, dims),
      [this.in2]: new ort.Tensor('float32', new Float32Array([t]), [1]),
    };
    const results = await this.session.run(feeds);
    const out = results[this.outName];
    const data = await out.getData();
    const copy = data instanceof Float32Array ? data : new Float32Array(data);
    out.dispose?.();
    return copy;
  }

  /** Times the model at a given padded size. First run compiles shaders, so it is discarded. */
  async bench(padW, padH, runs = 3) {
    const n = 3 * padW * padH;
    const a = new Float32Array(n).fill(0.25);
    const b = new Float32Array(n).fill(0.75);
    try {
      await this.run(a, b, 0.5, padW, padH); // warm-up / shader compile
    } catch (e) {
      throw new Error(
        `The model rejected a ${padW}x${padH} input (${e?.message ?? e}). This ONNX build may only support specific sizes.`,
      );
    }
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) await this.run(a, b, 0.5, padW, padH);
    this.msPerFrame = (performance.now() - t0) / runs;
    return this.msPerFrame;
  }
}

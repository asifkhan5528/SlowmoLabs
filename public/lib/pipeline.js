// Decode -> interpolate -> encode, one frame pair at a time.
import {
  VideoSampleSink,
  Output,
  Mp4OutputFormat,
  MovOutputFormat,
  WebMOutputFormat,
  BufferTarget,
  StreamTarget,
  CanvasSource,
  getFirstEncodableVideoCodec,
} from 'mediabunny';
import { interpolateFrames } from './core.js';
import { THUMB_W, THUMB_H } from './cuts.js';
import { rgbaToPlanar, planarToRgba, padTo } from './tensor.js';

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Output size: upright display size, optionally capped on the long side, forced to even numbers (video encoders need it). */
export function workSize(meta, maxSide) {
  const scale = maxSide ? Math.min(1, maxSide / Math.max(meta.width, meta.height)) : 1;
  const w = scale === 1 ? even(meta.width) : even(meta.width * scale);
  const h = scale === 1 ? even(meta.height) : even(meta.height * scale);
  return { w, h, padW: padTo(w), padH: padTo(h), scaled: scale < 1 };
}

/** Keeps the input's container type: .mov -> QuickTime, .webm -> WebM, everything else -> MP4. */
export function containerFor(fileName) {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (ext === 'mov') return { ext: 'mov', mime: 'video/quicktime', make: (fastStart) => new MovOutputFormat({ fastStart }) };
  if (ext === 'webm') return { ext: 'webm', mime: 'video/webm', make: () => new WebMOutputFormat() };
  return { ext: 'mp4', mime: 'video/mp4', make: (fastStart) => new Mp4OutputFormat({ fastStart }) };
}

/**
 * @param {object} o
 * @param {{track:any, meta:any}} o.probeResult   result of probe()
 * @param {string} o.fileName
 * @param {number} o.shotFps         the fps the clip should look like it was shot at
 * @param {number} o.playbackFps     fps of the exported file (timeline fps)
 * @param {number|null} o.maxSide    cap on the long side in pixels, or null for original size
 * @param {boolean} o.detectCuts
 * @param {number} o.bitrateMul      multiplier on the source bitrate
 * @param {import('./interp.js').Rife} o.model
 * @param {FileSystemWritableFileStream|null} o.writable  stream to disk; null = build in memory
 * @param {AbortSignal} [o.signal]
 * @param {(p:object)=>void} [o.onProgress]
 * @param {(s:string)=>void} [o.onLog]
 */
export async function runSlowmo(o) {
  const { probeResult, fileName, shotFps: F, playbackFps: P, maxSide, detectCuts, bitrateMul, model, writable, signal } = o;
  const log = o.onLog ?? (() => {});
  const { track, meta } = probeResult;
  const { w, h, padW, padH } = workSize(meta, maxSide);
  const throwIfAborted = () => { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); };

  // 1. model speed test at the real size (also compiles shaders)
  log(`Working size ${w}x${h} (model input ${padW}x${padH}), backend: ${model.backend}`);
  const ms = await model.bench(padW, padH);
  log(`Model speed: ${ms.toFixed(0)} ms per generated frame`);
  throwIfAborted();

  // 2. output setup
  const container = containerFor(fileName);
  const format = container.make(writable ? false : 'in-memory');
  const srcPixels = meta.width * meta.height;
  const bitrate = Math.round(Math.min(120e6, Math.max(2e6, meta.bitrate * (w * h / srcPixels) * bitrateMul)));
  const preferred = [meta.codec, 'avc', 'vp9', 'hevc', 'av1'].filter((c, i, a) => c && a.indexOf(c) === i);
  const supported = format.getSupportedVideoCodecs();
  const codec = await getFirstEncodableVideoCodec(preferred.filter((c) => supported.includes(c)), { width: w, height: h, bitrate });
  if (!codec) throw new Error('This browser cannot encode video for this container at this size.');
  log(`Encoding ${codec.toUpperCase()} in ${container.ext.toUpperCase()}, ${(bitrate / 1e6).toFixed(1)} Mbps, ${P} fps`);

  const target = writable ? new StreamTarget(writable, { chunked: true }) : new BufferTarget();
  const output = new Output({ format, target });
  const outCanvas = new OffscreenCanvas(w, h);
  const outCtx = outCanvas.getContext('2d', { alpha: false });
  const videoSource = new CanvasSource(outCanvas, { codec, bitrate });
  output.addVideoTrack(videoSource, { frameRate: P });
  await output.start();

  // 3. buffers
  const workCtx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  const thumbCtx = new OffscreenCanvas(THUMB_W, THUMB_H).getContext('2d', { willReadFrequently: true });
  const outImg = new ImageData(w, h);
  const pool = [];
  const takeBuf = () => pool.pop() ?? { tensor: new Float32Array(3 * padW * padH) };

  const ingest = (sample) => {
    const buf = takeBuf();
    sample.draw(workCtx, 0, 0, w, h); // draw() applies the file's rotation, so frames are upright
    buf.img = workCtx.getImageData(0, 0, w, h);
    thumbCtx.drawImage(workCtx.canvas, 0, 0, THUMB_W, THUMB_H);
    buf.thumb = thumbCtx.getImageData(0, 0, THUMB_W, THUMB_H).data;
    buf.pts = sample.timestamp;
    sample.close();
    rgbaToPlanar(buf.img.data, w, h, padW, padH, buf.tensor);
    return buf;
  };

  // 4. progress bookkeeping
  const estTotal = Math.max(1, Math.round(meta.durationSec * F));
  let done = 0;
  let cuts = 0;
  const startedAt = performance.now();

  const emit = async (j, out) => {
    if (out.kind === 'frame') {
      outCtx.putImageData(out.frame.img, 0, 0);
    } else {
      planarToRgba(out.data, w, h, padW, padH, outImg.data);
      outCtx.putImageData(outImg, 0, 0);
    }
    await videoSource.add(j / P, 1 / P);
    done++;
    if (done % 4 === 0 || done === 1) {
      const elapsed = (performance.now() - startedAt) / 1000;
      const rate = done / elapsed;
      o.onProgress?.({ done, total: Math.max(estTotal, done), etaSec: Math.max(0, (estTotal - done) / rate), cuts });
    }
  };

  // 5. main loop
  try {
    const sink = new VideoSampleSink(track);
    async function* frames() {
      for await (const sample of sink.samples()) yield ingest(sample);
    }
    const res = await interpolateFrames({
      frames: frames(),
      F,
      detectCuts,
      interpolate: (A, B, frac) => model.run(A.tensor, B.tensor, frac, padW, padH),
      emit,
      release: (f) => pool.push(f),
      onCut: (t) => { cuts++; log(`Scene cut near ${t.toFixed(2)} s: not interpolating across it`); },
      checkAbort: throwIfAborted,
    });
    cuts = res.cuts;
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    throw e;
  }

  const seconds = (performance.now() - startedAt) / 1000;
  o.onProgress?.({ done, total: done, etaSec: 0, cuts });
  const stats = { frames: done, seconds, cuts, width: w, height: h, codec, bitrate, container: container.ext, outDurationSec: done / P };
  if (writable) {
    try { await writable.close(); } catch { /* the target already closed it */ }
    return { blob: null, mime: container.mime, stats };
  }
  return { blob: new Blob([target.buffer], { type: container.mime }), mime: container.mime, stats };
}

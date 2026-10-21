import test from 'node:test';
import assert from 'node:assert/strict';
import { openAsBlob } from 'node:fs';
import { planInterval, totalFrames, firstOutputIndex } from '../public/lib/timemap.js';
import { meanAbsLumaDiff, isHardCut } from '../public/lib/cuts.js';
import { rgbaToPlanar, planarToRgba, padTo } from '../public/lib/tensor.js';
import { estimate, qualityHint, slowdown } from '../public/lib/presets.js';
import { probe } from '../public/lib/probe.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

// ---------- time mapping ----------
test('timemap: 30 fps source at 240 fps = 7 generated frames per interval, fracs i/8', () => {
  const dt = 1 / 30;
  const plan = planInterval(0, dt, 0, 240);
  assert.equal(plan.length, 8);
  plan.forEach((p, i) => { assert.equal(p.j, i); near(p.frac, i / 8, 1e-4); });
  assert.equal(plan[0].frac, 0); // first output is the real source frame
});

test('timemap: output frames are contiguous across intervals and total matches', () => {
  const N = 120, dt = 1 / 30, F = 240;
  let expectJ = 0;
  for (let i = 0; i < N - 1; i++) {
    for (const p of planInterval(i * dt, (i + 1) * dt, 0, F)) {
      assert.equal(p.j, expectJ++);
      assert.ok(p.frac >= 0 && p.frac < 1);
    }
  }
  const last = totalFrames((N - 1) * dt, 0, F);
  assert.equal(last, (N - 1) * 8 + 1);
  assert.equal(expectJ, last - 1, 'last source frame is emitted separately as the final frame');
});

test('timemap: 23.976 source to 240 fps (non-integer factor) stays monotonic and in range', () => {
  const dt = 1001 / 24000;
  let prevJ = -1, count = 0;
  for (let i = 0; i < 200; i++) {
    for (const p of planInterval(i * dt, (i + 1) * dt, 0, 240)) {
      assert.equal(p.j, prevJ + 1);
      prevJ = p.j; count++;
      assert.ok(p.frac >= 0 && p.frac <= 1);
    }
  }
  near(count / 200, 240 * dt, 0.01);
});

test('timemap: same fps as source returns the source frames untouched (frac 0)', () => {
  const plan = planInterval(0, 1 / 30, 0, 30);
  assert.deepEqual(plan, [{ j: 0, frac: 0 }]);
});

test('timemap: variable frame rate uses real timestamps', () => {
  // frames at 0, 0.05, 0.06 s; 100 fps output -> j = 0..4 in the first interval (0.00,0.01,..0.04), frac j*0.01/0.05
  const plan = planInterval(0, 0.05, 0, 100);
  assert.equal(plan.length, 5);
  near(plan[2].frac, 0.4, 1e-4);
  assert.equal(firstOutputIndex(0.06, 0, 100), 6);
});

test('timemap: non-zero first timestamp is handled via t0', () => {
  const plan = planInterval(10, 10 + 1 / 30, 10, 60);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].j, 0);
  near(plan[1].frac, 0.5, 1e-4);
});

test('timemap: millisecond-rounded timestamps (WebM, some Android MP4) still put real frames on exact slots', () => {
  const N = 60, K = 4, F = 120;
  const pts = Array.from({ length: N }, (_, i) => Math.round((i * 1000) / 30) / 1000); // 0, .033, .067, .1 ...
  let j0 = 0, count = 0;
  const realAt = [];
  for (let i = 0; i < N - 1; i++) {
    for (const p of planInterval(pts[i], pts[i + 1], 0, F)) {
      assert.equal(p.j, j0++);
      if (p.frac === 0) realAt.push([i, p.j]);
      count++;
    }
  }
  assert.equal(count + 1, (N - 1) * K + 1, 'same frame count as with exact timestamps');
  assert.equal(totalFrames(pts[N - 1], 0, F), (N - 1) * K + 1);
  realAt.forEach(([i, j]) => assert.equal(j, i * K, `source frame ${i} lands on slot ${i * K}, got ${j}`));
});

test('timemap: timestamp tolerance never merges genuinely different slots at high target rates', () => {
  // 960 fps from a 30 fps clip: 32 slots per interval, all distinct and increasing
  const plan = planInterval(1 / 30, 2 / 30, 0, 960);
  assert.equal(plan.length, 32);
  plan.forEach((p, i) => { assert.equal(p.j, 32 + i); assert.ok(i === 0 ? p.frac === 0 : p.frac > 0 && p.frac < 1); });
});

// ---------- cut detection ----------
const solid = (v) => { const a = new Uint8ClampedArray(64 * 36 * 4); for (let i = 0; i < a.length; i += 4) { a[i] = a[i + 1] = a[i + 2] = v; a[i + 3] = 255; } return a; };

test('cuts: identical frames = 0, black->white = 1 and a cut, small change is not a cut', () => {
  assert.equal(meanAbsLumaDiff(solid(120), solid(120)), 0);
  near(meanAbsLumaDiff(solid(0), solid(255)), 1, 1e-9);
  assert.ok(isHardCut(solid(10), solid(200)));
  assert.ok(!isHardCut(solid(100), solid(120)));
});

// ---------- tensors ----------
test('tensor: RGBA -> planar -> RGBA is lossless for 8-bit values, with edge-replicated padding', () => {
  const w = 5, h = 3, padW = padTo(w, 8), padH = padTo(h, 8);
  assert.equal(padTo(1080), 1088);
  assert.equal(padTo(1920), 1920);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37) % 256;
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const t = new Float32Array(3 * padW * padH);
  rgbaToPlanar(rgba, w, h, padW, padH, t);
  // channel planes are separate: R at index 0, G offset by one plane, B by two
  near(t[0], rgba[0] / 255); near(t[padW * padH], rgba[1] / 255); near(t[2 * padW * padH], rgba[2] / 255);
  // padding replicates the last column / row
  near(t[w], t[w - 1]); near(t[h * padW], t[(h - 1) * padW]);
  const back = planarToRgba(t, w, h, padW, padH, new Uint8ClampedArray(w * h * 4));
  assert.deepEqual([...back], [...rgba]);
});

test('tensor: out-of-range model output is clamped', () => {
  const t = new Float32Array(3 * 2 * 2).fill(1.7); t[1] = -0.4;
  const px = planarToRgba(t, 2, 2, 2, 2, new Uint8ClampedArray(16));
  assert.equal(px[0], 255); assert.equal(px[4], 0);
});

// ---------- presets / estimates ----------
test('presets: 30 fps clip at 240 fps shot on a 30 fps timeline = 8x slower, 7 generated per frame', () => {
  assert.equal(slowdown(240, 30), 8);
  const e = estimate({ durationSec: 10, sourceFps: 30, shotFps: 240, playbackFps: 30 });
  assert.equal(e.k, 8);
  assert.equal(e.outFrames, 2400);
  assert.equal(e.interpolations, 2400 - 300);
  assert.equal(e.outDurationSec, 80);
  assert.equal(qualityHint(8).level, 'warn');
  assert.equal(qualityHint(33).level, 'bad');
  assert.equal(qualityHint(0.5).level, 'bad');
});

// ---------- probing real files (uses mediabunny in Node; no WebCodecs needed) ----------
const load = (n) => openAsBlob(new URL(`../samples/${n}`, import.meta.url).pathname);

test('probe: normal clip (moov at end of file)', async () => {
  const { meta } = await probe(await load('motion_720p30.mp4'));
  assert.equal(meta.codec, 'avc');
  assert.equal(meta.width, 1280); assert.equal(meta.height, 720);
  assert.equal(meta.frameCount, 120);
  near(meta.fps, 30, 0.05);
  near(meta.durationSec, 4, 0.1);
  assert.equal(meta.rotation, 0);
  assert.equal(meta.hasAudio, true);
});

test('probe: rotated (phone-style) clip reports upright display size', async () => {
  const { meta } = await probe(await load('rot90_720p30.mp4'));
  assert.equal(meta.width, 720); assert.equal(meta.height, 1280);
  assert.ok(meta.rotation === 90 || meta.rotation === 270);
});

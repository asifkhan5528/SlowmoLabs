import test from 'node:test';
import assert from 'node:assert/strict';
import { interpolateFrames } from '../public/lib/core.js';

const solid = (v) => { const a = new Uint8ClampedArray(64 * 36 * 4); for (let i = 0; i < a.length; i += 4) { a[i] = a[i + 1] = a[i + 2] = v; a[i + 3] = 255; } return a; };

// frame i has pts i/fps and scalar value i*10, so a perfect interpolator gives v(t) = linear in time
async function* fakeFrames(n, fps, thumbFor = () => solid(100)) {
  for (let i = 0; i < n; i++) yield { id: i, pts: i / fps, v: i * 10, thumb: thumbFor(i) };
}

function harness({ n, srcFps, F, detectCuts = false, thumbFor, abortAfter }) {
  const emitted = [];
  const released = [];
  let interpCalls = 0;
  let abortCount = 0;
  const run = () => interpolateFrames({
    frames: fakeFrames(n, srcFps, thumbFor),
    F,
    detectCuts,
    interpolate: async (A, B, t) => { interpCalls++; return { v: A.v * (1 - t) + B.v * t }; },
    emit: async (j, out) => emitted.push({ j, kind: out.kind, v: out.kind === 'frame' ? out.frame.v : out.data.v }),
    release: (f) => released.push(f.id),
    checkAbort: abortAfter ? () => { if (++abortCount > abortAfter) throw new DOMException('Cancelled', 'AbortError'); } : undefined,
  });
  return { run, emitted, released, calls: () => interpCalls };
}

test('loop: 30 -> 240 fps emits contiguous frames 0..N, generated values follow time exactly', async () => {
  const h = harness({ n: 10, srcFps: 30, F: 240 });
  const res = await h.run();
  assert.equal(res.outputs, 9 * 8 + 1);
  assert.deepEqual(h.emitted.map((e) => e.j), [...Array(73).keys()]);
  // value at output frame j = (j/8) * 10  (frame i has value 10*i, 8 outputs per source interval)
  h.emitted.forEach((e) => assert.ok(Math.abs(e.v - (e.j / 8) * 10) < 1e-3, `j=${e.j} v=${e.v}`));
  assert.equal(h.calls(), 9 * 7, '7 generated frames per interval, none for original frames');
  assert.equal(h.emitted.filter((e) => e.kind === 'frame').length, 10, 'only the 10 real frames pass through untouched');
  assert.equal(h.emitted.at(-1).v, 90, 'clip ends on the last real frame');
});

test('loop: every frame except the last is released exactly once, in order', async () => {
  const h = harness({ n: 6, srcFps: 30, F: 120 });
  await h.run();
  assert.deepEqual(h.released, [0, 1, 2, 3, 4]);
});

test('loop: target equal to source fps generates nothing', async () => {
  const h = harness({ n: 8, srcFps: 30, F: 30 });
  const res = await h.run();
  assert.equal(h.calls(), 0);
  assert.equal(res.outputs, 8);
  assert.deepEqual(h.emitted.map((e) => e.v), [0, 10, 20, 30, 40, 50, 60, 70]);
});

test('loop: non-integer factor (24 -> 100 fps) stays contiguous and time-linear', async () => {
  const h = harness({ n: 12, srcFps: 24, F: 100 });
  await h.run();
  h.emitted.forEach((e, idx) => assert.equal(e.j, idx));
  // frame value is 10*i at t = i/24, so v(t) = 240 * t ; output j is at t = j/100
  h.emitted.slice(0, -1).forEach((e) => assert.ok(Math.abs(e.v - 240 * (e.j / 100)) < 1e-3, `j=${e.j} v=${e.v}`));
});

test('loop: a hard cut is held (nearest shot), never blended', async () => {
  // frames 0..4 dark, 5..9 bright: cut between 4 and 5
  const h = harness({ n: 10, srcFps: 30, F: 240, detectCuts: true, thumbFor: (i) => solid(i < 5 ? 10 : 240) });
  const res = await h.run();
  assert.equal(res.cuts, 1);
  assert.equal(h.calls(), (9 - 1) * 7, 'no generated frames inside the cut interval');
  const inCut = h.emitted.filter((e) => e.j >= 4 * 8 && e.j < 5 * 8);
  assert.equal(inCut.length, 8);
  assert.deepEqual(inCut.map((e) => e.v), [40, 40, 40, 40, 50, 50, 50, 50], 'first half holds the outgoing shot, second half the incoming');
  assert.ok(inCut.every((e) => e.kind === 'frame'));
});

test('loop: with cut detection off the same clip is blended across the cut', async () => {
  const h = harness({ n: 10, srcFps: 30, F: 240, detectCuts: false, thumbFor: (i) => solid(i < 5 ? 10 : 240) });
  await h.run();
  assert.equal(h.calls(), 9 * 7);
});

test('loop: a single-frame clip emits one frame', async () => {
  const h = harness({ n: 1, srcFps: 30, F: 240 });
  const res = await h.run();
  assert.equal(res.outputs, 1);
  assert.deepEqual(h.emitted.map((e) => e.j), [0]);
});

test('loop: an empty clip is an error', async () => {
  const h = harness({ n: 0, srcFps: 30, F: 240 });
  await assert.rejects(h.run(), /no decodable frames/);
});

test('loop: cancelling stops the loop with an AbortError', async () => {
  const h = harness({ n: 50, srcFps: 30, F: 240, abortAfter: 20 });
  await assert.rejects(h.run(), (e) => e.name === 'AbortError');
  assert.ok(h.emitted.length < 40);
});

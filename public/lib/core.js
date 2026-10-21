// The frame-pairing loop, free of any browser API so it can be tested in Node.
// `frames` yields { pts, thumb, ...anything } in presentation order; the caller decides what a frame holds.
import { planInterval, firstOutputIndex } from './timemap.js';
import { isHardCut } from './cuts.js';

/**
 * @param {object} o
 * @param {AsyncIterable<{pts:number, thumb:Uint8ClampedArray}>} o.frames
 * @param {number} o.F                    target ("shot") frame rate
 * @param {boolean} o.detectCuts
 * @param {(a:any,b:any,frac:number)=>Promise<any>} o.interpolate   returns the generated frame data
 * @param {(j:number, out:{kind:'frame', frame:any}|{kind:'generated', data:any})=>Promise<void>} o.emit
 * @param {(frame:any)=>void} [o.release]   called when a frame is no longer needed (buffer recycling)
 * @param {(ptsSec:number)=>void} [o.onCut]
 * @param {()=>void} [o.checkAbort]         throws to stop
 * @returns {Promise<{outputs:number, cuts:number}>}
 */
export async function interpolateFrames(o) {
  const { frames, F, detectCuts, interpolate, emit, release, onCut, checkAbort } = o;
  let A = null;
  let t0 = 0;
  let outputs = 0;
  let cuts = 0;

  for await (const B of frames) {
    checkAbort?.();
    if (!A) { A = B; t0 = B.pts; continue; }

    const plan = planInterval(A.pts, B.pts, t0, F);
    const cut = detectCuts && isHardCut(A.thumb, B.thumb);
    if (cut) { cuts++; onCut?.(B.pts); }

    for (const { j, frac } of plan) {
      checkAbort?.();
      if (frac === 0) await emit(j, { kind: 'frame', frame: A }); // an original frame passes through untouched
      else if (cut) await emit(j, { kind: 'frame', frame: frac < 0.5 ? A : B }); // hold nearest shot across a cut
      else await emit(j, { kind: 'generated', data: await interpolate(A, B, frac) });
      outputs++;
    }
    release?.(A);
    A = B;
  }

  if (!A) throw new Error('The video contained no decodable frames.');
  await emit(firstOutputIndex(A.pts, t0, F), { kind: 'frame', frame: A }); // the last source frame ends the clip
  outputs++;
  return { outputs, cuts };
}

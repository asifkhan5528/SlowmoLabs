// Maps output frames (at the "shot" frame rate F) onto source frame intervals.
//
// Output frame j represents source time  T_j = t0 + j / F.  A real F-fps camera captures one frame every 1/F s,
// so playing those frames back at the playback fps is exactly "F / playback" times slower.
// Works for constant and variable source frame rates because it uses real presentation timestamps.

// Container timestamps are often rounded (WebM/MKV and some Android MP4s use 1 ms ticks, so 1/30 s becomes 33 or 34 ms).
// A real frame whose time lands within that rounding error of an output slot belongs to that slot; without this,
// it would slip to the next slot and the previous slot would get a near-duplicate of it (a visible micro-stutter).
const TIMESTAMP_ERROR_SEC = 0.0006;
const tolerance = (F) => Math.min(0.5, TIMESTAMP_ERROR_SEC * F + 1e-6); // in output frames

/** Index of the first output frame whose time is at or after `ptsSec` (t0-relative), allowing for timestamp rounding. */
export function firstOutputIndex(ptsSec, t0, F) {
  const x = (ptsSec - t0) * F;
  const nearest = Math.round(x);
  return Math.max(0, Math.abs(x - nearest) <= tolerance(F) ? nearest : Math.ceil(x));
}

/** Total output frames if the last source frame is at `ptsLast`; the last source frame itself is always emitted. */
export function totalFrames(ptsLast, t0, F) {
  return firstOutputIndex(ptsLast, t0, F) + 1;
}

/**
 * Output frames that fall inside the source interval [ptsA, ptsB).
 * frac === 0 means "this is source frame A itself"; otherwise it is the timestep (0..1) between A and B.
 */
export function planInterval(ptsA, ptsB, t0, F) {
  const jA = firstOutputIndex(ptsA, t0, F);
  const jB = firstOutputIndex(ptsB, t0, F);
  const span = ptsB - ptsA;
  const xA = (ptsA - t0) * F;
  const aOnSlot = Math.abs(xA - Math.round(xA)) <= tolerance(F); // real frame A sits (within rounding) on slot jA
  const out = [];
  for (let j = jA; j < jB; j++) {
    let frac = (j === jA && aOnSlot) || span <= 0 ? 0 : (t0 + j / F - ptsA) / span;
    if (frac < 1e-4) frac = 0;
    if (frac > 1) frac = 1;
    out.push({ j, frac });
  }
  return out;
}

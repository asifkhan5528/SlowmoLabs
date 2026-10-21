// Hard-cut detection. Interpolating across an edit point produces a ghosted cross-morph of two unrelated shots,
// so on a detected cut the pipeline holds the last frame of the outgoing shot instead.

export const THUMB_W = 64;
export const THUMB_H = 36;
// Mean absolute luma difference on a 0..1 scale. Measured on test clips: ordinary motion stays around 0.01,
// a real cut between two different shots was 0.27. 0.15 leaves margin both ways.
export const CUT_THRESHOLD = 0.15;

/** Mean absolute luma difference between two same-size RGBA thumbnails, 0..1. */
export function meanAbsLumaDiff(a, b) {
  const n = a.length / 4;
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    const la = 0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2];
    const lb = 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2];
    sum += Math.abs(la - lb);
  }
  return sum / n / 255;
}

export function isHardCut(a, b, threshold = CUT_THRESHOLD) {
  return meanAbsLumaDiff(a, b) > threshold;
}

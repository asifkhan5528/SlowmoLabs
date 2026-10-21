// RGBA (canvas) <-> planar float CHW (RIFE model I/O: [1,3,H,W], 0..1, H and W padded to a multiple of 32).

export function padTo(n, multiple = 32) {
  return Math.ceil(n / multiple) * multiple;
}

/** Fills `out` (length 3*padH*padW) from RGBA pixels, replicating the last row/column into the padding. */
export function rgbaToPlanar(rgba, w, h, padW, padH, out) {
  const plane = padW * padH;
  const inv = 1 / 255;
  for (let y = 0; y < padH; y++) {
    const rowBase = (y < h ? y : h - 1) * w * 4;
    const o = y * padW;
    for (let x = 0; x < padW; x++) {
      const i = rowBase + (x < w ? x : w - 1) * 4;
      const p = o + x;
      out[p] = rgba[i] * inv;
      out[plane + p] = rgba[i + 1] * inv;
      out[2 * plane + p] = rgba[i + 2] * inv;
    }
  }
  return out;
}

/** Writes the visible w*h region of a planar tensor into `rgba` (length w*h*4), clamped, alpha = 255. */
export function planarToRgba(planar, w, h, padW, padH, rgba) {
  const plane = padW * padH;
  for (let y = 0; y < h; y++) {
    const o = y * padW;
    let i = y * w * 4;
    for (let x = 0; x < w; x++) {
      const p = o + x;
      // clamp to 0..1 first, then round to an exact integer (Uint8ClampedArray would round halves to even)
      const r = planar[p], g = planar[plane + p], b = planar[2 * plane + p];
      rgba[i] = ((r < 0 ? 0 : r > 1 ? 1 : r) * 255 + 0.5) | 0;
      rgba[i + 1] = ((g < 0 ? 0 : g > 1 ? 1 : g) * 255 + 0.5) | 0;
      rgba[i + 2] = ((b < 0 ? 0 : b > 1 ? 1 : b) * 255 + 0.5) | 0;
      rgba[i + 3] = 255;
      i += 4;
    }
  }
  return rgba;
}

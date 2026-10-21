// Presets say "this footage should behave as if it was shot at N fps".
// Camera entries are *nominal* maximum slow-motion rates (verify against your own camera's spec sheet);
// a preset only sets the target frame rate. It cannot recreate the detail a real high-speed sensor captures.

export const PRESET_GROUPS = [
  {
    label: 'Frame-rate tiers',
    items: [
      { id: 'fps-60', label: '60 fps', fps: 60 },
      { id: 'fps-120', label: '120 fps', fps: 120 },
      { id: 'fps-240', label: '240 fps', fps: 240 },
      { id: 'fps-480', label: '480 fps', fps: 480 },
      { id: 'fps-960', label: '960 fps', fps: 960 },
      { id: 'fps-2000', label: '2,000 fps (extreme)', fps: 2000 },
    ],
  },
  {
    label: 'Camera presets (nominal max slow-mo)',
    items: [
      { id: 'phone-120', label: 'Phone slow-mo, 120 fps', fps: 120 },
      { id: 'iphone-240', label: 'iPhone Pro slo-mo, 240 fps (1080p)', fps: 240 },
      { id: 'gopro-240', label: 'GoPro HERO, 240 fps (1080p)', fps: 240 },
      { id: 'sony-fx3-120', label: 'Sony FX3 / A7S III, 120 fps (4K)', fps: 120 },
      { id: 'sony-fx3-240', label: 'Sony FX3 / A7S III, S&Q 240 fps (1080p)', fps: 240 },
      { id: 'gh6-240', label: 'Panasonic GH6, 240 fps (1080p)', fps: 240 },
      { id: 'rx100-960', label: 'Sony RX100 VII, Super Slow-Mo 960 fps', fps: 960 },
      { id: 'rx10-1000', label: 'Sony RX10 IV, Super Slow-Mo 1,000 fps', fps: 1000 },
      { id: 'phantom-1000', label: 'Phantom high-speed (Flex4K class), 1,000 fps', fps: 1000 },
    ],
  },
];

export const CUSTOM_FPS_MIN = 30;
export const CUSTOM_FPS_MAX = 5000;

export const PLAYBACK_FPS_OPTIONS = [24, 25, 30, 50, 60];

/** Slow-motion factor you see on the timeline, e.g. 240 fps played back at 30 fps = 8x slower. */
export function slowdown(shotFps, playbackFps) {
  return shotFps / playbackFps;
}

/** Frames generated per source frame interval, e.g. 30 fps source -> 240 fps = 8 (1 real + 7 generated). */
export function interpolationFactor(shotFps, sourceFps) {
  return shotFps / sourceFps;
}

export function estimate({ durationSec, sourceFps, shotFps, playbackFps }) {
  const outFrames = Math.max(1, Math.round(durationSec * shotFps));
  const srcFrames = Math.max(1, Math.round(durationSec * sourceFps));
  return {
    slowdown: slowdown(shotFps, playbackFps),
    k: interpolationFactor(shotFps, sourceFps),
    outFrames,
    interpolations: Math.max(0, outFrames - srcFrames),
    outDurationSec: outFrames / playbackFps,
  };
}

/** Rough guidance on how believable the result will be. Heuristic, not a measurement. */
export function qualityHint(k) {
  if (k < 1) return { level: 'bad', text: 'Target is below the clip’s own frame rate, so this would speed the clip up. Pick a higher fps.' };
  if (k <= 2.01) return { level: 'ok', text: 'Gentle: usually looks natural.' };
  if (k <= 4.01) return { level: 'ok', text: 'Moderate: good on most footage; watch fast motion and thin objects.' };
  if (k <= 8.01) return { level: 'warn', text: 'Strong: fine for smooth, steady motion; fast action, spinning objects and occlusions will show warping.' };
  if (k <= 16.01) return { level: 'warn', text: 'Very strong: expect visible artifacts on anything fast. Best on slow camera moves or gentle subject motion.' };
  return { level: 'bad', text: 'Extreme: the clip only contains a fraction of this detail, so most generated frames are guesses. Expect smearing and ghosting on fast motion.' };
}

# Slow-Mo Lab (prototype)

Turns normal footage into slow motion by generating the in-between frames with the RIFE v4.9 neural network, entirely in your browser. Pick the frame rate the clip should look like it was shot at (or a camera preset), pick the timeline fps, export.

**It is synthetic slow motion.** A 30 fps clip contains no extra detail between frames. RIFE invents it. It looks convincing on smooth, steady motion and breaks down on fast action, spinning objects and things that appear from behind other things. The higher the factor, the more is invented.

## Run it

Needs Node 22+ and desktop Chrome or Edge (WebGPU + WebCodecs).

```
npm install
npm start
```

Open http://localhost:5173. On first start the server downloads the model (about 20 MB, once) into `models/`. If that download is blocked, get `rife49.onnx` from https://huggingface.co/edgetools/rife, put it in `models/`, or pick it in the app when it asks.

Use the local server rather than opening `public/index.html` directly: it sets the headers WebAssembly threads need and serves the libraries.

## The look

A late-90s video deck on a VCR-blue screen: silver bevelled windows, charcoal title bars, and an amber LCD that shows how many times slower the result will be. Under it, a frame ladder shows which frames are real and which are generated, and a meter shows how much is being invented. It has day and night modes (follows your system, press T to switch), collapsible windows, drag and drop anywhere on the page, keyboard shortcuts (press ?), toast messages, a before/after compare, a built-in sample clip, a "Copy debug info" button for bug reports, and it can be installed as an app. Settings are remembered.

## First test (5 minutes)

1. Wait for the model line to say **Model ready ... on your graphics card (WebGPU)**. If it says CPU it works but is very slow.
2. Press **Try the sample clip** (4 s, 120 frames, 30 fps), or drop in your own short clip.
3. Leave **Shot at 240 fps**, **Plays back at 30 fps**. The LCD should read 8.00, the ladder 1 real and 7 generated frames, the result length 00:32.
4. Press **Speed test**, then **Export slow motion**, and choose where to save.
5. Play the result. Press **Compare with original** to see it beside the original slowed to the same length.
6. Try `samples/cut_720p30.mp4`: there is a hard cut at 2 s, and the log should report one held cut.

If something fails, press **Copy debug info** and send what it copied.

## How it works

```
file -> mediabunny (demux + WebCodecs decode) -> upright RGB frames
     -> for each pair of real frames A,B: for every output time between them,
        RIFE(A, B, timestep) -> new frame      (onnxruntime-web, WebGPU)
     -> mediabunny (WebCodecs encode + mux) -> same container, saved to disk
```

- Output frame `j` is placed at source time `j / shotFps`, so a clip "shot at 240 fps" and played at 30 fps is 8× slower. Uses real timestamps, so variable-frame-rate phone clips work.
- Original frames pass through untouched; only the in-between frames come from the model.
- Hard cuts are detected and held instead of blended.
- Output keeps the container (MP4 / MOV / WebM) and codec of the input when the browser can encode it, otherwise H.264.

## Known limits of this prototype

- No audio in the export.
- The page layout was checked at desktop and phone widths in a headless browser; the real look on your screens is the thing to review.
- The whole input file is read through the browser's file API; very large files (several GB) are untested.
- Colour: frames pass through a canvas (sRGB). 10-bit / HDR / HLG phone footage will probably look flat or shifted. Use SDR clips for now.
- Default output is capped at 1080p because the model and memory cost grow quickly with resolution. "Original size" is available but untested at 4K.
- Camera presets are nominal maximum rates from memory of spec sheets; check your camera. A preset only sets the target frame rate.
- No speed ramps and no preview before exporting.

## Tests

- `npm test`: 23 tests, no GPU needed. File parsing (including moov-at-end and rotated files), frame timing (including millisecond-rounded timestamps), the frame-pairing loop with a fake model, cut detection, pixel and tensor conversion.
- `npm run test:e2e` (needs Python with Playwright, and ffprobe; the dev server must be running with the stand-in model, see the header of `tests/e2e.py`): drives the real page in Chromium through loading, settings, persistence, shortcuts, a full export checked with ffprobe, compare, debug report and cancel. It uses a tiny blend model instead of RIFE, so it cannot judge the AI model or WebGPU.

## Put it online

See `DEPLOY.md` (GitHub Pages, free, with a ready-made workflow).

## Licences

RIFE v4.9 weights and code: MIT (hzwer / Megvii). onnxruntime-web: MIT. mediabunny: MPL-2.0. Fonts: Tiny5 and DSEG7, both SIL Open Font License 1.1 (self-hosted in `public/fonts`).
# SlowmoLabs

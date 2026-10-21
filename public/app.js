import { probe } from './lib/probe.js';
import { Rife } from './lib/interp.js';
import { runSlowmo, workSize, containerFor } from './lib/pipeline.js';
import { PRESET_GROUPS, PLAYBACK_FPS_OPTIONS, CUSTOM_FPS_MIN, CUSTOM_FPS_MAX, estimate, qualityHint } from './lib/presets.js';
import { APP_VERSION, MODEL_URLS, SAMPLE_CLIP, FEEDBACK_URL } from './config.js';

const $ = (id) => document.getElementById(id);
const state = { file: null, pr: null, model: null, modelPromise: null, abort: null, running: false, urls: [], logLines: [], gpuInfo: null };
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- small helpers ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('slowmo.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('slowmo.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const fmtTime = (s) => {
  if (!isFinite(s)) return '–';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
};
const fmtNum = (n) => n.toLocaleString('en-US');
const log = (msg) => {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  state.logLines.push(line);
  if (state.logLines.length > 400) state.logLines.shift();
  const el = $('log');
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
};
const setStatus = (t) => { $('status').textContent = t; };
const objectUrl = (blob) => { const u = URL.createObjectURL(blob); state.urls.push(u); return u; };

function toast(msg, kind = '', ms = 6500) {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? Math.max(ms, 12000) : ms);
}

function renderPairs(dl, pairs) {
  dl.replaceChildren(...pairs.map(([k, v]) => {
    const d = document.createElement('div');
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    d.append(dt, dd);
    return d;
  }));
}

// ---------- theme ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const b = $('themeBtn');
  b.setAttribute('aria-pressed', String(t === 'night'));
  b.textContent = t === 'night' ? 'Day mode' : 'Night mode';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'night' ? '#0d0f13' : '#23262d');
}
const toggleTheme = () => {
  const next = document.documentElement.dataset.theme === 'night' ? 'day' : 'night';
  applyTheme(next);
  store.set('theme', next);
};
$('themeBtn').addEventListener('click', toggleTheme);
applyTheme(document.documentElement.dataset.theme || 'day');
$('ver').textContent = 'v' + APP_VERSION;

// ---------- collapsible windows ----------
for (const btn of document.querySelectorAll('.tb-btn[aria-controls]')) {
  btn.addEventListener('click', () => {
    const body = $(btn.getAttribute('aria-controls'));
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
    const name = btn.closest('.win').querySelector('h2').textContent;
    btn.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} the ${name} window`);
  });
}

// ---------- environment chips ----------
function chip(label, status, note = '') {
  const el = document.createElement('span');
  el.className = 'chip ' + status;
  el.setAttribute('role', 'listitem');
  el.textContent = label + (note && status !== 'ok' ? ` (${note})` : '');
  $('chips').append(el);
}
const hasCodecs = 'VideoDecoder' in window && 'VideoEncoder' in window;
chip('WebCodecs', hasCodecs ? 'ok' : 'no', 'use Chrome or Edge');
chip('WebGPU', navigator.gpu ? 'ok' : 'no', 'export will be very slow');
chip('Save to disk', 'showSaveFilePicker' in window ? 'ok' : 'info', 'builds the file in memory');
if (!hasCodecs) toast('This browser can’t read or write video the way the app needs. Open it in Chrome or Edge.', 'err');

async function gpuInfo() {
  if (state.gpuInfo || !navigator.gpu) return state.gpuInfo;
  try {
    const a = await navigator.gpu.requestAdapter();
    const i = a?.info ?? (await a?.requestAdapterInfo?.());
    state.gpuInfo = i ? [i.vendor, i.architecture, i.description].filter(Boolean).join(' / ') || 'unknown adapter' : 'no adapter';
  } catch (e) { state.gpuInfo = 'error: ' + e.message; }
  return state.gpuInfo;
}

// ---------- model ----------
function setModel(stateName, text) {
  $('modelLine').dataset.state = stateName;
  $('modelText').textContent = text;
}

async function loadFromUrls(urls, onProgress) {
  let last;
  for (const u of urls) {
    const url = new URL(u, document.baseURI).href;
    try {
      log('Loading model from ' + url);
      return await Rife.load({ url, onProgress });
    } catch (e) {
      last = e;
      log(`Model source failed (${url}): ${e.message}`);
    }
  }
  throw last ?? new Error('No model source configured.');
}

function loadModel(opts = {}) {
  setModel('loading', 'Model: starting…');
  $('modelPick').hidden = true;
  state.model = null;
  updateButtons();
  const onProgress = (p) => {
    if (p.phase === 'cached') setModel('loading', 'Model: loading from cache…');
    else if (p.phase === 'download') setModel('loading', p.total ? `Model: downloading ${(p.received / 1e6).toFixed(1)} of ${(p.total / 1e6).toFixed(1)} MB…` : 'Model: downloading (first visit only)…');
    else if (p.phase === 'init') setModel('loading', 'Model: starting the inference engine…');
  };
  state.modelPromise = (opts.bytes ? Rife.load({ bytes: opts.bytes, onProgress }) : loadFromUrls(MODEL_URLS, onProgress))
    .then((m) => {
      state.model = m;
      const gpu = m.backend === 'webgpu';
      setModel(gpu ? 'ok' : 'slow', `Model ready: RIFE v4.9 on ${gpu ? 'your graphics card (WebGPU)' : 'the CPU (very slow)'}`);
      if (!gpu) toast('WebGPU isn’t available, so the model runs on the CPU. Exports will take a very long time. Try Chrome or Edge on a computer with a graphics card.', 'err');
      log(`Model loaded, backend ${m.backend}, ${(m.modelBytes / 1e6).toFixed(0)} MB, inputs ${m.session.inputNames.join(', ')}, output ${m.outName}`);
      updateButtons();
      renderSummary();
      return m;
    })
    .catch((e) => {
      setModel('err', 'Model failed to load.\n' + (e.message || e) + '\nPick the model file by hand if you have it.');
      $('modelPick').hidden = false;
      log('Model error: ' + (e.stack || e));
      updateButtons();
      throw e;
    });
  state.modelPromise.catch(() => {});
}

$('modelFile').addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  loadModel({ bytes: new Uint8Array(await f.arrayBuffer()) });
});

// ---------- settings ----------
const presetFps = new Map();
function buildPresetSelect() {
  const sel = $('preset');
  sel.innerHTML = '';
  for (const g of PRESET_GROUPS) {
    const og = document.createElement('optgroup');
    og.label = g.label;
    for (const it of g.items) {
      og.append(new Option(it.label, it.id));
      presetFps.set(it.id, it.fps);
    }
    sel.append(og);
  }
  sel.append(new Option('Custom frame rate…', 'custom'));
  sel.value = 'fps-240';
  const pb = $('playback');
  for (const f of PLAYBACK_FPS_OPTIONS) pb.append(new Option(`${f} fps`, String(f)));
  pb.value = '30';
}
buildPresetSelect();

// restore what the person chose last time
for (const id of ['preset', 'size', 'quality']) {
  const v = store.get('set.' + id, null);
  if (v !== null && [...$(id).options].some((o) => o.value === v)) $(id).value = v;
}
{
  const cf = store.get('set.customFps', null);
  if (typeof cf === 'number') $('customFps').value = String(cf);
  const cuts = store.get('set.cuts', null);
  if (typeof cuts === 'boolean') $('cuts').checked = cuts;
  $('customWrap').hidden = $('preset').value !== 'custom';
}

function getShotFps() {
  if ($('preset').value === 'custom') {
    const v = Number($('customFps').value);
    return Math.min(CUSTOM_FPS_MAX, Math.max(CUSTOM_FPS_MIN, isFinite(v) && v > 0 ? v : 240));
  }
  return presetFps.get($('preset').value);
}
const getPlayback = () => Number($('playback').value);
const getMaxSide = () => Number($('size').value) || null;

function applySourceToControls(meta) {
  // presets below the clip's own frame rate would speed it up: disable them
  for (const o of $('preset').querySelectorAll('option')) {
    if (o.value === 'custom') continue;
    o.disabled = presetFps.get(o.value) < meta.fps * 0.999;
  }
  if ($('preset').selectedOptions[0]?.disabled) {
    const first = [...$('preset').querySelectorAll('option')].find((o) => !o.disabled);
    if (first) $('preset').value = first.value;
  }
  const nearest = PLAYBACK_FPS_OPTIONS.reduce((a, b) => (Math.abs(b - meta.fps) < Math.abs(a - meta.fps) ? b : a));
  $('playback').value = String(nearest);
  $('customFps').min = String(Math.ceil(meta.fps));
}

// ---------- the deck: LCD, frame ladder, numbers ----------
function setSeg(id, text) {
  const root = $(id);
  root.querySelector('.live').textContent = text;
  root.querySelector('.ghost').textContent = text.replace(/[0-9\-]/g, '8');
}
function lcdFactor(x) {
  if (!isFinite(x)) return '-.--';
  return x < 10 ? x.toFixed(2) : x < 100 ? x.toFixed(1) : x.toFixed(0);
}
function lcdClock(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

function renderLadder(k, srcFps) {
  const ladder = $('ladder');
  ladder.replaceChildren();
  const n = Math.max(1, Math.round(k));
  const shown = Math.min(n, 24);
  for (let i = 0; i < shown; i++) {
    const c = document.createElement('i');
    c.className = 'cell ' + (i === 0 ? 'real' : 'gen');
    ladder.append(c);
  }
  if (n > shown) {
    const more = document.createElement('span');
    more.className = 'more';
    more.textContent = `+${n - shown} more`;
    ladder.append(more);
  }
  const per = `1/${Math.round(srcFps)} s`;
  $('ladderNote').textContent = n <= 1
    ? 'Nothing to generate: the clip already has this frame rate.'
    : Number.isInteger(k) || Math.abs(k - n) < 0.01
      ? `Every ${per}: 1 real frame, ${n - 1} generated.`
      : `Every ${per}: about ${k.toFixed(2)} frames, 1 real and the rest generated.`;
}

function setHint(k) {
  const h = qualityHint(k);
  const hint = $('hint');
  hint.hidden = false;
  hint.dataset.level = h.level;
  $('hintText').textContent = h.text;
  const filled = k <= 2.01 ? 1 : k <= 4.01 ? 2 : k <= 8.01 ? 3 : k <= 16.01 ? 4 : 5;
  hint.querySelectorAll('.meter i').forEach((i, idx) => i.classList.toggle('on', idx < filled));
}

function renderSummary() {
  const pr = state.pr;
  if (!pr) return;
  const m = pr.meta;
  const shot = getShotFps(), P = getPlayback();
  const e = estimate({ durationSec: m.durationSec, sourceFps: m.fps, shotFps: shot, playbackFps: P });
  const ws = workSize(m, getMaxSide());

  setSeg('lcdFactor', lcdFactor(e.slowdown));
  setSeg('lcdShot', String(Math.round(shot)));
  setSeg('lcdPlay', String(P));
  setSeg('lcdTime', lcdClock(e.outDurationSec));
  $('lcdSr').textContent = `${lcdFactor(e.slowdown)} times slower. Shot at ${Math.round(shot)} frames per second, plays at ${P}. Result is ${fmtTime(e.outDurationSec)} long.`;
  renderLadder(e.k, m.fps);

  const pairs = [
    ['Output size', `${ws.w}×${ws.h}${ws.scaled ? ` (from ${m.width}×${m.height})` : ''}`],
    ['Total frames', fmtNum(e.outFrames)],
    ['Generated frames', `${fmtNum(e.interpolations)} (${Math.round((1 - 1 / Math.max(1, e.k)) * 100)}%)`],
  ];
  if (state.model?.msPerFrame) {
    pairs.push(['Estimated time', `about ${fmtTime((e.interpolations * state.model.msPerFrame) / 1000)} (${state.model.msPerFrame.toFixed(0)} ms per frame at the last speed test)`]);
  }
  renderPairs($('summary'), pairs);
  $('summary').hidden = false;
  $('summaryIdle').hidden = true;
  setHint(e.k);
  updateButtons();
}

for (const id of ['preset', 'customFps', 'playback', 'size', 'quality', 'cuts']) {
  $(id).addEventListener('input', () => {
    $('customWrap').hidden = $('preset').value !== 'custom';
    for (const k of ['preset', 'size', 'quality']) store.set('set.' + k, $(k).value);
    store.set('set.customFps', Number($('customFps').value));
    store.set('set.cuts', $('cuts').checked);
    renderSummary();
  });
}

function updateButtons() {
  const ready = !!state.pr && !state.running;
  $('go').disabled = !ready || (!state.model && !state.modelPromise);
  $('speed').disabled = !ready || !state.model;
  $('cancel').hidden = !state.running;
  $('go').hidden = state.running;
  $('speed').hidden = state.running;
  $('openBtn').disabled = state.running;
  $('sampleBtn').disabled = state.running;
}

// ---------- loading a clip ----------
async function handleFile(file) {
  if (!file || state.running) return;
  if (!file.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm)$/i.test(file.name)) {
    toast(`“${file.name}” doesn’t look like a video. Use an MP4, MOV or WebM file.`, 'err');
    return;
  }
  state.file = file;
  state.pr = null;
  $('result').hidden = true;
  setCompare(false);
  $('clipInfo').hidden = true;
  $('trayTitle').textContent = 'Reading the file…';
  setStatus('');
  updateButtons();
  try {
    const pr = await probe(file);
    const m = pr.meta;
    if (!(await pr.track.canDecode())) {
      throw new Error(`This browser can’t decode ${m.codec?.toUpperCase()} video. Try Chrome or Edge, or convert the clip to H.264 first.`);
    }
    state.pr = pr;
    renderPairs($('clipInfo'), [
      ['Container', m.containerName], ['Codec', (m.codec || '?').toUpperCase()],
      ['Size', `${m.width}×${m.height}${m.rotation ? ` (rotated ${m.rotation}°)` : ''}`],
      ['Frame rate', `${m.fps.toFixed(2)} fps`], ['Frames', fmtNum(m.frameCount)],
      ['Duration', fmtTime(m.durationSec)], ['Bitrate', `${(m.bitrate / 1e6).toFixed(1)} Mbps`],
      ['Audio', m.hasAudio ? 'present, not exported yet' : 'none'],
    ]);
    $('clipInfo').hidden = false;
    $('trayTitle').textContent = file.name;
    $('trayHint').textContent = 'Drop or choose another file to replace it.';
    const v = $('srcVideo');
    v.src = state.srcUrl = objectUrl(file);
    $('srcMonitor').hidden = false;
    applySourceToControls(m);
    $('customWrap').hidden = $('preset').value !== 'custom';
    log(`Loaded ${file.name}: ${m.width}x${m.height} ${m.codec} ${m.fps.toFixed(3)} fps, ${m.frameCount} frames`);
    renderSummary();
    if (m.durationSec > 60) toast('This clip is over a minute long. Export time grows with length and slow-motion factor, so try a short test first.');
  } catch (e) {
    $('trayTitle').textContent = 'Couldn’t open that file';
    $('trayHint').textContent = e.message || String(e);
    toast('Could not open the file: ' + (e.message || e), 'err');
    log('Open error: ' + (e.stack || e));
  }
  updateButtons();
}

const drop = $('drop');
$('file').addEventListener('change', (e) => { handleFile(e.target.files[0]); e.target.value = ''; });
$('openBtn').addEventListener('click', () => $('file').click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });

// drag and drop anywhere on the page
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('dropveil').hidden = false; });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropveil').hidden = true; });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('dropveil').hidden = true;
  handleFile(e.dataTransfer.files[0]);
});

$('sampleBtn').addEventListener('click', async () => {
  try {
    setStatus('Loading the sample clip…');
    const res = await fetch(new URL(SAMPLE_CLIP.url, document.baseURI));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    await handleFile(new File([blob], SAMPLE_CLIP.name, { type: 'video/mp4' }));
    setStatus('');
  } catch (e) {
    setStatus('');
    toast('Could not load the sample clip: ' + (e.message || e), 'err');
  }
});

// ---------- speed test ----------
$('speed').addEventListener('click', async () => {
  if (!state.model || !state.pr) return;
  const ws = workSize(state.pr.meta, getMaxSide());
  $('speed').disabled = true;
  setStatus(`Speed test at ${ws.padW}×${ws.padH}…`);
  try {
    const ms = await state.model.bench(ws.padW, ws.padH);
    setStatus(`The model makes one frame in ${ms.toFixed(0)} ms at ${ws.padW}×${ws.padH}.`);
    log(`Speed test ${ws.padW}x${ws.padH}: ${ms.toFixed(1)} ms/frame`);
    renderSummary();
  } catch (e) {
    setStatus('Speed test failed: ' + (e.message || e));
    toast('Speed test failed: ' + (e.message || e), 'err');
    log('Speed test error: ' + (e.stack || e));
  }
  updateButtons();
});

// ---------- export ----------
$('cancel').addEventListener('click', () => state.abort?.abort());
window.addEventListener('beforeunload', (e) => { if (state.running) { e.preventDefault(); e.returnValue = ''; } });

function setRunningUi(on) {
  $('rec').classList.toggle('on', on);
  $('bar').hidden = !on && $('bar').getAttribute('aria-valuenow') !== '100';
  if (!on) document.title = 'Slow-Mo Lab';
}
function setProgress(frac) {
  const pct = Math.max(0, Math.min(100, frac * 100));
  $('barFill').style.width = pct.toFixed(1) + '%';
  $('bar').setAttribute('aria-valuenow', String(Math.round(pct)));
  if (state.running) document.title = `${Math.round(pct)}% · Slow-Mo Lab`;
}

async function doExport() {
  if (!state.pr || state.running) return;
  const m = state.pr.meta;
  const shot = getShotFps(), P = getPlayback();
  if (shot < m.fps * 0.999) { setStatus('Pick a shot frame rate at or above the clip’s own frame rate.'); return; }

  // Ask where to save first: the save dialog needs the click's user activation.
  const container = containerFor(state.file.name);
  const base = state.file.name.replace(/\.[^.]+$/, '');
  const suggestedName = `${base}_slowmo_${Math.round(shot)}fps.${container.ext}`;
  let handle = null, writable = null;
  if ('showSaveFilePicker' in window) {
    try {
      handle = await showSaveFilePicker({ suggestedName, types: [{ description: 'Video', accept: { [container.mime]: ['.' + container.ext] } }] });
      writable = await handle.createWritable();
    } catch (e) {
      if (e.name === 'AbortError') return;
      log('Save dialog unavailable, building the file in memory instead: ' + e.message);
    }
  }

  state.running = true;
  state.abort = new AbortController();
  updateButtons();
  $('result').hidden = true;
  setCompare(false);
  $('bar').setAttribute('aria-valuenow', '0');
  $('bar').hidden = false;
  setProgress(0);
  $('rec').classList.add('on');
  setStatus('Preparing…');
  let wake = null;
  try { wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }

  try {
    const model = state.model ?? (await state.modelPromise);
    const res = await runSlowmo({
      probeResult: state.pr, fileName: state.file.name, shotFps: shot, playbackFps: P, maxSide: getMaxSide(),
      detectCuts: $('cuts').checked, bitrateMul: Number($('quality').value), model, writable, signal: state.abort.signal,
      onLog: log,
      onProgress: (p) => {
        setProgress(p.done / p.total);
        setStatus(`${fmtNum(p.done)} of ${fmtNum(p.total)} frames, about ${fmtTime(p.etaSec)} left${p.cuts ? `, ${p.cuts} scene cut${p.cuts > 1 ? 's' : ''} held` : ''}`);
      },
    });

    let url, name = suggestedName;
    if (res.blob) {
      url = objectUrl(res.blob);
    } else {
      const saved = await handle.getFile();
      url = objectUrl(saved);
      name = saved.name;
    }
    $('outVideo').src = url;
    state.outDuration = res.stats.outDurationSec;
    const a = $('download');
    a.hidden = !res.blob;
    if (res.blob) { a.href = url; a.download = name; }
    const s = res.stats;
    renderPairs($('resultInfo'), [
      ['File', res.blob ? name : `${name}, saved where you chose`], ['Format', `${s.container.toUpperCase()}, ${s.codec.toUpperCase()}`],
      ['Size', `${s.width}×${s.height}`], ['Duration', fmtTime(s.outDurationSec)], ['Frames', fmtNum(s.frames)],
      ['Processing time', fmtTime(s.seconds)], ['Speed', `${(s.frames / s.seconds).toFixed(1)} frames per second`],
    ]);
    $('result').hidden = false;
    setProgress(1);
    setStatus('Done.');
    toast(res.blob ? 'Done. Press Download to save the video.' : `Done. Saved as ${name}.`, 'ok');
    log(`Finished: ${s.frames} frames in ${fmtTime(s.seconds)}`);
    $('result').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'nearest' });
  } catch (e) {
    if (writable) { try { await writable.abort(); } catch { /* ignore */ } }
    if (e.name === 'AbortError') { setStatus('Cancelled.'); log('Cancelled by user'); }
    else { setStatus('Export failed: ' + (e.message || e)); toast('Export failed: ' + (e.message || e), 'err'); log('Export error: ' + (e.stack || e)); }
  } finally {
    wake?.release?.().catch?.(() => {});
    state.running = false;
    state.abort = null;
    $('rec').classList.remove('on');
    document.title = 'Slow-Mo Lab';
    updateButtons();
  }
}
$('go').addEventListener('click', doExport);

// ---------- compare with the original ----------
let compareOn = false;
function setCompare(on) {
  compareOn = on;
  $('compareBtn').setAttribute('aria-pressed', String(on));
  $('compareBtn').textContent = on ? 'Hide comparison' : 'Compare with original';
  $('cmpFig').hidden = !on;
  $('outCaption').textContent = on ? 'Slow-Mo Lab' : 'Slow-Mo Lab result';
  const cmp = $('cmpVideo'), out = $('outVideo');
  cmp.pause();
  if (on) {
    cmp.preload = 'auto';
    cmp.src = state.srcUrl;
    cmp.currentTime = 0;
    out.currentTime = 0;
  }
}
function cmpRate() {
  // playback speed that makes the original last as long as the result (known from the export, not from video metadata)
  const orig = state.pr?.meta.durationSec, out = state.outDuration || $('outVideo').duration;
  return orig && out ? orig / out : 1;
}
$('compareBtn').addEventListener('click', () => {
  if (!compareOn) {
    const r = cmpRate();
    if (r < 0.0625) { toast('Compare works up to a 16× slow-down. This result is slower than the browser can play the original.', 'err'); return; }
  }
  setCompare(!compareOn);
});
{
  const out = $('outVideo'), cmp = $('cmpVideo');
  const expected = () => out.currentTime * cmpRate();
  out.addEventListener('play', () => { if (!compareOn) return; cmp.playbackRate = Math.max(0.0625, cmpRate()); cmp.currentTime = expected(); cmp.play().catch(() => {}); });
  out.addEventListener('pause', () => { if (compareOn) cmp.pause(); });
  out.addEventListener('seeking', () => { if (compareOn) cmp.currentTime = expected(); });
  out.addEventListener('timeupdate', () => { if (compareOn && !out.paused && Math.abs(cmp.currentTime - expected()) > 0.2) cmp.currentTime = expected(); });
  out.addEventListener('ended', () => { if (compareOn) cmp.pause(); });
}

// ---------- help, feedback, debug report ----------
$('helpBtn').addEventListener('click', () => $('helpDialog').showModal());

async function debugReport() {
  const m = state.pr?.meta;
  const gpu = await gpuInfo();
  const lines = [
    `Slow-Mo Lab v${APP_VERSION}`,
    `Page: ${location.href.split('#')[0]}`,
    `Browser: ${navigator.userAgent}`,
    `Screen: ${screen.width}x${screen.height} @${devicePixelRatio}x, window ${innerWidth}x${innerHeight}`,
    `CPU threads: ${navigator.hardwareConcurrency ?? '?'}, memory hint: ${navigator.deviceMemory ?? '?'} GB, cross-origin isolated: ${self.crossOriginIsolated}`,
    `WebGPU: ${navigator.gpu ? 'yes' : 'no'} (${gpu ?? 'n/a'})`,
    `WebCodecs: ${hasCodecs ? 'yes' : 'no'}, save-to-disk: ${'showSaveFilePicker' in window ? 'yes' : 'no'}`,
    `Model: ${state.model ? `${state.model.backend}, ${state.model.msPerFrame ? state.model.msPerFrame.toFixed(0) + ' ms/frame' : 'not benchmarked'}` : $('modelText').textContent}`,
    m ? `Clip: ${m.width}x${m.height} ${m.codec} ${m.fps.toFixed(2)} fps, ${m.frameCount} frames, ${m.durationSec.toFixed(1)} s, rotation ${m.rotation}` : 'Clip: none loaded',
    `Settings: shot ${getShotFps()} fps, playback ${getPlayback()} fps, size ${$('size').value}, quality ${$('quality').value}, hold cuts ${$('cuts').checked}`,
    `Status: ${$('status').textContent || '(empty)'}`,
    '--- log (last 40 lines) ---',
    ...state.logLines.slice(-40),
  ];
  return lines.join('\n');
}
async function copyDebug() {
  const text = await debugReport();
  try {
    await navigator.clipboard.writeText(text);
    toast('Debug info copied. Paste it into your message.', 'ok');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    toast(ok ? 'Debug info copied. Paste it into your message.' : 'Could not copy automatically. Open the Log window and copy from there.', ok ? 'ok' : 'err');
  }
}
$('debugBtn').addEventListener('click', copyDebug);
$('feedbackBtn').addEventListener('click', async () => {
  if (FEEDBACK_URL) { window.open(FEEDBACK_URL, '_blank', 'noopener'); return; }
  await copyDebug();
  toast('No feedback form is set up yet, so the debug info is on your clipboard. Send it with your comments.');
});

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
  if (e.target.closest?.('input, select, textarea, [contenteditable], video, dialog')) return;
  const k = e.key.toLowerCase();
  if (k === 'o') { e.preventDefault(); if (!state.running) $('file').click(); }
  else if (k === 'e') { e.preventDefault(); if (!$('go').disabled && !$('go').hidden) $('go').click(); }
  else if (k === 't') { e.preventDefault(); toggleTheme(); }
  else if (e.key === '?') { e.preventDefault(); $('helpDialog').showModal(); }
});

(function idleLadder() {
  const ladder = $('ladder');
  for (let i = 0; i < 8; i++) { const c = document.createElement('i'); c.className = 'cell empty'; ladder.append(c); }
})();

loadModel();
updateButtons();

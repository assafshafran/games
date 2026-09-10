// The control console: camera, calibration, detector tuning, scenario control.
//
// The scenario itself runs in the arena window. This window turns camera
// frames into arena coordinates and sends them across; everything it displays
// is a readout of that pipeline, so a setup problem can be found here rather
// than by squinting at the projector.

import { Bus } from './bus.js';
import { ShotDetector, DEFAULT_PARAMS } from './detect.js';
import { peakDifference, accumulateMax, quadFromDifference, meanPeak } from './calibrate.js';
import { homographyFromQuads, applyHomography, orderCorners } from './homography.js';
import { listScenarios } from './library.js';
import { validateScenario } from './scenario.js';
import { unlock } from './audio.js';
import { ShotSuppressor } from './suppress.js';

const $ = (id) => document.getElementById(id);
const bus = new Bus('console');

const ARENA_QUAD = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
const STORE_CAL = 'dryfire.calibration.v1';
const STORE_PARAMS = 'dryfire.detector.v1';

// Processing runs at a fixed small width. Shot detection needs temporal
// consistency far more than resolution, and a smaller frame keeps the
// per-pixel pass comfortably inside one frame budget.
const PROC_WIDTH = 640;

const app = {
  stream: null,
  video: document.createElement('video'),
  proc: document.createElement('canvas'),
  procCtx: null,
  detector: null,
  homography: null,
  corners: null,
  mode: 'idle',      // idle | calibrating | picking
  picks: [],
  dragIndex: -1,
  frozen: null,
  scenario: null,
  custom: null,
  arenaOpen: false,
  arenaWindow: null,
  recentShots: [],
  suppressor: new ShotSuppressor(),
  echoes: 0,
  arenaMask: null,
  headroomAt: 0,
  brightness: 0.55,
  session: null,
  params: { ...DEFAULT_PARAMS },
};

app.video.playsInline = true;
app.video.muted = true;
app.procCtx = app.proc.getContext('2d', { willReadFrequently: true });

// --- persistence -----------------------------------------------------------

function loadStored() {
  try {
    const cal = JSON.parse(localStorage.getItem(STORE_CAL) || 'null');
    if (cal?.corners?.length === 4) {
      app.corners = cal.corners;
      app.homography = homographyFromQuads(cal.corners, ARENA_QUAD);
    }
    const p = JSON.parse(localStorage.getItem(STORE_PARAMS) || 'null');
    if (p) {
      app.params = { ...DEFAULT_PARAMS, ...p.detector ?? p };
      if (p.brightness) app.brightness = p.brightness;
    }
  } catch {
    // A corrupt or blocked store is not worth failing startup over; defaults
    // are always usable and the operator can simply calibrate again.
  }
}

// Which processing pixels fall inside the projected arena.
//
// Built once per calibration so the per-frame headroom measurement can look at
// the projected image alone, rather than being skewed by a lamp or a window
// elsewhere in the camera's view.
function buildArenaMask() {
  if (!app.homography || !app.proc.width) { app.arenaMask = null; return; }
  const w = app.proc.width;
  const h = app.proc.height;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = applyHomography(app.homography, x, y);
      if (a && a.x >= 0 && a.x <= 1 && a.y >= 0 && a.y <= 1) mask[y * w + x] = 1;
    }
  }
  app.arenaMask = mask;
}

// How much room a laser has to read brighter than the projected image.
//
// The detector fires on a pixel getting suddenly brighter. If the projector
// already drives the camera to 255 somewhere, nothing can read brighter there
// and a shot on that spot is invisible: exactly the case where hits register
// on a dark grid but not on a lit target. Reporting the number turns that from
// a mystery into something to act on.
function measureHeadroom(frame) {
  const mask = app.arenaMask;
  if (!mask) return null;

  const hist = new Uint32Array(256);
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = i << 2;
    const d = frame.data;
    const v = d[o] > d[o + 1] ? (d[o] > d[o + 2] ? d[o] : d[o + 2]) : (d[o + 1] > d[o + 2] ? d[o + 1] : d[o + 2]);
    hist[v]++;
    count++;
  }
  if (!count) return null;

  // The 99th percentile rather than the maximum: a handful of hot pixels
  // should not describe the whole projected image.
  let seen = 0;
  let p99 = 0;
  let median = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (!median && seen >= count * 0.5) median = v;
    if (seen >= count * 0.99) { p99 = v; break; }
  }
  return { p99, median, floor: app.params.minValue };
}

function renderHeadroom(h) {
  const el = $('headroom');
  if (!h) {
    el.textContent = 'Calibrate to measure how much headroom the laser has.';
    el.className = 'status';
    return;
  }
  const room = 255 - h.p99;
  el.innerHTML = `The projected image reads up to <b>${h.p99}</b> of 255 in the camera `
    + `(typically ${h.median}). A laser has <b>${room}</b> levels of headroom above that.`;

  if (h.p99 >= 250) {
    el.innerHTML += ' <b>The camera is saturated by the projector, so shots on bright areas cannot register.</b> '
      + 'Lower the arena brightness above, or lock your camera\'s exposure down.';
    el.className = 'status bad';
  } else if (h.p99 >= h.floor) {
    el.innerHTML += ` The brightness floor is ${h.floor}, so parts of the arena are already above it and could register as shots. `
      + 'Lower the arena brightness or raise the floor.';
    el.className = 'status bad';
  } else {
    el.className = 'status good';
  }
}

function saveCalibration() {
  try {
    localStorage.setItem(STORE_CAL, JSON.stringify({ corners: app.corners, at: Date.now() }));
  } catch { /* private browsing */ }
}

function saveParams() {
  try {
    localStorage.setItem(STORE_PARAMS, JSON.stringify({ detector: app.params, brightness: app.brightness }));
  } catch { /* ignore */ }
}

// --- camera ----------------------------------------------------------------

async function listDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === 'videoinput');
  const sel = $('deviceSelect');
  sel.innerHTML = '';
  if (!cams.length) {
    sel.innerHTML = '<option>No camera found</option>';
    return;
  }
  cams.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `Camera ${i + 1}`;
    sel.appendChild(o);
  });
}

async function startCamera() {
  const deviceId = $('deviceSelect').value;
  const constraints = {
    audio: false,
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 60 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  };

  try {
    app.stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    setCalStatus(`Camera refused: ${err.name}. On macOS, allow the browser under System Settings, Privacy & Security, Camera, then reload.`, 'bad');
    return;
  }

  app.video.srcObject = app.stream;
  await app.video.play();
  await listDevices();

  const vw = app.video.videoWidth;
  const vh = app.video.videoHeight;
  const scale = Math.min(1, PROC_WIDTH / vw);
  app.proc.width = Math.round(vw * scale);
  app.proc.height = Math.round(vh * scale);

  const preview = $('preview');
  preview.width = app.proc.width;
  preview.height = app.proc.height;
  preview.parentElement.style.aspectRatio = `${vw} / ${vh}`;

  app.detector = new ShotDetector(app.proc.width, app.proc.height, app.params);
  buildArenaMask();
  $('previewHint').style.display = 'none';
  $('cameraToggle').textContent = 'Stop';
  $('camInfo').textContent = `${vw}x${vh} in, processing at ${app.proc.width}x${app.proc.height}`;
  updateCalStatus();
}

function stopCamera() {
  app.stream?.getTracks().forEach((t) => t.stop());
  app.stream = null;
  app.detector = null;
  $('previewHint').style.display = '';
  $('previewHint').textContent = 'Camera off';
  $('cameraToggle').textContent = 'Start';
  $('camInfo').textContent = 'no signal';
}

function grabFrame() {
  if (!app.stream) return null;
  app.procCtx.drawImage(app.video, 0, 0, app.proc.width, app.proc.height);
  return app.procCtx.getImageData(0, 0, app.proc.width, app.proc.height);
}

// --- detection loop --------------------------------------------------------

function loop() {
  requestAnimationFrame(loop);
  if (!app.stream || app.video.readyState < 2) return;

  const frame = grabFrame();
  if (!frame) return;

  if (app.mode === 'idle' && app.detector) {
    const shot = app.detector.detect(frame.data, performance.now());
    const s = app.detector.lastStats;
    $('detStats').textContent =
      `${s.candidates} bright px, ${s.clusters} blob${s.clusters === 1 ? '' : 's'}, ${s.rejected} rejected`
      + (app.echoes ? `, ${app.echoes} marker echo${app.echoes === 1 ? '' : 'es'} ignored` : '');

    if (shot) onShot(shot);

    // Four times a second is plenty: this is a property of the room and the
    // projector, not something that changes frame to frame.
    const now = performance.now();
    if (now - app.headroomAt > 250) {
      app.headroomAt = now;
      renderHeadroom(measureHeadroom(frame));
    }
  }

  drawPreview(frame);
}

function onShot(shot) {
  app.recentShots.push({ x: shot.x, y: shot.y, t: performance.now() });
  if (app.recentShots.length > 12) app.recentShots.shift();

  if (!app.homography) {
    // Deliberately not the calibration status line: a stray detection landing
    // there would wipe out the calibration result or error the operator is in
    // the middle of reading.
    const note = $('detNote');
    note.textContent = 'A laser is being detected, but the arena is not calibrated, so shots cannot be placed on it.';
    note.classList.remove('hidden');
    return;
  }
  const arena = applyHomography(app.homography, shot.x, shot.y);
  // Outside the projected area: the shooter missed the screen entirely.
  if (!arena || arena.x < -0.02 || arena.x > 1.02 || arena.y < -0.02 || arena.y > 1.02) return;

  // The camera can see the hit marker the arena just drew, and a marker looks
  // exactly like a laser to the detector. Drop anything arriving from a point
  // we ourselves lit up.
  const now = performance.now();
  if (app.suppressor.blocked(arena.x, arena.y, now)) {
    app.echoes++;
    return;
  }
  app.suppressor.mark(arena.x, arena.y, now);

  bus.send('shot', { x: arena.x, y: arena.y, color: shot.color });
}

function drawPreview(frame) {
  const c = $('preview');
  const g = c.getContext('2d');

  if (app.mode === 'picking' && app.frozen) g.putImageData(app.frozen, 0, 0);
  else g.putImageData(frame, 0, 0);

  if ($('showMask').checked && app.detector) {
    // Paint the detector's candidate pixels so the brightness floor can be
    // tuned by eye: the projected image should contribute nothing here.
    const mask = app.detector.mask;
    const out = g.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const o = i << 2;
      out.data[o] = 255; out.data[o + 1] = 60; out.data[o + 2] = 200;
    }
    g.putImageData(out, 0, 0);
  }

  if (app.corners) {
    g.strokeStyle = '#58a6ff';
    g.lineWidth = 2;
    g.beginPath();
    app.corners.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
    g.stroke();

    g.fillStyle = '#58a6ff';
    g.font = '11px system-ui';
    ['TL', 'TR', 'BR', 'BL'].forEach((label, i) => {
      const p = app.corners[i];
      g.beginPath(); g.arc(p.x, p.y, 4, 0, Math.PI * 2); g.fill();
      g.fillText(label, p.x + 7, p.y + 4);
    });
  }

  if (app.picks.length === 4) {
    g.strokeStyle = 'rgba(240,136,62,0.9)';
    g.lineWidth = 2;
    g.beginPath();
    app.picks.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
    g.stroke();

    app.picks.forEach((p, i) => {
      g.fillStyle = i === app.dragIndex ? '#ffd7a8' : '#f0883e';
      g.beginPath(); g.arc(p.x, p.y, 8, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#0d1117'; g.lineWidth = 2; g.stroke();
    });
  }

  const now = performance.now();
  app.recentShots = app.recentShots.filter((s) => now - s.t < 1200);
  for (const s of app.recentShots) {
    const a = 1 - (now - s.t) / 1200;
    g.strokeStyle = `rgba(255,120,60,${a.toFixed(2)})`;
    g.lineWidth = 2;
    g.beginPath(); g.arc(s.x, s.y, 9, 0, Math.PI * 2); g.stroke();
  }
}

// --- calibration -----------------------------------------------------------

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Settle delays for the flash cycles, in milliseconds.
//
// One delay cannot suit every room. A webcam shown a white screen stops down
// within about a second, so a short delay catches the flash before
// auto-exposure erases it; a projector with input lag needs a longer one. The
// cycles run at all three and the per-pixel maximum is kept, so the result
// only needs one of them to have worked.
const SETTLE_DELAYS = [250, 500, 900];

async function autoCalibrate() {
  if (!app.stream) { setCalStatus('Start the camera first.', 'bad'); return; }
  if (!app.arenaOpen) { setCalStatus('Open the arena window first.', 'bad'); return; }

  app.mode = 'calibrating';
  app.picks = [];

  try {
    const w = app.proc.width;
    const h = app.proc.height;
    const diff = new Uint8ClampedArray(w * h);
    let dark = null;
    let lit = null;
    let meanDark = 0;
    let meanLit = 0;

    for (let cycle = 0; cycle < SETTLE_DELAYS.length; cycle++) {
      const delay = SETTLE_DELAYS[cycle];
      setCalStatus(`Calibrating, pass ${cycle + 1} of ${SETTLE_DELAYS.length}. Hold still and keep out of the camera's view.`);

      bus.send('calibrate:show', { fill: '#000000' });
      await wait(delay);
      const d = grabFrame();

      bus.send('calibrate:show', { fill: '#ffffff' });
      await wait(delay);
      const l = grabFrame();

      if (!d || !l) { setCalStatus('Lost the camera during calibration.', 'bad'); return; }

      accumulateMax(diff, peakDifference(l.data, d.data, w, h));

      // Keep the brightest pair seen for the diagnostics view, since that is
      // the one an operator can most usefully look at.
      const md = meanPeak(d.data, w, h);
      const ml = meanPeak(l.data, w, h);
      if (!lit || ml - md > meanLit - meanDark) { dark = d; lit = l; meanDark = md; meanLit = ml; }
    }

    const res = quadFromDifference(diff, w, h);
    showDiagnostics({ dark, lit, diff, meanDark, meanLit, res });

    if (res.error) {
      setCalStatus(res.error, 'bad');
      return;
    }

    const homography = homographyFromQuads(res.corners, ARENA_QUAD);
    if (!homography) {
      setCalStatus('Found four corners but they do not form a usable quadrilateral. Set the corners by hand instead.', 'bad');
      return;
    }

    app.corners = res.corners;
    app.homography = homography;
    saveCalibration();
    buildArenaMask();
    $('detNote').classList.add('hidden');
    setCalStatus(`Calibrated. The projection fills ${(res.diagnostics.regionFraction * 100).toFixed(0)}% of the camera view. Use Verify to confirm.`, 'good');
  } finally {
    app.mode = 'idle';
    app.detector?.reset();
    bus.send('idle');
  }
}

// Show what the camera saw during calibration: the two frames and the
// difference between them. On a failure this is the difference between "it
// did not work" and knowing which of the room, the camera or the projector is
// at fault.
function showDiagnostics({ dark, lit, diff, meanDark, meanLit, res }) {
  const wrap = $('calDiag');
  wrap.classList.remove('hidden');

  const w = app.proc.width;
  const h = app.proc.height;
  const paint = (id, imageData) => {
    const c = $(id);
    c.width = w; c.height = h;
    c.getContext('2d').putImageData(imageData, 0, 0);
  };
  if (dark) paint('diagDark', dark);
  if (lit) paint('diagLit', lit);

  // The difference, with everything above the chosen threshold tinted so the
  // detected area is obvious, and the fitted quad drawn on top.
  const c = $('diagDiff');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  const threshold = res.diagnostics.threshold;
  for (let i = 0; i < diff.length; i++) {
    const v = diff[i];
    const o = i << 2;
    if (v >= threshold) { img.data[o] = 255; img.data[o + 1] = 60; img.data[o + 2] = 200; }
    else { img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; }
    img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);

  if (res.corners) {
    g.strokeStyle = '#58a6ff';
    g.lineWidth = 2;
    g.beginPath();
    res.corners.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
    g.stroke();
  }

  const d = res.diagnostics;
  const rows = [
    ['camera saw black at', meanDark.toFixed(0)],
    ['camera saw white at', meanLit.toFixed(0)],
    // The single most useful number: how much brighter the camera saw the room
    // get when the arena went white. Near zero means it is not looking at the
    // projection, whatever else the other numbers say.
    ['flash strength', (meanLit - meanDark).toFixed(0)],
    ['threshold', String(d.threshold)],
    ['changed', `${(d.coverage * 100).toFixed(1)}%`],
    ['largest area', `${(d.regionFraction * 100).toFixed(1)}%`],
    ['one area', `${(d.coherence * 100).toFixed(0)}%`],
    ['rectangle fill', `${(d.fill * 100).toFixed(0)}%`],
  ];
  $('diagStats').innerHTML = rows
    .map(([k, v]) => `<span>${k}: <b>${v}</b></span>`)
    .join('');
}

// Manual corner picking.
//
// Four handles are placed inside the frame and dragged onto the corners of the
// projected image. Earlier this asked for four clicks in order, which gave no
// way to correct a corner that landed slightly off, and no way to recover from
// clicking them in the wrong order while looking at a projector across the
// room. Handles can be nudged until they are right.
const HANDLE_GRAB_PX = 22;

function startManual() {
  if (!app.stream) { setCalStatus('Start the camera first.', 'bad'); return; }

  // Light the arena so the operator can see what they are aiming the handles
  // at, and freeze a frame so a moving scene does not fight the dragging.
  bus.send('calibrate:show', { fill: '#ffffff' });
  setTimeout(() => { app.frozen = grabFrame(); }, 320);

  const w = app.proc.width;
  const h = app.proc.height;
  app.picks = app.corners
    ? app.corners.map((p) => ({ ...p }))
    : [
      { x: w * 0.15, y: h * 0.15 },
      { x: w * 0.85, y: h * 0.15 },
      { x: w * 0.85, y: h * 0.85 },
      { x: w * 0.15, y: h * 0.85 },
    ];

  app.mode = 'picking';
  app.dragIndex = -1;
  $('preview').classList.add('picking');
  $('confirmCorners').classList.remove('hidden');
  setCalStatus('Drag each handle onto a corner of the projected image, then press "Use these corners".');
}

// Where a pointer event lands in processing-canvas coordinates.
function eventToCanvas(ev) {
  const c = $('preview');
  const r = c.getBoundingClientRect();
  return {
    x: ((ev.clientX - r.left) / r.width) * c.width,
    y: ((ev.clientY - r.top) / r.height) * c.height,
  };
}

function onPointerDown(ev) {
  if (app.mode !== 'picking') return;
  const p = eventToCanvas(ev);
  const scale = $('preview').width / $('preview').getBoundingClientRect().width;

  let nearest = -1;
  let best = HANDLE_GRAB_PX * scale;
  app.picks.forEach((q, i) => {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < best) { best = d; nearest = i; }
  });

  // Grabbing empty space moves the nearest handle there outright, so a corner
  // far from where it should be takes one action rather than a long drag.
  app.dragIndex = nearest >= 0 ? nearest : nearestCorner(p);
  app.picks[app.dragIndex] = p;
  $('preview').classList.add('dragging');
  ev.preventDefault();
}

function nearestCorner(p) {
  let idx = 0;
  let best = Infinity;
  app.picks.forEach((q, i) => {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < best) { best = d; idx = i; }
  });
  return idx;
}

function onPointerMove(ev) {
  if (app.mode !== 'picking' || app.dragIndex < 0) return;
  app.picks[app.dragIndex] = eventToCanvas(ev);
}

function onPointerUp() {
  app.dragIndex = -1;
  $('preview').classList.remove('dragging');
}

function confirmCorners() {
  if (app.mode !== 'picking') return;

  // Accept the handles in whatever arrangement they ended up in: ordering them
  // here means the operator never has to think about which corner is first.
  const ordered = orderCorners(app.picks);
  const homography = ordered && homographyFromQuads(ordered, ARENA_QUAD);
  if (!homography) {
    setCalStatus('Those four points do not form a quadrilateral. Spread the handles out to the corners of the projection.', 'bad');
    return;
  }

  app.corners = ordered;
  app.homography = homography;
  app.picks = [];
  app.frozen = null;
  app.mode = 'idle';
  $('detNote').classList.add('hidden');
  $('preview').classList.remove('picking');
  $('confirmCorners').classList.add('hidden');
  saveCalibration();
  buildArenaMask();
  bus.send('idle');
  setCalStatus('Corners set by hand. Use Verify to confirm.', 'good');
}

function clearCalibration() {
  app.corners = null;
  app.homography = null;
  app.picks = [];
  app.arenaMask = null;
  try { localStorage.removeItem(STORE_CAL); } catch { /* ignore */ }
  updateCalStatus();
}

function setCalStatus(text, kind = '') {
  const el = $('calStatus');
  el.textContent = text;
  el.className = `status ${kind}`;
}

function updateCalStatus() {
  if (app.homography) setCalStatus('Calibrated. Use Verify to confirm the mapping.', 'good');
  else setCalStatus('Not calibrated. Shots cannot be placed on the arena until you calibrate.');
}

// --- scenarios -------------------------------------------------------------

function renderScenarios() {
  const wrap = $('scenarioList');
  wrap.innerHTML = '';
  for (const s of listScenarios()) {
    const b = document.createElement('button');
    b.className = 'scenario';
    b.dataset.id = s.id;
    const tags = [s.difficulty, ...s.tags]
      .map((t) => `<span class="tag ${t}">${t}</span>`).join('');
    b.innerHTML = `<span class="name">${s.name}${tags}</span><span class="desc">${s.description}</span>`;
    b.addEventListener('click', () => selectScenario(s.id));
    wrap.appendChild(b);
  }
}

function selectScenario(id) {
  app.scenario = id;
  app.custom = null;
  for (const el of document.querySelectorAll('.scenario')) {
    el.classList.toggle('sel', el.dataset.id === id);
  }
  $('startRun').disabled = !app.arenaOpen;
  bus.send('scenario:load', { id });
}

// Load a scenario authored as JSON, including branching video scenarios that
// reference clips alongside this page. See scenarios/README.md for the format.
async function loadScenarioFile(file) {
  let scenario;
  try {
    scenario = JSON.parse(await file.text());
  } catch (err) {
    $('liveStage').textContent = `${file.name} is not valid JSON: ${err.message}`;
    $('liveStage').className = 'status bad';
    return;
  }
  const problems = validateScenario(scenario);
  if (problems.length) {
    $('liveStage').textContent = `${file.name} is not a usable scenario. ${problems.join('. ')}.`;
    $('liveStage').className = 'status bad';
    return;
  }

  app.custom = scenario;
  app.scenario = scenario.id;
  for (const el of document.querySelectorAll('.scenario')) el.classList.remove('sel');
  bus.send('scenario:custom', { scenario });
  $('startRun').disabled = !app.arenaOpen;
  $('liveStage').textContent = `Loaded ${scenario.name ?? scenario.id} from ${file.name}.`;
  $('liveStage').className = 'status good';
}

function startRun() {
  if (!app.scenario) return;
  unlock();
  const sel = $('startDelay').value;
  const delayMs = sel === 'random' ? 2000 + Math.random() * 4000 : Number(sel);

  if (app.custom) {
    bus.send('scenario:custom', { scenario: app.custom });
  } else {
    // A fresh seed each run, so target placement is never memorised.
    bus.send('scenario:load', { id: app.scenario, seed: (Math.random() * 0x7fffffff) | 0 });
  }
  bus.send('scenario:start', { delayMs });

  app.suppressor.clear();
  app.echoes = 0;
  app.session = { scenario: app.scenario, startedAt: Date.now(), shots: [], result: null };
  $('shotLog').tBodies[0].innerHTML = '';
  $('stopRun').disabled = false;
  setLive({ score: 0, shots: 0, hits: 0, noshoot: 0 });
  $('liveStage').textContent = delayMs > 0 ? 'Standby...' : 'Running.';
}

function stopRun() {
  bus.send('scenario:stop');
  $('stopRun').disabled = true;
  $('liveStage').textContent = 'Stopped.';
}

function setLive({ score, shots, hits, noshoot }) {
  $('liveScore').textContent = score;
  $('liveShots').textContent = shots;
  $('liveHits').textContent = hits;
  $('liveNoShoot').textContent = noshoot;
}

function appendShot(rec, index) {
  const tb = $('shotLog').tBodies[0];
  const tr = document.createElement('tr');
  const cls = rec.score > 0 ? 'pos' : rec.score < 0 ? 'neg' : 'zero';
  tr.innerHTML = `
    <td>${index}</td>
    <td>${(rec.t / 1000).toFixed(2)}s</td>
    <td>${rec.split == null ? '—' : `${(rec.split / 1000).toFixed(2)}s`}</td>
    <td>${rec.actor ?? '<span class="muted">miss</span>'}</td>
    <td>${rec.zone ?? '—'}</td>
    <td class="${cls}">${rec.score > 0 ? '+' : ''}${rec.score}</td>`;
  tb.appendChild(tr);
  tb.parentElement.parentElement.scrollTop = 1e6;
}

// --- arena window ----------------------------------------------------------

function openArena() {
  app.arenaWindow = window.open('arena.html', 'dryfire-arena', 'width=1280,height=720');
  if (!app.arenaWindow) {
    setCalStatus('The browser blocked the arena window. Allow pop-ups for this page and try again.', 'bad');
    return;
  }
  setTimeout(() => bus.send('ping'), 700);
}

function setArenaOpen(open) {
  app.arenaOpen = open;
  const pill = $('arenaStatus');
  pill.textContent = open ? 'arena connected' : 'arena not open';
  pill.className = `pill ${open ? 'good' : 'bad'}`;
  $('startRun').disabled = !open || !app.scenario;
}

// --- wiring ----------------------------------------------------------------

bus.on('ready', () => {
  setArenaOpen(true);
  bus.send('settings', { brightness: app.brightness, showMarkers: $('showMarkers').checked });
});
bus.on('scenario:loaded', ({ name }) => { $('liveStage').textContent = `Loaded: ${name}`; });

bus.on('shot:result', ({ shot, total, stats }) => {
  if (!app.session) return;
  app.session.shots.push(shot);
  appendShot(shot, app.session.shots.length);
  setLive({ score: total, shots: stats.shots, hits: stats.hits, noshoot: stats.noshoot });
});

// Which stage a branching drill has reached. A multi-stage scenario otherwise
// gives the operator no sign of progress until it ends.
bus.on('stage', ({ id, caption }) => {
  if (!app.session) return;
  $('liveStage').textContent = caption || `Stage: ${id}`;
  $('liveStage').className = 'status';
});

bus.on('finish', (payload) => {
  if (app.session) { app.session.result = payload; app.session.endedAt = Date.now(); }
  setLive({
    score: payload.score, shots: payload.stats.shots,
    hits: payload.stats.hits, noshoot: payload.stats.noshoot,
  });
  const acc = payload.stats.shots ? Math.round((payload.stats.hits / payload.stats.shots) * 100) : 0;
  $('liveStage').textContent =
    `${payload.outcome === 'win' ? 'Clear' : 'Failed'} — ${payload.reason}. `
    + `${(payload.durationMs / 1000).toFixed(2)}s, ${acc}% accuracy.`;
  $('liveStage').className = `status ${payload.outcome === 'win' ? 'good' : 'bad'}`;
  $('stopRun').disabled = true;
});

// A rehearsal click in the arena is scored there; mirror it into the log here
// so a run driven by mouse looks identical to one driven by laser.
bus.on('shot:simulated', () => {});

bus.on('scenario:rejected', ({ problems }) => {
  $('liveStage').textContent = `The arena rejected that scenario. ${problems.join('. ')}.`;
  $('liveStage').className = 'status bad';
});

$('openArena').addEventListener('click', openArena);
$('cameraToggle').addEventListener('click', () => (app.stream ? stopCamera() : startCamera()));
$('deviceSelect').addEventListener('change', () => { if (app.stream) { stopCamera(); startCamera(); } });
$('preview').addEventListener('pointerdown', onPointerDown);
$('preview').addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);
$('confirmCorners').addEventListener('click', confirmCorners);
$('autoCal').addEventListener('click', autoCalibrate);
$('manualCal').addEventListener('click', startManual);
$('verifyCal').addEventListener('click', () => bus.send('calibrate:verify'));
$('clearCal').addEventListener('click', clearCalibration);
$('scenarioFile').addEventListener('change', (e) => {
  if (e.target.files[0]) loadScenarioFile(e.target.files[0]);
  e.target.value = '';
});
$('startRun').addEventListener('click', startRun);
$('stopRun').addEventListener('click', stopRun);
$('mouseShots').addEventListener('change', (e) => bus.send('settings', { mouseShots: e.target.checked }));
$('showMarkers').addEventListener('change', (e) => bus.send('settings', { showMarkers: e.target.checked }));

const brightEl = $('brightness');
brightEl.value = Math.round(app.brightness * 100);
$('outBright').textContent = `${brightEl.value}%`;
const pushBrightness = () => {
  app.brightness = Number(brightEl.value) / 100;
  $('outBright').textContent = `${brightEl.value}%`;
  bus.send('settings', { brightness: app.brightness });
  saveParams();
};
brightEl.addEventListener('input', pushBrightness);

for (const [id, key, out] of [['minValue', 'minValue', 'outValue'], ['minRise', 'minRise', 'outRise'], ['maxPixels', 'maxPixels', 'outMax']]) {
  const el = $(id);
  el.value = app.params[key];
  $(out).textContent = app.params[key];
  el.addEventListener('input', () => {
    app.params[key] = Number(el.value);
    $(out).textContent = el.value;
    if (app.detector) app.detector.params[key] = app.params[key];
    saveParams();
  });
}

$('exportLog').addEventListener('click', () => {
  if (!app.session) return;
  const blob = new Blob([JSON.stringify(app.session, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `dryfire-${app.session.scenario}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

window.addEventListener('beforeunload', () => { app.arenaWindow?.close(); });

// Exposed only so the browser tests can assert on drag state; nothing in the
// app reads it.
window.__dryfireDebug = app;

loadStored();
renderScenarios();
updateCalStatus();
listDevices().catch(() => {});
requestAnimationFrame(loop);

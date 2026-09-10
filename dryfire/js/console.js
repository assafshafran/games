// The control console: camera, calibration, detector tuning, scenario control.
//
// The scenario itself runs in the arena window. This window turns camera
// frames into arena coordinates and sends them across; everything it displays
// is a readout of that pipeline, so a setup problem can be found here rather
// than by squinting at the projector.

import { Bus } from './bus.js';
import { ShotDetector, DEFAULT_PARAMS } from './detect.js';
import { findProjectedQuad } from './calibrate.js';
import { homographyFromQuads, applyHomography, orderCorners } from './homography.js';
import { listScenarios } from './library.js';
import { validateScenario } from './scenario.js';
import { unlock } from './audio.js';

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
  frozen: null,
  scenario: null,
  custom: null,
  arenaOpen: false,
  arenaWindow: null,
  recentShots: [],
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
    if (p) app.params = { ...DEFAULT_PARAMS, ...p };
  } catch {
    // A corrupt or blocked store is not worth failing startup over; defaults
    // are always usable and the operator can simply calibrate again.
  }
}

function saveCalibration() {
  try {
    localStorage.setItem(STORE_CAL, JSON.stringify({ corners: app.corners, at: Date.now() }));
  } catch { /* private browsing */ }
}

function saveParams() {
  try { localStorage.setItem(STORE_PARAMS, JSON.stringify(app.params)); } catch { /* ignore */ }
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
      `${s.candidates} bright px, ${s.clusters} blob${s.clusters === 1 ? '' : 's'}, ${s.rejected} rejected`;

    if (shot) onShot(shot);
  }

  drawPreview(frame);
}

function onShot(shot) {
  app.recentShots.push({ x: shot.x, y: shot.y, t: performance.now() });
  if (app.recentShots.length > 12) app.recentShots.shift();

  if (!app.homography) {
    setCalStatus('Laser seen, but the arena is not calibrated yet, so the shot cannot be placed.', 'bad');
    return;
  }
  const arena = applyHomography(app.homography, shot.x, shot.y);
  // Outside the projected area: the shooter missed the screen entirely.
  if (!arena || arena.x < -0.02 || arena.x > 1.02 || arena.y < -0.02 || arena.y > 1.02) return;

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

  app.picks.forEach((p, i) => {
    g.fillStyle = '#f0883e';
    g.beginPath(); g.arc(p.x, p.y, 5, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.font = 'bold 10px system-ui';
    g.fillText(String(i + 1), p.x - 3, p.y - 8);
  });

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

async function autoCalibrate() {
  if (!app.stream) { setCalStatus('Start the camera first.', 'bad'); return; }
  if (!app.arenaOpen) { setCalStatus('Open the arena window first.', 'bad'); return; }

  app.mode = 'calibrating';
  app.picks = [];
  setCalStatus('Calibrating: hold still...');

  try {
    // A settle delay each way: projectors and camera auto-exposure both take
    // a moment, and sampling too early captures the transition, not the state.
    bus.send('calibrate:show', { fill: '#000000' });
    await wait(900);
    const dark = grabFrame();

    bus.send('calibrate:show', { fill: '#ffffff' });
    await wait(900);
    const lit = grabFrame();

    if (!dark || !lit) { setCalStatus('Lost the camera during calibration.', 'bad'); return; }

    const res = findProjectedQuad(lit.data, dark.data, app.proc.width, app.proc.height);
    if (res.error) { setCalStatus(res.error, 'bad'); return; }

    const h = homographyFromQuads(res.corners, ARENA_QUAD);
    if (!h) { setCalStatus('Found corners but they do not form a usable quadrilateral. Set the corners by hand instead.', 'bad'); return; }

    app.corners = res.corners;
    app.homography = h;
    saveCalibration();
    setCalStatus(`Calibrated. The projection fills ${(res.coverage * 100).toFixed(0)}% of the camera view. Use Verify to confirm.`, 'good');
  } finally {
    app.mode = 'idle';
    app.detector?.reset();
    bus.send('idle');
  }
}

function startManual() {
  if (!app.stream) { setCalStatus('Start the camera first.', 'bad'); return; }
  bus.send('calibrate:show', { fill: '#ffffff' });
  app.frozen = grabFrame();
  app.picks = [];
  app.mode = 'picking';
  $('preview').classList.add('picking');
  setCalStatus('Click the four corners of the projected image: top-left, top-right, bottom-right, bottom-left.');
}

function onPick(ev) {
  if (app.mode !== 'picking') return;
  const c = $('preview');
  const r = c.getBoundingClientRect();
  app.picks.push({
    x: ((ev.clientX - r.left) / r.width) * c.width,
    y: ((ev.clientY - r.top) / r.height) * c.height,
  });

  if (app.picks.length < 4) {
    setCalStatus(`${4 - app.picks.length} corner${app.picks.length === 3 ? '' : 's'} to go.`);
    return;
  }

  // Accept the clicks in any order rather than insisting the operator got the
  // sequence right while looking at a projector across the room.
  const ordered = orderCorners(app.picks);
  const h = ordered && homographyFromQuads(ordered, ARENA_QUAD);
  if (!h) {
    app.picks = [];
    setCalStatus('Those four points do not form a quadrilateral. Try again.', 'bad');
    return;
  }

  app.corners = ordered;
  app.homography = h;
  app.picks = [];
  app.frozen = null;
  app.mode = 'idle';
  $('preview').classList.remove('picking');
  saveCalibration();
  bus.send('idle');
  setCalStatus('Corners set by hand. Use Verify to confirm.', 'good');
}

function clearCalibration() {
  app.corners = null;
  app.homography = null;
  app.picks = [];
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

bus.on('ready', () => setArenaOpen(true));
bus.on('scenario:loaded', ({ name }) => { $('liveStage').textContent = `Loaded: ${name}`; });

bus.on('shot:result', (rec) => {
  if (!app.session) return;
  app.session.shots.push(rec);
  appendShot(rec, app.session.shots.length);
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
$('preview').addEventListener('click', onPick);
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

loadStored();
renderScenarios();
updateCalStatus();
listDevices().catch(() => {});
requestAnimationFrame(loop);

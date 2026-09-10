// The arena window: what the projector shows.
//
// This window owns the scenario engine and the render loop. The console sends
// it commands and shots and receives a small state summary back.

import { Bus } from './bus.js';
import { ScenarioEngine } from './scenario.js';
import { buildScenario } from './library.js';
import { validateScenario } from './scenario.js';
import { sfx, unlock } from './audio.js';
import { MARKER_MAX_RADIUS } from './suppress.js';

const canvas = document.getElementById('arena');
const ctx = canvas.getContext('2d');
const bus = new Bus('arena');

const MODE = { IDLE: 'idle', CALIBRATE: 'calibrate', VERIFY: 'verify', RUN: 'run', RESULT: 'result' };

const state = {
  mode: MODE.IDLE,
  calibrationFill: '#000000',
  engine: null,
  scenario: null,
  caption: '',
  result: null,
  shots: [],
  mouseShots: false,
  showMarkers: true,
  // Fraction of full brightness the arena renders at. Below 1 by default so a
  // laser has room to read brighter than the projected image.
  brightness: 0.55,
  video: null,
  countdown: null,
};

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  if (state.engine) state.engine.aspect = canvas.width / canvas.height;
}
window.addEventListener('resize', resize);
resize();

// --- drawing helpers -------------------------------------------------------

const W = () => canvas.width;
const H = () => canvas.height;
const px = (x) => x * W();
const py = (y) => y * H();

function fillPolygon(poly, fill, stroke = null, lineWidth = 2) {
  ctx.beginPath();
  ctx.moveTo(px(poly[0].x), py(poly[0].y));
  for (let i = 1; i < poly.length; i++) ctx.lineTo(px(poly[i].x), py(poly[i].y));
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
}

// Backdrops are kept dark on purpose. The detector separates a laser dot from
// the scene by brightness, so a bright backdrop directly costs shot detection
// reliability. These are dim scenes with a little depth, nothing more.
const BACKDROPS = {
  range(g) {
    g.addColorStop(0, '#0b1016');
    g.addColorStop(1, '#161d26');
  },
  street(g) {
    g.addColorStop(0, '#0a0d14');
    g.addColorStop(1, '#1a1410');
  },
  room(g) {
    g.addColorStop(0, '#0c0b10');
    g.addColorStop(1, '#191720');
  },
};

function drawBackdrop(name) {
  const g = ctx.createLinearGradient(0, 0, 0, H());
  (BACKDROPS[name] ?? BACKDROPS.range)(g);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W(), H());

  ctx.strokeStyle = ink(INK.zone, 0.045);
  ctx.lineWidth = Math.max(1, W() / 1400);

  if (name === 'street') {
    // Building silhouettes give a horizon to judge target size against.
    ctx.fillStyle = ink(INK.zone, 0.035);
    let x = 0;
    let i = 0;
    while (x < 1) {
      const w = 0.07 + ((i * 37) % 11) / 90;
      const h = 0.18 + ((i * 53) % 17) / 60;
      ctx.fillRect(px(x), py(0.62 - h), px(w) - 2, py(h));
      x += w;
      i++;
    }
    ctx.fillStyle = ink(INK.zone, 0.05);
    ctx.fillRect(0, py(0.62), W(), Math.max(1, py(0.004)));
  } else if (name === 'room') {
    // A doorway and floor line, so pop-ups read as coming from somewhere.
    ctx.strokeRect(px(0.34), py(0.20), px(0.32), py(0.62));
    ctx.beginPath();
    ctx.moveTo(0, py(0.82));
    ctx.lineTo(W(), py(0.82));
    ctx.stroke();
  } else {
    for (let i = 1; i < 5; i++) {
      ctx.beginPath();
      ctx.moveTo(px(i / 5), py(0.30));
      ctx.lineTo(px(i / 5), py(1));
      ctx.stroke();
    }
  }
}

// Arena brightness.
//
// A laser is only detectable if it makes the camera pixel brighter than what
// the projector is already putting at that spot. Render near-white and the
// camera is already saturated there, so the laser adds nothing and the shot is
// simply invisible. That is why hits used to register on the dark verify grid
// but not on a bright target: the targets were drawn at peak 216 and their
// outlines at 255, leaving the detector no headroom at all.
//
// Everything drawn here goes through ink(), which scales the palette down so
// the arena stays well below the sensor's ceiling. The one exception is the
// calibration flash, which must be true white to be found at all.
const INK = {
  text: [230, 237, 243],
  dim: [139, 148, 158],
  threat: [150, 44, 58],
  threatEdge: [210, 70, 83],
  noshoot: [32, 88, 119],
  noshootEdge: [70, 180, 230],
  noshootMark: [120, 215, 255],
  plate: [225, 220, 208],
  plateEdge: [245, 242, 232],
  zone: [255, 255, 255],
  good: [63, 185, 80],
  bad: [248, 81, 73],
  head: [210, 255, 120],
  accent: [88, 166, 255],
};

function ink(rgb, alpha = 1) {
  const k = state.brightness;
  return `rgba(${Math.round(rgb[0] * k)}, ${Math.round(rgb[1] * k)}, ${Math.round(rgb[2] * k)}, ${alpha})`;
}

const ACTOR_INK = {
  threat: { body: INK.threat, edge: INK.threatEdge },
  noshoot: { body: INK.noshoot, edge: INK.noshootEdge },
};

function drawActor(place) {
  const { actor, outline, zones } = place;
  const spec = actor.spec;

  if (actor.def.type === 'plate') {
    fillPolygon(outline, ink(INK.plate), ink(INK.plateEdge), Math.max(2, W() / 700));
    return;
  }

  const style = ACTOR_INK[spec.role] ?? ACTOR_INK.threat;
  fillPolygon(outline, ink(style.body), ink(style.edge), Math.max(2, W() / 900));

  // Scoring zones are drawn faintly. An operator coaching someone needs to see
  // where the boundaries are; a solid overlay would turn it into an aim point.
  for (let i = 0; i < zones.length; i++) {
    fillPolygon(zones[i], ink(INK.zone, 0.07), ink(INK.zone, 0.20), Math.max(1, W() / 1600));
  }

  if (spec.role === 'noshoot') {
    // A no-shoot must be unmistakable at projector distance under low light.
    const b = outline.reduce((a, p) => ({
      minX: Math.min(a.minX, p.x), maxX: Math.max(a.maxX, p.x),
      minY: Math.min(a.minY, p.y),
    }), { minX: 1, maxX: 0, minY: 1 });
    const cx = px((b.minX + b.maxX) / 2);
    const r = Math.max(6, (px(b.maxX) - px(b.minX)) * 0.22);
    ctx.strokeStyle = ink(INK.noshootMark);
    ctx.lineWidth = Math.max(2, W() / 800);
    ctx.beginPath();
    ctx.arc(cx, py(b.minY) - r * 1.5, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// How long a marker stays on screen. The console suppresses detections from a
// marker's position for the same span, so shortening this shortens the window
// in which a genuine second shot at the same spot would be dropped.
const SHOT_LIFE = 1000;

function drawShots(now) {
  state.shots = state.shots.filter((s) => now - s.t < SHOT_LIFE);
  if (!state.showMarkers) return;

  for (const s of state.shots) {
    const age = (now - s.t) / SHOT_LIFE;
    const alpha = (1 - age) * 0.85;
    const r = Math.max(6, W() * MARKER_MAX_RADIUS) * (0.55 + age * 0.45);

    // A soft filled disc rather than a thin bright ring.
    //
    // The camera is watching this surface, and the detector is built to find
    // something small, bright and suddenly present. A crisp ring is exactly
    // that, so it used to be detected as a fresh shot, drawn again slightly
    // offset, and so on into a wandering trail. A broad soft gradient is
    // larger than the detector's size ceiling and has no hard bright edge,
    // which removes the loop at the source. The console's suppression is what
    // actually guarantees it; this just stops relying on that alone.
    const g = ctx.createRadialGradient(px(s.x), py(s.y), 0, px(s.x), py(s.y), r);
    g.addColorStop(0, ink(s.rgb, alpha * 0.55));
    g.addColorStop(0.55, ink(s.rgb, alpha * 0.3));
    g.addColorStop(1, ink(s.rgb, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px(s.x), py(s.y), r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawHud() {
  const e = state.engine;
  if (!e || !state.scenario) return;
  const pad = Math.round(W() * 0.02);
  const fs = Math.max(14, Math.round(W() / 78));

  ctx.font = `600 ${fs}px -apple-system, system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = ink(INK.text, 0.82);
  ctx.textAlign = 'left';
  ctx.fillText(state.scenario.name, pad, pad);

  ctx.textAlign = 'center';
  const secs = ((performance.now() - e.startedAt) / 1000).toFixed(2);
  ctx.fillText(`${secs}s`, W() / 2, pad);

  ctx.textAlign = 'right';
  ctx.fillStyle = e.score < 0 ? ink(INK.bad) : ink(INK.text, 0.82);
  ctx.fillText(`${e.score}`, W() - pad, pad);

  if (state.caption) {
    ctx.textAlign = 'center';
    ctx.font = `600 ${Math.round(fs * 1.35)}px -apple-system, system-ui, sans-serif`;
    ctx.fillStyle = ink(INK.text, 0.92);
    ctx.fillText(state.caption, W() / 2, py(0.10));
  }
}

function drawCountdown() {
  if (state.countdown == null) return;
  const left = state.countdown - performance.now();
  if (left <= 0) return;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = ink(INK.text, 0.9);
  ctx.font = `700 ${Math.round(W() / 9)}px -apple-system, system-ui, sans-serif`;
  ctx.fillText(String(Math.ceil(left / 1000)), W() / 2, H() / 2);
}

function drawResult() {
  const r = state.result;
  if (!r) return;
  ctx.fillStyle = 'rgba(5, 8, 12, 0.86)';
  ctx.fillRect(0, 0, W(), H());

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = r.outcome === 'win' ? ink(INK.good) : ink(INK.bad);
  ctx.font = `700 ${Math.round(W() / 14)}px -apple-system, system-ui, sans-serif`;
  ctx.fillText(r.outcome === 'win' ? 'CLEAR' : 'FAILED', W() / 2, py(0.34));

  ctx.fillStyle = ink(INK.text, 0.85);
  ctx.font = `500 ${Math.round(W() / 38)}px -apple-system, system-ui, sans-serif`;
  ctx.fillText(r.reason || '', W() / 2, py(0.46));

  const acc = r.stats.shots ? Math.round((r.stats.hits / r.stats.shots) * 100) : 0;
  const lines = [
    `score ${r.score}`,
    `${(r.durationMs / 1000).toFixed(2)}s`,
    `${r.stats.hits}/${r.stats.shots} hits (${acc}%)`,
  ];
  if (r.stats.noshoot) lines.push(`${r.stats.noshoot} no-shoot hit${r.stats.noshoot > 1 ? 's' : ''}`);

  ctx.font = `500 ${Math.round(W() / 48)}px -apple-system, system-ui, sans-serif`;
  ctx.fillStyle = ink(INK.dim, 0.95);
  ctx.fillText(lines.join('     '), W() / 2, py(0.58));
}

// Calibration alternates a black and a white full screen. The console
// differences the two camera frames, which isolates exactly the area the
// projector lights regardless of what else is on the wall.
function drawCalibration() {
  ctx.fillStyle = state.calibrationFill;
  ctx.fillRect(0, 0, W(), H());
}

// After calibration, a grid the operator can shoot at to confirm the mapping.
function drawVerify() {
  ctx.fillStyle = '#0b1016';
  ctx.fillRect(0, 0, W(), H());
  ctx.strokeStyle = ink(INK.accent, 0.5);
  ctx.lineWidth = Math.max(1, W() / 1200);
  for (let i = 1; i < 6; i++) {
    ctx.beginPath(); ctx.moveTo(px(i / 6), 0); ctx.lineTo(px(i / 6), H()); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, py(i / 6)); ctx.lineTo(W(), py(i / 6)); ctx.stroke();
  }
  ctx.strokeStyle = ink(INK.accent);
  ctx.lineWidth = Math.max(3, W() / 300);
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, W() - ctx.lineWidth, H() - ctx.lineWidth);

  ctx.fillStyle = ink(INK.text, 0.75);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${Math.max(14, Math.round(W() / 60))}px -apple-system, system-ui, sans-serif`;
  ctx.fillText('Shoot the intersections. Markers should land where you aimed.', W() / 2, py(0.5));
}

function drawIdle() {
  ctx.fillStyle = '#080b10';
  ctx.fillRect(0, 0, W(), H());
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = ink(INK.dim, 0.75);
  ctx.font = `600 ${Math.max(14, Math.round(W() / 46))}px -apple-system, system-ui, sans-serif`;
  ctx.fillText('Arena ready', W() / 2, py(0.47));
  ctx.font = `400 ${Math.max(12, Math.round(W() / 72))}px -apple-system, system-ui, sans-serif`;
  ctx.fillStyle = ink(INK.dim, 0.5);
  ctx.fillText('Drag this window to the projector, then press F for fullscreen.', W() / 2, py(0.55));
}

// --- video stages ----------------------------------------------------------

function ensureVideo() {
  if (state.video) return state.video;
  const v = document.createElement('video');
  v.playsInline = true;
  v.muted = false;
  v.preload = 'auto';
  state.video = v;
  return v;
}

function drawVideoFrame() {
  const v = state.video;
  if (!v || v.readyState < 2) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W(), H());
    return;
  }
  // Cover the arena. Hit polygons are authored in arena coordinates, so the
  // footage must fill the same rectangle they are measured against.
  const vr = v.videoWidth / v.videoHeight;
  const ar = W() / H();
  let dw = W(), dh = H(), dx = 0, dy = 0;
  if (vr > ar) { dw = H() * vr; dx = (W() - dw) / 2; }
  else { dh = W() / vr; dy = (H() - dh) / 2; }
  ctx.drawImage(v, dx, dy, dw, dh);
}

// --- main loop -------------------------------------------------------------

function frame() {
  const now = performance.now();

  if (state.mode === MODE.CALIBRATE) {
    drawCalibration();
  } else if (state.mode === MODE.VERIFY) {
    drawVerify();
    drawShots(now);
  } else if (state.mode === MODE.RUN && state.engine) {
    const e = state.engine;
    if (state.countdown == null || now >= state.countdown) {
      if (state.countdown != null) { state.countdown = null; e.start(now); sfx.start(); }
      e.update(now);
    }
    if (e.stage?.video) drawVideoFrame();
    else drawBackdrop(e.stage?.backdrop ?? 'range');

    if (state.countdown == null) {
      for (const p of e.placements()) if (p.visible) drawActor(p);
    }
    drawShots(now);
    if (state.countdown == null) drawHud();
    drawCountdown();
  } else if (state.mode === MODE.RESULT) {
    drawBackdrop(state.engine?.stage?.backdrop ?? 'range');
    drawShots(now);
    drawResult();
  } else {
    drawIdle();
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- engine wiring ---------------------------------------------------------

const SHOT_INK = {
  hit: INK.good,
  head: INK.head,
  penalty: INK.bad,
  miss: INK.dim,
};

function onEngineEvent(type, payload) {
  if (type === 'stage') {
    state.caption = payload.stage.caption ?? '';
    bus.send('stage', { id: payload.id, caption: payload.stage.caption ?? '' });
    const vid = payload.stage.video;
    if (vid) {
      const v = ensureVideo();
      if (v.getAttribute('src') !== vid.src) { v.setAttribute('src', vid.src); v.load(); }
      v.loop = !!vid.loop;
      v.currentTime = 0;
      v.play().catch(() => {});
    } else if (state.video) {
      state.video.pause();
    }
  } else if (type === 'shot') {
    let key = 'miss';
    if (payload.role === 'noshoot') key = 'penalty';
    else if (payload.zone === 'head') key = 'head';
    else if (payload.actor) key = 'hit';
    state.shots.push({ x: payload.x, y: payload.y, t: performance.now(), rgb: SHOT_INK[key] });
    if (key === 'penalty') sfx.penalty();
    else if (key === 'head') sfx.headshot();
    else if (key === 'hit') sfx.hit();
    else sfx.miss();
    // Send the running totals alongside the shot. Without them the console's
    // live counters had nothing to update from and sat at zero for the whole
    // run, which made a hit that scored perfectly well look ignored.
    bus.send('shot:result', {
      shot: payload,
      total: state.engine.score,
      stats: { ...state.engine.stats },
    });
  } else if (type === 'finish') {
    state.result = payload;
    state.mode = MODE.RESULT;
    state.caption = '';
    if (state.video) state.video.pause();
    (payload.outcome === 'win' ? sfx.win : sfx.lose)();
    bus.send('finish', payload);
  }
}

function loadScenario(id, seed) {
  installScenario(buildScenario(id, seed ?? (Date.now() & 0x7fffffff)));
}

function installScenario(scenario) {
  state.scenario = scenario;
  state.engine = new ScenarioEngine(scenario, {
    aspect: canvas.width / canvas.height,
    onEvent: onEngineEvent,
  });
  state.result = null;
  state.shots = [];
  bus.send('scenario:loaded', { id: scenario.id, name: scenario.name, seed: scenario.seed });
}

function startRun(delayMs = 3000) {
  if (!state.engine) return;
  state.mode = MODE.RUN;
  state.result = null;
  state.shots = [];
  state.countdown = performance.now() + delayMs;
  unlock();
}

// --- bus commands ----------------------------------------------------------

bus.on('calibrate:show', ({ fill }) => { state.mode = MODE.CALIBRATE; state.calibrationFill = fill; });
bus.on('calibrate:verify', () => { state.mode = MODE.VERIFY; state.shots = []; });
bus.on('idle', () => { state.mode = MODE.IDLE; });
bus.on('scenario:load', ({ id, seed }) => loadScenario(id, seed));

// A scenario authored outside the built-in library, including one driven by
// video clips. Validated again here rather than trusting the sender: a bad
// scenario reaching the render loop would fail in front of the shooter.
bus.on('scenario:custom', ({ scenario }) => {
  const problems = validateScenario(scenario);
  if (problems.length) {
    bus.send('scenario:rejected', { problems });
    return;
  }
  installScenario(scenario);
});
bus.on('scenario:start', ({ delayMs }) => startRun(delayMs ?? 3000));
bus.on('scenario:stop', () => { state.mode = MODE.IDLE; state.engine = null; state.scenario = null; });
bus.on('settings', (s) => {
  if (s.mouseShots != null) state.mouseShots = s.mouseShots;
  if (s.showMarkers != null) state.showMarkers = s.showMarkers;
  if (s.brightness != null) state.brightness = Math.max(0.15, Math.min(1, s.brightness));
});
bus.on('ping', () => bus.send('ready', { mode: state.mode }));

function applyShot({ x, y, color }) {
  if (state.mode === MODE.VERIFY) {
    state.shots.push({ x, y, t: performance.now(), rgb: SHOT_INK.hit });
    sfx.hit();
    return;
  }
  // Shots during the countdown are dropped rather than scored: on a real
  // range that is a shot before the beep, and it should not count.
  if (state.mode !== MODE.RUN || !state.engine || state.countdown != null) return;
  state.engine.shoot(x, y, performance.now(), { color });
}

bus.on('shot', applyShot);

// Clicking the arena stands in for a laser, so the whole system can be
// exercised and a scenario rehearsed before a projector is set up.
canvas.addEventListener('click', (ev) => {
  unlock();
  if (!state.mouseShots) return;
  const r = canvas.getBoundingClientRect();
  const shot = {
    x: (ev.clientX - r.left) / r.width,
    y: (ev.clientY - r.top) / r.height,
    color: 'sim',
  };
  // Applied here rather than bounced off the console, so a scenario can be
  // rehearsed with this window alone.
  applyShot(shot);
  bus.send('shot:simulated', shot);
});

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'f' || ev.key === 'F') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }
});

// Exposed only so the browser tests can assert on arena state; nothing in the
// app reads it.
window.__dryfireArena = state;

bus.send('ready', { mode: state.mode });

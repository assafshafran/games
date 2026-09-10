// End-to-end checks in a real browser.
//
// The pure logic is covered by test/logic.mjs under node. This file covers the
// parts that only exist in a browser: module loading, the two windows finding
// each other over BroadcastChannel, canvas rendering, and the camera path.
//
//   npm install playwright && node test/browser.mjs
//
// Chromium's fake capture device stands in for the USB camera, so the camera
// wiring is exercised without hardware. It cannot show a real projected image,
// so calibration accuracy is verified against synthetic frames instead.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};

const server = createServer(async (req, res) => {
  try {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const path = join(ROOT, rel);
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext({ permissions: ['camera'] });

const errors = [];
context.on('weberror', (e) => errors.push(String(e.error())));

try {
  console.log('pages load');
  const consolePage = await context.newPage();
  consolePage.on('pageerror', (e) => errors.push(`console: ${e.message}`));
  consolePage.on('console', (m) => { if (m.type() === 'error') errors.push(`console log: ${m.text()}`); });
  await consolePage.goto(`${base}/index.html`);
  await consolePage.waitForSelector('.scenario');

  const names = await consolePage.$$eval('.scenario .name', (els) => els.map((e) => e.childNodes[0].textContent.trim()));
  ok('scenario list rendered', names.length === 7, names.join('|'));
  ok('hostage rescue is listed', names.includes('Hostage Rescue'), names.join('|'));

  const arenaPage = await context.newPage();
  arenaPage.on('pageerror', (e) => errors.push(`arena: ${e.message}`));
  arenaPage.on('console', (m) => { if (m.type() === 'error') errors.push(`arena log: ${m.text()}`); });
  await arenaPage.goto(`${base}/arena.html`);
  await arenaPage.waitForFunction(() => document.getElementById('arena').width > 0);
  ok('arena canvas sized', true);

  console.log('windows find each other');
  await consolePage.evaluate(() => new BroadcastChannel('dryfire').postMessage({ type: 'ping', payload: {}, from: 'console' }));
  await consolePage.waitForFunction(
    () => document.getElementById('arenaStatus').textContent.includes('connected'),
    null, { timeout: 4000 },
  ).then(() => ok('console sees the arena', true)).catch(() => ok('console sees the arena', false));

  console.log('a full run, driven over the bus');
  // Collect what the arena reports back, exactly as the console would.
  await consolePage.evaluate(() => {
    window.__seen = { shots: [], finish: null };
    const ch = new BroadcastChannel('dryfire');
    ch.onmessage = (ev) => {
      if (ev.data?.from !== 'arena') return;
      if (ev.data.type === 'shot:result') window.__seen.shots.push(ev.data.payload);
      if (ev.data.type === 'finish') window.__seen.finish = ev.data.payload;
    };
  });

  // Drive the arena directly so the test controls the seed and the timing.
  const outcome = await arenaPage.evaluate(async () => {
    const { buildScenario } = await import('./js/library.js');
    const { ScenarioEngine } = await import('./js/scenario.js');
    const s = buildScenario('steel_speed', 3);
    const e = new ScenarioEngine(s, { aspect: 16 / 9 });
    e.start(0);
    const places = e.placements();
    places.forEach((p, i) => {
      const c = p.outline.reduce((a, q) => ({ x: a.x + q.x / p.outline.length, y: a.y + q.y / p.outline.length }), { x: 0, y: 0 });
      e.shoot(c.x, c.y, 100 + i * 200);
    });
    return { outcome: e.outcome, score: e.score, hits: e.stats.hits };
  });
  ok('engine runs inside the browser', outcome.outcome === 'win', JSON.stringify(outcome));
  ok('score matches the node run', outcome.score === 25, String(outcome.score));

  console.log('arena renders, and it renders differently per mode');
  const shotAt = async (mode) => {
    await consolePage.evaluate((m) => {
      const ch = new BroadcastChannel('dryfire');
      ch.postMessage({ type: m.type, payload: m.payload, from: 'console' });
    }, mode);
    await arenaPage.waitForTimeout(250);
    return (await arenaPage.screenshot()).length;
  };
  const centrePixel = () => arenaPage.evaluate(() => {
    const c = document.getElementById('arena');
    const d = c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
    return [d[0], d[1], d[2]];
  });

  const idleShot = await shotAt({ type: 'idle', payload: {} });
  ok('idle screen renders', idleShot > 1000);

  const calShot = await shotAt({ type: 'calibrate:show', payload: { fill: '#ffffff' } });
  ok('calibration screen differs from idle', calShot !== idleShot);
  // The whole calibration method rests on these two frames actually being
  // black and white, so assert the pixels rather than just that they differ.
  const lit = await centrePixel();
  ok('lit calibration frame is white', lit.every((v) => v > 240), JSON.stringify(lit));

  await shotAt({ type: 'calibrate:show', payload: { fill: '#000000' } });
  const dark = await centrePixel();
  ok('dark calibration frame is black', dark.every((v) => v < 12), JSON.stringify(dark));

  const verifyShot = await shotAt({ type: 'calibrate:verify', payload: {} });
  ok('verify grid differs from calibration', verifyShot !== calShot);

  console.log('camera path');
  await consolePage.click('#cameraToggle');
  await consolePage.waitForFunction(
    () => document.getElementById('camInfo').textContent.includes('processing at'),
    null, { timeout: 8000 },
  ).then(() => ok('camera starts and reports a processing size', true))
   .catch(() => ok('camera starts and reports a processing size', false));

  const camInfo = await consolePage.textContent('#camInfo');
  ok('processing width capped at 640', /processing at (\d+)x/.exec(camInfo)?.[1] <= 640, camInfo);

  await consolePage.waitForTimeout(1200);
  const stats = await consolePage.textContent('#detStats');
  ok('detector is running on live frames', /bright px/.test(stats), stats);

  console.log('calibration maths in the browser');
  const cal = await consolePage.evaluate(async () => {
    const { findProjectedQuad } = await import('./js/calibrate.js');
    const { homographyFromQuads, applyHomography } = await import('./js/homography.js');
    const { pointInPolygon } = await import('./js/geometry.js');
    const W = 320, H = 240;
    const quad = [{ x: 38, y: 26 }, { x: 283, y: 52 }, { x: 262, y: 196 }, { x: 57, y: 172 }];
    const make = (lit) => {
      const a = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) << 2;
        const v = lit && pointInPolygon(x, y, quad) ? 232 : 18;
        a[o] = v; a[o + 1] = v; a[o + 2] = v; a[o + 3] = 255;
      }
      return a;
    };
    const res = findProjectedQuad(make(true), make(false), W, H);
    if (res.error) return { error: res.error };
    const h = homographyFromQuads(res.corners, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
    const p = applyHomography(h, quad[0].x, quad[0].y);
    return { err: Math.hypot(p.x, p.y), maxCorner: Math.max(...res.corners.map((c, i) => Math.hypot(c.x - quad[i].x, c.y - quad[i].y))) };
  });
  ok('finds the projection in the browser', !cal.error, cal.error || '');
  ok('corner error under 3px', cal.maxCorner < 3, String(cal.maxCorner));
  ok('maps a corner back to the arena origin', cal.err < 0.01, String(cal.err));

  console.log('a scored hit reaches the console');
  {
    // The whole chain for the Failure Drill: the engine scores the hit, the
    // arena reports its running totals, the console shows them. The live
    // counters used to update only when a drill ended, so a hit that scored
    // correctly looked as though it had been ignored.
    await consolePage.click('.scenario[data-id="mozambique"]');
    await consolePage.selectOption('#startDelay', '0');
    await consolePage.click('#startRun');

    // The drill opens with a briefing stage before the target appears.
    await arenaPage.waitForFunction(
      () => window.__dryfireArena?.engine?.stageId === 'engage',
      null, { timeout: 8000 },
    );

    // Aim at the centre-mass zone of wherever the target actually spawned.
    const aim = await arenaPage.evaluate(() => {
      const e = window.__dryfireArena.engine;
      const p = e.placements().find((q) => q.actor.id === 'hostile');
      const poly = p.zones[1];
      return {
        x: poly.reduce((s, q) => s + q.x, 0) / poly.length,
        y: poly.reduce((s, q) => s + q.y, 0) / poly.length,
      };
    });

    await consolePage.evaluate((a) => new BroadcastChannel('dryfire').postMessage({
      type: 'shot', payload: { x: a.x, y: a.y, color: 'red' }, from: 'console',
    }), aim);
    await consolePage.waitForTimeout(400);

    const live = await consolePage.evaluate(() => ({
      score: document.getElementById('liveScore').textContent,
      shots: document.getElementById('liveShots').textContent,
      hits: document.getElementById('liveHits').textContent,
    }));
    ok('the shot is counted while the drill is still running', live.shots === '1', JSON.stringify(live));
    ok('it is counted as a hit, not a miss', live.hits === '1', JSON.stringify(live));
    ok('centre mass scores 7', live.score === '7', JSON.stringify(live));

    const rows = await consolePage.$$eval('#shotLog tbody tr', (els) => els.map((e) => e.textContent));
    ok('the shot log has the row too', rows.length === 1 && /centre/.test(rows[0]), rows.join('|'));

    // A body hit must not drop the target: the drill needs the head shot.
    const stillUp = await arenaPage.evaluate(() => !window.__dryfireArena.engine.actors[0].down);
    ok('the target stays up after centre mass', stillUp);

    await consolePage.click('#stopRun');
    await consolePage.waitForTimeout(200);
  }

  console.log('the arena leaves the laser headroom');
  {
    // The bug this guards: targets were drawn at peak 216 and their outlines
    // at 255, so the camera was already saturated where they were projected
    // and a laser could not read any brighter. Shots landed on the dark verify
    // grid and vanished on lit targets.
    const peakOf = async () => arenaPage.evaluate(() => {
      const c = document.getElementById('arena');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let peak = 0;
      for (let i = 0; i < d.length; i += 4) {
        const v = Math.max(d[i], d[i + 1], d[i + 2]);
        if (v > peak) peak = v;
      }
      return peak;
    });

    const send = (type, payload) => consolePage.evaluate(
      (m) => new BroadcastChannel('dryfire').postMessage({ ...m, from: 'console' }),
      { type, payload },
    );

    // Zeroing draws the steel plates, the brightest thing the arena renders.
    await send('scenario:load', { id: 'zeroing', seed: 3 });
    await send('scenario:start', { delayMs: 0 });
    await arenaPage.waitForTimeout(700);

    const running = await arenaPage.evaluate(() => window.__dryfireArena?.mode);
    ok('the drill is running', running === 'run', String(running));

    const peak = await peakOf();
    ok('nothing on the arena saturates the camera', peak < 200, `peak ${peak}`);
    ok('but targets are still clearly visible', peak > 80, `peak ${peak}`);

    // Turning the brightness down has to actually reach the pixels.
    await send('settings', { brightness: 0.2 });
    await arenaPage.waitForTimeout(300);
    const dimmed = await peakOf();
    ok('lowering arena brightness dims the pixels', dimmed < peak - 20, `${peak} -> ${dimmed}`);

    await send('settings', { brightness: 0.55 });
    await send('scenario:stop', {});
    await arenaPage.waitForTimeout(200);
  }

  console.log('headroom readout');
  {
    await consolePage.waitForFunction(
      () => /headroom|Calibrate to measure/.test(document.getElementById('headroom').textContent),
      null, { timeout: 5000 },
    ).then(() => ok('the headroom panel reports something', true))
     .catch(() => ok('the headroom panel reports something', false));

    const text = await consolePage.textContent('#headroom');
    ok('it names a level out of 255', /of 255/.test(text) || /Calibrate to measure/.test(text), text.slice(0, 70));
  }

  console.log('hit markers on the projector');
  {
    ok('markers are on by default', await consolePage.isChecked('#showMarkers'));

    // Turning them off must actually reach the arena, since a camera sensitive
    // enough to see them is the whole reason the switch exists.
    await consolePage.uncheck('#showMarkers');
    await consolePage.waitForTimeout(200);
    ok('the arena hears the switch',
      await arenaPage.evaluate(() => window.__dryfireArena?.showMarkers === false));

    await consolePage.check('#showMarkers');
    await consolePage.waitForTimeout(200);
    ok('and hears it turned back on',
      await arenaPage.evaluate(() => window.__dryfireArena?.showMarkers === true));
  }

  console.log('manual corner picking');
  {
    await consolePage.click('#manualCal');
    await consolePage.waitForTimeout(500);

    ok('the confirm button appears',
      await consolePage.isVisible('#confirmCorners'));

    const before = await consolePage.evaluate(() => document.getElementById('calStatus').textContent);
    ok('it explains what to drag', /Drag each handle/.test(before), before);

    // Drag the top-left handle. It starts at 15% of the frame; move it toward
    // the corner the way an operator would.
    const box = await consolePage.$eval('#preview', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    await consolePage.mouse.move(box.x + box.w * 0.15, box.y + box.h * 0.15);
    await consolePage.mouse.down();
    await consolePage.mouse.move(box.x + box.w * 0.05, box.y + box.h * 0.06, { steps: 6 });
    await consolePage.mouse.up();

    const moved = await consolePage.evaluate(() => window.__dryfireDebug?.picks?.[0] ?? null);
    ok('dragging moves the handle', moved !== null && moved.x < 60, JSON.stringify(moved));

    await consolePage.click('#confirmCorners');
    await consolePage.waitForTimeout(200);
    const after = await consolePage.textContent('#calStatus');
    ok('confirming stores a calibration', /Corners set by hand/.test(after), after);
    ok('the confirm button goes away', !(await consolePage.isVisible('#confirmCorners')));

    const stored = await consolePage.evaluate(() => localStorage.getItem('dryfire.calibration.v1'));
    ok('the calibration is persisted', stored !== null && JSON.parse(stored).corners.length === 4);
  }

  console.log('auto calibration with nothing to see');
  {
    // The fake camera cannot see the arena window, so this must fail cleanly
    // and show the operator what it did see, rather than throwing.
    await consolePage.click('#autoCal');
    await consolePage.waitForFunction(
      () => !document.getElementById('calDiag').classList.contains('hidden'),
      null, { timeout: 20000 },
    ).then(() => ok('the diagnostics panel appears', true))
     .catch(() => ok('the diagnostics panel appears', false));

    const status = await consolePage.textContent('#calStatus');
    ok('it says what went wrong', status.length > 40 && !/Calibrating/.test(status), status.slice(0, 80));

    const stats = await consolePage.textContent('#diagStats');
    ok('it reports what the camera saw', /flash strength/.test(stats), stats.slice(0, 90));

    const painted = await consolePage.evaluate(() => {
      const c = document.getElementById('diagDiff');
      return c.width > 0 && c.height > 0;
    });
    ok('the difference image is drawn', painted);
  }

  console.log('opened as a file instead of served');
  {
    // The failure mode a first-time user actually hits. Over file:// the module
    // scripts never load, so the page renders as inert HTML with no scenarios
    // and a camera button that cannot work. The guard has to be a classic
    // inline script, because it is the only code that still runs here.
    const filePage = await context.newPage();
    await filePage.goto(pathToFileURL(join(ROOT, 'index.html')).href);
    await filePage.waitForTimeout(300);

    ok('the file:// guard appears', await filePage.$('[role=alert]') !== null);
    const command = await filePage.textContent('[role=alert] code').catch(() => '');
    ok('it names the directory to serve', command.includes(ROOT.replace(/\/$/, '')), command);
    ok('it gives the serve command', command.includes('http.server'), command);
    ok('modules really are blocked over file://',
      (await filePage.$$('.scenario')).length === 0, 'scenarios rendered unexpectedly');
    await filePage.close();

    // ...and it must stay out of the way when the page is served properly.
    ok('the guard stays hidden when served', await consolePage.$('[role=alert]') === null);
  }

  ok('no uncaught page errors', errors.length === 0, errors.slice(0, 4).join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

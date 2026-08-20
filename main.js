import { Application } from 'https://unpkg.com/@splinetool/runtime@1.9.28/build/runtime.js';
import { buildTrail, buildTrailFromPoints } from './trail.js';
import { createSim } from './sim.js';
import { createControls } from './controls.js';

// ---------------------------------------------------------------- CONFIG --
const CONFIG = {
  // Your scene URL from Spline: Export -> Code -> Web Content. Ends in
  // .splinecode. The editor URL (app.spline.design/file/...) will NOT work.
  sceneUrl: './scene.splinecode',

  // Spline coordinates of the trail's two ends.
  // baseX/baseY: where trekker1 stands at the bottom (its Position in Spline).
  // summitX/summitY: the monastery platform's Position.
  anchors: {
    baseX: -1736, baseY: -630,      // CONFIRM from trekker1's Transform panel
    summitX: 1200, summitY: 900,    // REPLACE with the monastery's Position
  },

  trekkerNames: ['trekker1','trekker2','trekker3','trekker4',
                 'trekker5','trekker6','trekker7','trekker8'],

  // Waypoint objects in the Spline scene, matched by name and sorted by their
  // number. Any object whose name fits works: Waypoint_00_Base,
  // Waypoint 3, waypoint_12_bridge, etc. When 2+ are found, the trail runs
  // through THEM and the traced path + anchors above are ignored entirely.
  waypointPattern: /^waypoint[_\s]*(\d+)/i,

  climbSeconds: 13,     // fixed pace; no longer user-adjustable

  // The canvas is always rendered at this size, then scaled to fit. It must be
  // wide enough that Spline's fixed camera framing shows the whole mountain -
  // i.e. the width at which the scene already looks right on desktop.
  stageWidth: 1280,
  stageHeight: 720,

  // Below this width the canvas is rendered at stageWidth and scaled down, so
  // the whole mountain stays in frame. Above it, the canvas fills the stage
  // normally - desktop keeps exactly the behaviour it had.
  scaleBelow: 900,

  // The scene sits inside a lot of empty cream at 1280x720, so a plain fit
  // leaves the mountain looking small. These enlarge it and crop the margins:
  // mobileFill scales past the container width, mobileKeepY is the fraction of
  // the frame height retained (the rest is empty sky and ground).
  // 1.0 = the whole frame fits the width, nothing cropped horizontally.
  // Anything above that trades the mountain's edges for size, which is what
  // clipped the base and the monastery at 1.5.
  mobileFill: 1.0,
  // Fraction of the frame height kept. The scene has empty sky above and a
  // little ground below, so trimming ~12% enlarges it without touching the
  // peak or the base.
  mobileKeepY: 0.88,

  // Render fewer pixels on phones. The camera framing depends on the canvas
  // ASPECT, not its size, so halving the resolution changes nothing visually
  // but roughly quarters the work the GPU does each frame - which is most of
  // why the mobile version feels heavy after it has downloaded.
  mobileStageWidth: 800,
  mobileStageHeight: 450,

  // Hold the scene download until the tool is near the viewport. In a long
  // article that means the page becomes readable immediately and the ~MBs of
  // 3D only cost anything for readers who actually scroll this far.
  lazyLoad: true,
  lazyMargin: '600px',      // start loading this far before it comes into view

  // Optional still of the mountain, shown instantly while the scene loads.
  // Drop a poster.jpg next to this file - a ~60 KB screenshot beats several MB
  // of geometry for the first paint, and most readers never notice the swap.
  posterUrl: 'poster.jpg',


  // Preserved on every frame. Your trekkers face along +X with Y=90; if they
  // end up backwards, this is the number to change.
  yawDegrees: 90,
};

// (the on-screen status element was removed; say() logs to the console)
// Status goes to the console only: the on-screen line was a development aid
// and has no place in the published piece.
const say = (m) => { console.log(m); };

let walkAmp = 0.7, kneeAmp = 0.45;   // set at load once units are known

const canvas = document.getElementById('canvas3d');
const app = new Application(canvas);

/* Kick the scene download off immediately, in parallel with the module
   graph resolving and the DOM work below. The browser dedupes this against
   the runtime's own request, so the bytes are already in flight - and often
   already cached - by the time app.load runs. */
if (!CONFIG.lazyLoad && !CONFIG.sceneUrl.startsWith('PASTE')) {
  const l = document.createElement('link');
  l.rel = 'preload'; l.as = 'fetch'; l.crossOrigin = 'anonymous';
  l.href = CONFIG.sceneUrl;
  document.head.appendChild(l);
}

/** Show a still immediately so the reader is never looking at an empty box. */
function showPoster() {
  if (!CONFIG.posterUrl) return null;
  const stage = document.querySelector('.trek-stage');
  const img = document.createElement('img');
  img.src = CONFIG.posterUrl;
  img.alt = '';
  img.className = 'stage-poster';
  img.onerror = () => img.remove();        // no poster file: fail quietly
  stage.appendChild(img);
  return img;
}

/** Resolve once the tool is near the viewport, so nothing heavy runs before.
 *  Races against a timeout: if the observer never fires - no support, a zero
 *  height container, an odd embedding context - the scene must still load
 *  rather than leaving the reader on a permanent loading bar. */
function whenVisible(el, margin, timeoutMs = 2500) {
  if (!el || !('IntersectionObserver' in window)) return Promise.resolve();
  return Promise.race([
    new Promise(resolve => {
      const io = new IntersectionObserver((entries) => {
        if (entries.some(e => e.isIntersecting)) { io.disconnect(); resolve(); }
      }, { rootMargin: margin });
      io.observe(el);
    }),
    new Promise(resolve => setTimeout(() => {
      console.warn('[harness] visibility check timed out - loading anyway');
      resolve();
    }, timeoutMs)),
  ]);
}

async function init() {
  if (CONFIG.sceneUrl.startsWith('PASTE')) {
    say('Open main.js and paste your scene URL into CONFIG.sceneUrl.');
    return;
  }

  const poster = showPoster();

  if (CONFIG.lazyLoad) {
    await whenVisible(document.querySelector('.trek-stage'), CONFIG.lazyMargin);
  }

  say('Loading Spline scene...');
  await app.load(CONFIG.sceneUrl);

  if (poster) {
    poster.classList.add('is-done');
    setTimeout(() => poster.remove(), 500);
  }
  const loader = document.getElementById('loader');
  if (loader) {
    loader.classList.add('is-done');
    setTimeout(() => loader.remove(), 500);
  }
  say('');

  // Belt and braces alongside the CSS: ask the runtime to drop its camera
  // controls too, so no future CSS change can accidentally re-enable
  // scroll-to-zoom over the graphic.
  try {
    if (app.setVariable) { /* no-op guard for older runtimes */ }
    const ctrl = app._controls || app.controls;
    if (ctrl) {
      if ('enabled' in ctrl) ctrl.enabled = false;
      if ('enableZoom' in ctrl) ctrl.enableZoom = false;
      if ('enableRotate' in ctrl) ctrl.enableRotate = false;
      if ('enablePan' in ctrl) ctrl.enablePan = false;
      console.log('[harness] Spline camera controls disabled');
    }
  } catch (e) { /* CSS already covers this */ }

  /* Keep the canvas at its design size and scale the element to fit.
     Spline reads the canvas's own width/height to frame the camera, so the
     canvas must stay large; only its on-screen presentation shrinks. */
  const stage = document.querySelector('.trek-stage');
  function fitStage() {
    const avail = stage.clientWidth || window.innerWidth;

    if (window.innerWidth >= CONFIG.scaleBelow) {
      // desktop: hand the canvas back to plain CSS
      stage.classList.remove('is-scaled');
      canvas.style.width = '';
      canvas.style.height = '';
      canvas.style.transform = '';
      canvas.style.position = '';
      canvas.style.left = '';
      canvas.style.top = '';
      stage.style.height = '';
      return;
    }

    stage.classList.add('is-scaled');

    // Scale past the container so the mountain fills the width, then crop the
    // empty margins by offsetting and shortening the stage.
    const cw = CONFIG.mobileStageWidth, ch = CONFIG.mobileStageHeight;
    const scale = (avail / cw) * CONFIG.mobileFill;
    const drawnW = cw * scale;
    const drawnH = ch * scale;
    const keptH = drawnH * CONFIG.mobileKeepY;

    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    canvas.style.position = 'absolute';
    canvas.style.left = ((avail - drawnW) / 2) + 'px';
    canvas.style.top = (-(drawnH - keptH) / 2) + 'px';
    canvas.style.transform = `scale(${scale})`;
    stage.style.height = keptH + 'px';
  }
  fitStage();
  window.addEventListener('resize', fitStage);
  // Spline resets canvas styles as it initialises, so re-apply once it settles
  setTimeout(fitStage, 60);
  setTimeout(fitStage, 400);

  /* No programmatic zoom here on purpose.
     app.setZoom is not a "fit to viewport" control - passing a ratio to it
     zooms the camera in hard. Fitting the scene is a scene-level setting:
     turn Auto Zoom ON in Spline (Scene panel) and re-export, and the runtime
     frames the whole mountain at any viewport size by itself. */

  // one flat list of every scene object; used by trekkers, bones, waypoints
  const all = app.getAllObjects ? app.getAllObjects() : [];

  // find the trekkers
  const trekkers = [];
  for (const name of CONFIG.trekkerNames) {
    const obj = app.findObjectByName(name);
    if (obj) trekkers.push({ name, obj });
    else console.warn(`[harness] no object named "${name}" in the scene`);
  }
  if (trekkers.length === 0) {
    say('No trekkers found - check the names in CONFIG.trekkerNames.');
    // print what does exist, to correct the names against
    console.log('[harness] scene objects:',
      app.getAllObjects ? app.getAllObjects().map(o => o.name) : '(api unavailable)');
    return;
  }
  console.log(`[harness] driving ${trekkers.length} trekkers`);

  // remember each trekker's authored Z and rotation so we never disturb them
  for (const t of trekkers) {
    t.z = t.obj.position.z;
    t.rot = { x: t.obj.rotation.x, y: t.obj.rotation.y, z: t.obj.rotation.z };
    t.scale = { x: t.obj.scale.x, y: t.obj.scale.y, z: t.obj.scale.z };
    t.phase = Math.random() * Math.PI * 2;   // desync strides across trekkers
    t.bones = null;
  }

  // ---- bones for the walk ------------------------------------------------
  // Spline's editor states cannot record child-bone poses, but the runtime
  // can rotate the bones directly - which is all a walk cycle is.
  //
  // Wrinkle: every trekker's bones share the same names (L_Thigh x8), and
  // findObjectByName returns only the first. getAllObjects lists them all,
  // in scene-tree order, so occurrences group per trekker: the i-th L_Thigh
  // belongs to the i-th trekker. That assumption is logged and checked.
  const BONES = ['L_Thigh', 'R_Thigh', 'L_Calf', 'R_Calf'];
  const boneLists = {};
  for (const b of BONES) {
    boneLists[b] = all.filter(o => o.name === b);
  }
  console.log('[walk] bone counts:',
    BONES.map(b => b + '=' + boneLists[b].length).join('  '),
    '(expect ' + trekkers.length + ' of each)');

  const boneCountsOk = BONES.every(b => boneLists[b].length === trekkers.length);
  if (boneCountsOk) {
    for (let i = 0; i < trekkers.length; i++) {
      const set = {};
      for (const b of BONES) {
        const bone = boneLists[b][i];
        // capture the rest pose; swings are offsets from THIS, so it works
        // whether the runtime reports radians or degrees
        set[b] = { bone, rest: bone.rotation.x };
      }
      trekkers[i].bones = set;
    }
    // Detect units: the editor showed rest ~180 for the thighs. In radians
    // that's ~3.14. Whichever magnitude we see decides the swing amplitude.
    const sample = Math.abs(trekkers[0].bones['L_Thigh'].rest);
    const RAD = sample < 10;
    walkAmp = RAD ? 0.7 : 40;         // ~40 degrees either way
    kneeAmp = RAD ? 0.45 : 26;
    console.log('[walk] rest sample ' + sample.toFixed(2) +
      ' -> treating rotations as ' + (RAD ? 'radians' : 'degrees'));
  } else {
    console.warn('[walk] bone counts do not line up per trekker - walking ' +
      'disabled, trekkers will glide. Positions still work.');
  }

  // Prefer waypoints placed in the scene: exact, editable in Spline, no
  // anchor calibration. Fall back to the traced path only if none exist.
  const wps = [];
  for (const o of all) {
    const m = o.name && o.name.match(CONFIG.waypointPattern);
    if (m) wps.push({ order: parseInt(m[1], 10), name: o.name,
                      x: o.position.x, y: o.position.y });
  }
  wps.sort((a, b) => a.order - b.order);

  // The waypoints are route data, not scenery: hide every matching object so
  // the black cubes disappear from the render while their positions keep
  // steering the trail.
  let hidden = 0;
  for (const o of all) {
    if (o.name && CONFIG.waypointPattern.test(o.name)) { o.visible = false; hidden++; }
  }
  if (hidden) console.log('[harness] hid ' + hidden + ' waypoint markers');

  let trail;
  if (wps.length >= 2) {
    console.log('[harness] using ' + wps.length + ' waypoints from the scene:');
    console.log('   ' + wps.map(w => w.name).join(' -> '));
    trail = buildTrailFromPoints(wps.map(w => ({ x: w.x, y: w.y })));
  } else {
    console.warn('[harness] fewer than 2 waypoint objects found - falling ' +
                 'back to the traced path. Scene objects: ' +
                 all.map(o => o.name).filter(Boolean).slice(0, 40).join(', '));
    trail = buildTrail(CONFIG.anchors);
  }
  console.log(`[harness] trail length ${trail.totalLength.toFixed(0)} spline units`);

  const sim = createSim({
    maxTrekkers: trekkers.length,
    climbSeconds: CONFIG.climbSeconds,
    metric: 'none',   // nothing selected until the reader picks
  });

  // Controls talk only to the sim. They never touch the scene, which is what
  // lets the same panel drive a different renderer later.
  const ui = createControls(sim, {
    nsm: document.getElementById('nsm-slot'),
    metric: document.getElementById('metric-slot'),
    stats: document.getElementById('stats-slot'),
    buttons: document.getElementById('buttons-slot'),
  });
  let statsClock = 0;

  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    sim.tick(dt);

    statsClock += dt;
    if (statsClock > 0.25) { ui.render(); statsClock = 0; }

    for (let i = 0; i < trekkers.length; i++) {
      const t = trekkers[i];
      const a = sim.agents[i];

      // more rigs than active agents (e.g. distance/user starts only 3):
      // park the spares out of sight
      if (!a || a.status === 'off') { t.obj.visible = false; continue; }

      const p = trail.at(a.t);
      t.obj.position.x = p.x;
      t.obj.position.y = p.y;
      t.obj.position.z = t.z;                       // depth stays authored

      // walk cycle: stride phase advances with time while climbing
      if (t.bones && a.status === 'climbing') {
        t.phase += dt * 2 * Math.PI * 1.6;          // ~1.6 strides per second
        const s1 = Math.sin(t.phase);
        const s2 = Math.sin(t.phase + Math.PI);
        t.bones['L_Thigh'].bone.rotation.x = t.bones['L_Thigh'].rest + s1 * walkAmp;
        t.bones['R_Thigh'].bone.rotation.x = t.bones['R_Thigh'].rest + s2 * walkAmp;
        // trailing knee bends on push-off
        t.bones['L_Calf'].bone.rotation.x = t.bones['L_Calf'].rest + Math.max(0, s2) * kneeAmp;
        t.bones['R_Calf'].bone.rotation.x = t.bones['R_Calf'].rest + Math.max(0, s1) * kneeAmp;
        // stride bob on the whole body
        t.obj.position.y = p.y + Math.abs(s1) * 6;
      } else if (t.bones) {
        for (const b of Object.values(t.bones)) b.bone.rotation.x = b.rest;
      }

      // visibility for the summit fade. The runtime exposes .visible on
      // objects; opacity per-object is less reliable, so we blink out at the
      // midpoint of the fade rather than fading alpha.
      t.obj.visible = a.visible;
    }
  }
  requestAnimationFrame(frame);
  say(`${trekkers.length} trekkers on the trail.`);
}

init().catch(err => {
  console.error('[harness] failed:', err);
  // Removing the status line left failures completely silent, so a broken
  // load looked identical to a slow one. Surface it in the loader instead.
  const l = document.getElementById('loader');
  if (l) {
    l.classList.remove('is-done');
    l.innerHTML = '<div class="loader-text">The 3D scene could not load. ' +
                  'Details are in the browser console.</div>';
  }
});

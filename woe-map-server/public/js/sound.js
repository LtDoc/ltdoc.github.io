'use strict';

/**
 * Battle sounds, from recordings in public/assets/sounds:
 *   - four looping beds, faded in and out with what is on screen: gunfire.mp3 (rifles and machine guns, close in, over
 *     fights in view from 800 % zoom), trench.mp3 (the battlefield, under it and at middling zoom), distant.mp3
 *     (a bombardment far off, zoomed out over fights) and hooves.mp3 (cavalry in view charging or wheeling); the renderer sets their levels and pan (scene) a few times a
 *     second, and they glide to them;
 *   - incoming.mp3 one-shots (two of them) for each shell, bomb or splash on screen: a whistle ending in the burst,
 *     started so its loudest moment lands with the explosion on screen, panned by where it is.
 * Off until switched on, and remembered per browser (🎧 in the top bar); the audio starts on the first click or key
 * press after that, as browsers require, and goes quiet while the tab is hidden.
 */
const BattleSound = (() => {
  // Each recording: file, and (one-shots) where in it the shell bursts, s.
  const CLIPS = {
    gunfire: { file: 'gunfire.mp3', loop: [0, 48] },
    trench: { file: 'trench.mp3', loop: [0.2, 55] },
    distant: { file: 'distant.mp3', loop: [0.3, 32.4] },
    hooves: { file: 'hooves.mp3', loop: [0.05, 8.05] },
    incoming1: { file: 'incoming-1.mp3', burst: 0.6 },
    incoming2: { file: 'incoming-2.mp3', burst: 0.9 },
  };
  const BEDS = ['gunfire', 'trench', 'distant', 'hooves'];
  const BED_GAIN = { gunfire: 0.54, trench: 0.36, distant: 0.85, hooves: 0.7 };
  let ctx = null, master = null, enabled = false, loading = null;
  const buffers = {}, beds = {};
  let shots = [];   // times of recent one-shots, to keep a heavy bombardment from piling up
  try { enabled = localStorage.getItem('woe.battleSound') === '1'; } catch { /* ignore */ }

  function audio() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.8;
    master.connect(ctx.destination);
    return ctx;
  }
  function load() {
    if (loading || !audio()) return loading;
    loading = Promise.all(Object.entries(CLIPS).map(([k, c]) => fetch('/assets/sounds/' + c.file).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b))
      .then(buf => { buffers[k] = buf; }).catch(() => {}))).then(startBeds);
    return loading;
  }
  // The beds run all the time while sound is on, silent until the scene calls for them.
  function startBeds() {
    for (const k of BEDS) {
      if (beds[k] || !buffers[k]) continue;
      const src = ctx.createBufferSource(); src.buffer = buffers[k]; src.loop = true;
      [src.loopStart, src.loopEnd] = CLIPS[k].loop;
      const g = ctx.createGain(); g.gain.value = 0;
      const p = ctx.createStereoPanner();
      src.connect(g).connect(p).connect(master);
      src.start(0, CLIPS[k].loop[0] + Math.random() * 10);   // not every listener at the same moment of it
      beds[k] = { src, g, p };
    }
  }
  const wake = () => {
    if (!enabled || !audio()) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    load();
  };
  window.addEventListener('pointerdown', wake, { passive: true });
  window.addEventListener('keydown', wake);
  document.addEventListener('visibilitychange', () => { if (ctx) master.gain.setTargetAtTime(document.hidden ? 0 : 0.8, ctx.currentTime, 0.2); });

  /** The beds' levels (0..1) and pan (-1..1), from what is on screen; they glide there over about a second. */
  function scene({ gunfire = 0, trench = 0, distant = 0, hooves = 0, pan = 0, hoovesPan = pan }) {
    if (!enabled || !ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime, lv = { gunfire, trench, distant, hooves };
    for (const k of BEDS) {
      const b = beds[k];
      if (!b) continue;
      b.g.gain.setTargetAtTime(Math.max(0, Math.min(1, lv[k])) * BED_GAIN[k], t, k === 'hooves' ? 0.25 : 0.35);
      b.p.pan.setTargetAtTime(Math.max(-0.8, Math.min(0.8, (k === 'hooves' ? hoovesPan : pan) * (k === 'distant' ? 0.4 : 0.7))), t, 0.35);
    }
  }
  /**
   * A shell (bomb, splash) bursting `inSec` from now at offset (dx, dy) from the middle of the view (half-widths):
   * an incoming whistle timed so its burst lands then. near (0..1): how close in we are.
   */
  function incoming(dx, dy, inSec = 0, near = 1) {
    if (!enabled || !ctx || ctx.state !== 'running' || document.hidden) return;
    const off = Math.hypot(dx, dy);
    if (off > 1.6) return;
    const now = performance.now();
    shots = shots.filter(t => now - t < 2000);
    if (shots.length >= 4) return;
    shots.push(now);
    const k = Math.random() < 0.5 ? 'incoming1' : 'incoming2', buf = buffers[k];
    if (!buf) return;
    const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = 0.92 + Math.random() * 0.16;
    const g = ctx.createGain(); g.gain.value = Math.max(0, 1 - off * 0.45) * (0.35 + 0.65 * near) * 0.48;
    const p = ctx.createStereoPanner(); p.pan.value = Math.max(-0.85, Math.min(0.85, dx * 0.8));
    src.connect(g).connect(p).connect(master);
    const lead = CLIPS[k].burst / src.playbackRate.value;
    if (inSec >= lead) src.start(ctx.currentTime + inSec - lead);
    else src.start(ctx.currentTime, (lead - inSec) * src.playbackRate.value);   // late: join it part-way through
  }
  return {
    scene, incoming,
    get enabled() { return enabled; },
    set enabled(on) {
      enabled = !!on;
      try { localStorage.setItem('woe.battleSound', enabled ? '1' : '0'); } catch { /* ignore */ }
      if (enabled) wake(); else if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
    },
  };
})();
window.BattleSound = BattleSound;

'use strict';

/**
 * Battle sounds, synthesised with the Web Audio API (no sound files): rifle cracks, machine-gun rounds, cannon, shell
 * whistles and bursts, flak, hoofbeats, splashes, and the distant rumble of guns. The renderer and the battle scenes
 * call BattleSound.play(type, dx, dy, opts) with the point's offset from the middle of the view (-1..1 across each
 * half of it); each sound is panned by where it is across the screen and
 * fades with its distance from the middle of the view. Voices of each type are rate-limited so a big fight stays a
 * din rather than a roar. Off until switched on, and remembered per browser (🎧 in the top bar); the audio starts on
 * the first click or key press after that, as browsers require.
 */
const BattleSound = (() => {
  let ctx = null, master = null, noise = null, enabled = false;
  try { enabled = localStorage.getItem('woe.battleSound') === '1'; } catch { /* ignore */ }
  const recent = new Map();   // type -> [times], for rate limits
  const LIMIT = { rifle: 14, mg: 40, cannon: 6, boom: 8, whistle: 4, flak: 6, hoof: 10, splash: 4, rumble: 3 };   // per second

  function audio() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createDynamicsCompressor();
    const vol = ctx.createGain(); vol.gain.value = 0.55;
    master.connect(vol).connect(ctx.destination);
    // Two seconds of white noise, the stuff of every shot and burst.
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }
  const wake = () => { if (enabled && audio() && ctx.state === 'suspended') ctx.resume().catch(() => {}); };
  window.addEventListener('pointerdown', wake, { passive: true });
  window.addEventListener('keydown', wake);

  function allowed(type, now) {
    const l = recent.get(type) || [];
    while (l.length && now - l[0] > 1000) l.shift();
    if (l.length >= (LIMIT[type] || 10)) return false;
    l.push(now); recent.set(type, l);
    return true;
  }
  // A burst of filtered noise: the body of most sounds.
  function burst(t, { gain, dur, type = 'bandpass', freq, q = 1, attack = 0.002, pan = 0, sweep = null }) {
    const src = ctx.createBufferSource(); src.buffer = noise;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    src.connect(f).connect(g).connect(p).connect(master);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }
  function tone(t, { gain, dur, from, to, pan = 0, wave = 'sine' }) {
    const o = ctx.createOscillator(); o.type = wave; o.frequency.setValueAtTime(from, t); o.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.3, dur * 0.3)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    o.connect(g).connect(p).connect(master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  /**
   * Play a sound at a point offset (dx, dy) from the middle of the view, in half-widths and half-heights. opts: { near (0..1, how close in we are: louder and crisper), size
   * (bursts: their size), dur (whistles: the shell's flight, s), delay (s) }.
   */
  function play(type, dx, dy, opts = {}) {
    if (!enabled || document.hidden) return;
    if (!audio() || ctx.state !== 'running') return;
    const now = performance.now();
    if (!allowed(type, now)) return;
    const off = Math.hypot(dx, dy);
    if (off > 1.8) return;
    const near = opts.near ?? 1, fall = Math.max(0, 1 - off * 0.45) * (0.35 + 0.65 * near), pan = Math.max(-0.9, Math.min(0.9, dx * 0.8));
    const t = ctx.currentTime + (opts.delay || 0) + Math.random() * 0.01;
    switch (type) {
      case 'rifle':
        burst(t, { gain: 0.32 * fall, dur: 0.09, type: 'highpass', freq: 1400, pan });
        burst(t, { gain: 0.25 * fall, dur: 0.18, type: 'lowpass', freq: 500, pan, attack: 0.004 });
        break;
      case 'mg':
        burst(t, { gain: 0.22 * fall, dur: 0.06, type: 'bandpass', freq: 1800, q: 0.8, pan });
        burst(t, { gain: 0.2 * fall, dur: 0.1, type: 'lowpass', freq: 380, pan });
        break;
      case 'cannon':
        burst(t, { gain: 0.6 * fall, dur: 0.9, type: 'lowpass', freq: 260, pan, attack: 0.004, sweep: 70 });
        burst(t, { gain: 0.3 * fall, dur: 0.12, type: 'bandpass', freq: 900, pan });
        break;
      case 'boom': {
        const size = Math.min(1.5, opts.size || 1);
        burst(t, { gain: 0.55 * fall * size, dur: 1.2 + size * 0.6, type: 'lowpass', freq: 180 + 120 * near, pan, attack: 0.01, sweep: 50 });
        burst(t, { gain: 0.25 * fall * near, dur: 0.35, type: 'bandpass', freq: 700, pan, attack: 0.005 });
        break;
      }
      case 'whistle':
        tone(t, { gain: 0.05 * fall, dur: Math.max(0.6, opts.dur || 1.2), from: 1500, to: 520, pan });
        break;
      case 'flak':
        burst(t, { gain: 0.3 * fall, dur: 0.5, type: 'lowpass', freq: 600, pan, sweep: 150 });
        break;
      case 'hoof':
        for (let i = 0; i < 3; i++) burst(t + i * 0.07, { gain: 0.12 * fall, dur: 0.06, type: 'lowpass', freq: 220, pan, attack: 0.003 });
        break;
      case 'splash':
        burst(t, { gain: 0.35 * fall, dur: 1.1, type: 'bandpass', freq: 1100, q: 0.5, pan, attack: 0.02, sweep: 400 });
        burst(t, { gain: 0.3 * fall, dur: 0.8, type: 'lowpass', freq: 200, pan, attack: 0.01 });
        break;
      case 'rumble':
        // Guns far off: a low roll, no crack to it.
        burst(t, { gain: 0.3 * fall, dur: 1.8 + Math.random(), type: 'lowpass', freq: 110, pan: pan * 0.5, attack: 0.08, sweep: 45 });
        break;
    }
  }
  return {
    play,
    get enabled() { return enabled; },
    set enabled(on) {
      enabled = !!on;
      try { localStorage.setItem('woe.battleSound', enabled ? '1' : '0'); } catch { /* ignore */ }
      if (enabled) wake(); else if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
    },
  };
})();
window.BattleSound = BattleSound;

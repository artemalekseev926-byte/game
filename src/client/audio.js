let ctx = null;
let master = null;
let verbIn = null;
let volume = 0.5;
let voices = 0;
const MAX_VOICES = 48;
const bufs = {};
const last = {};

export function setVolume(v) {
  volume = Math.max(0, Math.min(1, Number(v) || 0));
  if (master) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.02);
}

export const getVolume = () => volume;

function impulse(a, seconds, decay) {
  const len = Math.floor(a.sampleRate * seconds);
  const buf = a.createBuffer(2, len, a.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp = lp * 0.55 + (Math.random() * 2 - 1) * 0.45;
      const early = i < a.sampleRate * 0.08 && Math.random() < 0.004 ? 2.5 : 1;
      d[i] = lp * Math.pow(1 - t, decay) * early;
    }
  }
  return buf;
}

function ac() {
  if (!ctx) {
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      return null;
    }
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 14;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.3;
    master = ctx.createGain();
    master.gain.value = volume;
    const tone = ctx.createBiquadFilter();
    tone.type = 'highshelf';
    tone.frequency.value = 9000;
    tone.gain.value = -3;
    master.connect(tone).connect(comp).connect(ctx.destination);
    const conv = ctx.createConvolver();
    conv.buffer = impulse(ctx, 2.6, 3.2);
    const verbHp = ctx.createBiquadFilter();
    verbHp.type = 'highpass';
    verbHp.frequency.value = 160;
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.55;
    verbIn = ctx.createGain();
    verbIn.connect(verbHp).connect(conv).connect(verbOut).connect(master);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

export function unlock() { ac(); }

function noiseBuf(a, color) {
  if (bufs[color]) return bufs[color];
  const len = Math.floor(a.sampleRate * 3);
  const b = a.createBuffer(1, len, a.sampleRate);
  const d = b.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, br = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (color === 'pink') {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    } else if (color === 'brown') {
      br = (br + 0.02 * w) / 1.02;
      d[i] = br * 3.5;
    } else d[i] = w;
  }
  bufs[color] = b;
  return b;
}

let curve = null;
function shaper(a, amount = 2.2) {
  const s = a.createWaveShaper();
  if (!curve) {
    curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
    }
  }
  s.curve = curve;
  s.oversample = '2x';
  return s;
}

function bus(a, o, life) {
  const g = a.createGain();
  g.gain.value = o.gain == null ? 1 : o.gain;
  let out = g;
  if (a.createStereoPanner && o.pan) {
    const p = a.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, o.pan));
    g.connect(p);
    out = p;
  }
  out.connect(master);
  if (o.verb !== 0) {
    const s = a.createGain();
    s.gain.value = o.verb == null ? 0.25 : o.verb;
    out.connect(s).connect(verbIn);
  }
  voices++;
  setTimeout(() => { voices = Math.max(0, voices - 1); try { g.disconnect(); } catch { return; } }, (life + 3) * 1000);
  return g;
}

function env(g, t, peak, attack, decay, hold = 0) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  if (hold) g.gain.setValueAtTime(peak, t + attack + hold);
  g.gain.setTargetAtTime(0.0001, t + attack + hold, decay / 4.5);
}

function osc(a, out, t, o) {
  const node = a.createOscillator();
  node.type = o.type || 'sine';
  node.frequency.setValueAtTime(o.f, t);
  if (o.to) node.frequency.exponentialRampToValueAtTime(Math.max(10, o.to), t + (o.glide || o.dur));
  if (o.detune) node.detune.value = o.detune;
  const g = a.createGain();
  env(g, t, o.vol || 0.2, o.attack || 0.004, o.dur, o.hold || 0);
  let src = node;
  if (o.vib) {
    const l = a.createOscillator(), lg = a.createGain();
    l.frequency.value = o.vib[0];
    lg.gain.value = o.vib[1];
    l.connect(lg).connect(node.frequency);
    l.start(t);
    l.stop(t + o.dur + (o.hold || 0) + 0.3);
  }
  if (o.lp) {
    const f = a.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = o.q || 0.8;
    f.frequency.setValueAtTime(o.lp, t);
    if (o.lpTo) {
      f.frequency.linearRampToValueAtTime(o.lpPeak || o.lpTo, t + (o.lpAt || 0.08));
      f.frequency.setTargetAtTime(o.lpTo, t + (o.lpAt || 0.08), (o.dur || 0.3) / 3);
    }
    src.connect(f);
    src = f;
  }
  src.connect(g).connect(out);
  node.start(t);
  node.stop(t + (o.attack || 0.004) + (o.hold || 0) + o.dur * 1.6 + 0.1);
}

function noise(a, out, t, o) {
  const src = a.createBufferSource();
  src.buffer = noiseBuf(a, o.color || 'white');
  src.loop = true;
  src.playbackRate.value = o.rate || 1;
  let node = src;
  const f = a.createBiquadFilter();
  f.type = o.ft || 'lowpass';
  f.frequency.setValueAtTime(o.f || 1200, t);
  if (o.to) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t + (o.glide || o.dur));
  f.Q.value = o.q || 0.7;
  node.connect(f);
  node = f;
  if (o.drive) {
    const s = shaper(a, o.drive);
    node.connect(s);
    node = s;
  }
  if (o.am) {
    const amg = a.createGain();
    amg.gain.value = 0.5;
    const l = a.createOscillator(), lg = a.createGain();
    l.frequency.value = o.am[0];
    lg.gain.value = o.am[1] * 0.5;
    l.connect(lg).connect(amg.gain);
    l.start(t);
    l.stop(t + o.dur * 1.6 + (o.hold || 0) + 0.2);
    node.connect(amg);
    node = amg;
  }
  const g = a.createGain();
  env(g, t, o.vol || 0.2, o.attack || 0.003, o.dur, o.hold || 0);
  node.connect(g).connect(out);
  src.start(t, Math.random() * 2);
  src.stop(t + (o.attack || 0.003) + (o.hold || 0) + o.dur * 1.6 + 0.1);
}

function bell(a, out, t, f, vol, dur, ratio = 3.5, index = 2.2) {
  const car = a.createOscillator(), mod = a.createOscillator(), mg = a.createGain(), g = a.createGain();
  car.frequency.value = f;
  mod.frequency.value = f * ratio;
  mg.gain.setValueAtTime(f * index, t);
  mg.gain.exponentialRampToValueAtTime(f * 0.05, t + dur * 0.7);
  mod.connect(mg).connect(car.frequency);
  env(g, t, vol, 0.002, dur);
  car.connect(g).connect(out);
  car.start(t);
  mod.start(t);
  car.stop(t + dur * 1.6 + 0.1);
  mod.stop(t + dur * 1.6 + 0.1);
}

function brass(a, out, t, f, vol, dur, opts = {}) {
  for (const d of [-7, 0, 6]) {
    osc(a, out, t, {
      type: 'sawtooth', f, detune: d, vol: vol / 3, attack: opts.attack || 0.05, dur, hold: opts.hold || 0,
      lp: f * 1.2, lpPeak: f * (opts.bright || 6), lpTo: f * 2.5, lpAt: 0.09, q: 1.2, vib: [5.2, f * 0.006],
    });
  }
}

function strings(a, out, t, f, vol, dur, hold) {
  for (const d of [-9, -3, 4, 10]) {
    osc(a, out, t, { type: 'sawtooth', f, detune: d, vol: vol / 4, attack: 0.35, dur, hold, lp: f * 3, q: 0.5, vib: [4.6, f * 0.004] });
  }
}

function timpani(a, out, t, f, vol) {
  osc(a, out, t, { f: f * 1.6, to: f, glide: 0.06, vol, attack: 0.002, dur: 1.1 });
  osc(a, out, t, { f: f * 2.4, to: f * 1.5, glide: 0.05, vol: vol * 0.35, attack: 0.002, dur: 0.5 });
  noise(a, out, t, { color: 'pink', ft: 'lowpass', f: 900, to: 200, vol: vol * 0.6, dur: 0.18 });
}

function thump(a, out, t, f, vol, dur) {
  osc(a, out, t, { f: f * 2.2, to: f, glide: 0.08, vol, attack: 0.002, dur });
}

function crackle(a, out, t, n, spread, vol, hp = 1800) {
  for (let i = 0; i < n; i++) {
    const dt = Math.random() * spread;
    noise(a, out, t + dt, { ft: 'highpass', f: hp + Math.random() * 3000, vol: vol * (0.4 + Math.random() * 0.6), dur: 0.02 + Math.random() * 0.05, attack: 0.001 });
  }
}

function explosion(a, out, t, size) {
  noise(a, out, t, { ft: 'highpass', f: 1400, vol: 0.35 * size, dur: 0.06, attack: 0.001 });
  noise(a, out, t, { color: 'pink', ft: 'lowpass', f: 3200 * Math.min(1.4, size), to: 160, glide: 0.5 + size * 0.5, vol: 0.7 * Math.min(1.2, size), dur: 0.5 + size * 0.9, attack: 0.002, drive: 2.5 });
  noise(a, out, t + 0.02, { color: 'brown', ft: 'lowpass', f: 420, to: 70, glide: 1 + size, vol: 0.55 * size, dur: 0.9 + size * 1.6, attack: 0.03 });
  thump(a, out, t, 42 + 12 / size, 0.75 * Math.min(1.3, size), 0.5 + size * 0.5);
  crackle(a, out, t + 0.05, Math.round(4 + size * 8), 0.4 + size * 0.8, 0.12 * Math.min(1.5, size));
}

function siren(a, out, t, dur) {
  const o = a.createOscillator(), o2 = a.createOscillator(), g = a.createGain(), f = a.createBiquadFilter();
  o.type = 'sawtooth';
  o2.type = 'triangle';
  for (const node of [o, o2]) {
    node.frequency.setValueAtTime(260, t);
    node.frequency.linearRampToValueAtTime(620, t + dur * 0.35);
    node.frequency.setValueAtTime(620, t + dur * 0.55);
    node.frequency.linearRampToValueAtTime(240, t + dur);
  }
  o2.detune.value = 8;
  f.type = 'bandpass';
  f.frequency.value = 900;
  f.Q.value = 0.9;
  env(g, t, 0.22, 0.4, dur * 0.4, dur * 0.6);
  o.connect(f);
  o2.connect(f);
  f.connect(g).connect(out);
  o.start(t);
  o2.start(t);
  o.stop(t + dur * 1.6 + 0.5);
  o2.stop(t + dur * 1.6 + 0.5);
}

const N = (m) => 440 * Math.pow(2, (m - 69) / 12);

const SOUNDS = {
  click: { life: 0.2, verb: 0.05, fn: (a, o, t) => {
    noise(a, o, t, { ft: 'bandpass', f: 3800, q: 2.5, vol: 0.32, dur: 0.012, attack: 0.0008 });
    osc(a, o, t, { f: 1900, to: 1300, vol: 0.09, dur: 0.03, attack: 0.001 });
  } },
  select: { life: 0.6, verb: 0.15, fn: (a, o, t) => {
    bell(a, o, t, N(84), 0.07, 0.35, 2.01, 0.6);
    bell(a, o, t + 0.05, N(91), 0.05, 0.4, 2.01, 0.5);
  } },
  toggle: { life: 0.3, verb: 0.08, fn: (a, o, t) => {
    osc(a, o, t, { f: 520, to: 860, glide: 0.04, vol: 0.15, dur: 0.07, attack: 0.002 });
    noise(a, o, t, { ft: 'bandpass', f: 2600, q: 3, vol: 0.06, dur: 0.015, attack: 0.001 });
  } },
  error: { life: 0.6, verb: 0.1, fn: (a, o, t) => {
    osc(a, o, t, { type: 'triangle', f: 196, vol: 0.14, dur: 0.12, attack: 0.004, lp: 900 });
    osc(a, o, t + 0.11, { type: 'triangle', f: 165, vol: 0.14, dur: 0.18, attack: 0.004, lp: 800 });
  } },
  attack: { life: 1.4, verb: 0.3, fn: (a, o, t) => {
    timpani(a, o, t, 82, 0.35);
    timpani(a, o, t + 0.16, 73, 0.28);
    crackle(a, o, t + 0.1, 9, 0.7, 0.08, 1200);
    brass(a, o, t + 0.05, N(50), 0.1, 0.35, { bright: 5 });
  } },
  build: { life: 1, verb: 0.2, fn: (a, o, t) => {
    for (const [dt, v] of [[0, 1], [0.15, 0.8]]) {
      noise(a, o, t + dt, { ft: 'bandpass', f: 2600, q: 6, vol: 0.22 * v, dur: 0.09, attack: 0.001 });
      osc(a, o, t + dt, { f: 1240, vol: 0.05 * v, dur: 0.12, attack: 0.001 });
      osc(a, o, t + dt, { f: 1913, vol: 0.035 * v, dur: 0.09, attack: 0.001 });
      thump(a, o, t + dt, 90, 0.18 * v, 0.12);
    }
  } },
  built: { life: 1.2, verb: 0.3, fn: (a, o, t) => {
    bell(a, o, t, N(72), 0.09, 0.6, 4.0, 1.2);
    bell(a, o, t + 0.09, N(79), 0.08, 0.7, 4.0, 1.1);
  } },
  capture: { life: 2, verb: 0.35, fn: (a, o, t) => {
    brass(a, o, t, N(60), 0.16, 0.25);
    brass(a, o, t + 0.12, N(64), 0.16, 0.25);
    brass(a, o, t + 0.24, N(67), 0.18, 0.5, { hold: 0.15 });
    timpani(a, o, t, 98, 0.22);
  } },
  lost: { life: 2, verb: 0.35, fn: (a, o, t) => {
    brass(a, o, t, N(55), 0.15, 0.35, { bright: 3 });
    brass(a, o, t + 0.22, N(51), 0.15, 0.7, { bright: 3, hold: 0.1 });
    timpani(a, o, t, 65, 0.3);
  } },
  launch: { life: 3, verb: 0.4, fn: (a, o, t) => {
    noise(a, o, t, { ft: 'highpass', f: 900, vol: 0.25, dur: 0.15, attack: 0.002 });
    noise(a, o, t, { color: 'brown', ft: 'lowpass', f: 300, to: 1400, glide: 0.8, vol: 0.5, dur: 1.4, attack: 0.06, drive: 2 });
    noise(a, o, t + 0.05, { ft: 'bandpass', f: 700, to: 2600, glide: 1.6, q: 1.2, vol: 0.18, dur: 1.6, attack: 0.25 });
    thump(a, o, t, 50, 0.45, 0.6);
  } },
  drone: { life: 2.4, verb: 0.2, fn: (a, o, t) => {
    noise(a, o, t, { ft: 'bandpass', f: 520, to: 380, glide: 1.8, q: 4, vol: 0.34, dur: 1.4, attack: 0.25, am: [42, 0.9] });
    osc(a, o, t, { type: 'sawtooth', f: 210, to: 165, glide: 1.8, vol: 0.05, dur: 1.4, attack: 0.25, lp: 1400 });
  } },
  smallboom: { life: 2.5, verb: 0.45, fn: (a, o, t) => explosion(a, o, t, 0.6) },
  boom: { life: 4, verb: 0.55, fn: (a, o, t) => explosion(a, o, t, 1) },
  intercept: { life: 2.5, verb: 0.5, fn: (a, o, t) => {
    noise(a, o, t, { ft: 'bandpass', f: 500, to: 4200, glide: 0.25, q: 2, vol: 0.2, dur: 0.3, attack: 0.01 });
    explosion(a, o, t + 0.28, 0.4);
    osc(a, o, t + 0.28, { f: 2350, vol: 0.03, dur: 0.6, attack: 0.001 });
  } },
  nuke: { life: 7, verb: 0.75, fn: (a, o, t) => {
    noise(a, o, t, { ft: 'highpass', f: 2500, vol: 0.45, dur: 0.12, attack: 0.001 });
    explosion(a, o, t, 2.2);
    noise(a, o, t + 0.35, { color: 'brown', ft: 'lowpass', f: 260, to: 45, glide: 4, vol: 0.85, dur: 4.5, attack: 0.4, drive: 1.6 });
    thump(a, o, t, 30, 0.9, 2.2);
    noise(a, o, t + 0.6, { ft: 'bandpass', f: 1800, to: 300, glide: 1.5, q: 0.8, vol: 0.25, dur: 1.6, attack: 0.08 });
    crackle(a, o, t + 0.8, 30, 3, 0.08, 900);
  } },
  mega: { life: 8, verb: 0.6, fn: (a, o, t) => {
    siren(a, o, t, 3.2);
    siren(a, o, t + 3.4, 3.2);
    noise(a, o, t, { color: 'brown', ft: 'lowpass', f: 120, to: 60, glide: 6, vol: 0.4, dur: 4, attack: 2, hold: 2 });
  } },
  research: { life: 2.5, verb: 0.5, fn: (a, o, t) => {
    [N(76), N(79), N(84), N(88)].forEach((f, i) => bell(a, o, t + i * 0.08, f, 0.07, 1.2, 3.5, 1.4));
  } },
  researchReady: { life: 2, verb: 0.45, fn: (a, o, t) => {
    bell(a, o, t, N(81), 0.07, 0.9, 2.76, 1.3);
    bell(a, o, t + 0.12, N(88), 0.06, 1.1, 2.76, 1.2);
  } },
  victory: { life: 7, verb: 0.55, fn: (a, o, t) => {
    const prog = [[60, 64, 67], [65, 69, 72], [67, 71, 74], [72, 76, 79]];
    prog.forEach((ch, k) => {
      const tt = t + k * 0.55;
      ch.forEach((m) => brass(a, o, tt, N(m), 0.12, k === 3 ? 1.6 : 0.4, { hold: k === 3 ? 0.8 : 0.1 }));
      strings(a, o, tt, N(ch[0] - 12), 0.12, k === 3 ? 2 : 0.6, 0.2);
      timpani(a, o, tt, 98, k === 3 ? 0.4 : 0.25);
    });
  } },
  defeat: { life: 7, verb: 0.6, fn: (a, o, t) => {
    const prog = [[57, 60, 64], [53, 57, 60], [52, 55, 59], [45, 52, 57]];
    prog.forEach((ch, k) => {
      const tt = t + k * 0.8;
      ch.forEach((m) => strings(a, o, tt, N(m), 0.14, k === 3 ? 2.2 : 0.9, 0.3));
      if (k === 0 || k === 3) timpani(a, o, tt, 55, 0.35);
    });
  } },
  alert: { life: 1.6, verb: 0.35, fn: (a, o, t) => {
    for (const [dt, m] of [[0, 81], [0.22, 76], [0.44, 81], [0.66, 76]]) {
      osc(a, o, t + dt, { type: 'triangle', f: N(m), vol: 0.08, dur: 0.16, attack: 0.01, hold: 0.05, lp: 2400 });
    }
  } },
  ship: { life: 3.5, verb: 0.55, fn: (a, o, t) => {
    for (const [f, d] of [[98, -6], [147, 5], [196, 0]]) {
      osc(a, o, t, { type: 'sawtooth', f, detune: d, vol: f > 150 ? 0.05 : 0.09, attack: 0.18, hold: 0.9, dur: 0.8, lp: 520, q: 1.4, vib: [5, 0.6] });
    }
    noise(a, o, t, { color: 'pink', ft: 'lowpass', f: 700, to: 300, glide: 2, vol: 0.12, dur: 1.6, attack: 0.3 });
  } },
  boat: { life: 2.4, verb: 0.25, fn: (a, o, t) => {
    noise(a, o, t, { color: 'brown', ft: 'bandpass', f: 180, q: 2, vol: 0.5, dur: 1.2, attack: 0.1, am: [24, 1] });
    noise(a, o, t, { color: 'pink', ft: 'lowpass', f: 1600, to: 500, glide: 1, vol: 0.12, dur: 0.9, attack: 0.05 });
  } },
  splash: { life: 3, verb: 0.45, fn: (a, o, t) => {
    noise(a, o, t, { color: 'pink', ft: 'bandpass', f: 1800, to: 280, glide: 0.8, q: 0.9, vol: 0.4, dur: 1.1, attack: 0.005 });
    thump(a, o, t, 60, 0.3, 0.4);
    for (let i = 0; i < 9; i++) {
      const f = 380 + Math.random() * 700;
      osc(a, o, t + 0.25 + Math.random() * 1.1, { f, to: f * 1.9, glide: 0.05, vol: 0.03, dur: 0.06, attack: 0.002 });
    }
  } },
  trade: { life: 1.2, verb: 0.25, fn: (a, o, t) => {
    for (const [dt, v] of [[0, 1], [0.09, 0.7]]) {
      for (const f of [2637, 3951, 5274]) osc(a, o, t + dt, { f: f * (0.98 + Math.random() * 0.04), vol: 0.05 * v, dur: 0.35, attack: 0.001 });
    }
  } },
  cash: { life: 0.8, verb: 0.2, fn: (a, o, t) => {
    for (const f of [3136, 4699]) osc(a, o, t, { f, vol: 0.05, dur: 0.25, attack: 0.001 });
  } },
  proposal: { life: 2.5, verb: 0.5, fn: (a, o, t) => {
    [N(74), N(78), N(81), N(86)].forEach((f, i) => bell(a, o, t + i * 0.12, f, 0.06, 1.1, 2.0, 0.8));
  } },
  chat: { life: 0.6, verb: 0.15, fn: (a, o, t) => {
    osc(a, o, t, { f: 980, to: 1460, glide: 0.04, vol: 0.13, dur: 0.12, attack: 0.003 });
  } },
  spawn: { life: 4, verb: 0.55, fn: (a, o, t) => {
    [60, 67, 72, 76].forEach((m) => strings(a, o, t, N(m), 0.12, 1.4, 0.6));
    timpani(a, o, t, 82, 0.3);
    brass(a, o, t + 0.5, N(72), 0.1, 0.8, { hold: 0.3 });
  } },
  eliminated: { life: 5, verb: 0.6, fn: (a, o, t) => {
    bell(a, o, t, 82, 0.25, 3, 1.41, 3);
    bell(a, o, t, 123, 0.12, 2.5, 1.41, 2);
    noise(a, o, t, { color: 'brown', ft: 'lowpass', f: 200, vol: 0.2, dur: 2, attack: 0.01 });
  } },
};

const GAP = { nuke: 280, mega: 6000, boom: 110, smallboom: 90, trade: 160, cash: 220, alert: 1200, proposal: 400, capture: 220, lost: 300, attack: 140, intercept: 90, splash: 200, researchReady: 1500, drone: 150, launch: 160 };

export function play(name, opts = {}) {
  const def = SOUNDS[name];
  if (volume <= 0 || !def) return;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (last[name] && now - last[name] < (GAP[name] || 60)) return;
  const a = ac();
  if (!a) return;
  if (voices >= MAX_VOICES && name !== 'victory' && name !== 'defeat') return;
  last[name] = now;
  try {
    const o = bus(a, { pan: opts.pan || 0, gain: opts.gain == null ? 1 : opts.gain, verb: def.verb + (opts.far ? 0.25 : 0) }, def.life);
    def.fn(a, o, a.currentTime + 0.01);
  } catch {
    return;
  }
}

export const SOUND_NAMES = Object.keys(SOUNDS);

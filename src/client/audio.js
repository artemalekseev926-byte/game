let ctx = null;
let master = null;
let noiseBuf = null;
let volume = 0.5;
const last = {};

export function setVolume(v) {
  volume = Math.max(0, Math.min(1, Number(v) || 0));
  if (master) master.gain.value = volume;
}

export const getVolume = () => volume;

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
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(comp).connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

export function unlock() { ac(); }

function noiseBuffer(a) {
  if (noiseBuf) return noiseBuf;
  const len = Math.floor(a.sampleRate * 2);
  noiseBuf = a.createBuffer(1, len, a.sampleRate);
  const d = noiseBuf.getChannelData(0);
  let b = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b = 0.97 * b + 0.03 * w;
    d[i] = w * 0.6 + b * 2.2;
  }
  return noiseBuf;
}

function tone(freq, dur, type = 'square', vol = 0.2, slide = 0, delay = 0, attack = 0.004) {
  const a = ac();
  if (!a || volume <= 0) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function noise(dur, vol = 0.3, lp = 1200, delay = 0, opts = {}) {
  const a = ac();
  if (!a || volume <= 0) return;
  const t = a.currentTime + delay;
  const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  src.buffer = noiseBuffer(a);
  src.loop = true;
  src.playbackRate.value = opts.rate || 1;
  f.type = opts.type || 'lowpass';
  f.frequency.setValueAtTime(lp, t);
  if (opts.sweep) f.frequency.exponentialRampToValueAtTime(Math.max(30, opts.sweep), t + dur);
  if (opts.q) f.Q.value = opts.q;
  const at = opts.attack || 0.005;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + at);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.05);
}

const chord = (notes, dur, type, vol, step) => notes.forEach((f, i) => tone(f, dur, type, vol, 0, i * step));

const SOUNDS = {
  click: () => tone(720, 0.045, 'triangle', 0.12),
  select: () => { tone(540, 0.05, 'triangle', 0.12); tone(810, 0.06, 'triangle', 0.1, 0, 0.04); },
  toggle: () => tone(480, 0.05, 'sine', 0.14, 120),
  error: () => { tone(220, 0.1, 'square', 0.08); tone(165, 0.14, 'square', 0.08, 0, 0.09); },
  attack: () => { noise(0.12, 0.22, 900, 0, { sweep: 300 }); tone(150, 0.12, 'triangle', 0.18, -60); },
  build: () => { tone(440, 0.07, 'triangle', 0.16); tone(660, 0.1, 'triangle', 0.16, 0, 0.07); noise(0.05, 0.08, 3000, 0.02, { type: 'highpass' }); },
  built: () => chord([523, 784], 0.12, 'triangle', 0.12, 0.06),
  capture: () => chord([523, 659, 784], 0.12, 'square', 0.08, 0.08),
  lost: () => { tone(392, 0.14, 'square', 0.09); tone(311, 0.22, 'square', 0.09, 0, 0.12); },
  launch: () => { noise(0.8, 0.22, 600, 0, { sweep: 2600, attack: 0.08 }); tone(140, 0.7, 'sawtooth', 0.06, 380); },
  drone: () => { tone(880, 0.4, 'sawtooth', 0.03, -200); noise(0.35, 0.06, 2400, 0, { type: 'bandpass', q: 3 }); },
  boom: () => { noise(0.8, 0.42, 700, 0, { sweep: 120 }); tone(70, 0.6, 'sine', 0.3, -40); },
  smallboom: () => { noise(0.3, 0.26, 1600, 0, { sweep: 300 }); tone(110, 0.22, 'sine', 0.14, -50); },
  intercept: () => { tone(1400, 0.05, 'square', 0.06); noise(0.18, 0.18, 3200, 0.03, { sweep: 900 }); tone(900, 0.12, 'triangle', 0.08, -500, 0.03); },
  nuke: () => {
    noise(0.12, 0.5, 6000, 0, { type: 'highpass' });
    noise(3.2, 0.6, 900, 0.03, { sweep: 60, attack: 0.02, rate: 0.6 });
    tone(55, 2.6, 'sine', 0.45, -25, 0.02);
    tone(38, 3, 'triangle', 0.3, -12, 0.1);
  },
  mega: () => {
    for (let k = 0; k < 3; k++) {
      tone(420, 0.55, 'sawtooth', 0.06, 380, k * 0.62, 0.05);
      tone(800, 0.06, 'sawtooth', 0.04, -380, k * 0.62 + 0.55, 0.02);
    }
    noise(2.6, 0.3, 300, 0.1, { sweep: 80, attack: 0.6, rate: 0.5 });
  },
  research: () => chord([660, 880, 1320], 0.14, 'triangle', 0.13, 0.08),
  victory: () => { chord([523, 659, 784, 1047], 0.3, 'square', 0.08, 0.15); chord([523, 784, 1047], 0.6, 'triangle', 0.1, 0); },
  defeat: () => chord([392, 330, 262, 196], 0.3, 'square', 0.08, 0.2),
  alert: () => { tone(880, 0.09, 'square', 0.06); tone(880, 0.09, 'square', 0.06, 0, 0.16); },
  ship: () => { tone(110, 0.55, 'sawtooth', 0.05, 30, 0, 0.05); tone(165, 0.55, 'sawtooth', 0.04, 20, 0.02, 0.05); noise(0.5, 0.08, 500, 0, { attack: 0.1 }); },
  boat: () => { noise(0.45, 0.12, 700, 0, { sweep: 300, attack: 0.08 }); tone(196, 0.3, 'triangle', 0.08, -40); },
  splash: () => noise(0.5, 0.18, 1800, 0, { sweep: 250 }),
  trade: () => { tone(1320, 0.07, 'triangle', 0.07); tone(1760, 0.1, 'triangle', 0.06, 0, 0.06); },
  cash: () => tone(1500, 0.06, 'triangle', 0.045),
  proposal: () => { chord([587, 740, 880], 0.18, 'sine', 0.13, 0.11); tone(1175, 0.3, 'sine', 0.07, 0, 0.33); },
  chat: () => tone(990, 0.06, 'sine', 0.09, 60),
  spawn: () => { chord([392, 523, 659], 0.22, 'triangle', 0.1, 0.12); tone(784, 0.5, 'triangle', 0.11, 0, 0.36); },
  eliminated: () => { tone(330, 0.2, 'square', 0.06); tone(247, 0.35, 'square', 0.06, 0, 0.18); },
};

const GAP = { nuke: 350, mega: 1500, boom: 120, smallboom: 90, trade: 160, cash: 220, alert: 900, proposal: 400, capture: 160, lost: 250, attack: 120 };

export function play(name) {
  if (volume <= 0 || !SOUNDS[name]) return;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (last[name] && now - last[name] < (GAP[name] || 70)) return;
  last[name] = now;
  try {
    if (ac()) SOUNDS[name]();
  } catch {
    return;
  }
}

// 8-битные звуки на WebAudio (без файлов-ассетов)
let ctx = null;
let volume = 0.5;
let last = {};

export function setVolume(v) { volume = v; }
function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, dur, type = 'square', vol = 0.2, slide = 0, delay = 0) {
  const a = ac();
  if (!a || volume <= 0) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
  g.gain.setValueAtTime(vol * volume, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur, vol = 0.3, lp = 1200) {
  const a = ac();
  if (!a || volume <= 0) return;
  const len = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  src.buffer = buf;
  f.type = 'lowpass'; f.frequency.value = lp;
  g.gain.value = vol * volume;
  src.connect(f).connect(g).connect(a.destination);
  src.start();
}

const SOUNDS = {
  click: () => tone(660, 0.05, 'square', 0.12),
  error: () => { tone(200, 0.12, 'square', 0.15); tone(150, 0.15, 'square', 0.15, 0, 0.1); },
  build: () => { tone(440, 0.07, 'square', 0.15); tone(660, 0.1, 'square', 0.15, 0, 0.07); },
  recruit: () => tone(520, 0.06, 'triangle', 0.2, 200),
  move: () => tone(330, 0.08, 'triangle', 0.2, 120),
  battle: () => noise(0.18, 0.18, 2500),
  capture: () => { tone(523, 0.08, 'square', 0.15); tone(659, 0.08, 'square', 0.15, 0, 0.08); tone(784, 0.14, 'square', 0.15, 0, 0.16); },
  lost: () => { tone(392, 0.12, 'square', 0.15); tone(311, 0.2, 'square', 0.15, 0, 0.12); },
  launch: () => { tone(200, 0.4, 'sawtooth', 0.1, 600); noise(0.3, 0.1, 800); },
  drone: () => tone(900, 0.25, 'sawtooth', 0.05, -300),
  boom: () => { noise(0.6, 0.45, 600); tone(80, 0.5, 'sine', 0.3, -50); },
  smallboom: () => noise(0.25, 0.25, 1500),
  intercept: () => { tone(1200, 0.06, 'square', 0.1); noise(0.15, 0.15, 3000); },
  research: () => { tone(660, 0.08, 'triangle', 0.2); tone(880, 0.08, 'triangle', 0.2, 0, 0.08); tone(1320, 0.15, 'triangle', 0.2, 0, 0.16); },
  victory: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.2, 'square', 0.18, 0, i * 0.15)),
  defeat: () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.25, 'square', 0.18, 0, i * 0.18)),
  alert: () => { tone(880, 0.1, 'square', 0.12); tone(880, 0.1, 'square', 0.12, 0, 0.18); },
};

// Ограничиваем частоту одинаковых звуков
export function play(name) {
  const now = performance.now();
  if (last[name] && now - last[name] < 70) return;
  last[name] = now;
  try { SOUNDS[name] && SOUNDS[name](); } catch { /* звук не критичен */ }
}

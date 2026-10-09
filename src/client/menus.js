import { MAPS, generateMap, parseCustomMap } from '../core/map.js';
import { PLAYER_COLORS, DIFFICULTY } from '../core/config.js';
import { THEMES } from './theme.js';
import { HostLobby, ClientLobby, randomSeed, cleanName } from './lobby.js';
import { SteamTransport, LanHostTransport, LanClientTransport, hasNative, DEFAULT_PORT } from './net.js';
import { play } from './audio.js';
import { $, esc, tpl, setRangeFill, safeColor, fmtPct } from './hud.js';

export const THUMB_SEED = 20250;
const BG_DESC = { id: 'world', seed: 7 };
const DIFF_NAMES = { easy: 'лёгкий', normal: 'средний', hard: 'сложный' };
const DIFF_ORDER = ['easy', 'normal', 'hard'];
export const BOT_NAMES = [
  'Северная Империя', 'Южный Союз', 'Восточная Орда', 'Западная Лига', 'Пиксельная Республика', 'Красный Блок',
  'Синий Альянс', 'Железный Пакт', 'Островное Королевство', 'Пустынный Халифат', 'Ледяной Каганат', 'Горная Конфедерация',
  'Степное Ханство', 'Морская Держава', 'Лесная Федерация',
];

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function descKey(desc) {
  if (!desc) return 'none';
  if (desc.id === 'custom') return `custom:${hashStr((desc.rows || []).join('\n'))}:${desc.scale || 0}:${desc.seed >>> 0}`;
  return `${desc.id}:${desc.seed >>> 0}`;
}

export function customScale(d) {
  const w = d.rows[0].length, h = d.rows.length;
  let s = d.scale || Math.min(16, Math.ceil(1200 / w));
  while (s > 1 && w * s * h * s > 3200000) s--;
  return s;
}

const smooth = (a, b, v) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function mapMeta(map) {
  return { W: map.W, H: map.H, landCount: map.landCount, land: (map.landCount * 100) / (map.W * map.H), name: map.name };
}

export function sampleMap(map, w, h, fit = 'contain') {
  const W = map.W, H = map.H;
  const scale = fit === 'cover' ? Math.max(w / W, h / H) : Math.min(w / W, h / H);
  const ow = fit === 'cover' ? w : Math.max(1, Math.round(W * scale));
  const oh = fit === 'cover' ? h : Math.max(1, Math.round(H * scale));
  const x0 = fit === 'cover' ? (W - w / scale) / 2 : 0;
  const y0 = fit === 'cover' ? (H - h / scale) / 2 : 0;
  const K = Math.max(1, Math.min(3, Math.round(1 / scale)));
  const n = ow * oh * K * K;
  const ter = new Uint8Array(n), elev = new Uint8Array(n), lake = new Uint8Array(n);
  const t = map.terrain, el = map.elev, wb = map.waterBody, ob = map.oceanBodies;
  const step = 1 / (scale * K);
  let k = 0;
  for (let py = 0; py < oh; py++) {
    for (let px = 0; px < ow; px++) {
      for (let sy = 0; sy < K; sy++) {
        const ty = Math.min(H - 1, Math.max(0, Math.floor(y0 + (py * K + sy + 0.5) * step)));
        for (let sx = 0; sx < K; sx++) {
          const tx = Math.min(W - 1, Math.max(0, Math.floor(x0 + (px * K + sx + 0.5) * step)));
          const i = ty * W + tx;
          const tt = t[i];
          ter[k] = tt;
          elev[k] = el ? el[i] : tt >= 2 ? 90 : 30;
          lake[k] = tt < 2 && wb && ob && wb[i] >= 0 && !ob.has(wb[i]) ? 1 : 0;
          k++;
        }
      }
    }
  }
  return { w: ow, h: oh, K, ter, elev, lake, meta: mapMeta(map) };
}

export function paintSamples(S, themeName) {
  const th = THEMES[themeName] || THEMES.dark;
  const { w, h, K, ter, elev, lake } = S;
  const KK = K * K;
  const water = new Float32Array(256 * 3);
  for (let d = 0; d < 256; d++) {
    const dd = Math.min(1, d / 60);
    const a = smooth(0, 0.35, dd), b = smooth(0.25, 1, dd);
    for (let c = 0; c < 3; c++) {
      const m = th.shallow[c] + (th.mid[c] - th.shallow[c]) * a;
      water[d * 3 + c] = m + (th.deep[c] - m) * b;
    }
  }
  const land = new Float32Array(8 * 256 * 3);
  for (let tt = 2; tt < 8; tt++) {
    const base = th.land[tt];
    for (let e = 0; e < 256; e++) {
      const k = th.landGain * (0.84 + (e / 255) * 0.32);
      for (let c = 0; c < 3; c++) land[(tt * 256 + e) * 3 + c] = base[c] * k;
    }
  }
  const N = w * h;
  const rgb = new Float32Array(N * 3), ae = new Float32Array(N), lf = new Float32Array(N);
  let k = 0;
  for (let p = 0; p < N; p++) {
    let r = 0, g = 0, b = 0, e = 0, l = 0;
    for (let q = 0; q < KK; q++, k++) {
      const tt = ter[k];
      let o;
      if (tt >= 2) {
        o = (tt * 256 + elev[k]) * 3;
        r += land[o]; g += land[o + 1]; b += land[o + 2];
        e += elev[k];
        l++;
      } else if (lake[k]) {
        r += th.lake[0]; g += th.lake[1]; b += th.lake[2];
      } else {
        o = elev[k] * 3;
        r += water[o]; g += water[o + 1]; b += water[o + 2];
      }
    }
    rgb[p * 3] = r / KK;
    rgb[p * 3 + 1] = g / KK;
    rgb[p * 3 + 2] = b / KK;
    ae[p] = l ? e / l : 0;
    lf[p] = l / KK;
  }
  const out = new Uint8ClampedArray(N * 4);
  const shadeK = 0.011 * (th.shade || 1.4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let m = 1;
      if (lf[p] > 0) {
        const q = y > 0 && x > 0 ? p - w - 1 : p;
        const d = lf[q] > 0 ? ae[q] - ae[p] : 0;
        m = 1 + Math.max(-0.24, Math.min(0.24, d * shadeK)) * lf[p];
        if (lf[p] < 1 && lf[p] > 0) m *= 0.92 + 0.08 * lf[p];
      }
      out[p * 4] = rgb[p * 3] * m;
      out[p * 4 + 1] = rgb[p * 3 + 1] * m;
      out[p * 4 + 2] = rgb[p * 3 + 2] * m;
      out[p * 4 + 3] = 255;
    }
  }
  return out;
}

export function landMask(map, mw, mh) {
  const out = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    const ty = Math.min(map.H - 1, Math.floor(((y + 0.5) * map.H) / mh));
    for (let x = 0; x < mw; x++) {
      const tx = Math.min(map.W - 1, Math.floor(((x + 0.5) * map.W) / mw));
      out[y * mw + x] = map.terrain[ty * map.W + tx] >= 2 ? 1 : 0;
    }
  }
  return out;
}

function previewEngine() {
  const maps = [];
  const samples = new Map();
  const getMap = (desc) => {
    const key = descKey(desc);
    const hit = maps.find((m) => m.key === key);
    if (hit) return hit.map;
    const map = generateMap(desc);
    maps.push({ key, map });
    while (maps.length > 2) maps.shift();
    return map;
  };
  return (q) => {
    const skey = `${descKey(q.desc)}|${q.w}x${q.h}|${q.fit || 'contain'}`;
    let S = samples.get(skey);
    let map = null;
    if (!S) {
      map = getMap(q.desc);
      S = sampleMap(map, q.w, q.h, q.fit);
      samples.set(skey, S);
      if (samples.size > 32) samples.delete(samples.keys().next().value);
    }
    const data = paintSamples(S, q.theme);
    const res = { id: q.id, w: S.w, h: S.h, data, meta: S.meta };
    if (q.mask) res.mask = landMask(map || getMap(q.desc), q.mask[0], q.mask[1]);
    return res;
  };
}

export function startPreviewWorker() {
  const run = previewEngine();
  self.onmessage = (e) => {
    const q = e.data || {};
    try {
      const res = run(q);
      self.postMessage(res, [res.data.buffer]);
    } catch (err) {
      self.postMessage({ id: q.id, error: String((err && err.message) || err) });
    }
  };
}

export class MapPreviews {
  constructor(url) {
    this.jobs = new Map();
    this.byKey = new Map();
    this.cache = new Map();
    this.queue = [];
    this.busy = false;
    this.seq = 0;
    this.local = null;
    this.worker = null;
    if (url && typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(url);
        this.worker.onmessage = (e) => this.done(e.data);
        this.worker.onerror = (e) => {
          if (e && e.preventDefault) e.preventDefault();
          this.fallback();
        };
      } catch {
        this.worker = null;
      }
    }
  }

  fallback() {
    if (this.worker) {
      try { this.worker.terminate(); } catch { this.worker = null; }
    }
    this.worker = null;
    for (const job of this.jobs.values()) if (!this.queue.includes(job)) this.queue.push(job);
    this.pump();
  }

  get(desc, w, h, theme, opts = {}) {
    const fit = opts.fit || 'contain';
    const key = `${descKey(desc)}|${w}x${h}|${fit}|${theme}${opts.mask ? '|m' : ''}`;
    if (this.cache.has(key)) {
      const v = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, v);
      return Promise.resolve(v);
    }
    if (this.byKey.has(key)) return this.byKey.get(key).promise;
    const id = ++this.seq;
    const job = { id, key, msg: { id, desc, w, h, fit, theme, mask: opts.mask || null } };
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    this.jobs.set(id, job);
    this.byKey.set(key, job);
    if (this.worker) this.worker.postMessage(job.msg);
    else {
      if (opts.priority) this.queue.unshift(job);
      else this.queue.push(job);
      this.pump();
    }
    return job.promise;
  }

  pump() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    setTimeout(() => {
      const job = this.queue.shift();
      if (job) {
        if (!this.local) this.local = previewEngine();
        let res;
        try {
          res = this.local(job.msg);
        } catch (err) {
          res = { id: job.id, error: String((err && err.message) || err) };
        }
        this.done(res);
      }
      this.busy = false;
      this.pump();
    }, 40);
  }

  done(res) {
    const job = res && this.jobs.get(res.id);
    if (!job) return;
    this.jobs.delete(res.id);
    this.byKey.delete(job.key);
    if (res.error) {
      job.reject(new Error(res.error));
      return;
    }
    const v = { w: res.w, h: res.h, data: res.data, meta: res.meta, mask: res.mask || null, canvas: null };
    this.cache.set(job.key, v);
    while (this.cache.size > 48) this.cache.delete(this.cache.keys().next().value);
    job.resolve(v);
  }
}

function previewCanvas(res) {
  if (res.canvas) return res.canvas;
  const c = document.createElement('canvas');
  c.width = res.w;
  c.height = res.h;
  c.getContext('2d').putImageData(new ImageData(res.data, res.w, res.h), 0, 0);
  res.canvas = c;
  return c;
}

const rgb = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

export function drawPreview(canvas, res, theme) {
  const th = THEMES[theme] || THEMES.dark;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = rgb(th.deep);
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const src = previewCanvas(res);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const k = Math.min(canvas.width / res.w, canvas.height / res.h);
  const w = res.w * k, h = res.h * k;
  ctx.drawImage(src, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
}

export function drawPlaceholder(canvas, theme, text) {
  const th = THEMES[theme] || THEMES.dark;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = rgb(th.deep);
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!text) return;
  ctx.fillStyle = theme === 'light' ? 'rgba(255,255,255,0.85)' : 'rgba(220,230,245,0.75)';
  ctx.font = `600 ${Math.round(canvas.height / 14)}px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
}

class MenuBg {
  constructor(app) {
    this.app = app;
    this.cv = $('menu-bg');
    this.res = null;
    this.mask = null;
    this.mw = 300;
    this.mh = 120;
    this.owner = null;
    this.front = [];
    this.layer = null;
    this.t = Math.random() * 100;
    this.growT = 0;
    this.fade = 1;
    this.active = false;
    this.last = 0;
    this.raf = 0;
  }

  load() {
    const theme = this.app.settings.theme;
    this.app.previews.get(BG_DESC, 1200, 480, theme, { mask: this.mask ? null : [this.mw, this.mh] }).then((res) => {
      if (theme !== this.app.settings.theme) return;
      this.res = res;
      if (res.mask && !this.mask) {
        this.mask = res.mask;
        this.reset();
      }
    }).catch(() => {});
  }

  reset() {
    const n = this.mw * this.mh, mask = this.mask;
    this.owner = new Int8Array(n).fill(-1);
    this.front = [];
    const land = [];
    for (let i = 0; i < n; i++) if (mask[i]) land.push(i);
    this.landN = land.length;
    this.claimed = 0;
    const K = 9;
    for (let c = 0; c < K; c++) {
      const f = [];
      for (let t = 0; t < 30; t++) {
        const i = land[(Math.random() * land.length) | 0];
        if (this.owner[i] < 0) {
          this.claim(i, c, f);
          break;
        }
      }
      this.front.push(f);
    }
    this.fade = 0;
    this.colors = PLAYER_COLORS.slice(0, K).map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
    if (!this.layer) {
      this.layer = document.createElement('canvas');
      this.layer.width = this.mw;
      this.layer.height = this.mh;
      this.img = this.layer.getContext('2d').createImageData(this.mw, this.mh);
    }
  }

  claim(i, c, f) {
    if (this.owner[i] < 0) this.claimed++;
    this.owner[i] = c;
    const W = this.mw, x = i % W;
    const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W];
    for (const j of nb) if (j >= 0 && j < this.owner.length && this.mask[j] && this.owner[j] !== c) f.push(j);
  }

  grow() {
    if (!this.owner) return;
    for (let c = 0; c < this.front.length; c++) {
      const f = this.front[c];
      const n = 3 + ((c * 7) % 5);
      for (let k = 0; k < n && f.length; k++) {
        const r = (Math.random() * f.length) | 0;
        const i = f[r];
        f[r] = f[f.length - 1];
        f.pop();
        const o = this.owner[i];
        if (o === c) continue;
        if (o < 0 || Math.random() < 0.06) this.claim(i, c, f);
      }
    }
    if (this.claimed > this.landN * 0.82) this.fade = -1;
  }

  paintLayer() {
    const W = this.mw, H = this.mh, own = this.owner, d = this.img.data;
    for (let i = 0; i < W * H; i++) {
      const o = own[i];
      const p = i * 4;
      if (o < 0) {
        d[p + 3] = 0;
        continue;
      }
      const x = i % W;
      const edge = (x > 0 && own[i - 1] !== o) || (x < W - 1 && own[i + 1] !== o) || (i >= W && own[i - W] !== o) || (i < W * (H - 1) && own[i + W] !== o);
      const c = this.colors[o];
      const k = edge ? 0.62 : 1;
      d[p] = c[0] * k;
      d[p + 1] = c[1] * k;
      d[p + 2] = c[2] * k;
      d[p + 3] = edge ? 235 : 150;
    }
    this.layer.getContext('2d').putImageData(this.img, 0, 0);
  }

  start() {
    if (this.active) return;
    this.active = true;
    if (!this.res) this.load();
    this.last = performance.now();
    const loop = (now) => {
      if (!this.active) return;
      this.frame(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.active = false;
    cancelAnimationFrame(this.raf);
  }

  frame(now) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.t += dt;
    const cv = this.cv;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.floor(cv.clientWidth * dpr)), h = Math.max(1, Math.floor(cv.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    const th = THEMES[this.app.settings.theme] || THEMES.dark;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = rgb(th.deep);
    ctx.fillRect(0, 0, w, h);
    if (!this.res) return;
    this.growT += dt;
    if (this.owner && this.growT > 0.07) {
      this.growT = 0;
      this.grow();
      this.paintLayer();
    }
    if (this.fade < 0) {
      this.fadeOut = (this.fadeOut || 1) - dt * 0.5;
      if (this.fadeOut <= 0) {
        this.fadeOut = 0;
        this.reset();
      }
    } else {
      this.fade = Math.min(1, this.fade + dt * 0.6);
      this.fadeOut = 1;
    }
    const src = previewCanvas(this.res);
    const base = Math.max(w / src.width, h / src.height);
    const z = base * (1.18 + 0.06 * Math.sin(this.t * 0.05));
    const dw = src.width * z, dh = src.height * z;
    const ox = (w - dw) / 2 + Math.sin(this.t * 0.031) * (dw - w) * 0.35;
    const oy = (h - dh) / 2 + Math.cos(this.t * 0.023) * (dh - h) * 0.3;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, ox, oy, dw, dh);
    if (this.layer) {
      ctx.globalAlpha = 0.85 * Math.min(this.fade, this.fadeOut === undefined ? 1 : this.fadeOut);
      ctx.drawImage(this.layer, ox, oy, dw, dh);
      ctx.globalAlpha = 1;
    }
  }

  onTheme() {
    this.res = null;
    this.load();
  }
}

class Setup {
  constructor(app) {
    this.app = app;
    const st = app.settings;
    this.sel = typeof st.map === 'string' && MAPS.some((m) => m.id === st.map) ? 'm:' + st.map : 'm:world';
    this.seed = randomSeed();
    this.token = 0;
    this.meta = null;
    this.bind();
  }

  entries() {
    const out = MAPS.map((m) => ({
      key: 'm:' + m.id, id: m.id, name: m.name, desc: m.desc, w: m.w, h: m.h, max: Math.min(12, m.maxPlayers || 12), custom: false,
      mapDesc: (seed) => ({ id: m.id, seed: seed >>> 0 }),
      thumbSeed: m.id === 'world' ? BG_DESC.seed : THUMB_SEED,
    }));
    this.app.customMaps.forEach((d, i) => {
      const s = customScale(d);
      out.push({
        key: 'c:' + i, id: 'custom', name: d.name, desc: d.builtin ? 'Встроенная пользовательская карта.' : 'Карта из файла JSON.',
        w: d.rows[0].length * s, h: d.rows.length * s, max: 12, custom: true, index: i,
        mapDesc: (seed) => ({ id: 'custom', name: d.name, rows: d.rows, ...(d.scale ? { scale: d.scale } : {}), seed: seed >>> 0 }),
        thumbSeed: 0,
      });
    });
    return out;
  }

  current() {
    const list = this.entries();
    return list.find((e) => e.key === this.sel) || list[0];
  }

  bind() {
    const st = this.app.settings;
    $('map-grid').onclick = (e) => {
      const c = e.target.closest('.map-card');
      if (!c) return;
      play('click');
      this.select(c.dataset.key);
    };
    $('custom-map-file').onchange = (e) => this.importFile(e.target.files && e.target.files[0]);
    $('sp-name').onchange = (e) => {
      st.name = cleanName(e.target.value, 'Командир');
      e.target.value = st.name;
      this.app.saveSettings();
    };
    $('sp-color').onclick = (e) => {
      const b = e.target.closest('.swatch');
      if (!b || b.disabled) return;
      st.color = b.dataset.color;
      this.app.saveSettings();
      this.renderSwatches();
      play('click');
    };
    $('sp-bots').oninput = (e) => {
      setRangeFill(e.target);
      $('sp-bots-v').textContent = e.target.value;
      st.bots = Number(e.target.value);
      this.app.saveSettingsSoon();
    };
    $('sp-diff').onchange = () => {
      st.difficulty = this.diff();
      this.app.saveSettings();
      play('click');
    };
    const vic = () => {
      st.victory = {
        territory: $('sp-vic-territory').checked,
        territoryPct: Number($('sp-vic-pct').value),
        economy: $('sp-vic-economy').checked,
        economyMinutes: Number($('sp-vic-min').value),
      };
      this.syncVictory();
      this.app.saveSettingsSoon();
    };
    for (const id of ['sp-vic-territory', 'sp-vic-economy']) $(id).onchange = () => { vic(); play('toggle'); };
    for (const id of ['sp-vic-pct', 'sp-vic-min']) $(id).oninput = vic;
    $('sp-seed').onchange = (e) => {
      const v = Math.floor(Math.abs(Number(e.target.value) || 0)) >>> 0;
      this.seed = v;
      e.target.value = v;
      this.updatePreview();
    };
    $('sp-reseed').onclick = () => {
      this.seed = randomSeed();
      $('sp-seed').value = this.seed;
      play('click');
      this.updatePreview();
    };
    $('sp-start').onclick = () => this.start();
  }

  diff() {
    const r = document.querySelector('#sp-diff input:checked');
    return r ? r.value : 'normal';
  }

  onShow() {
    const st = this.app.settings;
    $('sp-name').value = st.name;
    const d = document.querySelector(`#sp-diff input[value="${st.difficulty}"]`);
    if (d) d.checked = true;
    const v = st.victory;
    $('sp-vic-territory').checked = !!v.territory;
    $('sp-vic-pct').value = v.territoryPct;
    $('sp-vic-economy').checked = !!v.economy;
    $('sp-vic-min').value = v.economyMinutes;
    this.syncVictory();
    $('sp-seed').value = this.seed;
    $('sp-bots').value = st.bots;
    this.renderSwatches();
    this.renderGrid();
    this.select(this.sel, true);
  }

  syncVictory() {
    for (const id of ['sp-vic-pct', 'sp-vic-min', 'sp-bots']) setRangeFill($(id));
    $('sp-vic-pct-v').textContent = $('sp-vic-pct').value + '%';
    $('sp-vic-min-v').textContent = $('sp-vic-min').value + ' мин';
  }

  renderSwatches() {
    const box = $('sp-color'), st = this.app.settings;
    if (!PLAYER_COLORS.includes(st.color)) st.color = PLAYER_COLORS[0];
    if (box.children.length !== PLAYER_COLORS.length) {
      box.innerHTML = '';
      for (const c of PLAYER_COLORS) {
        const b = tpl('tpl-swatch');
        b.style.background = c;
        b.dataset.color = c;
        b.title = c;
        box.appendChild(b);
      }
    }
    for (const b of box.children) b.classList.toggle('on', b.dataset.color === st.color);
  }

  renderGrid() {
    const grid = $('map-grid');
    grid.innerHTML = '';
    const theme = this.app.settings.theme;
    for (const e of this.entries()) {
      const card = tpl('tpl-map-card');
      card.dataset.key = e.key;
      if (e.custom) card.dataset.cmap = e.index;
      else card.dataset.map = e.id;
      card.querySelector('.map-card-name').textContent = e.name;
      card.querySelector('.map-card-meta').textContent = `${e.w}×${e.h} · до ${e.max} игроков`;
      card.querySelector('.map-badge').textContent = e.custom ? 'СВОЯ' : '';
      card.title = e.desc;
      grid.appendChild(card);
      const cv = card.querySelector('canvas');
      drawPlaceholder(cv, theme, '');
      this.app.previews.get(e.mapDesc(e.thumbSeed), cv.width, cv.height, theme, { fit: 'cover' })
        .then((res) => { if (cv.isConnected) drawPreview(cv, res, theme); })
        .catch(() => drawPlaceholder(cv, theme, 'Ошибка карты'));
    }
    this.markSelected();
  }

  markSelected() {
    for (const c of $('map-grid').children) c.classList.toggle('on', c.dataset.key === this.sel);
  }

  select(key, force = false) {
    if (key === this.sel && !force) return;
    if (!this.entries().some((e) => e.key === key)) key = 'm:world';
    this.sel = key;
    const e = this.current();
    if (!e.custom) {
      this.app.settings.map = e.id;
      this.app.saveSettings();
    }
    const bots = $('sp-bots');
    bots.max = Math.max(1, Math.min(11, e.max - 1));
    if (Number(bots.value) > Number(bots.max)) bots.value = bots.max;
    $('sp-bots-v').textContent = bots.value;
    setRangeFill(bots);
    this.markSelected();
    this.updatePreview();
  }

  chips(e, meta) {
    const W = meta ? meta.W : e.w, H = meta ? meta.H : e.h;
    const out = [`<span class="badge accent">${W}×${H} клеток</span>`, `<span class="badge">до ${e.max} игроков</span>`];
    if (meta) out.push(`<span class="badge">суша ${fmtPct(meta.land, 0)}</span>`);
    if (e.custom) out.push('<span class="badge blue">своя карта</span>');
    else if (e.id !== 'world') out.push(`<span class="badge">seed ${this.seed}</span>`);
    return out.join('');
  }

  updatePreview() {
    const e = this.current();
    const theme = this.app.settings.theme;
    $('map-name').textContent = e.name;
    $('map-desc').textContent = e.desc;
    $('map-meta').innerHTML = this.chips(e, null);
    const cv = $('map-preview');
    const token = ++this.token;
    drawPlaceholder(cv, theme, 'Генерация карты…');
    this.app.previews.get(e.mapDesc(this.seed), cv.width, cv.height, theme, { priority: true }).then((res) => {
      if (token !== this.token) return;
      drawPreview(cv, res, theme);
      $('map-meta').innerHTML = this.chips(e, res.meta);
    }).catch((err) => {
      if (token === this.token) drawPlaceholder(cv, theme, 'Не удалось построить карту: ' + err.message);
    });
  }

  async importFile(file) {
    if (!file) return;
    try {
      const desc = parseCustomMap(await file.text());
      this.app.addCustomMap(desc, true);
      this.renderGrid();
      const k = this.app.customMaps.findIndex((m) => m.name === desc.name);
      this.select('c:' + k, true);
      play('build');
    } catch (err) {
      this.app.showMessage('Ошибка карты', err.message);
    }
    $('custom-map-file').value = '';
  }

  onTheme() {
    if (this.app.screen === 'setup') {
      this.renderGrid();
      this.updatePreview();
    }
  }

  start() {
    play('click');
    const st = this.app.settings;
    const e = this.current();
    const name = cleanName($('sp-name').value || st.name, 'Командир');
    st.name = name;
    const diff = this.diff();
    const bots = Math.max(1, Math.min(Number($('sp-bots').max) || 11, Number($('sp-bots').value) || 1));
    const players = [{ name, color: st.color, ai: null }];
    const used = new Set([st.color]);
    const free = PLAYER_COLORS.filter((c) => !used.has(c));
    const off = Math.floor(Math.random() * BOT_NAMES.length);
    for (let i = 0; i < bots; i++) {
      players.push({
        name: BOT_NAMES[(off + i) % BOT_NAMES.length],
        color: free[i % free.length],
        ai: diff === 'mixed' ? DIFF_ORDER[i % 3] : diff,
      });
    }
    const v = st.victory;
    const settings = {
      victory: { territory: !!v.territory, territoryPct: v.territoryPct, economy: !!v.economy, economyMinutes: v.economyMinutes },
      spawnSeconds: 15,
      difficulty: DIFFICULTY[diff] ? diff : 'normal',
    };
    this.app.saveSettings();
    const seed = this.seed;
    this.app.startSingle({ desc: e.mapDesc(seed), seed, players, settings });
    this.seed = randomSeed();
  }
}

class Multiplayer {
  constructor(app) {
    this.app = app;
    this.busy = false;
    this.steamOk = false;
    this.bind();
  }

  bind() {
    const st = this.app.settings;
    $('mp-name').onchange = (e) => {
      st.name = cleanName(e.target.value, 'Командир');
      e.target.value = st.name;
      this.app.saveSettings();
    };
    $('steam-host').onclick = () => this.hostSteam();
    $('steam-join').onclick = () => this.joinSteam($('steam-lobby-id').value.trim());
    $('steam-lobby-id').onkeydown = (e) => { if (e.key === 'Enter') this.joinSteam(e.target.value.trim()); };
    $('steam-refresh').onclick = () => this.refreshLobbies();
    $('steam-lobbies').onclick = (e) => {
      const b = e.target.closest('[data-lobby]');
      if (b) this.joinSteam(b.dataset.lobby);
    };
    $('lan-host').onclick = () => this.hostLan();
    $('lan-join').onclick = () => this.joinLan();
    $('lan-addr').onkeydown = (e) => { if (e.key === 'Enter') this.joinLan(); };
    $('lan-port').onchange = (e) => {
      st.lanPort = Math.min(65535, Math.max(1024, Number(e.target.value) || DEFAULT_PORT));
      e.target.value = st.lanPort;
      this.app.saveSettings();
    };
    $('lan-addr').onchange = (e) => {
      st.lanAddr = e.target.value.trim();
      this.app.saveSettings();
    };
  }

  onShow() {
    const st = this.app.settings;
    $('mp-name').value = st.name;
    $('lan-port').value = st.lanPort || DEFAULT_PORT;
    $('lan-addr').value = st.lanAddr || '';
    $('lan-host').disabled = !hasNative();
    $('lan-host').title = hasNative() ? '' : 'Сервер можно создать только в версии для ПК';
    this.checkSteam();
  }

  name() {
    const v = cleanName($('mp-name').value || this.app.settings.name, 'Командир');
    this.app.settings.name = v;
    return v;
  }

  setSteam(ok, text) {
    const st = $('steam-status');
    st.dataset.state = ok === null ? 'wait' : ok ? 'ok' : 'off';
    st.textContent = text;
    st.title = text;
    for (const id of ['steam-host', 'steam-join', 'steam-refresh']) $(id).disabled = !ok;
  }

  async checkSteam() {
    this.setSteam(null, 'Проверка Steam…');
    let r;
    try {
      r = await SteamTransport.init();
    } catch (e) {
      r = { ok: false, error: e.message };
    }
    this.steamOk = !!(r && r.ok);
    this.setSteam(this.steamOk, this.steamOk ? `Steam: ${r.name || 'подключён'}` : (r && r.error) || 'Steam недоступен');
    if (this.steamOk) this.refreshLobbies();
    else $('steam-lobbies').innerHTML = `<li class="empty">${hasNative() ? 'Запустите Steam, чтобы увидеть открытые лобби' : 'Steam доступен только в версии для ПК'}</li>`;
  }

  async refreshLobbies() {
    const ul = $('steam-lobbies');
    if (!this.steamOk) return;
    ul.innerHTML = '<li class="empty">Поиск лобби…</li>';
    try {
      const list = await SteamTransport.list();
      ul.innerHTML = '';
      if (!list.length) {
        ul.innerHTML = '<li class="empty">Открытых лобби нет</li>';
        return;
      }
      for (const l of list) {
        const li = tpl('tpl-steam-lobby');
        li.querySelector('.lobby-name').textContent = l.name;
        li.querySelector('.tag').textContent = `${l.members} / ${l.max}`;
        const b = li.querySelector('.btn');
        b.dataset.lobby = l.id;
        b.disabled = l.members >= l.max;
        ul.appendChild(li);
      }
    } catch (e) {
      ul.innerHTML = `<li class="empty">${esc(e.message)}</li>`;
    }
  }

  async run(fn, title) {
    if (this.busy) return;
    this.busy = true;
    play('click');
    try {
      await fn();
    } catch (e) {
      this.app.hideLoading();
      this.app.showMessage(title, (e && e.message) || String(e));
    } finally {
      this.busy = false;
    }
  }

  lobbyOpts() {
    const st = this.app.settings;
    return { color: st.color, settings: { map: st.map || 'world', victory: { ...st.victory }, difficulty: st.difficulty === 'mixed' ? 'normal' : st.difficulty } };
  }

  hostSteam() {
    return this.run(async () => {
      const name = this.name();
      this.app.saveSettings();
      const t = await SteamTransport.host(12, name);
      this.app.lobbyView.open(new HostLobby(t, name, this.lobbyOpts()), true);
    }, 'Steam');
  }

  joinSteam(id) {
    if (!id) {
      this.app.showMessage('Steam', 'Введите ID лобби');
      return null;
    }
    if (this.app.session) {
      this.app.showMessage('Steam', 'Сначала завершите текущую партию');
      return null;
    }
    return this.run(async () => {
      const init = await SteamTransport.init();
      if (!init.ok) throw new Error(init.error || 'Steam недоступен');
      if (this.app.lobbyView.lobby) this.app.lobbyView.leave(false);
      const t = await SteamTransport.join(String(id));
      this.app.lobbyView.open(new ClientLobby(t, this.name(), { color: this.app.settings.color }), false);
    }, 'Steam');
  }

  hostLan() {
    return this.run(async () => {
      const name = this.name();
      this.app.saveSettings();
      const t = await LanHostTransport.host(Number($('lan-port').value) || DEFAULT_PORT);
      this.app.lobbyView.open(new HostLobby(t, name, this.lobbyOpts()), true);
    }, 'Сеть');
  }

  joinLan() {
    return this.run(async () => {
      const addr = $('lan-addr').value.trim();
      this.app.settings.lanAddr = addr;
      this.app.saveSettings();
      const t = await LanClientTransport.connect(addr);
      this.lanAddr = addr;
      this.app.lobbyView.open(new ClientLobby(t, this.name(), { color: this.app.settings.color }), false);
    }, 'Сеть');
  }
}

class LobbyView {
  constructor(app) {
    this.app = app;
    this.lobby = null;
    this.isHost = false;
    this.view = null;
    this.previewKey = '';
    this.token = 0;
    this.bind();
  }

  bind() {
    $('lobby-leave').onclick = () => { play('click'); this.leave(true); };
    $('lobby-start').onclick = () => this.start();
    $('lobby-add-ai').onclick = () => {
      if (!this.isHost || !this.lobby) return;
      if (this.lobby.addAI($('lobby-ai-diff').value) < 0) this.app.showMessage('Лобби', 'Лобби заполнено');
      else play('click');
    };
    $('lobby-slots').onclick = (e) => this.onSlotClick(e);
    $('lobby-map').onchange = (e) => {
      if (!this.isHost) return;
      const v = e.target.value;
      try {
        if (v.startsWith('custom:')) this.lobby.set({ custom: this.app.customMaps[Number(v.slice(7))] });
        else this.lobby.set({ map: v, custom: null });
      } catch (err) {
        this.app.showMessage('Ошибка карты', err.message);
      }
    };
    $('lobby-seed').onchange = (e) => this.isHost && this.lobby.set({ seed: Number(e.target.value) || 0 });
    $('lobby-reseed').onclick = () => {
      if (!this.isHost) return;
      play('click');
      this.lobby.set({ seed: randomSeed() });
    };
    const vic = () => {
      if (!this.isHost) return;
      for (const id of ['lobby-vic-pct', 'lobby-vic-min']) setRangeFill($(id));
      $('lobby-vic-pct-v').textContent = $('lobby-vic-pct').value + '%';
      $('lobby-vic-min-v').textContent = $('lobby-vic-min').value + ' мин';
      this.lobby.set({
        victory: {
          territory: $('lobby-vic-territory').checked,
          territoryPct: Number($('lobby-vic-pct').value),
          economy: $('lobby-vic-economy').checked,
          economyMinutes: Number($('lobby-vic-min').value),
        },
      });
    };
    for (const id of ['lobby-vic-territory', 'lobby-vic-economy']) $(id).onchange = vic;
    for (const id of ['lobby-vic-pct', 'lobby-vic-min']) $(id).oninput = vic;
    $('lobby-copy').onclick = () => this.copy();
    $('lobby-invite').onclick = () => {
      const t = this.lobby && this.lobby.transport;
      if (t && t.invite) t.invite();
    };
  }

  open(lobby, isHost) {
    this.lobby = lobby;
    this.isHost = isHost;
    this.view = null;
    this.previewKey = '';
    const t = lobby.transport;
    this.app.show('lobby');
    document.querySelectorAll('#screen-lobby .host-only').forEach((el) => { el.hidden = !isHost; });
    $('lobby-wait').hidden = isHost;
    $('lobby-kind').textContent = t.kind === 'steam' ? 'Steam' : 'LAN';
    $('lobby-invite').hidden = t.kind !== 'steam';
    $('lobby-copy').hidden = t.kind !== 'steam' && !isHost;
    $('lobby-copy').lastChild.textContent = t.kind === 'steam' ? 'Копировать ID' : 'Копировать адрес';
    let info;
    if (t.kind === 'steam') info = `ID лобби: <b>${esc(t.lobbyId)}</b>`;
    else if (isHost) info = `Адрес для подключения:<br>${(t.ips || []).map((ip) => `<b>${esc(ip)}:${t.port}</b>`).join('<br>') || `<b>localhost:${t.port}</b>`}`;
    else info = `Подключено к хосту <b>${esc(this.app.multiplayer.lanAddr || '')}</b>`;
    $('lobby-connect').innerHTML = info;
    $('lobby-hint').textContent = t.kind === 'steam'
      ? 'Друзья могут войти по приглашению Steam, по ID лобби или найти его в списке открытых лобби.'
      : isHost ? 'Игроки в той же сети (или через Radmin VPN, Hamachi, проброс порта) подключаются по этому адресу.' : 'Ожидайте, пока хост настроит партию и начнёт игру.';
    $('lobby-slots').innerHTML = '';
    $('lobby-info').innerHTML = isHost ? '' : 'Подключение к хосту…';
    drawPlaceholder($('lobby-preview'), this.app.settings.theme, isHost ? 'Генерация карты…' : 'Ожидание данных…');
    if (isHost) {
      const sel = $('lobby-map');
      sel.innerHTML = MAPS.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')
        + this.app.customMaps.map((m, i) => `<option value="custom:${i}">${esc(m.name)} (своя)</option>`).join('');
      lobby.onChange = (v) => this.render(v);
      lobby.onChat = () => {};
      lobby.sync();
    } else {
      lobby.onChange = (v) => this.render(v);
      lobby.onStart = (session) => {
        this.lobby = null;
        this.app.enterGame(session);
      };
      lobby.onClosed = (reason) => {
        this.lobby = null;
        this.app.hideLoading();
        if (this.app.screen === 'lobby') this.app.show('mp');
        this.app.showMessage('Лобби', reason);
      };
      lobby.onError = (msg) => this.app.showMessage('Лобби', msg);
      lobby.onCustom = () => this.updatePreview(true);
      this.holdStart(lobby);
    }
  }

  holdStart(lobby) {
    const t = lobby.transport;
    const orig = t.onMessage;
    let held = null;
    t.onMessage = (peer, msg) => {
      if (held) {
        held.push([peer, msg]);
        return;
      }
      if (msg && msg.t === 'start') {
        held = [];
        this.app.showLoading('Загрузка карты…').then(() => {
          const q = held;
          held = null;
          orig(peer, msg);
          for (const [p, m] of q) t.onMessage(p, m);
          if (!this.app.session) this.app.hideLoading();
        });
        return;
      }
      orig(peer, msg);
    };
  }

  goalsText(s) {
    const v = s.victory, out = [];
    if (v.territory) out.push(`территория ${v.territoryPct}%`);
    if (v.economy) out.push(`экономика ${v.economyMinutes} мин`);
    out.push('последний выживший');
    return out.join(', ');
  }

  render(v) {
    if (!v || !this.lobby) return;
    this.view = v;
    const ul = $('lobby-slots');
    while (ul.children.length < v.slots.length) ul.appendChild(tpl('tpl-lobby-slot'));
    while (ul.children.length > v.slots.length) ul.lastElementChild.remove();
    v.slots.forEach((sl, i) => {
      const li = ul.children[i];
      li.classList.toggle('me', i === v.you);
      const dot = li.querySelector('.dot');
      dot.style.background = safeColor(sl.color);
      const canColor = i === v.you || (this.isHost && sl.ai);
      dot.dataset.color = canColor ? i : '';
      dot.title = canColor ? 'Сменить цвет' : '';
      dot.style.cursor = canColor ? 'pointer' : '';
      li.querySelector('.slot-name').textContent = sl.name + (i === v.you ? ' (вы)' : '');
      const tag = li.querySelector('.tag');
      tag.className = 'tag' + (sl.host ? ' host' : sl.ai ? ' bot' : '');
      tag.textContent = sl.host ? 'Хост' : sl.ai ? `Бот · ${DIFF_NAMES[sl.ai] || sl.ai}` : '';
      tag.dataset.ai = this.isHost && sl.ai ? i : '';
      tag.title = this.isHost && sl.ai ? 'Сменить сложность' : '';
      tag.style.cursor = this.isHost && sl.ai ? 'pointer' : '';
      const kick = li.querySelector('.slot-kick');
      kick.hidden = !this.isHost || i === 0;
      kick.dataset.kick = i;
    });
    $('lobby-count').textContent = `${v.slots.length} / ${v.maxPlayers}`;
    const s = v.settings;
    if (this.isHost) {
      const active = document.activeElement;
      const sel = $('lobby-map');
      const val = s.custom ? 'custom:' + this.app.customMaps.findIndex((m) => m.name === s.custom.name) : s.map;
      if (active !== sel && [...sel.options].some((o) => o.value === val)) sel.value = val;
      if (active !== $('lobby-seed')) $('lobby-seed').value = s.seed;
      $('lobby-vic-territory').checked = s.victory.territory;
      $('lobby-vic-economy').checked = s.victory.economy;
      if (active !== $('lobby-vic-pct')) $('lobby-vic-pct').value = s.victory.territoryPct;
      if (active !== $('lobby-vic-min')) $('lobby-vic-min').value = s.victory.economyMinutes;
      for (const id of ['lobby-vic-pct', 'lobby-vic-min']) setRangeFill($(id));
      $('lobby-vic-pct-v').textContent = s.victory.territoryPct + '%';
      $('lobby-vic-min-v').textContent = s.victory.economyMinutes + ' мин';
      const st = $('lobby-start');
      st.disabled = !!v.canStart;
      st.title = v.canStart || '';
      $('lobby-add-ai').disabled = v.slots.length >= v.maxPlayers;
      $('lobby-info').innerHTML = '';
    } else {
      $('lobby-info').innerHTML = `Карта: <b>${esc(s.mapName)}</b>${s.custom ? ` (${s.custom.w}×${s.custom.h})` : ''} · seed <b>${s.seed}</b><br>`
        + `Цели победы: <b>${esc(this.goalsText(s))}</b><br>Игроков: <b>${v.slots.length}</b> из ${v.maxPlayers}`;
    }
    this.updatePreview(false);
  }

  previewDesc() {
    const v = this.view;
    if (!v) return null;
    const s = v.settings;
    if (this.isHost) return this.lobby.mapDesc();
    if (s.custom) {
      const d = this.lobby.customDesc;
      return d ? { ...d, seed: s.seed } : null;
    }
    return { id: s.map, seed: s.seed };
  }

  updatePreview(force) {
    const desc = this.previewDesc();
    const theme = this.app.settings.theme;
    const key = desc ? descKey(desc) + '|' + theme : 'none';
    if (key === this.previewKey && !force) return;
    this.previewKey = key;
    const cv = $('lobby-preview');
    if (!desc) {
      drawPlaceholder(cv, theme, 'Загрузка карты от хоста…');
      return;
    }
    const token = ++this.token;
    drawPlaceholder(cv, theme, 'Генерация карты…');
    this.app.previews.get(desc, cv.width, cv.height, theme, { priority: true }).then((res) => {
      if (token === this.token) drawPreview(cv, res, theme);
    }).catch(() => {
      if (token === this.token) drawPlaceholder(cv, theme, 'Ошибка карты');
    });
  }

  nextColor(cur) {
    const used = new Set((this.view ? this.view.slots : []).map((s) => s.color.toLowerCase()));
    const k = PLAYER_COLORS.findIndex((c) => c.toLowerCase() === String(cur).toLowerCase());
    for (let d = 1; d <= PLAYER_COLORS.length; d++) {
      const c = PLAYER_COLORS[(k + d + PLAYER_COLORS.length) % PLAYER_COLORS.length];
      if (!used.has(c.toLowerCase())) return c;
    }
    return null;
  }

  onSlotClick(e) {
    const lb = this.lobby, v = this.view;
    if (!lb || !v) return;
    const kick = e.target.closest('[data-kick]');
    if (kick && this.isHost) {
      lb.remove(Number(kick.dataset.kick));
      play('click');
      return;
    }
    const dot = e.target.closest('.dot');
    if (dot && dot.dataset.color !== '' && dot.dataset.color !== undefined) {
      const i = Number(dot.dataset.color);
      const c = this.nextColor(v.slots[i].color);
      if (!c) return;
      if (this.isHost) lb.setColor(i, c);
      else lb.setColor(c);
      if (i === v.you) {
        this.app.settings.color = c;
        this.app.saveSettings();
      }
      play('click');
      return;
    }
    const tag = e.target.closest('.tag');
    if (tag && this.isHost && tag.dataset.ai !== '') {
      const i = Number(tag.dataset.ai);
      const cur = v.slots[i].ai;
      lb.setAI(i, DIFF_ORDER[(DIFF_ORDER.indexOf(cur) + 1) % 3]);
      play('click');
    }
  }

  copy() {
    const t = this.lobby && this.lobby.transport;
    if (!t) return;
    const text = t.kind === 'steam' ? String(t.lobbyId) : (t.ips || []).map((ip) => `${ip}:${t.port}`)[0] || '';
    if (!text) return;
    const btn = $('lobby-copy');
    const label = btn.lastChild;
    const prev = label.textContent;
    const ok = () => {
      label.textContent = 'Скопировано!';
      setTimeout(() => { label.textContent = prev; }, 1500);
    };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); ok(); } catch { this.app.showMessage('Копирование', text); }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fallback);
    else fallback();
    play('click');
  }

  async start() {
    const lb = this.lobby;
    if (!this.isHost || !lb) return;
    const err = lb.canStart();
    if (err) {
      this.app.showMessage('Лобби', err);
      return;
    }
    play('click');
    await this.app.showLoading('Генерация карты…');
    try {
      const map = this.app.getMap(lb.mapDesc());
      const session = lb.start({ map });
      this.lobby = null;
      this.app.enterGame(session);
    } catch (e) {
      this.app.hideLoading();
      this.app.showMessage('Не удалось начать игру', e.message);
    }
  }

  leave(toMp = true) {
    if (this.lobby) this.lobby.close();
    this.lobby = null;
    this.view = null;
    if (toMp) this.app.show('mp');
  }

  onTheme() {
    if (this.app.screen === 'lobby') this.updatePreview(true);
  }
}

export class Menus {
  constructor(app) {
    this.app = app;
    this.bg = new MenuBg(app);
    this.setup = new Setup(app);
    this.mp = new Multiplayer(app);
    this.lobby = new LobbyView(app);
  }

  onShow(id) {
    if (id === 'menu') this.bg.start();
    else this.bg.stop();
    if (id === 'setup') this.setup.onShow();
    if (id === 'mp') this.mp.onShow();
  }

  onTheme() {
    this.bg.onTheme();
    this.setup.onTheme();
    this.lobby.onTheme();
  }

  warmup() {
    const theme = this.app.settings.theme;
    const list = this.setup.entries();
    let k = 0;
    const next = () => {
      if (k >= list.length || this.app.session) return;
      const e = list[k++];
      this.app.previews.get(e.mapDesc(e.thumbSeed), 240, 120, theme, { fit: 'cover' }).then(next, next);
    };
    next();
  }
}

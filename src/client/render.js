import { THEMES, hexToRgb, mix, shade, rgba, rgbStr, playerTones } from './theme.js';
import { markerCanvas, unitCanvas } from './icons.js';
import { SAM, STRIKES, WARHEAD, ECON, cruiseRange, siloReload, airbaseReload } from '../core/config.js';
import { nearestCoastTile } from '../core/nav.js';
import { boatPlan } from '../core/units.js';

const CH = 256;
const BLK = 32;
const BPR = CH / BLK;
const NBLK = BPR * BPR;
const LEVELS = [2, 4, 8, 16, 32];
const CHUNK_Z = 1.7;
const MAX_CHUNKS = 96;
const TB = 64;
const GRAIN = 512;
const TAU = Math.PI * 2;
const FONT = 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif';
const NUKES = { atom: true, hbomb: true, mega: true, warhead: true };
const TEX_AMP = [0, 0, 14, 30, 16, 22, 30, 10];
const UNIT_LEN = { warship: 3.8, transport: 3, trade: 3.4, train: 3.4, truck: 1.7 };
const UNIT_MIN = { warship: 19, transport: 15, trade: 16, train: 15, truck: 10 };
const UNIT_MAX = { warship: 84, transport: 64, trade: 74, train: 76, truck: 40 };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const easeOut = (t) => 1 - (1 - clamp(t, 0, 1)) * (1 - clamp(t, 0, 1));
const wrapPi = (a) => {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
};
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function fmtNum(n) {
  n = Math.floor(Number(n) || 0);
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e4) return Math.round(n / 1e3) + 'K';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function hash(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
}

function pnoise(x, y, per, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const x0 = ((xi % per) + per) % per, y0 = ((yi % per) + per) % per;
  const x1 = (x0 + 1) % per, y1 = (y0 + 1) % per;
  const a = hash(x0, y0, s), b = hash(x1, y0, s), c = hash(x0, y1, s), d = hash(x1, y1, s);
  return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
}

function tileNoise(size, cell, oct, s, white) {
  const out = new Int8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0, amp = 0.5, tot = 0, c = cell;
      for (let k = 0; k < oct; k++) {
        v += pnoise(x / c, y / c, size / c, s + k * 13) * amp;
        tot += amp;
        amp *= 0.5;
        c /= 2;
      }
      const a = (v / tot) * (1 - white) + hash(x, y, s + 99) * white;
      out[y * size + x] = Math.round((a - 0.5) * 2 * 127);
    }
  }
  return out;
}

function fbm(x, y, s, oct) {
  let v = 0, amp = 0.5, f = 1, tot = 0;
  for (let k = 0; k < oct; k++) {
    v += valueNoise(x * f, y * f, s + k * 17) * amp;
    tot += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return v / tot;
}

function chamfer(W, H, src, cap) {
  const N = W * H;
  const d = new Float32Array(N);
  for (let i = 0; i < N; i++) d[i] = src[i] ? 0 : cap;
  const D = 1.41421356;
  for (let y = 0; y < H; y++) {
    const r = y * W;
    for (let x = 0; x < W; x++) {
      const i = r + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0 && d[i - 1] + 1 < v) v = d[i - 1] + 1;
      if (y > 0) {
        if (d[i - W] + 1 < v) v = d[i - W] + 1;
        if (x > 0 && d[i - W - 1] + D < v) v = d[i - W - 1] + D;
        if (x < W - 1 && d[i - W + 1] + D < v) v = d[i - W + 1] + D;
      }
      d[i] = v;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    const r = y * W;
    for (let x = W - 1; x >= 0; x--) {
      const i = r + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < W - 1 && d[i + 1] + 1 < v) v = d[i + 1] + 1;
      if (y < H - 1) {
        if (d[i + W] + 1 < v) v = d[i + W] + 1;
        if (x < W - 1 && d[i + W + 1] + D < v) v = d[i + W + 1] + D;
        if (x > 0 && d[i + W - 1] + D < v) v = d[i + W - 1] + D;
      }
      d[i] = v;
    }
  }
  return d;
}

function noiseField(W, H, scale, seed, oct, step) {
  const gw = Math.ceil(W / step) + 2, gh = Math.ceil(H / step) + 2;
  const g = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) g[y * gw + x] = fbm((x * step) / scale, (y * step) / scale, seed, oct) * 2 - 1;
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const v = y / step, y0 = Math.floor(v), fy = v - y0;
    for (let x = 0; x < W; x++) {
      const u = x / step, x0 = Math.floor(u), fx = u - x0;
      const i = y0 * gw + x0;
      const a = g[i] + (g[i + 1] - g[i]) * fx;
      const b = g[i + gw] + (g[i + gw + 1] - g[i + gw]) * fx;
      out[y * W + x] = a + (b - a) * fy;
    }
  }
  return out;
}

function blur3(src, W, H) {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const r = y * W;
    for (let x = 0; x < W; x++) {
      const a = x > 0 ? src[r + x - 1] : src[r + x], b = x < W - 1 ? src[r + x + 1] : src[r + x];
      tmp[r + x] = (a + src[r + x] * 2 + b) * 0.25;
    }
  }
  for (let y = 0; y < H; y++) {
    const r = y * W;
    for (let x = 0; x < W; x++) {
      const a = y > 0 ? tmp[r + x - W] : tmp[r + x], b = y < H - 1 ? tmp[r + x + W] : tmp[r + x];
      out[r + x] = (a + tmp[r + x] * 2 + b) * 0.25;
    }
  }
  return out;
}

function clipLine(ax, ay, bx, by, x0, y0, x1, y1) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const p = [-dx, dx, -dy, dy], q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
  for (let k = 0; k < 4; k++) {
    if (p[k] === 0) {
      if (q[k] < 0) return null;
    } else {
      const r = q[k] / p[k];
      if (p[k] < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return [t0, t1];
}

function blurMasked3(R, G, B, mask, W, H) {
  const N = W * H;
  const tr = new Float32Array(N), tg = new Float32Array(N), tb = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    const r0 = y * W;
    for (let x = 0; x < W; x++) {
      const i = r0 + x;
      if (!mask[i]) continue;
      let a = R[i] * 2, b = G[i] * 2, c = B[i] * 2, n = 2;
      if (x > 0 && mask[i - 1]) { a += R[i - 1]; b += G[i - 1]; c += B[i - 1]; n++; }
      if (x < W - 1 && mask[i + 1]) { a += R[i + 1]; b += G[i + 1]; c += B[i + 1]; n++; }
      const k = 1 / n;
      tr[i] = a * k; tg[i] = b * k; tb[i] = c * k;
    }
  }
  for (let y = 0; y < H; y++) {
    const r0 = y * W;
    for (let x = 0; x < W; x++) {
      const i = r0 + x;
      if (!mask[i]) continue;
      let a = tr[i] * 2, b = tg[i] * 2, c = tb[i] * 2, n = 2;
      if (y > 0 && mask[i - W]) { a += tr[i - W]; b += tg[i - W]; c += tb[i - W]; n++; }
      if (y < H - 1 && mask[i + W]) { a += tr[i + W]; b += tg[i + W]; c += tb[i + W]; n++; }
      const k = 1 / n;
      R[i] = a * k; G[i] = b * k; B[i] = c * k;
    }
  }
}

let T2A = 0, T2B = 0;
const MIX = new Float32Array(3);

function top2(q0, w0, q1, w1, q2, w2, q3, w3) {
  const s0 = q0 ? w0 + (q1 === q0 ? w1 : 0) + (q2 === q0 ? w2 : 0) + (q3 === q0 ? w3 : 0) : -1;
  const s1 = q1 && q1 !== q0 ? w1 + (q2 === q1 ? w2 : 0) + (q3 === q1 ? w3 : 0) : -1;
  const s2 = q2 && q2 !== q0 && q2 !== q1 ? w2 + (q3 === q2 ? w3 : 0) : -1;
  const s3 = q3 && q3 !== q0 && q3 !== q1 && q3 !== q2 ? w3 : -1;
  let a = 0, sa = 0, b = 0, sb = 0;
  if (s0 > sa) { b = a; sb = sa; a = q0; sa = s0; } else if (s0 > sb) { b = q0; sb = s0; }
  if (s1 > sa) { b = a; sb = sa; a = q1; sa = s1; } else if (s1 > sb) { b = q1; sb = s1; }
  if (s2 > sa) { b = a; sb = sa; a = q2; sa = s2; } else if (s2 > sb) { b = q2; sb = s2; }
  if (s3 > sa) { b = a; sb = sa; a = q3; sa = s3; } else if (s3 > sb) { b = q3; sb = s3; }
  T2A = a;
  T2B = b;
}

function maskMix(c, q0, w0, q1, w1, q2, w2, q3, w3, k) {
  const m0 = !k || !q0 || q0 === k ? w0 : 0, m1 = !k || !q1 || q1 === k ? w1 : 0;
  const m2 = !k || !q2 || q2 === k ? w2 : 0, m3 = !k || !q3 || q3 === k ? w3 : 0;
  const n = m0 + m1 + m2 + m3;
  const iv = n > 1e-6 ? 1 / n : 0;
  MIX[0] = (c[0] * m0 + c[1] * m1 + c[2] * m2 + c[3] * m3) * iv;
  MIX[1] = (c[4] * m0 + c[5] * m1 + c[6] * m2 + c[7] * m3) * iv;
  MIX[2] = (c[8] * m0 + c[9] * m1 + c[10] * m2 + c[11] * m3) * iv;
}

const SPX = new Float32Array(8), SPY = new Float32Array(8);

function splineW(t, out) {
  const t2 = t * t, t3 = t2 * t, u = 1 - t;
  out[0] = 0.25 * (-t3 + 2 * t2 - t) + (u * u * u) / 12;
  out[1] = 0.25 * (3 * t3 - 5 * t2 + 2) + (3 * t3 - 6 * t2 + 4) / 12;
  out[2] = 0.25 * (-3 * t3 + 4 * t2 + t) + (-3 * t3 + 3 * t2 + 3 * t + 1) / 12;
  out[3] = 0.25 * (t3 - t2) + t3 / 12;
  out[4] = 0.25 * (-3 * t2 + 4 * t - 1) - (u * u) / 4;
  out[5] = 0.25 * (9 * t2 - 10 * t) + (3 * t2 - 4 * t) / 4;
  out[6] = 0.25 * (-9 * t2 + 8 * t + 1) + (-3 * t2 + 2 * t + 1) / 4;
  out[7] = 0.25 * (3 * t2 - 2 * t) + t2 / 4;
}

function crMix(c, o, a0, a1, a2, a3, e0, e1, e2, e3) {
  return e0 * (a0 * c[o] + a1 * c[o + 1] + a2 * c[o + 2] + a3 * c[o + 3])
    + e1 * (a0 * c[o + 4] + a1 * c[o + 5] + a2 * c[o + 6] + a3 * c[o + 7])
    + e2 * (a0 * c[o + 8] + a1 * c[o + 9] + a2 * c[o + 10] + a3 * c[o + 11])
    + e3 * (a0 * c[o + 12] + a1 * c[o + 13] + a2 * c[o + 14] + a3 * c[o + 15]);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

const packRGBA = (r, g, b, a) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;

export function mapPreview(map, width, height, themeName = 'dark', state = null) {
  const th = THEMES[themeName] || THEMES.dark;
  const W = map.W, H = map.H;
  const w = Math.max(1, Math.round(width || 240));
  const h = Math.max(1, Math.round(height || (w * H) / W));
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const u = new Uint32Array(img.data.buffer);
  const t = map.terrain, el = map.elev, wb = map.waterBody, ob = map.oceanBodies;
  const own = state && state.owner ? state.owner : null;
  const pc = [];
  if (own && state.players) for (const p of state.players) pc.push(hexToRgb(p.color));
  const K = 3, kx = W / w / K, ky = H / h / K;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < K; sy++) {
        const ty = Math.min(H - 1, Math.floor((py * K + sy + 0.5) * ky));
        for (let sx = 0; sx < K; sx++) {
          const tx = Math.min(W - 1, Math.floor((px * K + sx + 0.5) * kx));
          const i = ty * W + tx, tt = t[i];
          let cr, cg, cb;
          if (tt >= 2) {
            const base = th.land[tt] || th.land[2];
            const k = th.landGain * (0.86 + (el ? el[i] / 255 : 0.3) * 0.3);
            cr = base[0] * k; cg = base[1] * k; cb = base[2] * k;
            const o = own ? own[i] : 0;
            if (o && pc[o - 1]) {
              const q = pc[o - 1], a = th.fillA + 0.15;
              cr += (q[0] - cr) * a; cg += (q[1] - cg) * a; cb += (q[2] - cb) * a;
            }
          } else {
            const lake = wb && ob && wb[i] >= 0 && !ob.has(wb[i]);
            const d = el ? clamp(el[i] / 60, 0, 1) : tt === 1 ? 0.2 : 0.8;
            const q = lake ? th.lake : mix(mix(th.shallow, th.mid, smooth(0, 0.35, d)), th.deep, smooth(0.25, 1, d));
            cr = q[0]; cg = q[1]; cb = q[2];
          }
          r += cr; g += cg; b += cb;
        }
      }
      const n = 1 / (K * K);
      u[py * w + px] = packRGBA(clamp(r * n, 0, 255) | 0, clamp(g * n, 0, 255) | 0, clamp(b * n, 0, 255) | 0, 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.dpr = 1;
    this.cam = { x: 0, y: 0, z: 2 };
    this.anim = null;
    this.keys = { x: 0, y: 0 };
    this.panSpeed = 900;
    this.themeName = 'dark';
    this.map = null;
    this.game = null;
    this.selection = null;
    this.selKey = null;
    this.selSet = new Set();
    this.box = null;
    this.orders = null;
    this.insets = null;
    this.hoverTile = -1;
    this.mode = null;
    this.showAA = false;
    this.showLabels = true;
    this.time = 0;
    this.frame = 0;
    this.budgetMs = 7;
    this.chunks = new Map();
    this.levelCount = new Map();
    this.fx = [];
    this.parts = [];
    this.texts = [];
    this.flash = 0;
    this.shake = 0;
    this.uPos = new Map();
    this.uTick = -1;
    this.projLast = new Map();
    this.labels = new Map();
    this.labelAt = -1e9;
    this.validCache = { key: '', ok: true, error: '' };
    this.stats = { drawMs: 0, chunkMs: 0, blocks: 0, chunks: 0, dirty: 0 };
    this.grain = null;
    this.allyKey = '';
  }

  get theme() { return THEMES[this.themeName] || THEMES.dark; }

  get minZoom() { return 0.5 * this.dpr; }

  get maxZoom() { return 40 * this.dpr; }

  setTheme(name) {
    const n = THEMES[name] ? name : 'dark';
    if (n === this.themeName && this.baked) return;
    this.themeName = n;
    if (this.map) {
      this.bakeTheme();
      this.dropChunks();
      if (this.game) {
        this.buildPalette();
        this.rebuildTerritory();
      }
    }
  }

  setMap(map) {
    if (this.map === map) return;
    this.map = map;
    this.game = null;
    this.dropChunks();
    this.prepMap();
    this.bakeTheme();
    this.labels.clear();
    this.uPos.clear();
    this.projLast.clear();
    this.fx = [];
    this.parts = [];
    this.texts = [];
    this.fit();
  }

  prepMap() {
    const map = this.map, W = map.W, H = map.H, N = W * H, t = map.terrain;
    const land = new Uint8Array(N);
    const water = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (t[i] >= 2) land[i] = 1;
      else water[i] = 1;
    }
    this.land = land;
    const dl = chamfer(W, H, water, 64);
    const dw = chamfer(W, H, land, 64);
    const sdf = new Float32Array(N);
    for (let i = 0; i < N; i++) sdf[i] = land[i] ? dl[i] - 0.5 : 0.5 - dw[i];
    const sb = blur3(sdf, W, H);
    for (let i = 0; i < N; i++) sdf[i] = land[i] ? Math.max(sb[i], 0.14) : Math.min(sb[i], -0.14);
    this.sdf = sdf;
    const lake = new Uint8Array(N);
    if (map.waterBody && map.oceanBodies) {
      for (let i = 0; i < N; i++) if (!land[i] && map.waterBody[i] >= 0 && !map.oceanBodies.has(map.waterBody[i])) lake[i] = 1;
    }
    this.lake = lake;
    const e = new Float32Array(N);
    const el = map.elev;
    for (let i = 0; i < N; i++) e[i] = land[i] ? (el ? el[i] / 255 : 0.3) : 0.14;
    const eb = blur3(e, W, H);
    const grad = new Float32Array(N);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const xl = x > 0 ? i - 1 : i, xr = x < W - 1 ? i + 1 : i;
        const yu = y > 0 ? i - W : i, yd = y < H - 1 ? i + W : i;
        grad[i] = (eb[xr] - eb[xl]) + (eb[yd] - eb[yu]);
      }
    }
    this.elevB = eb;
    this.grad = grad;
    this.vary = noiseField(W, H, 9, 11, 3, 3);
    this.vary2 = noiseField(W, H, 41, 29, 3, 8);
    this.edgeArr = new Uint8Array(N);
    this.stamp = new Uint32Array(N);
    this.stampN = 0;
    this.tbw = Math.ceil(W / TB);
    this.tbh = Math.ceil(H / TB);
    this.tblocks = new Uint8Array(this.tbw * this.tbh);
    this.terrCanvas = makeCanvas(W, H);
    this.terrCtx = this.terrCanvas.getContext('2d');
    this.terrImg = this.terrCtx.createImageData(W, H);
    this.terrU32 = new Uint32Array(this.terrImg.data.buffer);
    this.baseCanvas = makeCanvas(W, H);
    this.baseCtx = this.baseCanvas.getContext('2d');
    if (!this.grain) this.makeGrain();
    this.labelGrid = Math.max(2, Math.round(Math.sqrt(N / 42000)));
    this.blockImg = this.ctx.createImageData(BLK, BLK);
    this.blockU32 = new Uint32Array(this.blockImg.data.buffer);
  }

  makeGrain() {
    this.grain = tileNoise(GRAIN, 4, 2, 5, 0.25);
    this.detail = tileNoise(256, 16, 3, 77, 0.15);
  }

  bakeTheme() {
    const th = this.theme, map = this.map;
    const W = map.W, H = map.H, N = W * H, t = map.terrain;
    this.baked = true;
    const lut = new Uint8Array(256 * 3);
    const llut = new Uint8Array(256 * 3);
    for (let k = 0; k < 256; k++) {
      const d = k / 8;
      let c = mix(th.shallow, th.mid, smooth(0.3, 4.5, d));
      c = mix(c, th.deep, smooth(3, 16, d));
      lut[k * 3] = clamp(c[0], 0, 255);
      lut[k * 3 + 1] = clamp(c[1], 0, 255);
      lut[k * 3 + 2] = clamp(c[2], 0, 255);
      const l = mix(th.lake, shade(th.lake, 0.8), smooth(1, 8, d));
      llut[k * 3] = clamp(l[0], 0, 255);
      llut[k * 3 + 1] = clamp(l[1], 0, 255);
      llut[k * 3 + 2] = clamp(l[2], 0, 255);
    }
    this.wlut = lut;
    this.llut = llut;
    const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
    const el = map.elev;
    const vary = this.vary, vary2 = this.vary2, land = this.land;
    const Lp = th.land, pk = th.peak, blot = th.blot;
    for (let i = 0; i < N; i++) {
      const tt = t[i];
      if (tt < 2) continue;
      const e = el ? el[i] / 255 : 0.3;
      const c = Lp[tt] || Lp[2];
      const v = vary[i], v2 = vary2[i];
      let r = c[0], g = c[1], b = c[2], q, m;
      if (tt === 2) {
        q = Lp[3]; m = clamp(v2 * 0.5 + 0.12, 0, 0.4);
        r += (q[0] - r) * m; g += (q[1] - g) * m; b += (q[2] - b) * m;
        q = Lp[4]; m = clamp(-v2 * 0.35 - 0.1, 0, 0.25);
        r += (q[0] - r) * m; g += (q[1] - g) * m; b += (q[2] - b) * m;
      } else if (tt === 3) {
        q = Lp[2]; m = clamp(v * 0.4, 0, 0.3);
        r += (q[0] - r) * m; g += (q[1] - g) * m; b += (q[2] - b) * m;
      } else if (tt === 4) {
        q = Lp[5]; m = clamp(v2 * 0.35, 0, 0.25);
        r += (q[0] - r) * m; g += (q[1] - g) * m; b += (q[2] - b) * m;
      } else if (tt === 5) {
        q = Lp[2]; m = clamp(0.62 - e, 0, 0.3);
        r += (q[0] - r) * m; g += (q[1] - g) * m; b += (q[2] - b) * m;
      } else if (tt === 6) {
        q = pk; m = smooth(0.9, 1.04, e) * 0.6;
        r += (q[0] - r) * m; g += (q[1] - g) * m; b += (q[2] - b) * m;
      } else if (tt === 7) {
        q = Lp[6]; m = clamp(v * 0.25, 0, 0.18);
        r += (q[0] - r) * m; g += (q[1] - g) * m; b += (q[2] - b) * m;
      }
      const k = 1 + v * blot;
      R[i] = r * k;
      G[i] = g * k;
      B[i] = b * k;
    }
    const R0 = R.slice(), G0 = G.slice(), B0 = B.slice();
    blurMasked3(R, G, B, land, W, H);
    const tamp = new Uint8Array(N);
    for (let i = 0; i < N; i++) tamp[i] = land[i] ? TEX_AMP[t[i]] || 0 : 0;
    this.tamp = tamp;
    const grad = this.grad, eb = this.elevB, sdf = this.sdf;
    const lk = new Float32Array(N).fill(1);
    const gain = th.landGain;
    for (let i = 0; i < N; i++) {
      if (!land[i]) continue;
      const lit = clamp(grad[i] * th.shade, -0.3, 0.3);
      lk[i] = gain * (1 + lit) * (0.93 + eb[i] * 0.16);
    }
    const shore = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (land[i] || sdf[i] < -2.2) continue;
        const nb = [];
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < W && land[yy * W + xx]) nb.push(yy * W + xx);
          }
        }
        if (nb.length) shore.push(i, nb);
      }
    }
    for (let k = 0; k < shore.length; k += 2) {
      const nb = shore[k + 1];
      let kk = 0;
      for (const j of nb) kk += lk[j];
      lk[shore[k]] = kk / nb.length;
    }
    const pack = (R2, G2, B2) => {
      const lc = new Uint32Array(N);
      for (let i = 0; i < N; i++) {
        if (!land[i]) continue;
        const sd = sdf[i];
        let r = R2[i], g = G2[i], b = B2[i];
        if (sd < 1.6 && t[i] !== 7 && t[i] !== 6) {
          const bt = (1 - smooth(0.4, 1.6, sd)) * 0.35;
          r += (th.beach[0] - r) * bt;
          g += (th.beach[1] - g) * bt;
          b += (th.beach[2] - b) * bt;
        }
        r = clamp(r, 0, 255);
        g = clamp(g, 0, 255);
        b = clamp(b, 0, 255);
        lc[i] = (r | 0) | ((g | 0) << 8) | ((b | 0) << 16);
      }
      for (let k = 0; k < shore.length; k += 2) {
        const nb = shore[k + 1];
        let r = 0, g = 0, b = 0;
        for (const j of nb) {
          const c = lc[j];
          r += c & 255;
          g += (c >> 8) & 255;
          b += (c >> 16) & 255;
        }
        const n = nb.length;
        lc[shore[k]] = ((r / n) | 0) | (((g / n) | 0) << 8) | (((b / n) | 0) << 16);
      }
      return lc;
    };
    const lc = pack(R, G, B);
    this.lc0 = pack(R0, G0, B0);
    this.lc = lc;
    this.lk = lk;
    const img = this.baseCtx.createImageData(W, H);
    const u = new Uint32Array(img.data.buffer);
    const gr = this.grain, ga = th.grain / 127;
    const lake = this.lake;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const gn = gr[(y & (GRAIN - 1)) * GRAIN + (x & (GRAIN - 1))] * ga;
        let r, g, b;
        if (land[i]) {
          const c = lc[i], k = lk[i];
          r = (c & 255) * k + gn;
          g = ((c >> 8) & 255) * k + gn;
          b = ((c >> 16) & 255) * k + gn;
          if (map.coast && map.coast[i]) {
            r *= 0.9;
            g *= 0.9;
            b *= 0.9;
          }
        } else {
          const L = lake[i] ? this.llut : lut;
          const k = clamp(Math.round(-sdf[i] * 8), 0, 255) * 3;
          const v = vary2[i] * 4;
          r = L[k] + v + gn * 0.4;
          g = L[k + 1] + v + gn * 0.4;
          b = L[k + 2] + v * 1.4 + gn * 0.4;
        }
        u[i] = packRGBA(clamp(r, 0, 255) | 0, clamp(g, 0, 255) | 0, clamp(b, 0, 255) | 0, 255);
      }
    }
    this.baseCtx.putImageData(img, 0, 0);
  }

  resize() {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const cw = this.canvas.clientWidth || this.canvas.width;
    const chh = this.canvas.clientHeight || this.canvas.height;
    const w = Math.max(1, Math.floor(cw * dpr));
    const h = Math.max(1, Math.floor(chh * dpr));
    const ow = this.canvas.width, oh = this.canvas.height;
    if (dpr === this.dpr && ow === w && oh === h) return;
    const z0 = this.cam.z;
    const cx = this.cam.x + ow / z0 / 2, cy = this.cam.y + oh / z0 / 2;
    if (dpr !== this.dpr) {
      this.cam.z = z0 * (dpr / this.dpr);
      this.dpr = dpr;
      this.anim = null;
    }
    if (ow !== w || oh !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.cam.x = cx - w / this.cam.z / 2;
    this.cam.y = cy - h / this.cam.z / 2;
    if (this.anim && this.anim.kind === 'zoom') this.anim = null;
    this.clampCam();
  }

  get viewW() { return this.canvas.width; }

  get viewH() { return this.canvas.height; }

  fit(insets) {
    if (!this.map) return;
    this.resize();
    const { W, H } = this.map;
    const d = this.dpr, vw = this.viewW, vh = this.viewH;
    const ins = insets || { t: 0, b: 0, l: 0, r: 0, bh: 0 };
    const t = (ins.t || 0) * d, b = (ins.b || 0) * d, r = (ins.r || 0) * d, l = (ins.l || 0) * d, bh = (ins.bh || 0) * d;
    const place = (x0, y0, x1, y1) => {
      const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
      const z = clamp(Math.min(w / W, h / H) * 0.98, this.minZoom, this.maxZoom);
      const mx = x0 + (w - W * z) / 2, my = y0 + (h - H * z) / 2;
      return { z, mx, my };
    };
    let p = place(0, t, vw - r, vh - b);
    if (l > 0 && bh > 0 && p.mx < l && p.my < bh) {
      const side = place(l, t, vw - r, vh - b);
      const below = place(0, bh, vw - r, vh - b);
      p = below.z > side.z ? below : side;
    }
    this.cam.z = p.z;
    this.cam.x = -p.mx / p.z;
    this.cam.y = -p.my / p.z;
    this.anim = null;
    this.clampCam();
  }

  get zoom() { return this.cam.z / this.dpr; }

  focus(x, y, zoom, instant = false) {
    const z1 = clamp(zoom ? zoom * this.dpr : this.cam.z, this.minZoom, this.maxZoom);
    if (instant) {
      this.cam.z = z1;
      this.cam.x = x - this.viewW / z1 / 2;
      this.cam.y = y - this.viewH / z1 / 2;
      this.anim = null;
      this.clampCam();
      return;
    }
    const cx = this.cam.x + this.viewW / this.cam.z / 2, cy = this.cam.y + this.viewH / this.cam.z / 2;
    this.anim = { kind: 'fly', t: 0, dur: 0.65, x0: cx, y0: cy, z0: this.cam.z, x1: x, y1: y, z1 };
  }

  zoomAt(sx, sy, factor) {
    const base = this.anim && this.anim.kind === 'zoom' ? this.anim.tz : this.cam.z;
    const tz = clamp(base * factor, this.minZoom, this.maxZoom);
    const [wx, wy] = this.screenToTile(sx, sy);
    this.anim = { kind: 'zoom', tz, wx, wy, sx, sy };
  }

  setZoom(z, instant = false) {
    this.zoomAt(this.viewW / 2, this.viewH / 2, (z * this.dpr) / this.cam.z);
    if (instant) this.stepCamera(10);
  }

  pan(dx, dy) {
    this.cam.x -= dx / this.cam.z;
    this.cam.y -= dy / this.cam.z;
    if (this.anim && this.anim.kind === 'zoom') {
      this.anim.sx += dx;
      this.anim.sy += dy;
    } else if (this.anim) this.anim = null;
    this.clampCam();
  }

  stepCamera(dt) {
    const a = this.anim;
    if (a && a.kind === 'zoom') {
      const k = 1 - Math.exp(-dt * 16);
      const lz = Math.log(this.cam.z), lt = Math.log(a.tz);
      let nz = Math.exp(lz + (lt - lz) * k);
      if (Math.abs(lt - Math.log(nz)) < 0.002) {
        nz = a.tz;
        this.anim = null;
      }
      this.cam.z = nz;
      this.cam.x = a.wx - a.sx / nz;
      this.cam.y = a.wy - a.sy / nz;
    } else if (a && a.kind === 'fly') {
      a.t += dt;
      const p = clamp(a.t / a.dur, 0, 1);
      const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      const z = Math.exp(Math.log(a.z0) + (Math.log(a.z1) - Math.log(a.z0)) * e);
      const cx = a.x0 + (a.x1 - a.x0) * e, cy = a.y0 + (a.y1 - a.y0) * e;
      this.cam.z = z;
      this.cam.x = cx - this.viewW / z / 2;
      this.cam.y = cy - this.viewH / z / 2;
      if (p >= 1) this.anim = null;
    }
    if (this.keys.x || this.keys.y) {
      const sp = this.panSpeed * this.dpr * dt;
      this.cam.x += (this.keys.x * sp) / this.cam.z;
      this.cam.y += (this.keys.y * sp) / this.cam.z;
      if (this.anim && this.anim.kind === 'zoom') {
        this.anim.wx += (this.keys.x * sp) / this.cam.z;
        this.anim.wy += (this.keys.y * sp) / this.cam.z;
      }
    }
    this.clampCam();
  }

  clampCam() {
    if (!this.map) return;
    const z = this.cam.z;
    const vw = this.viewW / z, vh = this.viewH / z;
    const { W, H } = this.map;
    const mx = Math.min(vw * 0.4, W * 0.5), my = Math.min(vh * 0.4, H * 0.5);
    this.cam.x = vw > W + mx * 2 ? (W - vw) / 2 : clamp(this.cam.x, -mx, W - vw + mx);
    this.cam.y = vh > H + my * 2 ? (H - vh) / 2 : clamp(this.cam.y, -my, H - vh + my);
  }

  screenToTile(sx, sy) { return [this.cam.x + sx / this.cam.z, this.cam.y + sy / this.cam.z]; }

  tileToScreen(x, y) { return [(x - this.cam.x) * this.cam.z, (y - this.cam.y) * this.cam.z]; }

  tileAtScreen(sx, sy) {
    if (!this.map) return -1;
    const [x, y] = this.screenToTile(sx, sy);
    const xi = Math.floor(x), yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= this.map.W || yi >= this.map.H) return -1;
    return yi * this.map.W + xi;
  }

  canvasPoint(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return [(clientX - r.left) * this.dpr, (clientY - r.top) * this.dpr];
  }

  sx(x) { return (x - this.cam.x) * this.cam.z; }

  sy(y) { return (y - this.cam.y) * this.cam.z; }

  bindGame(game) {
    if (game.map !== this.map) this.setMap(game.map);
    this.game = game;
    this.uPos.clear();
    this.uTick = -1;
    this.projLast.clear();
    this.labels.clear();
    this.labelAt = -1e9;
    this.allyKey = '';
    this.boatKey = '';
    this.validCache = { key: '', ok: true, error: '' };
    this.buildPalette();
    this.rebuildTerritory();
    if (typeof game.drainDirty === 'function') game.drainDirty();
  }

  allySignature() {
    const g = this.game, me = this.localPid;
    if (!g || me < 0) return '';
    let k = '';
    for (let q = 0; q < g.s.players.length; q++) if (q !== me && g.isAllied(me, q)) k += q + ',';
    return k;
  }

  buildPalette() {
    const g = this.game, th = this.theme, P = g.s.players.length;
    const n = P + 1;
    this.pFill = new Float32Array(n * 3);
    this.pRim = new Float32Array(n * 3);
    this.pDark = new Float32Array(n * 3);
    this.tFill = new Uint32Array(n);
    this.tRim = new Uint32Array(n);
    this.tDark = new Uint32Array(n);
    this.tones = [];
    const me = this.localPid;
    const meTone = me >= 0 && g.s.players[me] ? playerTones(g.s.players[me].color, th) : null;
    for (let p = 0; p < P; p++) {
      const pl = g.s.players[p];
      const tn = playerTones(pl.color, th);
      this.tones[p] = tn;
      const allied = meTone && p !== me && g.isAllied(me, p);
      const dark = allied ? mix(meTone.dark, tn.dark, 0.25) : tn.dark;
      const o = p + 1;
      for (let c = 0; c < 3; c++) {
        this.pFill[o * 3 + c] = tn.fill[c];
        this.pRim[o * 3 + c] = tn.rim[c];
        this.pDark[o * 3 + c] = dark[c];
      }
      this.tFill[o] = packRGBA(tn.fill[0] | 0, tn.fill[1] | 0, tn.fill[2] | 0, Math.round(th.fillA * 255));
      this.tRim[o] = packRGBA(tn.rim[0] | 0, tn.rim[1] | 0, tn.rim[2] | 0, Math.round(th.rimA * 255));
      this.tDark[o] = packRGBA(clamp(dark[0], 0, 255) | 0, clamp(dark[1], 0, 255) | 0, clamp(dark[2], 0, 255) | 0, Math.round(th.darkA * 255));
    }
    const hi = th.falloutHi, lo = th.falloutLo, fa = Math.round(th.falloutA * 255);
    this.fHi = packRGBA(hi[0], hi[1], hi[2], fa);
    this.fLo = packRGBA(lo[0], lo[1], lo[2], Math.round(fa * 0.7));
    this.allyKey = this.allySignature();
  }

  isEdge(i, o) {
    const own = this.game.s.owner, W = this.map.W, N = own.length;
    const x = i % W;
    return (x > 0 && own[i - 1] !== o) || (x < W - 1 && own[i + 1] !== o) || (i >= W && own[i - W] !== o) || (i < N - W && own[i + W] !== o);
  }

  cellColor(i) {
    if (!this.land[i]) return 0;
    const s = this.game.s, o = s.owner[i];
    if (!o) {
      if (s.fallout[i]) {
        const W = this.map.W, x = i % W, y = (i - x) / W;
        return ((x + y) & 3) < 2 ? this.fHi : this.fLo;
      }
      return 0;
    }
    if (this.edgeArr[i]) return this.tDark[o] || 0;
    const W = this.map.W, N = s.owner.length, x = i % W, e = this.edgeArr;
    if ((x > 0 && e[i - 1]) || (x < W - 1 && e[i + 1]) || (i >= W && e[i - W]) || (i < N - W && e[i + W])) return this.tRim[o] || 0;
    return this.tFill[o] || 0;
  }

  rebuildTerritory() {
    const g = this.game;
    if (!g || !this.map) return;
    const own = g.s.owner, W = this.map.W, N = own.length, e = this.edgeArr;
    for (let i = 0; i < N; i++) {
      const o = own[i];
      e[i] = o && this.land[i] && this.isEdge(i, o) ? 1 : 0;
    }
    const u = this.terrU32;
    for (let i = 0; i < N; i++) u[i] = this.cellColor(i);
    this.terrCtx.putImageData(this.terrImg, 0, 0);
    this.tblocks.fill(0);
    this.invalidateChunks();
    void W;
  }

  applyDirty(tiles) {
    const W = this.map.W, N = W * this.map.H;
    if (tiles.length > N / 12) {
      this.rebuildTerritory();
      return;
    }
    const own = this.game.s.owner, e = this.edgeArr, st = this.stamp, u = this.terrU32, land = this.land;
    const tb = this.tblocks, tbw = this.tbw;
    this.stampN = (this.stampN + 2) >>> 0;
    if (this.stampN < 2 || this.stampN > 0xfffffff0) {
      st.fill(0);
      this.stampN = 2;
    }
    const sA = this.stampN, sB = this.stampN + 1;
    this.stampN++;
    let touched = this.touchBuf;
    if (!touched || touched.length < tiles.length * 5) touched = this.touchBuf = new Int32Array(Math.max(1024, tiles.length * 5));
    let nt = 0;
    for (let k = 0; k < tiles.length; k++) {
      const i = tiles[k];
      if (!(i >= 0 && i < N)) continue;
      const x = i % W;
      for (let q = 0; q < 5; q++) {
        const j = q === 0 ? i : q === 1 ? (x > 0 ? i - 1 : -1) : q === 2 ? (x < W - 1 ? i + 1 : -1) : q === 3 ? i - W : i + W;
        if (j < 0 || j >= N || st[j] === sA || st[j] === sB) continue;
        st[j] = sA;
        const o = own[j];
        e[j] = o && land[j] && this.isEdge(j, o) ? 1 : 0;
        touched[nt++] = j;
      }
    }
    for (let k = 0; k < nt; k++) {
      const i = touched[k];
      const x = i % W;
      for (let q = 0; q < 5; q++) {
        const j = q === 0 ? i : q === 1 ? (x > 0 ? i - 1 : -1) : q === 2 ? (x < W - 1 ? i + 1 : -1) : q === 3 ? i - W : i + W;
        if (j < 0 || j >= N || st[j] === sB) continue;
        st[j] = sB;
        u[j] = this.cellColor(j);
        const jx = j % W, jy = (j - jx) / W;
        tb[((jy / TB) | 0) * tbw + ((jx / TB) | 0)] = 1;
      }
    }
    this.markChunkTiles(tiles);
  }

  flushTerritory() {
    const tb = this.tblocks, W = this.map.W, H = this.map.H;
    for (let b = 0; b < tb.length; b++) {
      if (!tb[b]) continue;
      tb[b] = 0;
      const bx = (b % this.tbw) * TB, by = ((b / this.tbw) | 0) * TB;
      this.terrCtx.putImageData(this.terrImg, 0, 0, bx, by, Math.min(TB, W - bx), Math.min(TB, H - by));
    }
  }

  levelFor(z) {
    let s = Math.pow(2, Math.round(Math.log2(Math.max(z, 1))));
    if (s < LEVELS[0]) s = LEVELS[0];
    if (s > LEVELS[LEVELS.length - 1]) s = LEVELS[LEVELS.length - 1];
    return s;
  }

  dropChunks() {
    this.chunks.clear();
    this.levelCount.clear();
  }

  invalidateChunks() {
    for (const ch of this.chunks.values()) {
      ch.todo.fill(1);
      ch.pending = NBLK;
    }
  }

  getChunk(S, cx, cy) {
    const key = S * 1e8 + cy * 1e4 + cx;
    let ch = this.chunks.get(key);
    if (ch) return ch;
    const canvas = makeCanvas(CH, CH);
    ch = {
      key, S, cx, cy, C: CH / S, canvas, ctx: canvas.getContext('2d'),
      todo: new Uint8Array(NBLK).fill(1), pending: NBLK, fresh: NBLK, used: this.frame,
    };
    this.chunks.set(key, ch);
    this.levelCount.set(S, (this.levelCount.get(S) || 0) + 1);
    return ch;
  }

  evictChunks(keep) {
    if (this.chunks.size <= MAX_CHUNKS) return;
    const list = [...this.chunks.values()].filter((c) => !keep.has(c.key)).sort((a, b) => a.used - b.used);
    let n = this.chunks.size - MAX_CHUNKS;
    for (const c of list) {
      if (n-- <= 0) break;
      this.chunks.delete(c.key);
      this.levelCount.set(c.S, (this.levelCount.get(c.S) || 1) - 1);
    }
  }

  markChunkTiles(tiles) {
    if (!this.chunks.size) return;
    const W = this.map.W;
    for (const S of LEVELS) {
      if (!(this.levelCount.get(S) > 0)) continue;
      const C = CH / S;
      for (let k = 0; k < tiles.length; k++) {
        const i = tiles[k];
        const x = i % W, y = (i - x) / W;
        const x0 = x - 2, x1 = x + 3, y0 = y - 2, y1 = y + 3;
        const cxa = Math.floor(x0 / C), cxb = Math.floor((x1 - 0.001) / C);
        const cya = Math.floor(y0 / C), cyb = Math.floor((y1 - 0.001) / C);
        for (let cy = cya; cy <= cyb; cy++) {
          for (let cx = cxa; cx <= cxb; cx++) {
            const ch = this.chunks.get(S * 1e8 + cy * 1e4 + cx);
            if (!ch) continue;
            const px0 = clamp((x0 - cx * C) * S, 0, CH), px1 = clamp((x1 - cx * C) * S, 0, CH);
            const py0 = clamp((y0 - cy * C) * S, 0, CH), py1 = clamp((y1 - cy * C) * S, 0, CH);
            if (px1 <= px0 || py1 <= py0) continue;
            const bxa = (px0 / BLK) | 0, bxb = Math.min(BPR - 1, ((px1 - 1) / BLK) | 0);
            const bya = (py0 / BLK) | 0, byb = Math.min(BPR - 1, ((py1 - 1) / BLK) | 0);
            for (let by = bya; by <= byb; by++) {
              for (let bx = bxa; bx <= bxb; bx++) {
                const b = by * BPR + bx;
                if (!ch.todo[b]) {
                  ch.todo[b] = 1;
                  ch.pending++;
                }
              }
            }
          }
        }
      }
    }
  }

  renderBlock(ch, bi) {
    const map = this.map, W = map.W, H = map.H;
    const s = this.game ? this.game.s : null;
    const own = s ? s.owner : null, fo = s ? s.fallout : null;
    const th = this.theme;
    const S = ch.S, inv = 1 / S, C = ch.C, half = S >> 1;
    const px0 = (bi % BPR) * BLK, py0 = ((bi / BPR) | 0) * BLK;
    const ox = ch.cx * C, oy = ch.cy * C;
    const out = this.blockU32;
    const sdf = this.sdf, lc = this.lc, lk = this.lk, land = this.land, lake = this.lake;
    const wl = this.wlut, ll = this.llut;
    const gr = this.grain, gAmp = th.grain / 127;
    const gxb = ch.cx * CH + px0, gyb = ch.cy * CH + py0;
    const pF = this.pFill, pR = this.pRim, pD = this.pDark;
    const fillA = th.fillA, rimA = th.rimA, darkA = th.darkA;
    const bwD = S <= 2 ? 0.95 : clamp(0.2 * S, 1.05, 4), bwR = bwD + (S <= 2 ? 0 : clamp(0.19 * S, 0.9, 4.4));
    const fHi = th.falloutHi, fLo = th.falloutLo, fA = th.falloutA;
    const fPer = Math.max(6, Math.round(S * 0.7)), fRim = 2 + S * 0.12;
    const shoreW = clamp(S * 0.12, 1, 3);
    const foam = th.foam, foamW = clamp(S * 0.3, 1.4, 5), foamA = th.foamA;
    const det = this.detail, detA = (th.detail / 127) * (0.35 + 0.65 * smooth(3, 14, S));
    const sharpK = 1.25, warpK = (S >= 4 ? 0.34 : 0.3) / 127, warpH = S >= 4 ? 0.42 / 127 : 0;
    const useCR = S >= 8, useBio = S >= 4, useDet = S >= 4, useHf = S >= 8, texK = smooth(3, 12, S) / 127, tamp = this.tamp;
    const cc = this.ccBuf || (this.ccBuf = new Int32Array(16));
    const k16 = this.k16Buf || (this.k16Buf = new Int8Array(16));
    const s16 = this.s16Buf || (this.s16Buf = new Float32Array(16));
    const c12 = this.c12Buf || (this.c12Buf = new Float32Array(12));
    const lc0 = this.lc0, terr = map.terrain, bwT = Math.max(0.7, 0.2 * S);
    const sc = this.scBuf || (this.scBuf = new Float32Array(16));
    const cy = this.cyBuf || (this.cyBuf = new Float32Array(8));
    const gyA = Math.floor(oy + (py0 + 0.5) * inv - 0.5), gyB = Math.floor(oy + (py0 + BLK - 0.5) * inv - 0.5);
    const gxA = Math.floor(ox + (px0 + 0.5) * inv - 0.5), gxB = Math.floor(ox + (px0 + BLK - 0.5) * inv - 0.5);
    const cl = (v, m) => (v < 0 ? 0 : v > m ? m : v);
    for (let gy = gyA; gy <= gyB; gy++) {
      const pyS = Math.max(0, (gy - oy) * S + half - py0), pyE = Math.min(BLK, (gy - oy) * S + half + S - py0);
      if (pyE <= pyS) continue;
      const ya = cl(gy, H - 1), yb = cl(gy + 1, H - 1);
      const ra = ya * W, rb = yb * W, r0 = cl(gy - 1, H - 1) * W, r3 = cl(gy + 2, H - 1) * W;
      for (let gx = gxA; gx <= gxB; gx++) {
        const pxS = Math.max(0, (gx - ox) * S + half - px0), pxE = Math.min(BLK, (gx - ox) * S + half + S - px0);
        if (pxE <= pxS) continue;
        const xa = cl(gx, W - 1), xb = cl(gx + 1, W - 1);
        const i00 = ra + xa, i10 = ra + xb, i01 = rb + xa, i11 = rb + xb;
        const s00 = sdf[i00], s10 = sdf[i10], s01 = sdf[i01], s11 = sdf[i11];
        const k00 = lk[i00], k10 = lk[i10], k01 = lk[i01], k11 = lk[i11];
        let c = lc[i00];
        const r00 = c & 255, g00 = (c >> 8) & 255, b00 = (c >> 16) & 255;
        c = lc[i10];
        const r10 = c & 255, g10 = (c >> 8) & 255, b10 = (c >> 16) & 255;
        c = lc[i01];
        const r01 = c & 255, g01 = (c >> 8) & 255, b01 = (c >> 16) & 255;
        c = lc[i11];
        const r11 = c & 255, g11 = (c >> 8) & 255, b11 = (c >> 16) & 255;
        const isLake = lake[i00] + lake[i10] + lake[i01] + lake[i11] >= 2;
        const L = isLake ? ll : wl;
        const l00 = land[i00], l10 = land[i10], l01 = land[i01], l11 = land[i11];
        const anyW = !(l00 && l10 && l01 && l11);
        const allW = !(l00 || l10 || l01 || l11) && s00 + s10 + s01 + s11 < -2.5;
        let o00 = 0, o10 = 0, o01 = 0, o11 = 0, uni = true, anyF = false, f00 = 0, f10 = 0, f01 = 0, f11 = 0;
        if (own && !allW) {
          o00 = own[i00]; o10 = own[i10]; o01 = own[i01]; o11 = own[i11];
          if (anyW) {
            const sub = l00 ? o00 : l10 ? o10 : l01 ? o01 : l11 ? o11 : 0;
            if (!l00) o00 = l10 ? o10 : l01 ? o01 : sub;
            if (!l10) o10 = l00 ? o00 : l11 ? o11 : sub;
            if (!l01) o01 = l00 ? o00 : l11 ? o11 : sub;
            if (!l11) o11 = l10 ? o10 : l01 ? o01 : sub;
          }
          uni = o00 === o10 && o00 === o01 && o00 === o11;
          f00 = l00 && fo[i00] ? 1 : 0;
          f10 = l10 && fo[i10] ? 1 : 0;
          f01 = l01 && fo[i01] ? 1 : 0;
          f11 = l11 && fo[i11] ? 1 : 0;
          anyF = f00 + f10 + f01 + f11 > 0;
        }
        let ccOk = false, pk = -1, colOk = false, pkc = -1, uniK = true;
        for (let py = pyS; py < pyE; py++) {
          const wy = oy + (py0 + py + 0.5) * inv;
          const rowO = py * BLK;
          if (wy >= H) {
            for (let px = pxS; px < pxE; px++) out[rowO + px] = 0;
            continue;
          }
          const fy = wy - 0.5 - gy;
          const ay = 1 - fy;
          const grow = ((gyb + py) & (GRAIN - 1)) * GRAIN;
          let cyOk = false;
          for (let px = pxS; px < pxE; px++) {
            const wx = ox + (px0 + px + 0.5) * inv;
            const o = rowO + px;
            if (wx >= W) {
              out[o] = 0;
              continue;
            }
            const fx = wx - 0.5 - gx;
            const ax = 1 - fx;
            const w00 = ax * ay, w10 = fx * ay, w01 = ax * fy, w11 = fx * fy;
            const d = s00 * w00 + s10 * w10 + s01 * w01 + s11 * w11;
            let cov = d * S + 0.5;
            cov = cov < 0 ? 0 : cov > 1 ? 1 : cov;
            const gn = gr[grow + ((gxb + px) & (GRAIN - 1))] * gAmp;
            let r = 0, g = 0, b = 0;
            if (cov < 1) {
              let k = (-d * 8) | 0;
              k = k < 0 ? 0 : k > 255 ? 255 : k;
              k *= 3;
              r = L[k] + gn * 0.35;
              g = L[k + 1] + gn * 0.35;
              b = L[k + 2] + gn * 0.35;
              const dw = -d * S;
              if (dw < foamW) {
                const f = (1 - (dw < 0 ? 0 : dw) / foamW) * foamA;
                r += (foam[0] - r) * f;
                g += (foam[1] - g) * f;
                b += (foam[2] - b) * f;
              }
            }
            if (cov > 0) {
              let nd = gn * 3, nh = 0, hr = 0;
              if (useDet) {
                const u = wx * 3, v = wy * 3;
                const iu = u | 0, iv = v | 0;
                const fu = u - iu, fv = v - iv;
                const a0 = (iv & 255) << 8, a1 = ((iv + 1) & 255) << 8;
                const b0 = iu & 255, b1 = (iu + 1) & 255;
                const n0 = det[a0 + b0] + (det[a0 + b1] - det[a0 + b0]) * fu;
                const n1 = det[a1 + b0] + (det[a1 + b1] - det[a1 + b0]) * fu;
                nd = n0 + (n1 - n0) * fv;
              }
              if (useHf) {
                const u = wx * 11 + 97, v = wy * 11 + 131;
                const iu = u | 0, iv = v | 0;
                const fu = u - iu, fv = v - iv;
                const a0 = (iv & 255) << 8, a1 = ((iv + 1) & 255) << 8;
                const b0 = iu & 255, b1 = (iu + 1) & 255;
                const n0 = det[a0 + b0] + (det[a0 + b1] - det[a0 + b0]) * fu;
                const n1 = det[a1 + b0] + (det[a1 + b1] - det[a1 + b0]) * fu;
                hr = n0 + (n1 - n0) * fv;
                const slope = (det[a0 + b1] - det[a0 + b0]) + (det[a1 + b0] - det[a0 + b0]);
                nh = (hr * 0.6 - slope * 0.5) * texK * (tamp[i00] * w00 + tamp[i10] * w10 + tamp[i01] * w01 + tamp[i11] * w11);
              }
              const dn = gn + nd * detA + nh;
              const wn = nd * warpK + hr * warpH;
              const kk = k00 * w00 + k10 * w10 + k01 * w01 + k11 * w11;
              let lr, lg, lb;
              if (useBio) {
                if (!colOk) {
                  colOk = true;
                  const c0 = cl(gx - 1, W - 1), c3 = cl(gx + 2, W - 1);
                  let q = 0;
                  for (let j = 0; j < 4; j++) {
                    const rr = j === 0 ? r0 : j === 1 ? ra : j === 2 ? rb : r3;
                    for (let k = 0; k < 4; k++) {
                      const id = rr + (k === 0 ? c0 : k === 1 ? xa : k === 2 ? xb : c3);
                      k16[q++] = land[id] ? terr[id] : 0;
                    }
                  }
                  pkc = -1;
                  const p0 = k16[5], p1 = k16[6], p2 = k16[9], p3 = k16[10];
                  const base = p0 || p1 || p2 || p3;
                  uniK = (!p0 || p0 === base) && (!p1 || p1 === base) && (!p2 || p2 === base) && (!p3 || p3 === base);
                  for (let k = 0; k < 4; k++) {
                    const cv = lc0[k === 0 ? i00 : k === 1 ? i10 : k === 2 ? i01 : i11];
                    c12[k] = cv & 255;
                    c12[k + 4] = (cv >> 8) & 255;
                    c12[k + 8] = (cv >> 16) & 255;
                  }
                }
                let tx = fx + wn, ty = fy - wn;
                tx = tx < 0 ? 0 : tx > 1 ? 1 : tx;
                ty = ty < 0 ? 0 : ty > 1 ? 1 : ty;
                const bx = 1 - tx, by = 1 - ty;
                const u00 = bx * by, u10 = tx * by, u01 = bx * ty, u11 = tx * ty;
                let B = 0;
                if (uniK) {
                  lr = c12[0] * u00 + c12[1] * u10 + c12[2] * u01 + c12[3] * u11;
                  lg = c12[4] * u00 + c12[5] * u10 + c12[6] * u01 + c12[7] * u11;
                  lb = c12[8] * u00 + c12[9] * u10 + c12[10] * u01 + c12[11] * u11;
                } else {
                  top2(k16[5], u00, k16[6], u10, k16[9], u01, k16[10], u11);
                  B = T2B;
                  maskMix(c12, k16[5], u00, k16[6], u10, k16[9], u01, k16[10], u11, T2A);
                  lr = MIX[0]; lg = MIX[1]; lb = MIX[2];
                }
                if (B) {
                  const A = T2A;
                  const key = A * 16 + B;
                  if (key !== pkc) {
                    pkc = key;
                    for (let q = 0; q < 16; q++) s16[q] = k16[q] === A ? 1 : k16[q] === B ? -1 : 0;
                  }
                  splineW(tx, SPX);
                  splineW(ty, SPY);
                  const a0 = SPX[0], a1 = SPX[1], a2 = SPX[2], a3 = SPX[3], d0 = SPX[4], d1 = SPX[5], d2 = SPX[6], d3 = SPX[7];
                  const e0 = SPY[0], e1 = SPY[1], e2 = SPY[2], e3 = SPY[3], h0 = SPY[4], h1 = SPY[5], h2 = SPY[6], h3 = SPY[7];
                  const f = crMix(s16, 0, a0, a1, a2, a3, e0, e1, e2, e3);
                  const gxv = crMix(s16, 0, d0, d1, d2, d3, e0, e1, e2, e3);
                  const gyv = crMix(s16, 0, a0, a1, a2, a3, h0, h1, h2, h3);
                  const gl = Math.sqrt(gxv * gxv + gyv * gyv);
                  const dpx = gl > 1e-6 ? (f / gl) * S : f > 0 ? 1e9 : -1e9;
                  let m = (dpx + bwT) / (2 * bwT);
                  m = m < 0 ? 0 : m > 1 ? 1 : m;
                  m = m * m * (3 - 2 * m);
                  if (m < 1) {
                    const ar = lr, ag = lg, ab = lb;
                    maskMix(c12, k16[5], u00, k16[6], u10, k16[9], u01, k16[10], u11, B);
                    lr = MIX[0] + (ar - MIX[0]) * m;
                    lg = MIX[1] + (ag - MIX[1]) * m;
                    lb = MIX[2] + (ab - MIX[2]) * m;
                  }
                }
                lr = lr * kk + dn;
                lg = lg * kk + dn;
                lb = lb * kk + dn;
              } else {
                let qx = (fx - 0.5) * sharpK + 0.5 + wn;
                qx = qx < 0 ? 0 : qx > 1 ? 1 : qx;
                let qy = (fy - 0.5) * sharpK + 0.5 - wn;
                qy = qy < 0 ? 0 : qy > 1 ? 1 : qy;
                const ex = 1 - qx, ey = 1 - qy;
                const v00 = ex * ey, v10 = qx * ey, v01 = ex * qy, v11 = qx * qy;
                lr = (r00 * v00 + r10 * v10 + r01 * v01 + r11 * v11) * kk + dn;
                lg = (g00 * v00 + g10 * v10 + g01 * v01 + g11 * v11) * kk + dn;
                lb = (b00 * v00 + b10 * v10 + b01 * v01 + b11 * v11) * kk + dn;
              }
              if (anyW) {
                const ds = d * S;
                if (ds < shoreW) {
                  const k = 0.86 + 0.14 * (ds < 0 ? 0 : ds / shoreW);
                  lr *= k; lg *= k; lb *= k;
                }
              }
              if (cov < 1) {
                r += (lr - r) * cov;
                g += (lg - g) * cov;
                b += (lb - b) * cov;
              } else {
                r = lr; g = lg; b = lb;
              }
              if (own) {
                let oA = o00, dp = 1e9;
                if (!uni) {
                  let best = o00, bw = w00 + (o10 === o00 ? w10 : 0) + (o01 === o00 ? w01 : 0) + (o11 === o00 ? w11 : 0);
                  let t = (o10 === o00 ? 0 : w10) + (o01 === o10 ? w01 : 0) + (o11 === o10 ? w11 : 0);
                  if (o10 !== o00 && t > bw) { best = o10; bw = t; }
                  t = (o01 === o00 || o01 === o10 ? 0 : w01) + (o11 === o01 ? w11 : 0);
                  if (o01 !== o00 && o01 !== o10 && t > bw) { best = o01; bw = t; }
                  t = o11 === o00 || o11 === o10 || o11 === o01 ? 0 : w11;
                  if (o11 !== o00 && o11 !== o10 && o11 !== o01 && t > bw) { best = o11; bw = t; }
                  oA = best;
                  let oB = -1, sb = -1;
                  const c00 = o00 === oA ? -1 : w00 + (o10 === o00 ? w10 : 0) + (o01 === o00 ? w01 : 0) + (o11 === o00 ? w11 : 0);
                  if (c00 > sb) { sb = c00; oB = o00; }
                  const c10 = o10 === oA || o10 === o00 ? -1 : w10 + (o01 === o10 ? w01 : 0) + (o11 === o10 ? w11 : 0);
                  if (c10 > sb) { sb = c10; oB = o10; }
                  const c01 = o01 === oA || o01 === o00 || o01 === o10 ? -1 : w01 + (o11 === o01 ? w11 : 0);
                  if (c01 > sb) { sb = c01; oB = o01; }
                  const c11 = o11 === oA || o11 === o00 || o11 === o10 || o11 === o01 ? -1 : w11;
                  if (c11 > sb) { sb = c11; oB = o11; }
                  if (oB >= 0 && !useCR) {
                    const q00 = o00 === oA ? 1 : o00 === oB ? -1 : 0;
                    const q10 = o10 === oA ? 1 : o10 === oB ? -1 : 0;
                    const q01 = o01 === oA ? 1 : o01 === oB ? -1 : 0;
                    const q11 = o11 === oA ? 1 : o11 === oB ? -1 : 0;
                    const f = q00 * w00 + q10 * w10 + q01 * w01 + q11 * w11;
                    const gxv = (q10 - q00) * ay + (q11 - q01) * fy;
                    const gyv = (q01 - q00) * ax + (q11 - q10) * fx;
                    const gl = Math.sqrt(gxv * gxv + gyv * gyv);
                    dp = gl > 1e-6 ? (f / gl) * S : 1e9;
                  } else if (oB >= 0) {
                    if (!ccOk) {
                      ccOk = true;
                      const c0 = cl(gx - 1, W - 1), c3 = cl(gx + 2, W - 1);
                      let q = 0;
                      for (let j = 0; j < 4; j++) {
                        const rr = j === 0 ? r0 : j === 1 ? ra : j === 2 ? rb : r3;
                        let id = rr + c0; cc[q++] = land[id] ? own[id] : -1;
                        id = rr + xa; cc[q++] = land[id] ? own[id] : -1;
                        id = rr + xb; cc[q++] = land[id] ? own[id] : -1;
                        id = rr + c3; cc[q++] = land[id] ? own[id] : -1;
                      }
                    }
                    const key = oA * 65536 + oB;
                    if (key !== pk) {
                      pk = key;
                      for (let q = 0; q < 16; q++) sc[q] = cc[q] === oA ? 1 : cc[q] === oB ? -1 : 0;
                    }
                    if (!cyOk) {
                      cyOk = true;
                      const v2 = fy * fy, v3 = v2 * fy;
                      cy[0] = 0.5 * (-v3 + 2 * v2 - fy); cy[1] = 0.5 * (3 * v3 - 5 * v2 + 2);
                      cy[2] = 0.5 * (-3 * v3 + 4 * v2 + fy); cy[3] = 0.5 * (v3 - v2);
                      cy[4] = 0.5 * (-3 * v2 + 4 * fy - 1); cy[5] = 0.5 * (9 * v2 - 10 * fy);
                      cy[6] = 0.5 * (-9 * v2 + 8 * fy + 1); cy[7] = 0.5 * (3 * v2 - 2 * fy);
                    }
                    const t2 = fx * fx, t3 = t2 * fx;
                    const wx0 = 0.5 * (-t3 + 2 * t2 - fx), wx1 = 0.5 * (3 * t3 - 5 * t2 + 2), wx2 = 0.5 * (-3 * t3 + 4 * t2 + fx), wx3 = 0.5 * (t3 - t2);
                    const dx0 = 0.5 * (-3 * t2 + 4 * fx - 1), dx1 = 0.5 * (9 * t2 - 10 * fx), dx2 = 0.5 * (-9 * t2 + 8 * fx + 1), dx3 = 0.5 * (3 * t2 - 2 * fx);
                    const R0 = wx0 * sc[0] + wx1 * sc[1] + wx2 * sc[2] + wx3 * sc[3];
                    const R1 = wx0 * sc[4] + wx1 * sc[5] + wx2 * sc[6] + wx3 * sc[7];
                    const R2 = wx0 * sc[8] + wx1 * sc[9] + wx2 * sc[10] + wx3 * sc[11];
                    const R3 = wx0 * sc[12] + wx1 * sc[13] + wx2 * sc[14] + wx3 * sc[15];
                    const D0 = dx0 * sc[0] + dx1 * sc[1] + dx2 * sc[2] + dx3 * sc[3];
                    const D1 = dx0 * sc[4] + dx1 * sc[5] + dx2 * sc[6] + dx3 * sc[7];
                    const D2 = dx0 * sc[8] + dx1 * sc[9] + dx2 * sc[10] + dx3 * sc[11];
                    const D3 = dx0 * sc[12] + dx1 * sc[13] + dx2 * sc[14] + dx3 * sc[15];
                    let f = cy[0] * R0 + cy[1] * R1 + cy[2] * R2 + cy[3] * R3;
                    let gxv = cy[0] * D0 + cy[1] * D1 + cy[2] * D2 + cy[3] * D3;
                    let gyv = cy[4] * R0 + cy[5] * R1 + cy[6] * R2 + cy[7] * R3;
                    if (f < 0) {
                      oA = oB;
                      f = -f;
                      gxv = -gxv;
                      gyv = -gyv;
                    }
                    const gl = Math.sqrt(gxv * gxv + gyv * gyv);
                    dp = gl > 1e-6 ? (f / gl) * S : 1e9;
                  }
                }
                if (oA) {
                  if (anyW) {
                    const dc = d * S;
                    if (dc < dp) dp = dc;
                  }
                  const q = oA * 3;
                  let cr = pF[q], cg = pF[q + 1], cb = pF[q + 2], a = fillA;
                  if (dp < bwR + 1) {
                    let tR = bwR - dp + 0.5;
                    tR = tR < 0 ? 0 : tR > 1 ? 1 : tR;
                    let tD = bwD - dp + 0.5;
                    tD = tD < 0 ? 0 : tD > 1 ? 1 : tD;
                    cr += (pR[q] - cr) * tR; cg += (pR[q + 1] - cg) * tR; cb += (pR[q + 2] - cb) * tR; a += (rimA - a) * tR;
                    cr += (pD[q] - cr) * tD; cg += (pD[q + 1] - cg) * tD; cb += (pD[q + 2] - cb) * tD; a += (darkA - a) * tD;
                    let e = dp + 0.5;
                    e = e < 0 ? 0 : e > 1 ? 1 : e;
                    a *= e;
                  }
                  a *= cov;
                  r += (cr - r) * a;
                  g += (cg - g) * a;
                  b += (cb - b) * a;
                }
                if (anyF) {
                  const F = f00 * w00 + f10 * w10 + f01 * w01 + f11 * w11;
                  const fd = (F - 0.5) * S;
                  let fc = fd * 0.9 + 0.5;
                  fc = fc < 0 ? 0 : fc > 1 ? 1 : fc;
                  if (fc > 0) {
                    const k0 = fc * cov;
                    let ba = fA * 0.55 * k0;
                    r += (fLo[0] - r) * ba;
                    g += (fLo[1] - g) * ba;
                    b += (fLo[2] - b) * ba;
                    const ph = (gxb + px + gyb + py) % fPer;
                    let sa = fPer * 0.3 - ph;
                    sa = sa < 0 ? 0 : sa > 1 ? 1 : sa;
                    let eg = 1 - fd / fRim;
                    eg = eg < 0 ? 0 : eg > 1 ? 1 : eg;
                    ba = (fA * 0.8 * sa + 0.75 * eg * eg) * k0;
                    if (ba > 1) ba = 1;
                    if (ba > 0) {
                      r += (fHi[0] - r) * ba;
                      g += (fHi[1] - g) * ba;
                      b += (fHi[2] - b) * ba;
                    }
                  }
                }
              }
            }
            r = r < 0 ? 0 : r > 255 ? 255 : r;
            g = g < 0 ? 0 : g > 255 ? 255 : g;
            b = b < 0 ? 0 : b > 255 ? 255 : b;
            out[o] = (0xff000000 | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0)) >>> 0;
          }
        }
      }
    }
    ch.ctx.putImageData(this.blockImg, px0, py0);
  }

  drawProxy(ctx, ch, ax, ay, bx, by, keep) {
    const S = ch.S;
    if (S > LEVELS[0]) {
      const p = this.chunks.get((S / 2) * 1e8 + (ch.cy >> 1) * 1e4 + (ch.cx >> 1));
      if (p && !p.fresh) {
        keep.add(p.key);
        const h = CH / 2;
        ctx.drawImage(p.canvas, (ch.cx & 1) * h, (ch.cy & 1) * h, h, h, ax, ay, bx - ax, by - ay);
        return true;
      }
    }
    if (S < LEVELS[LEVELS.length - 1]) {
      const kids = [];
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 2; i++) {
          const k = this.chunks.get(S * 2 * 1e8 + (ch.cy * 2 + j) * 1e4 + ch.cx * 2 + i);
          if (!k || k.fresh) return false;
          kids.push(k);
        }
      }
      const mx = Math.round((ax + bx) / 2), my = Math.round((ay + by) / 2);
      for (let q = 0; q < 4; q++) {
        const k = kids[q];
        keep.add(k.key);
        const x0 = q & 1 ? mx : ax, y0 = q & 2 ? my : ay, x1 = q & 1 ? bx : mx, y1 = q & 2 ? by : my;
        ctx.drawImage(k.canvas, x0, y0, x1 - x0, y1 - y0);
      }
      return true;
    }
    return false;
  }

  drawMapLayers(ctx) {
    const map = this.map, z = this.cam.z, W = map.W, H = map.H;
    const vw = this.viewW, vh = this.viewH;
    const x0 = Math.max(0, this.cam.x), y0 = Math.max(0, this.cam.y);
    const x1 = Math.min(W, this.cam.x + vw / z), y1 = Math.min(H, this.cam.y + vh / z);
    ctx.fillStyle = this.theme.bg;
    ctx.fillRect(0, 0, vw, vh);
    if (x1 <= x0 || y1 <= y0) return;
    const mx0 = this.sx(0), my0 = this.sy(0), mx1 = this.sx(W), my1 = this.sy(H);
    if (mx0 > 0 || my0 > 0 || mx1 < vw || my1 < vh) {
      const m = 40 * this.dpr;
      const ex0 = Math.max(mx0, -m), ey0 = Math.max(my0, -m), ex1 = Math.min(mx1, vw + m), ey1 = Math.min(my1, vh + m);
      ctx.save();
      ctx.shadowColor = this.theme.edge;
      ctx.shadowBlur = 24 * this.dpr;
      ctx.fillStyle = this.theme.bg;
      ctx.fillRect(ex0, ey0, ex1 - ex0, ey1 - ey0);
      ctx.restore();
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    if (z < CHUNK_Z || !this.game) {
      const sx0 = Math.floor(x0), sy0 = Math.floor(y0);
      const sw = Math.min(W, Math.ceil(x1)) - sx0, sh = Math.min(H, Math.ceil(y1)) - sy0;
      const dx = this.sx(sx0), dy = this.sy(sy0);
      ctx.drawImage(this.baseCanvas, sx0, sy0, sw, sh, dx, dy, sw * z, sh * z);
      if (this.game) ctx.drawImage(this.terrCanvas, sx0, sy0, sw, sh, dx, dy, sw * z, sh * z);
      this.stats.chunks = 0;
      return;
    }
    const S = this.levelFor(z), C = CH / S;
    const cxa = Math.floor(x0 / C), cxb = Math.floor((x1 - 1e-6) / C);
    const cya = Math.floor(y0 / C), cyb = Math.floor((y1 - 1e-6) / C);
    const keep = new Set();
    const vis = [];
    const ccx = this.cam.x + vw / z / 2, ccy = this.cam.y + vh / z / 2;
    for (let cy = cya; cy <= cyb; cy++) {
      for (let cx = cxa; cx <= cxb; cx++) {
        const ch = this.getChunk(S, cx, cy);
        ch.used = this.frame;
        keep.add(ch.key);
        const dx = (cx + 0.5) * C - ccx, dy = (cy + 0.5) * C - ccy;
        ch.dist = dx * dx + dy * dy;
        vis.push(ch);
      }
    }
    vis.sort((a, b) => a.dist - b.dist);
    const t0 = now();
    let blocks = 0;
    const budget = this.anim || this.keys.x || this.keys.y ? this.budgetMs * 0.45 : this.budgetMs;
    outer: for (const ch of vis) {
      if (!ch.pending) continue;
      for (let b = 0; b < NBLK; b++) {
        if (!ch.todo[b]) continue;
        if (blocks >= 2 && now() - t0 > budget) break outer;
        this.renderBlock(ch, b);
        ch.todo[b] = 0;
        ch.pending--;
        if (ch.fresh) ch.fresh--;
        blocks++;
      }
    }
    this.stats.chunkMs = now() - t0;
    this.stats.blocks = blocks;
    this.stats.chunks = vis.length;
    for (const ch of vis) {
      const wx0 = ch.cx * C, wy0 = ch.cy * C;
      const ax = Math.round(this.sx(wx0)), ay = Math.round(this.sy(wy0));
      const bx = Math.round(this.sx(wx0 + C)), by = Math.round(this.sy(wy0 + C));
      if (ch.fresh && !this.drawProxy(ctx, ch, ax, ay, bx, by, keep)) {
        const sw = Math.min(C, W - wx0), sh = Math.min(C, H - wy0);
        if (sw > 0 && sh > 0) {
          const ex = Math.round(this.sx(wx0 + sw)), ey = Math.round(this.sy(wy0 + sh));
          ctx.drawImage(this.baseCanvas, wx0, wy0, sw, sh, ax, ay, ex - ax, ey - ay);
          ctx.drawImage(this.terrCanvas, wx0, wy0, sw, sh, ax, ay, ex - ax, ey - ay);
        }
      }
      if (ch.fresh < NBLK) ctx.drawImage(ch.canvas, ax, ay, bx - ax, by - ay);
    }
    this.evictChunks(keep);
  }

  draw(session, dt = 1 / 60) {
    const t0 = now();
    dt = clamp(Number(dt) || 0, 0, 0.25);
    this.time += dt;
    this.frame++;
    this.resize();
    const game = session && session.game;
    this.session = session;
    this.localPid = session && Number.isInteger(session.localPid) ? session.localPid : -1;
    if (game && game !== this.game) this.bindGame(game);
    if (!this.map) {
      this.ctx.fillStyle = this.theme.bg;
      this.ctx.fillRect(0, 0, this.viewW, this.viewH);
      return;
    }
    this.stepCamera(dt);
    const s = game ? game.s : null;
    if (game) {
      const sig = this.allySignature();
      if (sig !== this.allyKey) {
        this.buildPalette();
        this.rebuildTerritory();
      }
      const dd = typeof game.drainDirty === 'function' ? game.drainDirty() : { all: false, tiles: game.dirty || [] };
      this.stats.dirty = dd.all ? -1 : dd.tiles.length;
      if (dd.all) this.rebuildTerritory();
      else if (dd.tiles.length) this.applyDirty(dd.tiles);
      this.flushTerritory();
      this.trackUnits(s);
    }
    const alpha = session && typeof session.alpha === 'function' ? clamp(session.alpha(), 0, 1) : 1;
    this.alpha = alpha;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    let shx = 0, shy = 0;
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt);
      const a = this.shake * 9 * this.dpr;
      shx = (Math.random() - 0.5) * a;
      shy = (Math.random() - 0.5) * a;
      ctx.setTransform(1, 0, 0, 1, shx, shy);
    }
    this.drawMapLayers(ctx);
    if (s) {
      if (this.showAA || (this.mode && this.mode.kind === 'strike')) this.drawAA(ctx, s);
      this.drawSpawn(ctx, s);
      this.drawRails(ctx, s);
      this.drawRoutes(ctx, s);
      this.drawBuildings(ctx, s);
      this.drawUnits(ctx, s);
      this.drawHover(ctx, s);
      this.drawSelection(ctx, s);
      this.drawOrders(ctx);
      if (this.showLabels) this.drawLabels(ctx, s, dt);
      this.drawMode(ctx, s);
      this.drawProjectiles(ctx, s);
    }
    this.drawFx(ctx, dt);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawBox(ctx);
    if (this.flash > 0.001) {
      ctx.fillStyle = `rgba(255,248,230,${Math.min(0.6, this.flash)})`;
      ctx.fillRect(0, 0, this.viewW, this.viewH);
      this.flash *= Math.exp(-dt * 5.5);
    }
    this.stats.drawMs = now() - t0;
  }

  inView(x, y, m = 0) {
    const sx = this.sx(x), sy = this.sy(y);
    return sx > -m && sy > -m && sx < this.viewW + m && sy < this.viewH + m;
  }

  trackUnits(s) {
    if (s.tick === this.uTick) return;
    const tk = s.tick;
    for (const u of s.units) {
      let r = this.uPos.get(u.id);
      if (!r) {
        r = { px: u.x, py: u.y, x: u.x, y: u.y, ph: u.heading || 0, h: u.heading || 0, t: tk };
        this.uPos.set(u.id, r);
      } else {
        const jump = Math.abs(u.x - r.x) + Math.abs(u.y - r.y) > 30;
        r.px = jump ? u.x : r.x;
        r.py = jump ? u.y : r.y;
        r.ph = r.h;
        r.x = u.x;
        r.y = u.y;
        r.h = u.heading || 0;
        r.t = tk;
      }
    }
    for (const [id, r] of this.uPos) if (r.t !== tk) this.uPos.delete(id);
    this.uTick = tk;
  }

  unitPos(u) {
    const r = this.uPos.get(u.id);
    const a = this.alpha;
    if (!r) return [u.x, u.y, u.heading || 0];
    return [r.px + (r.x - r.px) * a, r.py + (r.y - r.py) * a, r.ph + wrapPi(r.h - r.ph) * a];
  }

  relColor(owner) {
    const th = this.theme, me = this.localPid, g = this.game;
    if (owner === me) return th.aaOwn;
    if (me >= 0 && g && !g.isHostile(me, owner)) return th.aaAlly;
    return th.aaEnemy;
  }

  drawAA(ctx, s) {
    const z = this.cam.z, dpr = this.dpr;
    ctx.save();
    for (const b of s.buildings) {
      if (b.type !== 'sam') continue;
      const R = SAM.radius(b.level || 1);
      const x = b.x + 0.5, y = b.y + 0.5;
      if (!this.inView(x, y, R * z + 4)) continue;
      const c = this.relColor(b.owner);
      const active = b.build === 0 || b.up;
      const sx = this.sx(x), sy = this.sy(y), r = R * z;
      ctx.fillStyle = rgba(c, active ? 0.09 : 0.04);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = rgba(c, active ? 0.85 : 0.45);
      ctx.lineWidth = 2 * dpr;
      ctx.setLineDash([7 * dpr, 5 * dpr]);
      ctx.lineDashOffset = -this.time * 10 * dpr;
      ctx.stroke();
    }
    ctx.restore();
  }

  drawSpawn(ctx, s) {
    if (s.phase !== 'spawn') return;
    const z = this.cam.z, dpr = this.dpr, th = this.theme, me = this.localPid;
    ctx.save();
    for (const p of s.players) {
      if (!(p.capital >= 0)) continue;
      const W = this.map.W;
      const x = (p.capital % W) + 0.5, y = Math.floor(p.capital / W) + 0.5;
      const sx = this.sx(x), sy = this.sy(y);
      const c = hexToRgb(p.color);
      if (p.id !== me) {
        ctx.strokeStyle = rgba(th.bad, 0.45);
        ctx.lineWidth = 1.2 * dpr;
        ctx.setLineDash([5 * dpr, 6 * dpr]);
        ctx.beginPath();
        ctx.arc(sx, sy, ECON.spawnMinDist * z, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const pulse = (this.time * 0.9 + p.id * 0.13) % 1;
      ctx.strokeStyle = rgba(c, 1 - pulse);
      ctx.lineWidth = 2.5 * dpr;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(8 * dpr, (ECON.spawnRadius + 1) * z) * (1 + pulse * 0.8), 0, TAU);
      ctx.stroke();
      ctx.fillStyle = rgbStr(c);
      ctx.strokeStyle = th.ring;
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.arc(sx, sy, (p.id === me ? 6 : 4.5) * dpr, 0, TAU);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  drawRails(ctx, s) {
    if (!s.rails.length) return;
    const z = this.cam.z, dpr = this.dpr, th = this.theme, g = this.game;
    ctx.save();
    ctx.lineCap = 'round';
    const segs = [];
    for (const r of s.rails) {
      const a = g.buildingById(r.a), b = g.buildingById(r.b);
      if (!a || !b) continue;
      const c = this.clipSeg(a.x + 0.5, a.y + 0.5, b.x + 0.5, b.y + 0.5, 4);
      if (c) segs.push([a.x + 0.5, a.y + 0.5, b.x + 0.5, b.y + 0.5, c, r.owner]);
    }
    if (z < 2.2) {
      ctx.lineWidth = Math.max(1.4 * dpr, z * 0.45);
      ctx.strokeStyle = rgba(th.rail, 0.85);
      ctx.beginPath();
      for (const [ax, ay, bx, by] of segs) {
        ctx.moveTo(this.sx(ax), this.sy(ay));
        ctx.lineTo(this.sx(bx), this.sy(by));
      }
      ctx.stroke();
      ctx.lineWidth = Math.max(0.6 * dpr, z * 0.16);
      ctx.strokeStyle = rgba(th.railHi, 0.8);
      ctx.stroke();
      ctx.restore();
      return;
    }
    const gauge = clamp(z * 0.3, 1.8 * dpr, 9 * dpr);
    const tieL = gauge * 1.85;
    const step = clamp(z * 0.55, 7 * dpr, 18 * dpr);
    ctx.strokeStyle = rgba(th.tie, 0.95);
    ctx.lineWidth = clamp(z * 0.1, 1.3 * dpr, 4.5 * dpr);
    ctx.lineCap = 'butt';
    ctx.beginPath();
    for (const [ax, ay, bx, by, cl] of segs) {
      const X0 = this.sx(ax), Y0 = this.sy(ay), X1 = this.sx(bx), Y1 = this.sy(by);
      const L = Math.hypot(X1 - X0, Y1 - Y0);
      if (L < 1) continue;
      const ux = (X1 - X0) / L, uy = (Y1 - Y0) / L, nx = -uy * tieL / 2, ny = ux * tieL / 2;
      const t0 = Math.floor((cl[0] * L) / step) * step, t1 = cl[1] * L;
      for (let t = t0 + step / 2; t <= t1; t += step) {
        const px = X0 + ux * t, py = Y0 + uy * t;
        ctx.moveTo(px - nx, py - ny);
        ctx.lineTo(px + nx, py + ny);
      }
    }
    ctx.stroke();
    ctx.lineCap = 'round';
    ctx.lineWidth = clamp(z * 0.07, 1.1 * dpr, 3 * dpr);
    ctx.strokeStyle = rgba(th.rail, 1);
    ctx.beginPath();
    for (const [ax, ay, bx, by] of segs) {
      const X0 = this.sx(ax), Y0 = this.sy(ay), X1 = this.sx(bx), Y1 = this.sy(by);
      const L = Math.hypot(X1 - X0, Y1 - Y0);
      if (L < 1) continue;
      const nx = (-(Y1 - Y0) / L) * gauge / 2, ny = ((X1 - X0) / L) * gauge / 2;
      ctx.moveTo(X0 + nx, Y0 + ny);
      ctx.lineTo(X1 + nx, Y1 + ny);
      ctx.moveTo(X0 - nx, Y0 - ny);
      ctx.lineTo(X1 - nx, Y1 - ny);
    }
    ctx.stroke();
    ctx.restore();
  }

  clipSeg(ax, ay, bx, by, m) {
    const z = this.cam.z;
    return clipLine(ax, ay, bx, by, this.cam.x - m, this.cam.y - m, this.cam.x + this.viewW / z + m, this.cam.y + this.viewH / z + m);
  }

  tracePath(ctx, x, y, path, from) {
    const m = 12 * this.dpr, x1 = this.viewW + m, y1 = this.viewH + m;
    let ax = this.sx(x), ay = this.sy(y), open = false;
    for (let k = from; k < path.length; k++) {
      const bx = this.sx(path[k][0]), by = this.sy(path[k][1]);
      const c = clipLine(ax, ay, bx, by, -m, -m, x1, y1);
      if (c) {
        if (!open || c[0] > 0) ctx.moveTo(ax + (bx - ax) * c[0], ay + (by - ay) * c[0]);
        ctx.lineTo(ax + (bx - ax) * c[1], ay + (by - ay) * c[1]);
        open = c[1] >= 1;
      } else open = false;
      ax = bx;
      ay = by;
    }
  }

  drawRoutes(ctx, s) {
    const th = this.theme, dpr = this.dpr, z = this.cam.z, me = this.localPid;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([3.5 * dpr, 5.5 * dpr]);
    ctx.lineDashOffset = -this.time * 14 * dpr;
    ctx.lineWidth = clamp(z * 0.22, 1.1 * dpr, 2.6 * dpr);
    ctx.strokeStyle = rgba(th.route, th.routeA);
    ctx.beginPath();
    for (const u of s.units) {
      if (u.type !== 'trade' || !u.path || u.pi >= u.path.length) continue;
      const [x, y] = this.unitPos(u);
      this.tracePath(ctx, x, y, u.path, u.pi);
    }
    ctx.stroke();
    for (const u of s.units) {
      if (u.type !== 'transport' || !u.path || u.pi >= u.path.length) continue;
      const mine = u.owner === me;
      const tgt = this.game && u.target >= 0 ? this.game.tileOwner(u.target) : -1;
      if (!mine && tgt !== me) continue;
      const c = mine ? hexToRgb(s.players[u.owner].color) : th.bad;
      ctx.strokeStyle = rgba(c, 0.75);
      ctx.lineWidth = clamp(z * 0.25, 1.3 * dpr, 3 * dpr);
      ctx.beginPath();
      const [x, y] = this.unitPos(u);
      this.tracePath(ctx, x, y, u.path, u.pi);
      ctx.stroke();
    }
    ctx.restore();
  }

  markerRadius() {
    const z = this.cam.z / this.dpr;
    const r = z < 2 ? 2.2 + z * 1.2 : 2.6 + z * 1.1;
    return Math.round(clamp(r, 2.5, 18) * this.dpr);
  }

  drawBuildings(ctx, s) {
    if (!s.buildings.length) return;
    const th = this.theme, dpr = this.dpr, me = this.localPid;
    const r = this.markerRadius();
    const showIcon = r >= 7 * dpr;
    const sel = this.selection && this.selection.kind === 'building' ? this.selection.id : -1;
    for (const b of s.buildings) {
      const x = this.sx(b.x + 0.5), y = this.sy(b.y + 0.5);
      if (x < -r * 2 || y < -r * 2 || x > this.viewW + r * 2 || y > this.viewH + r * 2) continue;
      const p = s.players[b.owner];
      const color = p ? p.color : '#888888';
      const building = b.build > 0 && !b.up;
      const m = markerCanvas(b.type, color, r, { level: showIcon ? b.level : 0, ring: th.ring, badge: th.badge, badgeText: th.badgeText, icon: showIcon });
      const rr = b.id === sel ? 1.15 : 1;
      ctx.globalAlpha = building ? 0.62 : 1;
      if (rr !== 1) ctx.drawImage(m.c, Math.round(x - m.off * rr), Math.round(y - m.off * rr), m.c.width * rr, m.c.height * rr);
      else ctx.drawImage(m.c, Math.round(x - m.off), Math.round(y - m.off));
      ctx.globalAlpha = 1;
      if (b.build > 0 && b.total > 0) {
        const pr = clamp(1 - (b.build - this.alpha) / b.total, 0, 1);
        this.ring(ctx, x, y, r + 2.2 * dpr, pr, th.progress, 2.6 * dpr);
      } else if (b.owner === me && b.cd > 0 && (b.type === 'silo' || b.type === 'airbase')) {
        const tot = b.type === 'silo' ? siloReload(b.level) : airbaseReload(b.level);
        this.ring(ctx, x, y, r + 2 * dpr, clamp(1 - b.cd / tot, 0, 1), th.reload, 2 * dpr);
      }
    }
  }

  ring(ctx, x, y, r, p, color, w) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = w + 2 * this.dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.stroke();
    ctx.lineWidth = w;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + TAU * p);
    ctx.stroke();
    ctx.restore();
  }

  unitLen(type) {
    const L = UNIT_LEN[type] * this.cam.z;
    return Math.round(clamp(L, UNIT_MIN[type] * this.dpr, UNIT_MAX[type] * this.dpr));
  }

  drawUnits(ctx, s) {
    if (!s.units.length) return;
    const th = this.theme, dpr = this.dpr, z = this.cam.z;
    const sel = this.selectedShips();
    const opts = { hull: th.hull, deck: th.deck };
    ctx.save();
    for (const u of s.units) {
      const L = this.unitLen(u.type);
      if (!L) continue;
      const [x, y, h] = this.unitPos(u);
      const sx = this.sx(x), sy = this.sy(y);
      if (sx < -L || sy < -L || sx > this.viewW + L || sy > this.viewH + L) continue;
      const p = s.players[u.owner];
      const color = p ? p.color : '#888888';
      const ship = u.type === 'warship' || u.type === 'transport' || u.type === 'trade';
      const moving = u.path && u.pi < u.path.length;
      if (ship && moving && z >= 2) {
        ctx.strokeStyle = th.wake;
        ctx.lineWidth = Math.max(1, L * 0.05);
        const bx = Math.cos(h), by = Math.sin(h);
        const tx = sx - bx * L * 0.45, ty = sy - by * L * 0.45;
        const wl = L * 0.7, sp = L * 0.2;
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - bx * wl - by * sp, ty - by * wl + bx * sp);
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - bx * wl + by * sp, ty - by * wl - bx * sp);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      const uc = unitCanvas(u.type, color, L, { ...opts, seed: u.id & 3 });
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(h);
      ctx.drawImage(uc.c, -uc.ox, -uc.oy);
      ctx.restore();
      if (sel.has(u.id)) {
        ctx.strokeStyle = th.select;
        ctx.lineWidth = 2 * dpr;
        ctx.globalAlpha = 0.6 + 0.4 * Math.sin(this.time * 6);
        ctx.beginPath();
        ctx.arc(sx, sy, L * 0.62, 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (u.type === 'warship' && u.maxHp > 0 && u.hp < u.maxHp) {
        const bw = L * 0.8, bh = Math.max(2.5 * dpr, L * 0.07);
        const fr = clamp(u.hp / u.maxHp, 0, 1);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(sx - bw / 2 - 1, sy - L * 0.42 - bh - 1, bw + 2, bh + 2);
        ctx.fillStyle = fr > 0.5 ? rgbStr(th.ok) : fr > 0.25 ? rgbStr(th.warn) : rgbStr(th.bad);
        ctx.fillRect(sx - bw / 2, sy - L * 0.42 - bh, bw * fr, bh);
      }
      if (u.type === 'transport' && u.troops > 0 && L >= 14 * dpr) {
        const fs = Math.round(clamp(L * 0.34, 9 * dpr, 14 * dpr));
        this.tag(ctx, fmtNum(u.troops), sx, sy - L * 0.48 - fs * 0.6, fs, color);
      }
    }
    ctx.restore();
  }

  tag(ctx, text, x, y, fs, color) {
    ctx.font = `700 ${fs}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + fs * 0.7;
    const h = fs * 1.35;
    ctx.fillStyle = 'rgba(8,11,17,0.82)';
    this.roundRect(ctx, x - w / 2, y - h / 2, w, h, h * 0.35);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillRect(x - w / 2 + h * 0.2, y + h / 2 - Math.max(1, fs * 0.12), w - h * 0.4, Math.max(1, fs * 0.12));
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x, y);
  }

  roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  drawHover(ctx, s) {
    let i = this.hoverTile;
    if (Array.isArray(i)) i = this.map && i[0] >= 0 && i[1] >= 0 && i[0] < this.map.W && i[1] < this.map.H ? Math.floor(i[1]) * this.map.W + Math.floor(i[0]) : -1;
    if (!(i >= 0) || !this.map) return;
    const W = this.map.W, z = this.cam.z, dpr = this.dpr;
    const x = i % W, y = (i - x) / W;
    if (z >= 4) {
      ctx.strokeStyle = this.theme.hover;
      ctx.lineWidth = Math.max(1, dpr * 1.2);
      ctx.strokeRect(this.sx(x) + 0.5, this.sy(y) + 0.5, z - 1, z - 1);
    }
    void s;
  }

  drawSelection(ctx, s) {
    const sel = this.selection;
    if (!sel || !this.game) return;
    const th = this.theme, dpr = this.dpr, z = this.cam.z;
    ctx.save();
    if (sel.kind === 'building') {
      const b = this.game.buildingById(sel.id);
      if (b) {
        const x = this.sx(b.x + 0.5), y = this.sy(b.y + 0.5), r = this.markerRadius();
        const pulse = 0.55 + 0.45 * Math.sin(this.time * 5);
        ctx.strokeStyle = th.select;
        ctx.globalAlpha = pulse;
        ctx.lineWidth = 2.2 * dpr;
        ctx.beginPath();
        ctx.arc(x, y, r * 1.15 + 5 * dpr, 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = 1;
        let R = 0;
        if (b.type === 'sam') R = SAM.radius(b.level || 1);
        else if (b.type === 'fort') R = ECON.fortRadius;
        if (R) {
          const c = b.type === 'sam' ? th.aaOwn : th.ok;
          ctx.fillStyle = rgba(c, 0.07);
          ctx.strokeStyle = rgba(c, 0.8);
          ctx.lineWidth = 1.6 * dpr;
          ctx.setLineDash([6 * dpr, 5 * dpr]);
          ctx.beginPath();
          ctx.arc(x, y, R * z, 0, TAU);
          ctx.fill();
          ctx.stroke();
        }
      }
    } else if (sel.kind === 'ship') {
      ctx.strokeStyle = rgba(th.aaOwn, 0.85);
      ctx.lineWidth = 1.8 * dpr;
      const ends = [];
      for (const id of this.selectedShips()) {
        const u = this.game.unitById(id);
        if (!u || !u.path || u.pi >= u.path.length) continue;
        const [x, y] = this.unitPos(u);
        ctx.setLineDash([6 * dpr, 6 * dpr]);
        ctx.lineDashOffset = -this.time * 18 * dpr;
        ctx.beginPath();
        this.tracePath(ctx, x, y, u.path, u.pi);
        ctx.stroke();
        ends.push(u.path[u.path.length - 1]);
      }
      ctx.setLineDash([]);
      ctx.beginPath();
      for (const e of ends) {
        const ex = this.sx(e[0]), ey = this.sy(e[1]);
        ctx.moveTo(ex + 5 * dpr, ey);
        ctx.arc(ex, ey, 5 * dpr, 0, TAU);
      }
      ctx.stroke();
    }
    ctx.restore();
    void s;
  }

  selectedShips() {
    const sel = this.selection;
    if (!sel || sel.kind !== 'ship') return new Set();
    if (this.selKey !== sel) {
      this.selKey = sel;
      this.selSet = new Set(sel.ids || [sel.id]);
    } else if (this.selSet.size !== (sel.ids || [sel.id]).length) this.selSet = new Set(sel.ids || [sel.id]);
    return this.selSet;
  }

  markOrders(points) {
    this.orders = { pts: (points || []).slice(0, 64), t: this.time };
  }

  drawOrders(ctx) {
    const o = this.orders;
    if (!o) return;
    const k = (this.time - o.t) / 0.9;
    if (k >= 1) {
      this.orders = null;
      return;
    }
    const dpr = this.dpr, th = this.theme;
    ctx.save();
    ctx.strokeStyle = rgba(th.aaOwn, 0.9 * (1 - k));
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    for (const [x, y] of o.pts) {
      const sx = this.sx(x), sy = this.sy(y), r = (4 + 9 * easeOut(k)) * dpr;
      ctx.moveTo(sx + r, sy);
      ctx.arc(sx, sy, r, 0, TAU);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawBox(ctx) {
    const b = this.box;
    if (!b) return;
    const dpr = this.dpr, th = this.theme;
    ctx.save();
    ctx.fillStyle = rgba(th.aaOwn, 0.1);
    ctx.strokeStyle = rgba(th.aaOwn, 0.95);
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    ctx.strokeRect(b.x0 + 0.5, b.y0 + 0.5, b.x1 - b.x0, b.y1 - b.y0);
    if (b.n > 0) this.tag(ctx, String(b.n), b.x1, b.y0, Math.round(12 * dpr), rgbStr(th.aaOwn));
    ctx.restore();
  }

  hoverXY() {
    let i = this.hoverTile;
    if (Array.isArray(i)) return [Math.floor(i[0]), Math.floor(i[1])];
    if (!(i >= 0) || !this.map) return null;
    const W = this.map.W;
    return [i % W, Math.floor(i / W)];
  }

  validate(cmd) {
    const g = this.game, me = this.localPid;
    if (!g || me < 0) return { ok: false, error: '' };
    const key = JSON.stringify(cmd) + '|' + g.s.tick;
    if (this.validCache.key === key) return this.validCache;
    let r;
    try {
      r = g.validate(me, cmd);
    } catch (e) {
      r = { ok: false, error: String(e && e.message) };
    }
    this.validCache = { key, ok: !!r.ok, error: r.error || '' };
    return this.validCache;
  }

  drawMode(ctx, s) {
    const m = this.mode;
    const hv = this.hoverXY();
    if (!m || !hv || !this.game) return;
    const th = this.theme, dpr = this.dpr, z = this.cam.z, me = this.localPid, g = this.game;
    const [hx, hy] = hv;
    const cx = this.sx(hx + 0.5), cy = this.sy(hy + 0.5);
    ctx.save();
    if (m.kind === 'build') {
      const v = this.validate({ c: 'build', type: m.type, x: hx, y: hy });
      const col = v.ok ? th.ok : th.bad;
      let R = 0;
      if (m.type === 'sam') R = SAM.radius(1);
      else if (m.type === 'fort') R = ECON.fortRadius;
      if (R) {
        ctx.fillStyle = rgba(col, 0.08);
        ctx.strokeStyle = rgba(col, 0.7);
        ctx.lineWidth = 1.5 * dpr;
        ctx.setLineDash([6 * dpr, 5 * dpr]);
        ctx.beginPath();
        ctx.arc(cx, cy, R * z, 0, TAU);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const md = ECON.buildMinDist;
      if (z >= 2) {
        ctx.strokeStyle = rgba(th.bad, 0.35);
        ctx.lineWidth = dpr;
        for (const b of s.buildings) {
          if (Math.abs(b.x - hx) > md * 3 || Math.abs(b.y - hy) > md * 3) continue;
          const x0 = this.sx(b.x - md + 1), y0 = this.sy(b.y - md + 1);
          ctx.strokeRect(x0, y0, (md * 2 - 1) * z, (md * 2 - 1) * z);
        }
      }
      const r = this.markerRadius();
      const color = s.players[me] ? s.players[me].color : '#888888';
      const mk = markerCanvas(m.type, color, r, { ring: th.ring, icon: r >= 7 * dpr });
      ctx.globalAlpha = 0.78;
      ctx.drawImage(mk.c, Math.round(cx - mk.off), Math.round(cy - mk.off));
      ctx.globalAlpha = 1;
      ctx.strokeStyle = rgbStr(col);
      ctx.lineWidth = 2.4 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 4 * dpr, 0, TAU);
      ctx.stroke();
    } else if (m.kind === 'strike' || STRIKES[m.kind]) {
      const src = g.buildingById(m.from);
      const K = this.modeStrikeKind(m);
      const D = STRIKES[K];
      const v = K ? this.validate({ c: 'strike', kind: K, from: m.from, x: hx, y: hy }) : { ok: false };
      const col = v.ok ? th.ok : th.bad;
      if (src && D) {
        const ax = this.sx(src.x + 0.5), ay = this.sy(src.y + 0.5);
        if (K === 'cruise') {
          const p = s.players[src.owner];
          const rg = cruiseRange(p ? p.research.missile : 1);
          if (Number.isFinite(rg)) {
            ctx.strokeStyle = rgba(th.warn, 0.7);
            ctx.lineWidth = 1.6 * dpr;
            ctx.setLineDash([8 * dpr, 6 * dpr]);
            ctx.beginPath();
            ctx.arc(ax, ay, rg * z, 0, TAU);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
        const dist = Math.hypot(hx + 0.5 - src.x - 0.5, hy + 0.5 - src.y - 0.5);
        const H = this.arcHeight(K, dist) * z;
        ctx.strokeStyle = rgba(col, 0.85);
        ctx.lineWidth = 2 * dpr;
        ctx.setLineDash([7 * dpr, 6 * dpr]);
        ctx.lineDashOffset = -this.time * 24 * dpr;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo((ax + cx) / 2, (ay + cy) / 2 - H * 2, cx, cy);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const R = D && D.r ? (K === 'mega' ? WARHEAD.r : D.r) : 1.5;
      ctx.fillStyle = rgba(col, 0.12);
      ctx.strokeStyle = rgba(col, 0.9);
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(R * z, 7 * dpr), 0, TAU);
      ctx.fill();
      ctx.stroke();
      this.crosshair(ctx, cx, cy, Math.max(R * z, 7 * dpr), col);
    } else if (m.kind === 'boat') {
      const v = this.validate({ c: 'boat', x: hx, y: hy, ratio: 0.3 });
      const col = v.ok ? th.ok : th.bad;
      const plan = this.boatPreview(hx, hy, s.tick);
      if (plan && plan.path && plan.path.length > 1) {
        const P = plan.path, W = this.map.W;
        const lx = (plan.landing % W) + 0.5, ly = Math.floor(plan.landing / W) + 0.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 4 * dpr;
        ctx.beginPath();
        this.tracePath(ctx, P[0][0], P[0][1], P, 1);
        ctx.lineTo(this.sx(lx), this.sy(ly));
        ctx.stroke();
        ctx.strokeStyle = rgba(col, 0.95);
        ctx.lineWidth = 2 * dpr;
        ctx.setLineDash([6 * dpr, 6 * dpr]);
        ctx.lineDashOffset = -this.time * 20 * dpr;
        ctx.beginPath();
        this.tracePath(ctx, P[0][0], P[0][1], P, 1);
        ctx.lineTo(this.sx(lx), this.sy(ly));
        ctx.stroke();
        ctx.setLineDash([]);
        const e = P[P.length - 1], f = P[P.length - 2];
        this.arrowHead(ctx, this.sx(f[0]), this.sy(f[1]), this.sx(e[0]), this.sy(e[1]), 10 * dpr, rgba(col, 0.95));
        const sx0 = this.sx(P[0][0]), sy0 = this.sy(P[0][1]);
        ctx.fillStyle = rgba(col, 0.95);
        ctx.beginPath();
        ctx.arc(sx0, sy0, 3.5 * dpr, 0, TAU);
        ctx.fill();
      } else if (plan && plan.from >= 0) {
        const W = this.map.W, fi = plan.from;
        const fx = this.sx((fi % W) + 0.5), fy = this.sy(Math.floor(fi / W) + 0.5);
        ctx.strokeStyle = rgba(col, 0.85);
        ctx.lineWidth = 2 * dpr;
        ctx.setLineDash([6 * dpr, 6 * dpr]);
        ctx.lineDashOffset = -this.time * 20 * dpr;
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(cx, cy);
        ctx.stroke();
        ctx.setLineDash([]);
        this.arrowHead(ctx, fx, fy, cx, cy, 9 * dpr, rgba(col, 0.95));
      }
      ctx.strokeStyle = rgbStr(col);
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(6 * dpr, z * 0.8), 0, TAU);
      ctx.stroke();
    } else if (m.kind === 'rail') {
      const a = g.buildingById(m.from);
      if (a) {
        const tb = g.buildingAt(hy * this.map.W + hx);
        const v = tb && tb.id !== a.id ? this.validate({ c: 'rail', a: a.id, b: tb.id }) : { ok: false };
        const col = tb ? (v.ok ? th.ok : th.bad) : th.warn;
        const ax = this.sx(a.x + 0.5), ay = this.sy(a.y + 0.5);
        const bx = tb ? this.sx(tb.x + 0.5) : cx, by = tb ? this.sy(tb.y + 0.5) : cy;
        ctx.strokeStyle = rgba(col, 0.9);
        ctx.lineWidth = Math.max(2.5 * dpr, z * 0.3);
        ctx.setLineDash([z >= 3 ? z * 0.35 : 5 * dpr, z >= 3 ? z * 0.25 : 4 * dpr]);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  boatPreview(x, y, tick) {
    const g = this.game, me = this.localPid;
    if (!g || me < 0) return null;
    const key = x + ',' + y + ',' + Math.floor(tick / 5);
    if (this.boatKey === key) return this.boatCache;
    this.boatKey = key;
    let plan = null;
    try {
      const r = boatPlan(g, me, x, y);
      if (r && !r.error) plan = { path: r.path, landing: r.landing, from: r.start };
    } catch (e) {
      plan = null;
    }
    if (!plan) plan = { path: null, landing: -1, from: nearestCoastTile(this.map, g.s.owner, me + 1, x + 0.5, y + 0.5) };
    this.boatCache = plan;
    return plan;
  }

  modeStrikeKind(m) {
    for (const k of ['strike', 'weapon', 'type', 'kind']) if (typeof m[k] === 'string' && STRIKES[m[k]]) return m[k];
    for (const k of Object.keys(m)) if (typeof m[k] === 'string' && STRIKES[m[k]]) return m[k];
    return null;
  }

  crosshair(ctx, x, y, r, col) {
    const dpr = this.dpr;
    ctx.strokeStyle = rgba(col, 0.9);
    ctx.lineWidth = 1.6 * dpr;
    ctx.beginPath();
    const a = r + 4 * dpr, b = Math.max(3 * dpr, r * 0.4);
    ctx.moveTo(x - a, y); ctx.lineTo(x - b, y);
    ctx.moveTo(x + b, y); ctx.lineTo(x + a, y);
    ctx.moveTo(x, y - a); ctx.lineTo(x, y - b);
    ctx.moveTo(x, y + b); ctx.lineTo(x, y + a);
    ctx.stroke();
  }

  arrowHead(ctx, x0, y0, x1, y1, size, color) {
    const a = Math.atan2(y1 - y0, x1 - x0);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - Math.cos(a - 0.45) * size, y1 - Math.sin(a - 0.45) * size);
    ctx.lineTo(x1 - Math.cos(a + 0.45) * size, y1 - Math.sin(a + 0.45) * size);
    ctx.closePath();
    ctx.fill();
  }

  computeLabels(s) {
    const map = this.map, W = map.W, H = map.H, g = this.labelGrid;
    const gw = Math.ceil(W / g), gh = Math.ceil(H / g);
    const n = gw * gh;
    if (!this.lLab || this.lLab.length !== n) {
      this.lLab = new Uint16Array(n);
      this.lDist = new Float32Array(n);
    }
    const lab = this.lLab, d = this.lDist, own = s.owner;
    const half = g >> 1;
    for (let y = 0; y < gh; y++) {
      const yy = Math.min(H - 1, y * g + half);
      for (let x = 0; x < gw; x++) {
        const xx = Math.min(W - 1, x * g + half);
        lab[y * gw + x] = own[yy * W + xx];
      }
    }
    const BIG = 1e9, D = 1.41421356;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x, l = lab[i];
        if (!l) { d[i] = 0; continue; }
        const edge = x === 0 || y === 0 || x === gw - 1 || y === gh - 1 || lab[i - 1] !== l || lab[i + 1] !== l || lab[i - gw] !== l || lab[i + gw] !== l;
        d[i] = edge ? 1 : BIG;
      }
    }
    for (let y = 1; y < gh; y++) {
      for (let x = 1; x < gw - 1; x++) {
        const i = y * gw + x, l = lab[i];
        if (!l) continue;
        let v = d[i];
        if (lab[i - 1] === l && d[i - 1] + 1 < v) v = d[i - 1] + 1;
        if (lab[i - gw] === l && d[i - gw] + 1 < v) v = d[i - gw] + 1;
        if (lab[i - gw - 1] === l && d[i - gw - 1] + D < v) v = d[i - gw - 1] + D;
        if (lab[i - gw + 1] === l && d[i - gw + 1] + D < v) v = d[i - gw + 1] + D;
        d[i] = v;
      }
    }
    for (let y = gh - 2; y >= 0; y--) {
      for (let x = gw - 2; x >= 1; x--) {
        const i = y * gw + x, l = lab[i];
        if (!l) continue;
        let v = d[i];
        if (lab[i + 1] === l && d[i + 1] + 1 < v) v = d[i + 1] + 1;
        if (lab[i + gw] === l && d[i + gw] + 1 < v) v = d[i + gw] + 1;
        if (lab[i + gw + 1] === l && d[i + gw + 1] + D < v) v = d[i + gw + 1] + D;
        if (lab[i + gw - 1] === l && d[i + gw - 1] + D < v) v = d[i + gw - 1] + D;
        d[i] = v;
      }
    }
    const P = s.players.length;
    const best = new Float32Array(P + 1);
    const at = new Int32Array(P + 1).fill(-1);
    for (let i = 0; i < n; i++) {
      const l = lab[i];
      if (l && l <= P && d[i] > best[l]) { best[l] = d[i]; at[l] = i; }
    }
    const seen = new Set();
    for (let p = 0; p < P; p++) {
      const pl = s.players[p];
      if (!pl.alive || !(pl.tiles > 0)) continue;
      let tx, ty, rad;
      if (at[p + 1] >= 0) {
        const i = at[p + 1];
        tx = ((i % gw) + 0.5) * g;
        ty = (Math.floor(i / gw) + 0.5) * g;
        rad = best[p + 1] * g;
      } else if (pl.capital >= 0) {
        tx = (pl.capital % W) + 0.5;
        ty = Math.floor(pl.capital / W) + 0.5;
        rad = Math.sqrt(pl.tiles / Math.PI);
      } else continue;
      seen.add(p);
      const L = this.labels.get(p);
      if (!L) this.labels.set(p, { x: tx, y: ty, tx, ty, r: rad, tr: rad });
      else {
        if (Math.hypot(L.x - tx, L.y - ty) > Math.max(30, rad * 3)) { L.x = tx; L.y = ty; L.r = rad; }
        L.tx = tx; L.ty = ty; L.tr = rad;
      }
    }
    for (const k of [...this.labels.keys()]) if (!seen.has(k)) this.labels.delete(k);
  }

  drawLabels(ctx, s, dt) {
    if (this.time - this.labelAt > 1 || this.labelTick === undefined || (s.tick < 50 && s.tick !== this.labelTick)) {
      this.labelAt = this.time;
      this.labelTick = s.tick;
      this.computeLabels(s);
    }
    const th = this.theme, z = this.cam.z, dpr = this.dpr, me = this.localPid;
    const k = 1 - Math.exp(-dt * 3);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const items = [];
    for (const [p, L] of this.labels) {
      L.x += (L.tx - L.x) * k;
      L.y += (L.ty - L.y) * k;
      L.r += (L.tr - L.r) * k;
      const pl = s.players[p];
      if (!pl || !pl.alive) continue;
      const name = pl.name;
      const len = Math.max(3, name.length);
      const byTiles = Math.sqrt(Math.max(1, pl.tiles)) * 0.17;
      const byRoom = (L.r * 2.1) / (len * 0.62);
      let fs = Math.min(byTiles, byRoom) * z;
      fs = Math.min(fs, 46 * dpr);
      if (p === me) fs = Math.max(fs, 11 * dpr);
      else if (s.phase === 'spawn') fs = Math.max(fs, 9.5 * dpr);
      if (fs < 8.5 * dpr) continue;
      const x = this.sx(L.x), y = this.sy(L.y);
      if (x < -300 * dpr || y < -100 * dpr || x > this.viewW + 300 * dpr || y > this.viewH + 100 * dpr) continue;
      items.push([fs, p, x, y, pl]);
    }
    items.sort((a, b) => a[0] - b[0]);
    for (const [fs, p, x, y, pl] of items) {
      const sub = Math.max(8 * dpr, fs * 0.62);
      const ny = y - sub * 0.42;
      ctx.font = `800 ${fs.toFixed(1)}px ${FONT}`;
      ctx.lineWidth = Math.max(2.5 * dpr, fs * 0.2);
      ctx.strokeStyle = th.labelStroke;
      ctx.strokeText(pl.name, x, ny);
      ctx.fillStyle = th.label;
      ctx.fillText(pl.name, x, ny);
      const traitor = pl.traitorUntil > s.tick;
      ctx.font = `700 ${sub.toFixed(1)}px ${FONT}`;
      ctx.lineWidth = Math.max(2.2 * dpr, sub * 0.24);
      const ty = ny + fs * 0.52 + sub * 0.62;
      const txt = fmtNum(pl.troops);
      ctx.strokeText(txt, x, ty);
      ctx.fillStyle = traitor ? rgbStr(th.warn) : th.labelSub;
      ctx.fillText(txt, x, ty);
      if (p === me || (me >= 0 && this.game.isAllied(me, p))) {
        const tw = ctx.measureText(txt).width;
        const ic = sub * 0.9;
        ctx.fillStyle = p === me ? pl.color : rgbStr(th.aaAlly);
        ctx.strokeStyle = th.labelStroke;
        ctx.lineWidth = Math.max(1.5 * dpr, ic * 0.18);
        ctx.beginPath();
        ctx.arc(x - tw / 2 - ic * 0.75, ty, ic * 0.32, 0, TAU);
        ctx.stroke();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  arcHeight(kind, dist) {
    if (kind === 'drone' || kind === 'kamikaze') return Math.min(dist * 0.14, 7);
    if (kind === 'cruise') return Math.min(dist * 0.18, 22);
    return Math.min(dist * 0.3, 70);
  }

  projPoint(pr, k) {
    const dist = Math.hypot(pr.tx - pr.sx, pr.ty - pr.sy);
    const H = this.arcHeight(pr.type, dist);
    const gx = pr.sx + (pr.tx - pr.sx) * k, gy = pr.sy + (pr.ty - pr.sy) * k;
    return [gx, gy, 4 * k * (1 - k) * H, H];
  }

  drawProjectiles(ctx, s) {
    const list = s.projectiles;
    const live = new Set();
    if (!list.length) {
      if (this.projLast.size) this.projLast.clear();
      return;
    }
    const th = this.theme, z = this.cam.z, dpr = this.dpr, a = this.alpha, me = this.localPid;
    const zk = clamp(z / (3 * dpr), 1, 1.8);
    ctx.save();
    ctx.lineCap = 'round';
    for (const pr of list) {
      if (pr.intercepted) continue;
      const nuke = !!NUKES[pr.type];
      if (!nuke && pr.type !== 'cruise') continue;
      const R = pr.type === 'warhead' ? WARHEAD.r : STRIKES[pr.type] ? STRIKES[pr.type].r : 0;
      const x = this.sx(pr.tx), y = this.sy(pr.ty);
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 7 + pr.id);
      const hostile = pr.owner !== me;
      const col = hostile ? th.bad : th.warn;
      if (nuke && pr.type !== 'mega') {
        const rr = Math.max(R * z, 9 * dpr);
        ctx.fillStyle = rgba(col, 0.06 + pulse * 0.07);
        ctx.strokeStyle = rgba(col, 0.6 + pulse * 0.35);
        ctx.lineWidth = 2 * dpr;
        ctx.setLineDash([6 * dpr, 5 * dpr]);
        ctx.lineDashOffset = this.time * 12 * dpr;
        ctx.beginPath();
        ctx.arc(x, y, rr, 0, TAU);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
        this.crosshair(ctx, x, y, Math.min(rr, 14 * dpr), col);
      } else {
        this.crosshair(ctx, x, y, (pr.type === 'mega' ? 13 : 7) * dpr, col);
      }
    }
    for (const pr of list) {
      if (pr.intercepted) continue;
      live.add(pr.id);
      const nuke = !!NUKES[pr.type];
      const small = pr.type === 'drone' || pr.type === 'kamikaze';
      const k = clamp((pr.t - 1 + a) / Math.max(1, pr.dur), 0, 1);
      const [gx, gy, h] = this.projPoint(pr, k);
      this.projLast.set(pr.id, { x: gx, y: gy, h, type: pr.type, owner: pr.owner });
      const X = this.sx(gx), Y = this.sy(gy) - h * z;
      const pc = s.players[pr.owner] ? hexToRgb(s.players[pr.owner].color) : [200, 200, 200];
      if (!small && k < 1) {
        ctx.strokeStyle = rgba(pr.owner === me ? pc : th.bad, 0.4);
        ctx.lineWidth = 1.4 * dpr;
        ctx.setLineDash([2 * dpr, 6 * dpr]);
        ctx.beginPath();
        const n = 18;
        for (let j = 0; j <= n; j++) {
          const kj = k + ((1 - k) * j) / n;
          const [qx, qy, qh] = this.projPoint(pr, kj);
          const QX = this.sx(qx), QY = this.sy(qy) - qh * z;
          if (j) ctx.lineTo(QX, QY);
          else ctx.moveTo(QX, QY);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath();
      ctx.ellipse(this.sx(gx), this.sy(gy), Math.max(2.5 * dpr, z * 0.5), Math.max(1.4 * dpr, z * 0.28), 0, 0, TAU);
      ctx.fill();
      const span = Math.min(k, (small ? 7 : 16) / Math.max(1, pr.dur));
      const segs = 12;
      let px = X, py = Y;
      const smoke = small ? [205, 215, 225] : [238, 238, 240];
      for (let j = 1; j <= segs; j++) {
        const kj = k - (span * j) / segs;
        if (kj < 0) break;
        const [qx, qy, qh] = this.projPoint(pr, kj);
        const QX = this.sx(qx), QY = this.sy(qy) - qh * z;
        const f = 1 - j / segs;
        ctx.strokeStyle = rgba(smoke, 0.6 * f);
        ctx.lineWidth = Math.max(1, (nuke ? 4.2 : small ? 2.2 : 3) * dpr * zk * (0.35 + f * 0.75));
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(QX, QY);
        ctx.stroke();
        px = QX;
        py = QY;
      }
      const [nx, ny, nh] = this.projPoint(pr, Math.min(1, k + 0.01));
      const ang = Math.atan2(this.sy(ny) - nh * z - Y, this.sx(nx) - X);
      this.drawWarhead(ctx, pr.type, X, Y, ang, pc, zk);
    }
    ctx.restore();
    for (const id of [...this.projLast.keys()]) if (!live.has(id)) this.projLast.delete(id);
  }

  drawWarhead(ctx, type, x, y, ang, col, zk = 1) {
    const dpr = this.dpr;
    const nuke = !!NUKES[type];
    if (nuke) {
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 9);
      const gr = (type === 'hbomb' || type === 'mega' ? 22 : 17) * dpr * zk;
      const g = ctx.createRadialGradient(x, y, 0, x, y, gr);
      g.addColorStop(0, `rgba(255,90,60,${0.35 + pulse * 0.25})`);
      g.addColorStop(1, 'rgba(255,60,40,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, gr, 0, TAU);
      ctx.fill();
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    if (type === 'drone' || type === 'kamikaze') {
      const s = 6.5 * dpr * zk;
      ctx.fillStyle = rgbStr(col);
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 1.3 * dpr;
      ctx.beginPath();
      ctx.moveTo(s * 1.2, 0);
      ctx.lineTo(-s * 0.8, -s);
      ctx.lineTo(-s * 0.35, 0);
      ctx.lineTo(-s * 0.8, s);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      if (type === 'kamikaze') {
        ctx.fillStyle = '#ff5a3a';
        ctx.beginPath();
        ctx.arc(s * 0.3, 0, s * 0.32, 0, TAU);
        ctx.fill();
      }
    } else {
      const L = (nuke ? (type === 'hbomb' || type === 'mega' ? 19 : 15) : 13) * dpr * zk;
      const w = L * (nuke ? 0.4 : 0.24);
      const g = ctx.createRadialGradient(-L * 0.62, 0, 0, -L * 0.62, 0, L * 0.75);
      g.addColorStop(0, 'rgba(255,244,190,0.95)');
      g.addColorStop(0.45, 'rgba(255,150,40,0.6)');
      g.addColorStop(1, 'rgba(255,80,20,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(-L * 0.62, 0, L * (0.6 + 0.15 * Math.sin(this.time * 30)), 0, TAU);
      ctx.fill();
      ctx.fillStyle = nuke ? '#30343c' : '#eef0f3';
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 1.2 * dpr;
      ctx.beginPath();
      ctx.moveTo(L * 0.5, 0);
      ctx.quadraticCurveTo(L * 0.36, -w / 2, L * 0.06, -w / 2);
      ctx.lineTo(-L * 0.42, -w / 2);
      ctx.lineTo(-L * 0.6, -w * 1.05);
      ctx.lineTo(-L * 0.54, 0);
      ctx.lineTo(-L * 0.6, w * 1.05);
      ctx.lineTo(-L * 0.42, w / 2);
      ctx.lineTo(L * 0.06, w / 2);
      ctx.quadraticCurveTo(L * 0.36, w / 2, L * 0.5, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = nuke ? '#ffcf3a' : rgbStr(col);
      ctx.fillRect(-L * 0.14, -w / 2, L * 0.16, w);
      if (nuke) {
        ctx.fillStyle = '#20232a';
        ctx.beginPath();
        ctx.arc(-L * 0.06, 0, w * 0.2, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  airPos(x, y) {
    let best = null, bd = 1e9;
    for (const p of this.projLast.values()) {
      const d = Math.abs(p.x - x) + Math.abs(p.y - y);
      if (d < bd) { bd = d; best = p; }
    }
    return best && bd < 6 ? best : { x, y, h: 0 };
  }

  addEvents(events) {
    if (!events || !events.length || !this.map) return;
    const s = this.game ? this.game.s : null;
    const me = this.localPid;
    for (const e of events) {
      if (!e || typeof e !== 'object') continue;
      switch (e.k) {
        case 'nuke': {
          const r = e.r || 14;
          this.fx.push({ k: 'nuke', x: e.x, y: e.y, r, t: 0, life: 5.5 });
          this.debris(e.x, e.y, 0, Math.min(70, 22 + r), r * 0.75, 'fire', 0.05);
          this.debris(e.x, e.y, 0, Math.min(40, 12 + r * 0.5), r * 0.4, 'smoke', 0.7);
          if (this.inView(e.x, e.y, r * this.cam.z)) {
            this.flash = Math.max(this.flash, r >= 30 ? 0.7 : 0.45);
            this.shake = Math.max(this.shake, r >= 30 ? 0.75 : 0.45);
          }
          break;
        }
        case 'impact': {
          if (NUKES[e.kind] && e.kind !== 'mega') break;
          if (e.kind === 'mega') {
            this.fx.push({ k: 'boom', x: e.x, y: e.y, h: 0, r: 6, t: 0, life: 1, air: true });
            this.debris(e.x, e.y, 0, 30, 4, 'spark', 0);
            this.flash = Math.max(this.flash, 0.3);
            break;
          }
          const r = e.kind === 'drone' ? Math.max(2, e.r || 3) : 1.7;
          this.fx.push({ k: 'boom', x: e.x, y: e.y, h: 0, r, t: 0, life: 1.1 });
          this.debris(e.x, e.y, 0, e.kind === 'drone' ? 16 : 12, r * 0.8, 'fire', 0);
          this.debris(e.x, e.y, 0, 7, r * 0.45, 'smoke', 0.25);
          break;
        }
        case 'intercept': {
          const p = this.airPos(e.x, e.y);
          this.fx.push({ k: 'air', x: p.x, y: p.y, h: p.h, r: NUKES[e.kind] ? 3.2 : 1.9, t: 0, life: 0.85 });
          this.debris(p.x, p.y, p.h, 16, 1.6, 'spark', 0);
          break;
        }
        case 'samShot': {
          const p = this.airPos(e.tx, e.ty);
          this.fx.push({ k: 'tracer', x: e.x + 0.5, y: e.y + 0.5, h: 0, x2: p.x, y2: p.y, h2: p.h, t: 0, life: 0.4, c: e.hit ? [255, 240, 160] : [190, 220, 255] });
          break;
        }
        case 'shipFire': {
          this.fx.push({ k: 'tracer', x: e.x, y: e.y, h: 0, x2: e.tx, y2: e.ty, h2: 0, t: 0, life: 0.25, c: [255, 220, 120] });
          this.fx.push({ k: 'splash', x: e.tx + (Math.random() - 0.5) * 1.6, y: e.ty + (Math.random() - 0.5) * 1.6, r: 1.2, t: 0, life: 0.8 });
          break;
        }
        case 'shipSunk': {
          this.fx.push({ k: 'boom', x: e.x, y: e.y, h: 0, r: 2, t: 0, life: 0.9 });
          this.fx.push({ k: 'splash', x: e.x, y: e.y, r: 3.2, t: 0, life: 1.8 });
          this.debris(e.x, e.y, 0, 9, 1.2, 'smoke', 0.2);
          break;
        }
        case 'destroyed': {
          this.fx.push({ k: 'boom', x: e.x + 0.5, y: e.y + 0.5, h: 0, r: 1.6, t: 0, life: 0.9 });
          this.debris(e.x + 0.5, e.y + 0.5, 0, 8, 1, 'smoke', 0.2);
          break;
        }
        case 'capture': {
          if (s && s.players[e.pid]) this.fx.push({ k: 'ring', x: e.x + 0.5, y: e.y + 0.5, r: e.capital ? 10 : 4, t: 0, life: 1.1, c: hexToRgb(s.players[e.pid].color) });
          break;
        }
        case 'built': {
          const b = this.game && this.game.buildingById(e.id);
          if (b && s && s.players[b.owner]) this.fx.push({ k: 'ring', x: b.x + 0.5, y: b.y + 0.5, r: 2.5, t: 0, life: 0.8, c: [255, 255, 255] });
          break;
        }
        case 'trade': {
          if (e.from === me && e.gold > 0) this.addText(e.x + 0.5, e.y + 0.5, '+' + fmtNum(e.gold), this.theme.floatGold);
          else if (e.to === me && e.goldTo > 0) this.addText(e.x + 0.5, e.y + 0.5, '+' + fmtNum(e.goldTo), this.theme.floatGold);
          break;
        }
        case 'cargo': {
          if (e.pid === me && e.gold > 0) this.addText(e.x + 0.5, e.y + 0.5, '+' + fmtNum(e.gold), this.theme.floatGold);
          break;
        }
        case 'launch': {
          this.debris(e.x, e.y, 0, 8, 0.9, 'smoke', 0);
          this.fx.push({ k: 'ring', x: e.x, y: e.y, r: 2, t: 0, life: 0.6, c: [255, 220, 160] });
          break;
        }
        default:
          break;
      }
    }
    if (this.fx.length > 240) this.fx.splice(0, this.fx.length - 240);
    if (this.parts.length > 900) this.parts.splice(0, this.parts.length - 900);
  }

  addText(x, y, text, color) {
    if (this.texts.length > 40) this.texts.shift();
    this.texts.push({ x, y, text, color, t: 0, life: 1.7 });
  }

  debris(x, y, h, n, spread, kind, delay = 0) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const v = spread * (0.4 + Math.random() * 1.1);
      const p = { x, y, h, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.8, vh: 0, t: -delay * (0.6 + Math.random() * 0.8), kind };
      if (kind === 'fire') {
        p.vh = spread * (0.5 + Math.random() * 1.6);
        p.life = 0.5 + Math.random() * 0.8;
        p.size = 0.16 + Math.random() * 0.2;
      } else if (kind === 'spark') {
        p.vh = (Math.random() - 0.3) * spread;
        p.life = 0.3 + Math.random() * 0.45;
        p.size = 0.11;
      } else {
        p.vx *= 0.3;
        p.vy *= 0.3;
        p.vh = spread * (0.25 + Math.random() * 0.45);
        p.life = 1.6 + Math.random() * 1.6;
        p.size = spread * (0.3 + Math.random() * 0.35) + 0.4;
      }
      this.parts.push(p);
    }
  }

  stepParticles(dt) {
    const keep = [];
    for (const q of this.parts) {
      q.t += dt;
      if (q.t >= q.life) continue;
      keep.push(q);
      if (q.t < 0) continue;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.h = Math.max(0, q.h + q.vh * dt);
      if (q.kind !== 'smoke') q.vh -= 9 * dt;
      const damp = 1 - Math.min(0.5, dt * 1.2);
      q.vx *= damp;
      q.vy *= damp;
    }
    this.parts = keep;
  }

  drawParticles(ctx, smoke) {
    const z = this.cam.z, dpr = this.dpr, sm = this.theme.smoke;
    for (const q of this.parts) {
      if (q.t < 0 || (q.kind === 'smoke') !== smoke) continue;
      const x = this.sx(q.x), y = this.sy(q.y) - q.h * z;
      if (x < -60 || y < -60 || x > this.viewW + 60 || y > this.viewH + 60) continue;
      const p = q.t / q.life;
      if (smoke) {
        const r = Math.max(2.5 * dpr, q.size * z * (0.6 + p * 1.3));
        const a = 0.3 * (p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85);
        ctx.fillStyle = rgba(sm, a);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
      } else {
        const r = Math.max(1.2 * dpr, q.size * z) * (1 - p * 0.5);
        ctx.fillStyle = q.kind === 'spark' ? `rgba(220,240,255,${1 - p})` : `rgba(255,${(210 - p * 150) | 0},${(90 - p * 70) | 0},${1 - p})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
      }
    }
  }

  drawFx(ctx, dt) {
    const z = this.cam.z, dpr = this.dpr;
    ctx.save();
    this.stepParticles(dt);
    this.drawParticles(ctx, true);
    const keep = [];
    for (const f of this.fx) {
      f.t += dt;
      if (f.t >= f.life) continue;
      keep.push(f);
      const p = f.t / f.life;
      const x = this.sx(f.x), y = this.sy(f.y) - (f.h || 0) * z;
      const maxR = (f.r || 1) * z * 3 + 80 * dpr;
      if (x < -maxR || y < -maxR || x > this.viewW + maxR || y > this.viewH + maxR) continue;
      if (f.k === 'boom' || f.k === 'air') {
        const R = Math.max(f.r * z, (f.k === 'air' ? 7 : 9) * dpr);
        ctx.globalCompositeOperation = 'lighter';
        const fr = R * (0.55 + 0.75 * easeOut(p * 1.6));
        const g = ctx.createRadialGradient(x, y, 0, x, y, fr);
        const a = 1 - p;
        g.addColorStop(0, `rgba(255,250,225,${a})`);
        g.addColorStop(0.35, f.k === 'air' ? `rgba(160,210,255,${a * 0.8})` : `rgba(255,172,64,${a * 0.85})`);
        g.addColorStop(1, 'rgba(255,60,20,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, fr, 0, TAU);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = `rgba(255,236,205,${(1 - p) * 0.75})`;
        ctx.lineWidth = Math.max(1, R * 0.13 * (1 - p));
        ctx.beginPath();
        ctx.arc(x, y, R * (0.4 + 1.6 * easeOut(p)), 0, TAU);
        ctx.stroke();
      } else if (f.k === 'nuke') {
        this.drawNuke(ctx, f, x, y);
      } else if (f.k === 'tracer') {
        const x2 = this.sx(f.x2), y2 = this.sy(f.y2) - (f.h2 || 0) * z;
        const q = clamp(f.t / (f.life * 0.5), 0, 1);
        const hx = x + (x2 - x) * q, hy = y + (y2 - y) * q;
        ctx.strokeStyle = rgba(f.c, 0.9 * (1 - p));
        ctx.lineWidth = 1.8 * dpr;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x + (x2 - x) * Math.max(0, q - 0.45), y + (y2 - y) * Math.max(0, q - 0.45));
        ctx.lineTo(hx, hy);
        ctx.stroke();
        ctx.fillStyle = rgba(f.c, 1 - p);
        ctx.beginPath();
        ctx.arc(x, y, 3 * dpr * (1 - p), 0, TAU);
        ctx.fill();
      } else if (f.k === 'splash') {
        const R = Math.max(f.r * z, 5 * dpr);
        ctx.strokeStyle = `rgba(230,245,255,${(1 - p) * 0.85})`;
        ctx.lineWidth = 1.5 * dpr;
        for (let j = 0; j < 2; j++) {
          const q = clamp(p * 1.3 - j * 0.25, 0, 1);
          if (q <= 0) continue;
          ctx.beginPath();
          ctx.arc(x, y, R * (0.3 + q), 0, TAU);
          ctx.stroke();
        }
      } else if (f.k === 'ring') {
        const R = Math.max(f.r * z, 8 * dpr) * (0.4 + easeOut(p) * 1.1);
        ctx.strokeStyle = rgba(f.c, (1 - p) * 0.95);
        ctx.lineWidth = 2.5 * dpr * (1 - p) + 0.5;
        ctx.beginPath();
        ctx.arc(x, y, R, 0, TAU);
        ctx.stroke();
      }
    }
    this.fx = keep;
    this.drawParticles(ctx, false);
    if (this.texts.length) {
      const tk = [];
      for (const t of this.texts) {
        t.t += dt;
        if (t.t >= t.life) continue;
        tk.push(t);
        const p = t.t / t.life;
        const x = this.sx(t.x), y = this.sy(t.y) - (12 + p * 28) * dpr;
        const fs = 13 * dpr;
        ctx.font = `800 ${fs}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3;
        ctx.lineWidth = 3.5 * dpr;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.strokeText(t.text, x, y);
        ctx.fillStyle = t.color;
        ctx.fillText(t.text, x, y);
        ctx.globalAlpha = 1;
      }
      this.texts = tk;
    }
    ctx.restore();
  }

  drawNuke(ctx, f, x, y) {
    const z = this.cam.z, dpr = this.dpr;
    const R = Math.max(f.r * z, 16 * dpr);
    const t = f.t, life = f.life;
    ctx.save();
    const sc = 1 - clamp((t - life * 0.55) / (life * 0.45), 0, 1);
    if (sc > 0) {
      const g0 = ctx.createRadialGradient(x, y, 0, x, y, R * 1.05);
      g0.addColorStop(0, `rgba(30,16,10,${0.62 * sc})`);
      g0.addColorStop(0.55, `rgba(58,32,18,${0.42 * sc})`);
      g0.addColorStop(0.85, `rgba(120,60,24,${0.22 * sc})`);
      g0.addColorStop(1, 'rgba(120,60,24,0)');
      ctx.fillStyle = g0;
      ctx.beginPath();
      ctx.arc(x, y, R * 1.05, 0, TAU);
      ctx.fill();
    }
    const sw = clamp(t / 1.7, 0, 1);
    if (sw < 1) {
      const rr = R * (0.3 + 2.5 * easeOut(sw));
      const g1 = ctx.createRadialGradient(x, y, rr * 0.6, x, y, rr);
      g1.addColorStop(0, 'rgba(255,240,220,0)');
      g1.addColorStop(1, `rgba(255,240,220,${0.16 * (1 - sw)})`);
      ctx.fillStyle = g1;
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = `rgba(255,250,236,${0.95 * (1 - sw)})`;
      ctx.lineWidth = Math.max(1.5 * dpr, R * 0.1 * (1 - sw));
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'lighter';
    if (t < 0.6) {
      const a = 1 - t / 0.6;
      const g = ctx.createRadialGradient(x, y, 0, x, y, R * 2);
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(0.35, `rgba(255,246,214,${a * 0.75})`);
      g.addColorStop(1, 'rgba(255,200,120,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, R * 2, 0, TAU);
      ctx.fill();
    }
    const fa = clamp(1 - (t - 0.8) / 2.4, 0, 1);
    if (fa > 0) {
      const fr = R * (0.35 + 0.5 * easeOut(t / 0.9));
      const g2 = ctx.createRadialGradient(x, y, 0, x, y, fr);
      g2.addColorStop(0, `rgba(255,252,236,${fa})`);
      g2.addColorStop(0.25, `rgba(255,222,120,${fa * 0.95})`);
      g2.addColorStop(0.6, `rgba(250,120,40,${fa * 0.75})`);
      g2.addColorStop(1, 'rgba(160,30,10,0)');
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.arc(x, y, fr, 0, TAU);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    const m = clamp((t - 0.3) / (life - 0.3), 0, 1);
    if (m > 0) {
      const rise = easeOut(clamp(m * 1.8, 0, 1));
      const lift = R * 1.2 * rise;
      const cr = R * (0.32 + 0.46 * rise);
      const a = Math.min(1, m * 5) * (1 - m * m) * 0.92;
      const hot = clamp(1 - m * 2.4, 0, 1);
      const cy = y - lift;
      const sw2 = cr * 0.24;
      const gs = ctx.createLinearGradient(x - sw2, 0, x + sw2, 0);
      gs.addColorStop(0, `rgba(70,58,52,${a * 0.8})`);
      gs.addColorStop(0.45, `rgba(${(150 + 90 * hot) | 0},${(120 + 40 * hot) | 0},${(100 - 30 * hot) | 0},${a * 0.85})`);
      gs.addColorStop(1, `rgba(60,50,46,${a * 0.8})`);
      ctx.fillStyle = gs;
      ctx.beginPath();
      ctx.moveTo(x - sw2 * 1.6, y);
      ctx.quadraticCurveTo(x - sw2 * 0.55, y - lift * 0.45, x - sw2, cy + cr * 0.3);
      ctx.lineTo(x + sw2, cy + cr * 0.3);
      ctx.quadraticCurveTo(x + sw2 * 0.55, y - lift * 0.45, x + sw2 * 1.6, y);
      ctx.closePath();
      ctx.fill();
      const ry = y - lift * 0.5;
      ctx.fillStyle = `rgba(200,190,182,${a * 0.28})`;
      ctx.beginPath();
      ctx.ellipse(x, ry, cr * 0.62, cr * 0.16, 0, 0, TAU);
      ctx.fill();
      const g3 = ctx.createRadialGradient(x - cr * 0.15, cy - cr * 0.35, cr * 0.08, x, cy, cr);
      g3.addColorStop(0, `rgba(${(214 + 41 * hot) | 0},${(180 + 40 * hot) | 0},${(150 - 40 * hot) | 0},${a})`);
      g3.addColorStop(0.5, `rgba(${(132 + 100 * hot) | 0},${(104 + 30 * hot) | 0},${(88 - 30 * hot) | 0},${a * 0.95})`);
      g3.addColorStop(0.85, `rgba(78,66,60,${a * 0.75})`);
      g3.addColorStop(1, 'rgba(60,52,48,0)');
      ctx.fillStyle = g3;
      ctx.beginPath();
      ctx.ellipse(x, cy, cr, cr * 0.7, 0, 0, TAU);
      ctx.fill();
      if (hot > 0) {
        ctx.globalCompositeOperation = 'lighter';
        const g4 = ctx.createRadialGradient(x, cy + cr * 0.25, 0, x, cy + cr * 0.25, cr * 0.85);
        g4.addColorStop(0, `rgba(255,150,60,${0.6 * hot})`);
        g4.addColorStop(1, 'rgba(255,90,30,0)');
        ctx.fillStyle = g4;
        ctx.beginPath();
        ctx.arc(x, cy + cr * 0.25, cr * 0.85, 0, TAU);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    ctx.restore();
  }
}

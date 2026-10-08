import { makeRng, makeGradNoise } from './rng.js';
import { WORLD_W, WORLD_H, WORLD_LAT_TOP, WORLD_LAT_BOTTOM, WORLD_LAND_B64 } from '../data/worldmap.js';
import { buildNav } from './nav.js';

export const TER = { DEEP: 0, SHALLOW: 1, PLAINS: 2, FOREST: 3, DESERT: 4, HILLS: 5, MOUNTAIN: 6, SNOW: 7 };
const { DEEP, SHALLOW, PLAINS, FOREST, DESERT, HILLS, MOUNTAIN, SNOW } = TER;
export const OCEAN_MIN = 400;
export const isLand = (t) => t >= 2;

const PW = 1400, PH = 800;

export const MAPS = [
  { id: 'world', name: 'Земля', desc: 'Настоящая карта мира: материки, проливы и тысячи островов.', w: WORLD_W, h: WORLD_H, maxPlayers: 12 },
  { id: 'archipelago', name: 'Архипелаг', desc: 'Сотни островов — побеждает тот, кто держит моря и небо.', w: PW, h: PH, maxPlayers: 10 },
  { id: 'pangaea', name: 'Пангея', desc: 'Один огромный материк — сухопутная мясорубка.', w: PW, h: PH, maxPlayers: 12 },
  { id: 'twin', name: 'Два континента', desc: 'Два материка, соединённые узким перешейком.', w: PW, h: PH, maxPlayers: 10 },
  { id: 'ring', name: 'Внутреннее море', desc: 'Кольцевой материк вокруг моря с островами в центре.', w: PW, h: PH, maxPlayers: 10 },
  { id: 'random', name: 'Случайная', desc: 'Новая карта при каждом запуске (зависит от seed).', w: PW, h: PH, maxPlayers: 12 },
];

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeB64(s) {
  const lut = new Uint8Array(128);
  for (let i = 0; i < 64; i++) lut[B64.charCodeAt(i)] = i;
  lut[45] = 62; lut[95] = 63;
  let len = s.length;
  while (len && s.charCodeAt(len - 1) === 61) len--;
  const out = new Uint8Array((len * 3) >> 2);
  let o = 0, buf = 0, bits = 0;
  for (let i = 0; i < len; i++) {
    buf = ((buf << 6) | lut[s.charCodeAt(i)]) & 0xffffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 255; }
  }
  return out;
}

let worldBits = null;
function worldLand() {
  if (!worldBits) {
    const bytes = decodeB64(WORLD_LAND_B64);
    worldBits = new Uint8Array(WORLD_W * WORLD_H);
    for (let i = 0; i < worldBits.length; i++) worldBits[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  }
  return worldBits.slice();
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function labelComponents(W, H, pick) {
  const N = W * H;
  const id = new Int32Array(N).fill(-1);
  const sizes = [];
  const stack = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (id[s] >= 0 || !pick(s)) continue;
    const c = sizes.length;
    let sp = 0, n = 0;
    stack[sp++] = s; id[s] = c;
    while (sp) {
      const i = stack[--sp];
      n++;
      const x = i % W;
      if (x > 0 && id[i - 1] < 0 && pick(i - 1)) { id[i - 1] = c; stack[sp++] = i - 1; }
      if (x < W - 1 && id[i + 1] < 0 && pick(i + 1)) { id[i + 1] = c; stack[sp++] = i + 1; }
      if (i >= W && id[i - W] < 0 && pick(i - W)) { id[i - W] = c; stack[sp++] = i - W; }
      if (i < N - W && id[i + W] < 0 && pick(i + W)) { id[i + W] = c; stack[sp++] = i + W; }
    }
    sizes.push(n);
  }
  return { id, sizes };
}

function chamfer(W, H, land, src, cap) {
  const N = W * H;
  const d = new Float32Array(N);
  for (let i = 0; i < N; i++) d[i] = land[i] === src ? 0 : cap;
  const A = 1, B = 1.4142135;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0 && d[i - 1] + A < v) v = d[i - 1] + A;
      if (y > 0) {
        if (d[i - W] + A < v) v = d[i - W] + A;
        if (x > 0 && d[i - W - 1] + B < v) v = d[i - W - 1] + B;
        if (x < W - 1 && d[i - W + 1] + B < v) v = d[i - W + 1] + B;
      }
      d[i] = v;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < W - 1 && d[i + 1] + A < v) v = d[i + 1] + A;
      if (y < H - 1) {
        if (d[i + W] + A < v) v = d[i + W] + A;
        if (x < W - 1 && d[i + W + 1] + B < v) v = d[i + W + 1] + B;
        if (x > 0 && d[i + W - 1] + B < v) v = d[i + W - 1] + B;
      }
      d[i] = v;
    }
  }
  return d;
}

function cleanLand(W, H, land, minIsland) {
  const N = W * H;
  if (minIsland > 1) {
    const lc = labelComponents(W, H, (i) => land[i] === 1);
    for (let i = 0; i < N; i++) if (lc.id[i] >= 0 && lc.sizes[lc.id[i]] < minIsland) land[i] = 0;
  }
  const wc = labelComponents(W, H, (i) => land[i] === 0);
  const remap = new Int32Array(wc.sizes.length);
  const sizes = [];
  for (let b = 0; b < wc.sizes.length; b++) {
    if (wc.sizes[b] < 3) remap[b] = -1;
    else { remap[b] = sizes.length; sizes.push(wc.sizes[b]); }
  }
  const id = wc.id;
  for (let i = 0; i < N; i++) {
    if (id[i] < 0) continue;
    const r = remap[id[i]];
    id[i] = r;
    if (r < 0) land[i] = 1;
  }
  return { waterBody: id, sizes };
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  let t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - px, ey = ay + dy * t - py;
  return Math.sqrt(ex * ex + ey * ey);
}

const E = (lon, lat, rx, ry, w = 1) => ({ e: 1, lon, lat, rx, ry, w, x0: lon - rx, x1: lon + rx, y0: lat - ry, y1: lat + ry });
const L = (pts, r, w = 1) => {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); y0 = Math.min(y0, y - r); y1 = Math.max(y1, y + r); }
  return { e: 0, pts, r, w, x0, x1, y0, y1 };
};

const WORLD_DESERT = [
  E(4, 23, 23, 8.5), E(24, 24, 11, 7), E(-12, 21, 6, 5), E(47, 22.5, 11, 8), E(41, 31.5, 6, 3.5), E(57, 31, 7.5, 4.5),
  E(62, 41, 8, 3.5), E(71, 27, 4, 3, 0.9), E(83, 39, 8.5, 3), E(104, 42.5, 13, 4), E(94, 40, 5, 2.5, 0.8),
  E(19, -24, 6, 4.5), E(15, -23, 2.5, 6), E(46.5, 8, 4.5, 3.5, 0.8), E(133, -25, 15.5, 8.5), E(122, -21, 4, 3),
  E(-70, -24, 2, 7), E(-68, -46, 3.5, 5, 0.7), E(-113, 33, 6.5, 5), E(-105, 29, 4, 4), E(-113, 28, 2.5, 4), E(-117, 40, 4, 3, 0.8),
  E(54, 45, 6, 2.5, 0.8), E(66, 46, 5, 2, 0.7), E(36, 19, 6, 3, 0.9), E(-38.5, -8, 2.5, 2.5, 0.6),
];

const WORLD_MOUNT = [
  L([[72, 35.5], [77, 33], [81, 30], [85, 28.2], [89, 27.8], [93, 28.5], [96, 28.5]], 2.2, 1.15),
  L([[76, 37], [84, 36], [92, 36], [100, 35.5]], 1.6),
  E(87, 32.5, 12, 3.5, 0.75),
  L([[64, 34.5], [70, 36], [74, 37.5], [77, 35.5]], 1.9, 1.1),
  L([[69, 41.5], [76, 42], [80, 42], [86, 43], [93, 43]], 1.6),
  L([[84, 50], [88, 49.5], [92, 50.5], [98, 51.5]], 1.8, 0.9),
  L([[98, 26], [100, 30], [102, 32]], 2.2, 0.9),
  L([[45, 36], [48, 33.5], [52, 30], [56, 27.5]], 1.5, 0.95),
  L([[48, 37], [52, 36.3], [56, 37], [60, 37]], 1.1, 0.9),
  L([[39, 43.8], [43, 42.8], [47, 41.8], [49.5, 40.8]], 1.0, 1.05),
  E(35, 39, 7, 2.5, 0.65),
  L([[5.8, 44.5], [7, 46], [10, 46.5], [13, 47], [16, 47.3]], 1.0, 1.05),
  L([[-1.5, 43], [1, 42.7], [3, 42.5]], 0.6, 0.95),
  L([[18, 49.3], [21, 49.2], [24, 48], [25.5, 46.5], [23, 45.4]], 0.9, 0.75),
  L([[15, 45], [18, 43.5], [20, 42], [22, 41]], 1.0, 0.7),
  L([[6, 59], [7.5, 61.5], [10, 63], [13, 65.5], [16, 68], [19, 69.3]], 1.4, 0.9),
  L([[59.5, 68], [60, 64], [59, 60], [58.5, 55], [58, 52]], 1.1, 0.75),
  L([[-9, 30.5], [-6, 32], [-3, 33.5], [1, 35], [6, 35.8], [9, 36]], 1.2, 0.9),
  E(38.5, 10, 4, 4.5, 0.85),
  L([[30, 0], [30.5, -4], [33, -8], [35, -10]], 1.5, 0.6),
  L([[28, -29], [30, -28.5], [29, -31]], 1.2, 0.7),
  L([[-150, 62], [-143, 61.3], [-135, 59.5], [-128, 57], [-122, 53], [-116, 49], [-111, 45], [-108, 40], [-106, 35], [-106, 32]], 2.6, 1.05),
  L([[-122, 48.5], [-121.5, 44], [-121, 41], [-119, 37.5], [-117, 35]], 1.2, 0.95),
  L([[-108, 29], [-105, 25], [-103, 21], [-100, 18.5]], 1.6, 0.9),
  L([[-100, 27], [-99, 23], [-97, 19]], 1.0, 0.8),
  L([[-162, 67.8], [-150, 68.3], [-142, 69]], 1.2, 0.85),
  L([[-154, 62], [-150, 63], [-145, 63]], 1.0, 0.95),
  L([[-86, 34], [-83, 35.5], [-80, 37.5], [-78, 39.5], [-76, 41.5], [-73, 44], [-70, 45.5]], 1.4, 0.6),
  L([[-92, 15.5], [-88, 14.5], [-85, 12.5], [-84, 10], [-80, 8.5]], 1.0, 0.75),
  L([[-75, 10], [-76, 6], [-77, 2], [-78.5, -2], [-77, -9], [-73, -15], [-69, -18], [-68, -23], [-69, -28], [-70, -33], [-71, -38], [-72, -43], [-73, -48], [-73.5, -52]], 2.3, 1.15),
  E(-67.5, -19, 3, 4, 1.0),
  E(-45, -18, 6, 6, 0.55), E(-62, 5, 4, 2, 0.6),
  L([[145.5, -15], [146.5, -20], [149, -25], [151.5, -30], [149.5, -35], [147, -37.3]], 1.3, 0.65),
  L([[167.5, -45.5], [169, -44], [171, -42.8], [172.8, -41.5]], 0.8, 1.0),
  L([[131, 33], [133.5, 34.5], [136, 35.8], [138, 36.5], [139.5, 38], [140.5, 40], [141, 42.5], [143, 43.5]], 0.9, 0.85),
  L([[156, 51.5], [158, 54], [160, 57], [162, 59]], 1.2, 0.9),
  L([[128, 64], [133, 66], [138, 67.5], [145, 66], [152, 64]], 2.0, 0.7),
  L([[120, 56], [127, 56], [134, 57]], 1.5, 0.65),
  L([[49, -13], [47.5, -18], [46.5, -22], [46, -25]], 1.2, 0.65),
  L([[-73, 46.5], [-71, 48], [-67, 49]], 1.0, 0.5),
  L([[100, 18], [99, 13], [98.5, 9]], 1.0, 0.6),
  L([[104, 21], [106, 17], [108, 14]], 1.0, 0.6),
  L([[121, 24.5], [121, 22.5]], 0.6, 0.9),
  L([[96, 4], [100, 0], [102.5, -3], [104.5, -5]], 0.9, 0.7),
  E(138, -4.5, 6, 1.6, 0.85),
  L([[-5, 43], [-3.5, 43.1], [-6, 40.5], [-3.5, 37.3]], 0.9, 0.6),
  L([[9, 44.3], [12, 43.5], [14, 42], [16, 40], [16.2, 38.5]], 0.8, 0.65),
];

const WORLD_FOREST = [
  E(-62, -5, 14, 8), E(-72, 2, 5, 5, 0.8), E(21, 0, 10, 5.5), E(-5, 7, 8, 2.5, 0.85), E(102, 15, 8, 8, 0.8), E(110, 0, 15, 6),
  E(142, -5, 8, 4), E(100, 60, 45, 7), E(60, 60, 15, 5), E(130, 58, 22, 6), E(-100, 56, 30, 6.5), E(-70, 51, 12, 4.5),
  E(22, 55, 14, 5, 0.65), E(16, 61, 7, 3.5, 0.9), E(-84, 38, 10, 7, 0.85), E(-124, 50, 5, 7), E(112, 26, 9, 5, 0.85),
  E(-45, -20, 4, 8, 0.7), E(27, -10, 10, 4, 0.55), E(49, -17, 2, 6, 0.8), E(92, 25, 4, 3, 0.8), E(135, 37, 8, 5, 0.75),
  E(151, -28, 3, 8, 0.6), E(172, -42, 4, 5, 0.75), E(-150, 62, 8, 3, 0.55), E(76, 12, 2.5, 5, 0.7), E(9, 49, 6, 3, 0.6),
  E(-90, 16, 5, 4, 0.8), E(-80, 8, 4, 3, 0.75), E(123, 10, 4, 7, 0.85),
];

const WORLD_SNOW = [E(-42, 74, 26, 14, 1.2), E(-18.5, 65, 4, 2, 0.6)];

function shapeField(list, W, H, step, lonOf, latOf) {
  const cw = Math.ceil(W / step) + 1, ch = Math.ceil(H / step) + 1;
  const f = new Float32Array(cw * ch).fill(-1);
  for (let cy = 0; cy < ch; cy++) {
    const lat = latOf(cy * step);
    for (let cx = 0; cx < cw; cx++) {
      const lon = lonOf(cx * step);
      let best = -1;
      for (const s of list) {
        if (lon < s.x0 || lon > s.x1 || lat < s.y0 || lat > s.y1) continue;
        let d;
        if (s.e) {
          const a = (lon - s.lon) / s.rx, b = (lat - s.lat) / s.ry;
          d = Math.sqrt(a * a + b * b);
        } else {
          d = Infinity;
          const p = s.pts;
          for (let k = 0; k + 1 < p.length; k++) {
            const v = segDist(lon, lat, p[k][0], p[k][1], p[k + 1][0], p[k + 1][1]);
            if (v < d) d = v;
          }
          d /= s.r;
        }
        const v = (1 - d) * s.w;
        if (v > best) best = v;
      }
      f[cy * cw + cx] = best;
    }
  }
  return (x, y) => {
    const u = x / step, v = y / step;
    const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
    const i = y0 * cw + x0;
    const a = f[i] + (f[i + 1] - f[i]) * fx;
    const b = f[i + cw] + (f[i + cw + 1] - f[i + cw]) * fx;
    return a + (b - a) * fy;
  };
}

function worldTerrain(map, landDist, N2) {
  const { W, H, terrain, elev } = map;
  const latTop = WORLD_LAT_TOP, latSpan = WORLD_LAT_TOP - WORLD_LAT_BOTTOM;
  const lonOf = (x) => -180 + ((x + 0.5) / W) * 360;
  const latOf = (y) => latTop - ((y + 0.5) / H) * latSpan;
  const mountF = shapeField(WORLD_MOUNT, W, H, 4, lonOf, latOf);
  const desertF = shapeField(WORLD_DESERT, W, H, 4, lonOf, latOf);
  const forestF = shapeField(WORLD_FOREST, W, H, 4, lonOf, latOf);
  const snowF = shapeField(WORLD_SNOW, W, H, 4, lonOf, latOf);
  for (let y = 0; y < H; y++) {
    const lat = latOf(y);
    const alat = lat < 0 ? -lat : lat;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!terrain[i]) continue;
      const inland = clamp01(landDist[i] / 30);
      const jit = N2.fbm(x / 16 + 3, y / 16 - 5, 3) * 0.5 + N2.fbm(x / 110 - 8, y / 110 + 4, 2) * 0.4;
      const ridge = N2.ridged(x / 28 + 40, y / 28 - 11, 3);
      const moist = N2.fbm(x / 55 - 7, y / 55 + 3, 3);
      const m = clamp01((mountF(x, y) + jit * 0.5) * 2.4);
      const mv = m * (0.3 + 0.95 * ridge);
      const snowLine = 66 + jit * 9;
      let t = PLAINS, e = 0.2 + inland * 0.16 + (moist + 0.5) * 0.06 + ridge * 0.06;
      if (alat > snowLine || clamp01((snowF(x, y) + jit) * 2.4) > 0.5 || (mv > 0.98 && alat > 32)) {
        t = SNOW; e = 0.45 + mv * 0.4 + ridge * 0.1;
      } else if (mv > 0.8) {
        t = MOUNTAIN; e = 0.75 + clamp01(mv - 0.8) * 1.2;
      } else if (mv > 0.5) {
        t = HILLS; e = 0.5 + ridge * 0.2;
      } else {
        const hl = N2.ridged(x / 70 - 13, y / 70 + 29, 2);
        const dw = clamp01((desertF(x, y) + jit) * 2.4) - moist * 0.6;
        const fw = clamp01((forestF(x, y) + jit * 0.8) * 2.4) * 0.8 + moist * 0.8;
        if (hl > 0.86 && jit > 0.05) { t = HILLS; e = 0.45 + hl * 0.15; }
        else if (dw > 0.5) t = DESERT;
        else if (fw > 0.5) t = FOREST;
        else if (alat > 36 && alat < 60 && moist > 0.16) t = FOREST;
      }
      terrain[i] = t;
      elev[i] = Math.max(1, Math.min(255, Math.round(e * 255)));
    }
  }
}

function procTerrain(map, landDist, N2) {
  const { W, H, terrain, elev } = map;
  const k = Math.max(W, H) / 1400;
  for (let y = 0; y < H; y++) {
    const lat = 70 - ((y + 0.5) / H) * 140;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!terrain[i]) continue;
      const inland = clamp01(landDist[i] / 40);
      const tect = N2.fbm(x / (420 * k) - 5, y / (420 * k) + 2, 2);
      const wu = x + N2.fbm(x / 90 + 1, y / 90, 2) * 45, wv = y + N2.fbm(x / 90 - 4, y / 90 + 6, 2) * 45;
      const n1 = N2.noise(wu / (240 * k), wv / (240 * k));
      const line = 1 - Math.min(1, (n1 < 0 ? -n1 : n1) * 5.5);
      const ridge = N2.ridged(x / 26 + 40, y / 26 - 11, 2);
      const mv = line * clamp01(0.55 + tect * 2.2) * (0.7 + 0.4 * inland) * (0.55 + 0.6 * ridge);
      const moist = N2.fbm(x / (150 * k) - 7, y / (150 * k) + 3, 3) + (1 - inland) * 0.05;
      const jit = N2.fbm(x / 22 + 9, y / 22, 3);
      const alat = (lat < 0 ? -lat : lat) + jit * 10;
      let t = PLAINS, e = 0.22 + inland * 0.2 + moist * 0.08 + ridge * 0.08;
      if (alat > 62) { t = SNOW; e += 0.2; }
      else if (mv > 0.66) { t = MOUNTAIN; e = 0.78 + clamp01(mv - 0.66) * 0.8; }
      else if (mv > 0.4 + jit * 0.1) { t = HILLS; e = 0.52 + (mv - 0.4) * 1.2; }
      else if (alat > 13 && alat < 37 && moist + jit * 0.15 < -0.1) t = DESERT;
      else if (moist + jit * 0.15 > 0.12) t = FOREST;
      terrain[i] = t;
      elev[i] = Math.max(1, Math.min(255, Math.round(e * 255)));
    }
  }
}

export function buildMapFromLand(desc, W, H, landBits, seed) {
  const N = W * H;
  const isWorld = desc.id === 'world';
  const land = new Uint8Array(N);
  for (let i = 0; i < N; i++) land[i] = landBits[i] ? 1 : 0;
  const wb = cleanLand(W, H, land, isWorld ? 1 : 2);
  const terrain = new Uint8Array(N);
  const elev = new Uint8Array(N);
  let landCount = 0;
  for (let i = 0; i < N; i++) if (land[i]) { terrain[i] = PLAINS; landCount++; }
  const name = desc.id === 'custom' ? String(desc.name || 'Своя карта') : (MAPS.find((m) => m.id === desc.id) || MAPS[MAPS.length - 1]).name;
  const map = { desc, id: desc.id, name, W, H, terrain, elev, coast: new Uint8Array(N), waterBody: null, bodySize: null, oceanBodies: null, landCount, nav: null };
  if (isWorld) map.geo = { latTop: WORLD_LAT_TOP, latBottom: WORLD_LAT_BOTTOM, lonLeft: -180, lonRight: 180 };

  const waterDist = chamfer(W, H, land, 1, 255);
  const landDist = chamfer(W, H, land, 0, 255);
  const N2 = makeGradNoise((seed ^ 0x6c8e9cf5) >>> 0);
  if (isWorld) worldTerrain(map, landDist, N2);
  else procTerrain(map, landDist, N2);

  for (let i = 0; i < N; i++) {
    if (land[i]) continue;
    const d = waterDist[i];
    terrain[i] = d <= 3.01 ? SHALLOW : DEEP;
    elev[i] = Math.min(255, Math.round(d * 6));
  }

  map.waterBody = wb.waterBody;
  map.bodySize = Int32Array.from(wb.sizes);
  map.oceanBodies = new Set();
  for (let b = 0; b < wb.sizes.length; b++) if (wb.sizes[b] >= OCEAN_MIN) map.oceanBodies.add(b);

  const coast = map.coast;
  for (let i = 0; i < N; i++) {
    if (!land[i]) continue;
    const x = i % W;
    if ((x > 0 && !land[i - 1]) || (x < W - 1 && !land[i + 1]) || (i >= W && !land[i - W]) || (i < N - W && !land[i + W])) coast[i] = 1;
  }
  map.nav = buildNav(map);
  return map;
}

function edgeFade(x, y, W, H, m) {
  const e = Math.min(x, y, W - 1 - x, H - 1 - y);
  return e >= m ? 0 : (1 - e / m) * (1 - e / m);
}

function fieldLand(W, H, fn, step = 2) {
  const gw = Math.ceil((W - 1) / step) + 2, gh = Math.ceil((H - 1) / step) + 2;
  const g = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) g[gy * gw + gx] = fn(gx * step, gy * step);
  const land = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const v = y / step, y0 = Math.floor(v), fy = v - y0;
    for (let x = 0; x < W; x++) {
      const u = x / step, x0 = Math.floor(u), fx = u - x0;
      const i = y0 * gw + x0;
      const a = g[i] + (g[i + 1] - g[i]) * fx;
      const b = g[i + gw] + (g[i + gw + 1] - g[i + gw]) * fx;
      land[y * W + x] = a + (b - a) * fy > 0 ? 1 : 0;
    }
  }
  return land;
}

function warp(N, x, y, f, a) {
  return [x + N.fbm(x * f + 5.2, y * f + 1.3, 3) * a, y + N.fbm(x * f - 3.7, y * f + 8.1, 3) * a];
}

function blob(x, y, cx, cy, rx, ry) {
  const a = (x - cx) / rx, b = (y - cy) / ry;
  return 1 - Math.sqrt(a * a + b * b);
}

function genArchipelago(seed) {
  const N = makeGradNoise(seed);
  return fieldLand(PW, PH, (x, y) => {
    const [u, v] = warp(N, x, y, 1 / 150, 55);
    const big = N.fbm(u / 230, v / 230, 3);
    const mid = N.fbm(u / 80 + 11, v / 80 - 4, 4);
    const fine = N.fbm(u / 28 - 20, v / 28 + 7, 3);
    return big * 0.6 + mid * 0.55 + fine * 0.2 - edgeFade(x, y, PW, PH, 90) * 1.4 - 0.075;
  });
}

function genPangaea(seed) {
  const N = makeGradNoise(seed);
  return fieldLand(PW, PH, (x, y) => {
    const [u, v] = warp(N, x, y, 1 / 200, 95);
    const d = blob(u, v, 700, 400, 620, 345);
    return d * 0.9 + N.fbm(u / 210, v / 210, 5) * 0.75 + N.fbm(u / 55 + 3, v / 55, 3) * 0.12 - edgeFade(x, y, PW, PH, 50) * 0.8 - 0.14;
  });
}

function genTwin(seed) {
  const N = makeGradNoise(seed);
  const rng = makeRng(seed ^ 0x7f4a7c15);
  const iy = 300 + rng.next() * 200;
  const land = fieldLand(PW, PH, (x, y) => {
    const [u, v] = warp(N, x, y, 1 / 190, 80);
    const d = Math.max(blob(u, v, 360, 400, 300, 335), blob(u, v, 1040, 400, 300, 335));
    return d * 0.9 + N.fbm(u / 190, v / 190, 5) * 0.7 + N.fbm(u / 50 + 3, v / 50, 3) * 0.12 - edgeFade(x, y, PW, PH, 50) * 0.8 - 0.14;
  });
  for (let x = 540; x <= 860; x++) {
    const t = (x - 540) / 320;
    const cy = iy + (400 - iy) * (1 - 4 * t * (1 - t)) + N.fbm(x / 70, 3.3, 3) * 70;
    const w = 6 + (N.fbm(x / 40, 9.1, 2) + 0.5) * 7;
    for (let y = Math.floor(cy - w); y <= Math.ceil(cy + w); y++) {
      if (y < 0 || y >= PH) continue;
      if ((y - cy) * (y - cy) <= w * w) land[y * PW + x] = 1;
    }
  }
  return land;
}

const RING_CUTS = [[-0.966, 0.259], [0.906, -0.423]];

function genRing(seed) {
  const N = makeGradNoise(seed);
  return fieldLand(PW, PH, (x, y) => {
    const [u, v] = warp(N, x, y, 1 / 180, 55);
    const a = (u - 700) / 620, b = (v - 400) / 350;
    const d = Math.sqrt(a * a + b * b);
    const ring = 1 - Math.abs(d - 0.66) / 0.22;
    let h = ring + N.fbm(u / 160, v / 160, 5) * 0.7 + N.fbm(u / 45, v / 45, 3) * 0.1 - edgeFade(x, y, PW, PH, 40) * 0.8;
    if (d > 0.4 && d < 1.0) {
      for (const [cx, cy] of RING_CUTS) {
        const dist = Math.abs(a * cy - b * cx) * 350;
        if (a * cx + b * cy > 0 && dist < 14 + N.fbm(u / 50, v / 50, 2) * 8) h = -1;
      }
    }
    if (d < 0.36) h = Math.max(h, N.fbm(u / 45 + 17, v / 45 - 3, 4) * 1.4 - 0.05 + (0.36 - d) * 0.6);
    return h - 0.32;
  });
}

function genRandom(seed) {
  const rng = makeRng(seed ^ 0x51ed27);
  const N = makeGradNoise(seed);
  const n = 1 + Math.floor(rng.next() * 5);
  const frac = 0.24 + rng.next() * 0.12;
  const centers = [];
  for (let k = 0; k < n; k++) {
    let best = null, bd = -1;
    for (let c = 0; c < 16; c++) {
      const cx = n === 1 ? 500 + rng.next() * 400 : 220 + rng.next() * (PW - 440);
      const cy = n === 1 ? 300 + rng.next() * 200 : 180 + rng.next() * (PH - 360);
      let d = Infinity;
      for (const p of centers) d = Math.min(d, (p[0] - cx) * (p[0] - cx) + (p[1] - cy) * (p[1] - cy) * 2);
      if (d > bd) { bd = d; best = [cx, cy]; }
    }
    centers.push(best);
  }
  const base = Math.sqrt((frac * PW * PH) / (n * 2.2));
  const blobs = centers.map(([cx, cy]) => {
    const r = base * (0.8 + rng.next() * 0.45);
    const asp = 0.6 + rng.next() * 0.5;
    return [cx, cy, r / Math.sqrt(asp), r * Math.sqrt(asp)];
  });
  const scale = 150 + rng.next() * 120;
  const rough = 0.55 + rng.next() * 0.3;
  const isles = 0.05 + rng.next() * 0.3;
  return fieldLand(PW, PH, (x, y) => {
    const [u, v] = warp(N, x, y, 1 / 190, 55 + rough * 40);
    let d = -1;
    for (const [cx, cy, rx, ry] of blobs) d = Math.max(d, blob(u, v, cx, cy, rx, ry));
    return d * 0.9 + N.fbm(u / scale, v / scale, 5) * rough + N.fbm(u / 40 - 7, v / 40, 3) * isles - edgeFade(x, y, PW, PH, 110) * 1.5 - 0.14;
  });
}

function customLand(desc, seed) {
  const rows = desc.rows;
  const h = rows.length, w = rows[0].length;
  const s = customScale(w, h, desc.scale);
  const W = w * s, H = h * s;
  const src = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) src[y * w + x] = rows[y][x] === '#' ? 1 : 0;
  const sm = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.min(w - 1, Math.max(0, x + dx)), yy = Math.min(h - 1, Math.max(0, y + dy));
        sum += src[yy * w + xx];
      }
      sm[y * w + x] = src[y * w + x] * 0.5 + (sum / 9) * 0.5;
    }
  }
  const N = makeGradNoise(seed ^ 0x3c6ef372);
  const at = (x, y) => sm[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  const land = fieldLand(W, H, (x, y) => {
    const u = (x + 0.5) / s - 0.5, v = (y + 0.5) / s - 0.5;
    const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
    const val = a + (b - a) * fy;
    return val + N.fbm(x / (s * 1.6), y / (s * 1.6), 3) * 0.2 - 0.5;
  }, s >= 4 ? 2 : 1);
  return { W, H, land };
}

function customScale(w, h, want) {
  let s = Number.isFinite(want) && want >= 1 ? Math.min(16, Math.floor(want)) : Math.max(1, Math.min(16, Math.ceil(1200 / w)));
  while (s > 1 && w * s * h * s > 3200000) s--;
  return s;
}

export function generateMap(desc) {
  const seed = (desc.seed >>> 0) || 0;
  switch (desc.id) {
    case 'world':
      return buildMapFromLand(desc, WORLD_W, WORLD_H, worldLand(), seed);
    case 'archipelago':
      return buildMapFromLand(desc, PW, PH, genArchipelago(seed), seed);
    case 'pangaea':
      return buildMapFromLand(desc, PW, PH, genPangaea(seed), seed);
    case 'twin':
      return buildMapFromLand(desc, PW, PH, genTwin(seed), seed);
    case 'ring':
      return buildMapFromLand(desc, PW, PH, genRing(seed), seed);
    case 'custom': {
      const { W, H, land } = customLand(desc, seed);
      return buildMapFromLand(desc, W, H, land, seed);
    }
    default:
      return buildMapFromLand({ ...desc, id: 'random' }, PW, PH, genRandom(seed), seed);
  }
}

export function parseCustomMap(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!data || !Array.isArray(data.rows) || data.rows.length < 10) throw new Error('Карта должна содержать массив rows (минимум 10 строк)');
  const w = typeof data.rows[0] === 'string' ? data.rows[0].length : 0;
  if (w < 10 || data.rows.some((r) => typeof r !== 'string' || r.length !== w)) throw new Error('Все строки rows должны быть одной длины (>= 10)');
  if (w * data.rows.length > 400 * 250) throw new Error('Карта слишком большая (максимум 400x250)');
  if (!data.rows.some((r) => r.includes('#'))) throw new Error('На карте нет суши (символ #)');
  const desc = { id: 'custom', name: String(data.name || 'Своя карта').slice(0, 40), rows: data.rows.slice() };
  const sc = Number(data.scale);
  if (Number.isFinite(sc) && sc >= 1) desc.scale = Math.min(16, Math.floor(sc));
  desc.seed = Number.isFinite(Number(data.seed)) ? Number(data.seed) >>> 0 : 0;
  return desc;
}

export function tileLonLat(map, x, y) {
  if (!map.geo) return null;
  const g = map.geo;
  return [g.lonLeft + ((x + 0.5) / map.W) * (g.lonRight - g.lonLeft), g.latTop - ((y + 0.5) / map.H) * (g.latTop - g.latBottom)];
}

export function lonLatToTile(map, lon, lat) {
  const g = map.geo || { latTop: WORLD_LAT_TOP, latBottom: WORLD_LAT_BOTTOM, lonLeft: -180, lonRight: 180 };
  const x = Math.floor(((lon - g.lonLeft) / (g.lonRight - g.lonLeft)) * map.W);
  const y = Math.floor(((g.latTop - lat) / (g.latTop - g.latBottom)) * map.H);
  return [Math.min(map.W - 1, Math.max(0, x)), Math.min(map.H - 1, Math.max(0, y))];
}

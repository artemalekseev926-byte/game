import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { feature } from 'topojson-client';

const require = createRequire(import.meta.url);
const topo = JSON.parse(readFileSync(require.resolve('world-atlas/land-10m.json'), 'utf8'));
const land = feature(topo, topo.objects.land);

const W = 2000, H = 800;
const LAT_TOP = 84, LAT_BOTTOM = -60;
const S = 4;
const MIN_COVER = 7;
const SMALL_AREA = 6;

const px = (lon) => ((lon + 180) / 360) * W;
const py = (lat) => ((LAT_TOP - lat) / (LAT_TOP - LAT_BOTTOM)) * H;

const STRAITS = [
  [[-6.6, 35.85], [-5.9, 35.95], [-5.4, 36.0], [-4.7, 36.1]],
  [[25.9, 40.0], [26.25, 40.12], [26.5, 40.3], [26.75, 40.42], [27.2, 40.55], [27.6, 40.68]],
  [[28.85, 40.9], [29.0, 41.03], [29.08, 41.15], [29.12, 41.3], [29.2, 41.45]],
  [[12.5, 56.3], [12.62, 56.05], [12.68, 55.8], [12.75, 55.55], [12.85, 55.3]],
  [[36.45, 44.95], [36.55, 45.2], [36.62, 45.45], [36.75, 45.6]],
  [[15.55, 38.0], [15.62, 38.2], [15.68, 38.35]],
  [[43.25, 12.75], [43.38, 12.55], [43.5, 12.4]],
  [[103.4, 1.15], [103.8, 1.18], [104.2, 1.25], [104.5, 1.3]],
];

function unwrap(ring) {
  const out = [];
  let shift = 0, prev = ring[0][0];
  for (const [lon, lat] of ring) {
    if (lon - prev > 180) shift -= 360;
    else if (prev - lon > 180) shift += 360;
    prev = lon;
    out.push([lon + shift, lat]);
  }
  return out;
}

function collectPolygons() {
  const polys = [];
  let skipped = 0;
  for (const f of land.features) {
    const g = f.geometry;
    const list = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const rings of list) {
      const shifts = new Set([0]);
      const flat = [];
      for (const r of rings) {
        const u = unwrap(r);
        if (Math.abs(u[0][0] - u[u.length - 1][0]) > 1e-9) { skipped++; continue; }
        let lo = Infinity, hi = -Infinity;
        for (const [lon] of u) { lo = Math.min(lo, lon); hi = Math.max(hi, lon); }
        if (lo < -180) shifts.add(360);
        if (hi > 180) shifts.add(-360);
        flat.push(u);
      }
      if (!flat.length) continue;
      for (const d of shifts) polys.push(flat.map((r) => r.map(([lon, lat]) => [px(lon + d), py(lat)])));
    }
  }
  if (skipped) console.log('пропущено колец вокруг полюса:', skipped);
  return polys;
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(a) / 2;
}

function rasterize(polys) {
  const rows = H * S;
  const counts = new Int32Array(rows + 1);
  const eachEdge = (fn) => {
    for (const rings of polys) for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const y0 = ring[j][1] * S, y1 = ring[i][1] * S;
        if (y0 === y1) continue;
        const lo = Math.max(0, Math.ceil(Math.min(y0, y1) - 0.5));
        const hi = Math.min(rows - 1, Math.ceil(Math.max(y0, y1) - 0.5) - 1);
        if (hi < lo) continue;
        fn(ring[j][0] * S, y0, ring[i][0] * S, y1, lo, hi);
      }
    }
  };
  eachEdge((x0, y0, x1, y1, lo, hi) => { for (let r = lo; r <= hi; r++) counts[r + 1]++; });
  for (let r = 0; r < rows; r++) counts[r + 1] += counts[r];
  const xs = new Float64Array(counts[rows]);
  const fill = counts.slice(0, rows);
  eachEdge((x0, y0, x1, y1, lo, hi) => {
    const k = (x1 - x0) / (y1 - y0);
    for (let r = lo; r <= hi; r++) xs[fill[r]++] = x0 + (r + 0.5 - y0) * k;
  });
  const cover = new Uint8Array(W * H);
  const cols = W * S;
  for (let r = 0; r < rows; r++) {
    const seg = xs.subarray(counts[r], counts[r + 1]).sort();
    const base = ((r / S) | 0) * W;
    for (let k = 0; k + 1 < seg.length; k += 2) {
      const a = Math.max(0, Math.ceil(seg[k] - 0.5));
      const b = Math.min(cols, Math.ceil(seg[k + 1] - 0.5));
      for (let c = a; c < b; c++) cover[base + ((c / S) | 0)]++;
    }
  }
  return cover;
}

function keepSmallIslands(polys, land) {
  let added = 0;
  for (const rings of polys) {
    const outer = rings[0];
    if (ringArea(outer) >= SMALL_AREA) continue;
    const cells = new Set();
    for (const [x, y] of outer) {
      const cx = Math.floor(x), cy = Math.floor(y);
      if (cx >= 0 && cy >= 0 && cx < W && cy < H) cells.add(cy * W + cx);
    }
    if ([...cells].some((i) => land[i])) continue;
    for (const i of cells) { land[i] = 1; added++; }
  }
  return added;
}

function carve(land) {
  for (const line of STRAITS) {
    const pts = line.map(([lon, lat]) => [px(lon), py(lat)]);
    let prev = -1;
    for (let s = 0; s + 1 < pts.length; s++) {
      const [ax, ay] = pts[s], [bx, by] = pts[s + 1];
      const steps = Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 4) + 1;
      for (let t = 0; t <= steps; t++) {
        const x = Math.floor(ax + ((bx - ax) * t) / steps), y = Math.floor(ay + ((by - ay) * t) / steps);
        const i = y * W + x;
        if (i === prev) continue;
        if (prev >= 0) {
          const qx = prev % W, qy = (prev / W) | 0;
          if (qx !== x && qy !== y) land[qy * W + x] = 0;
        }
        land[i] = 0;
        prev = i;
      }
    }
  }
}

function pack(land) {
  const bytes = new Uint8Array(Math.ceil((W * H) / 8));
  for (let i = 0; i < W * H; i++) if (land[i]) bytes[i >> 3] |= 0x80 >> (i & 7);
  return Buffer.from(bytes).toString('base64url');
}

const t0 = process.hrtime.bigint();
const polys = collectPolygons();
const cover = rasterize(polys);
const landBits = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) landBits[i] = cover[i] >= MIN_COVER ? 1 : 0;
const added = keepSmallIslands(polys, landBits);
carve(landBits);
let count = 0;
for (let i = 0; i < W * H; i++) count += landBits[i];
const b64 = pack(landBits);
const lines = b64.match(/.{1,120}/g);

const out = `export const WORLD_W = ${W};
export const WORLD_H = ${H};
export const WORLD_LAT_TOP = ${LAT_TOP};
export const WORLD_LAT_BOTTOM = ${LAT_BOTTOM};
export const WORLD_LAND_B64 = [
${lines.map((l) => `  '${l}',`).join('\n')}
].join('');
`;
writeFileSync(new URL('../src/data/worldmap.js', import.meta.url), out);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`worldmap ${W}x${H}: суша ${count} (${((count / (W * H)) * 100).toFixed(1)}%), мелких островов добавлено ${added}, полигонов ${polys.length}, ${ms.toFixed(0)} мс`);

import { makeRng, makeNoise } from './rng.js';
import { WORLD_ROWS, WORLD_W, WORLD_H, WORLD_LAT_TOP, WORLD_LAT_BOTTOM } from '../data/worldmap.js';

export const MAPS = [
  { id: 'world', name: 'Земля', desc: 'Пиксельная карта мира. Морские пути через проливы.', players: 12 },
  { id: 'archipelago', name: 'Архипелаг', desc: 'Сотни островов — побеждает тот, кто держит моря и небо.', players: 8 },
  { id: 'pangaea', name: 'Пангея', desc: 'Один огромный материк — сухопутная мясорубка.', players: 10 },
  { id: 'twin', name: 'Два континента', desc: 'Два материка, соединённые узким перешейком.', players: 8 },
  { id: 'ring', name: 'Внутреннее море', desc: 'Кольцевой материк вокруг моря с островами в центре.', players: 8 },
  { id: 'random', name: 'Случайная', desc: 'Новая карта при каждом запуске (зависит от seed).', players: 10 },
];

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function fromRows(rows) {
  const H = rows.length, W = rows[0].length;
  const land = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) land[y * W + x] = rows[y][x] === '#' ? 1 : 0;
  return { W, H, land };
}

function fromNoise(W, H, seed, fn) {
  const noise = makeNoise(seed);
  const land = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) land[y * W + x] = fn(x, y, noise) ? 1 : 0;
  return { W, H, land };
}

function baseShape(desc) {
  const seed = desc.seed >>> 0;
  switch (desc.id) {
    case 'world':
      return { ...fromRows(WORLD_ROWS), area: 34, seaRange: 6, latTop: WORLD_LAT_TOP, latBottom: WORLD_LAT_BOTTOM };
    case 'archipelago':
      return { ...fromNoise(200, 110, seed, (x, y, n) => {
        const edge = Math.min(x, y, 199 - x, 109 - y) / 12;
        return n(x / 14, y / 14, 4) * Math.min(1, edge) > 0.57;
      }), area: 26, seaRange: 11 };
    case 'pangaea':
      return { ...fromNoise(200, 110, seed, (x, y, n) => {
        const dx = (x - 100) / 95, dy = (y - 55) / 52;
        const d = Math.sqrt(dx * dx + dy * dy);
        return n(x / 18, y / 18, 5) + 0.55 - d * 0.75 > 0.45;
      }), area: 34, seaRange: 5 };
    case 'twin':
      return { ...fromNoise(220, 100, seed, (x, y, n) => {
        const blob = (cx, cy, rx, ry) => 1 - Math.hypot((x - cx) / rx, (y - cy) / ry);
        let v = Math.max(blob(55, 50, 50, 44), blob(165, 50, 50, 44));
        if (Math.abs(y - 50 - Math.sin(x / 9) * 4) < 3 && x > 90 && x < 130) v = Math.max(v, 0.4);
        return v + (n(x / 12, y / 12, 4) - 0.5) * 0.6 > 0.12;
      }), area: 32, seaRange: 5 };
    case 'ring':
      return { ...fromNoise(180, 120, seed, (x, y, n) => {
        const d = Math.hypot((x - 90) / 82, (y - 60) / 54);
        const ring = 1 - Math.abs(d - 0.68) / 0.26;
        const isle = n(x / 7, y / 7, 3) > 0.62 && d < 0.32;
        return isle || ring + (n(x / 10, y / 10, 4) - 0.5) * 0.9 > 0.32;
      }), area: 30, seaRange: 8 };
    case 'custom': {
      const r = fromRows(desc.rows);
      return { ...r, area: desc.area || 30, seaRange: desc.seaRange || 7 };
    }
    case 'random':
    default: {
      const rng = makeRng(seed ^ 0x51ed);
      const W = 200, H = 110;
      const k = rng.range(13, 22), thr = rng.range(0.5, 0.56);
      return { ...fromNoise(W, H, seed, (x, y, n) => {
        const edge = Math.min(x, y, W - 1 - x, H - 1 - y) / 10;
        return n(x / k, y / k, 5) * Math.min(1, edge) > thr;
      }), area: 30, seaRange: 7 };
    }
  }
}

class Heap {
  constructor() { this.a = []; }
  push(p, v) {
    const a = this.a; a.push([p, v]);
    let i = a.length - 1;
    while (i > 0) { const j = (i - 1) >> 1; if (a[j][0] <= a[i][0]) break; [a[i], a[j]] = [a[j], a[i]]; i = j; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

export function generateMap(desc) {
  const seed = desc.seed >>> 0;
  const shape = baseShape(desc);
  const { W, H, land } = shape;
  const rng = makeRng(seed ^ 0x9e3779b9);
  const noise = makeNoise(seed ^ 0x1234567);
  const idx = (x, y) => y * W + x;

  const comp = new Int32Array(W * H).fill(-1);
  const comps = [];
  for (let i = 0; i < W * H; i++) {
    if (!land[i] || comp[i] >= 0) continue;
    const id = comps.length, stack = [i], tiles = [];
    comp[i] = id;
    while (stack.length) {
      const t = stack.pop(); tiles.push(t);
      const x = t % W, y = (t / W) | 0;
      for (const [dx, dy] of N4) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = idx(nx, ny);
        if (land[j] && comp[j] < 0) { comp[j] = id; stack.push(j); }
      }
    }
    comps.push(tiles);
  }
  for (const tiles of comps) if (tiles.length < 3) for (const t of tiles) land[t] = 0;

  const area = shape.area;
  const minDist = Math.sqrt(area) * 0.85;
  const landTiles = [];
  for (let i = 0; i < W * H; i++) if (land[i]) landTiles.push(i);
  const target = Math.max(4, Math.round(landTiles.length / area));
  const seeds = [];
  const cell = Math.ceil(minDist);
  const grid = new Map();
  const near = (x, y) => {
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const s of grid.get((gx + a) + ',' + (gy + b)) || []) if (Math.hypot(s[0] - x, s[1] - y) < minDist) return true;
    }
    return false;
  };
  const addSeed = (t) => {
    const x = t % W, y = (t / W) | 0;
    seeds.push(t);
    const k = Math.floor(x / cell) + ',' + Math.floor(y / cell);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push([x, y]);
  };
  for (let tries = 0; tries < target * 40 && seeds.length < target; tries++) {
    const t = landTiles[Math.floor(rng.next() * landTiles.length)];
    if (!near(t % W, (t / W) | 0)) addSeed(t);
  }

  const prov = new Int16Array(W * H).fill(-1);
  const grow = () => {
    const dist = new Float32Array(W * H).fill(Infinity);
    const heap = new Heap();
    prov.fill(-1);
    seeds.forEach((t, i) => { dist[t] = 0; heap.push(0, t * 4096 + i); });
    while (heap.size) {
      const [d, v] = heap.pop();
      const t = Math.floor(v / 4096), p = v % 4096;
      if (prov[t] >= 0) continue;
      prov[t] = p;
      const x = t % W, y = (t / W) | 0;
      for (const [dx, dy] of N4) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = idx(nx, ny);
        if (!land[j] || prov[j] >= 0) continue;
        const nd = d + 0.6 + noise(nx / 5, ny / 5, 2) * 1.4;
        if (nd < dist[j]) { dist[j] = nd; heap.push(nd, j * 4096 + p); }
      }
    }
  };
  grow();
  for (;;) {
    const orphan = landTiles.find((t) => land[t] && prov[t] < 0);
    if (orphan === undefined) break;
    addSeed(orphan);
    grow();
  }

  const build = () => {
    const n = seeds.length;
    const sizes = new Int32Array(n);
    for (let i = 0; i < W * H; i++) if (prov[i] >= 0) sizes[prov[i]]++;
    return sizes;
  };
  let sizes = build();
  const adjOf = (p) => {
    const counts = new Map();
    for (let i = 0; i < W * H; i++) {
      if (prov[i] !== p) continue;
      const x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of N4) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = prov[idx(nx, ny)];
        if (q >= 0 && q !== p) counts.set(q, (counts.get(q) || 0) + 1);
      }
    }
    return counts;
  };
  for (let p = 0; p < seeds.length; p++) {
    if (sizes[p] === 0 || sizes[p] >= area * 0.3) continue;
    const adj = adjOf(p);
    if (!adj.size) continue;
    let best = -1, bestSize = Infinity;
    for (const q of adj.keys()) if (sizes[q] < bestSize) { bestSize = sizes[q]; best = q; }
    for (let i = 0; i < W * H; i++) if (prov[i] === p) prov[i] = best;
    sizes[best] += sizes[p]; sizes[p] = 0;
  }
  const remap = new Int16Array(seeds.length).fill(-1);
  let count = 0;
  for (let p = 0; p < seeds.length; p++) if (sizes[p] > 0) remap[p] = count++;
  for (let i = 0; i < W * H; i++) if (prov[i] >= 0) prov[i] = remap[prov[i]];

  const provinces = [];
  for (let p = 0; p < count; p++) provinces.push({ id: p, size: 0, sx: 0, sy: 0, neighbors: new Set(), sea: new Set(), coastal: false, tiles: [] });
  for (let i = 0; i < W * H; i++) {
    const p = prov[i];
    if (p < 0) continue;
    const P = provinces[p], x = i % W, y = (i / W) | 0;
    P.size++; P.sx += x; P.sy += y; P.tiles.push(i);
    for (const [dx, dy] of N4) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) { continue; }
      const q = prov[idx(nx, ny)];
      if (q < 0) P.coastal = true;
      else if (q !== p) P.neighbors.add(q);
    }
  }
  for (const P of provinces) {
    const mx = P.sx / P.size, my = P.sy / P.size;
    let best = P.tiles[0], bd = Infinity;
    for (const t of P.tiles) {
      const x = t % W, y = (t / W) | 0;
      let inner = 0;
      for (const [dx, dy] of N4) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H && prov[idx(nx, ny)] === P.id) inner++; }
      const d = Math.hypot(x - mx, y - my) + (4 - inner) * 1.5;
      if (d < bd) { bd = d; best = t; }
    }
    P.cx = best % W; P.cy = (best / W) | 0;
  }

  const seaDist = new Int16Array(W * H);
  const seaLinks = (P, range) => {
    seaDist.fill(-1);
    const q = [];
    for (const t of P.tiles) {
      const x = t % W, y = (t / W) | 0;
      for (const [dx, dy] of N4) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = idx(nx, ny);
        if (!land[j] && seaDist[j] < 0) { seaDist[j] = 1; q.push(j); }
      }
    }
    for (let h = 0; h < q.length; h++) {
      const t = q[h], x = t % W, y = (t / W) | 0, d = seaDist[t];
      for (const [dx, dy] of N4) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = idx(nx, ny);
        if (land[j]) {
          const o = prov[j];
          if (o !== P.id && !P.neighbors.has(o)) P.sea.add(o);
        } else if (seaDist[j] < 0 && d < range) { seaDist[j] = d + 1; q.push(j); }
      }
    }
  };
  for (const P of provinces) if (P.coastal) seaLinks(P, shape.seaRange);
  for (const P of provinces) {
    for (let r = shape.seaRange * 2; P.coastal && !P.neighbors.size && !P.sea.size && r < 200; r *= 2) seaLinks(P, r);
  }
  for (const P of provinces) for (const o of P.sea) if (!provinces[o].neighbors.has(P.id)) provinces[o].sea.add(P.id);

  for (;;) {
    const compOf = new Int32Array(provinces.length).fill(-1);
    let nc = 0;
    for (const P of provinces) {
      if (compOf[P.id] >= 0) continue;
      const st = [P.id]; compOf[P.id] = nc;
      while (st.length) {
        const c = st.pop();
        for (const n of [...provinces[c].neighbors, ...provinces[c].sea]) if (compOf[n] < 0) { compOf[n] = nc; st.push(n); }
      }
      nc++;
    }
    if (nc <= 1) break;
    let best = null, bd = Infinity;
    for (const A of provinces) {
      if (compOf[A.id] !== 0 || !A.coastal) continue;
      for (const B of provinces) {
        if (compOf[B.id] === 0 || !B.coastal) continue;
        const d = Math.hypot(A.cx - B.cx, A.cy - B.cy);
        if (d < bd) { bd = d; best = [A, B]; }
      }
    }
    if (!best) break;
    best[0].sea.add(best[1].id); best[1].sea.add(best[0].id);
  }

  const tnoise = makeNoise(seed ^ 0xabcdef);
  for (const P of provinces) {
    let terrain = 'plain';
    const lat = shape.latTop !== undefined
      ? shape.latTop - (P.cy / H) * (shape.latTop - shape.latBottom)
      : 70 - (P.cy / H) * 140;
    const m = tnoise(P.cx / 9, P.cy / 9, 3), f = tnoise(P.cx / 6 + 50, P.cy / 6 + 50, 3);
    if (Math.abs(lat) > 58) terrain = 'snow';
    else if (m > 0.64) terrain = 'hills';
    else if (Math.abs(lat) > 14 && Math.abs(lat) < 34 && f < 0.48) terrain = 'desert';
    else if (f > 0.55) terrain = 'forest';
    P.terrain = terrain;
  }

  const name = desc.id === 'custom' ? desc.name || 'Своя карта' : (MAPS.find((m) => m.id === desc.id) || MAPS[MAPS.length - 1]).name;
  return {
    desc, name, W, H, land, prov,
    provinces: provinces.map((P) => ({
      id: P.id, cx: P.cx, cy: P.cy, size: P.size, coastal: P.coastal, terrain: P.terrain,
      neighbors: [...P.neighbors].sort((a, b) => a - b),
      sea: [...P.sea].sort((a, b) => a - b),
      adj: [...new Set([...P.neighbors, ...P.sea])].sort((a, b) => a - b),
    })),
  };
}

export function parseCustomMap(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!Array.isArray(data.rows) || data.rows.length < 10) throw new Error('Карта должна содержать массив rows (минимум 10 строк)');
  const w = data.rows[0].length;
  if (w < 10 || data.rows.some((r) => typeof r !== 'string' || r.length !== w)) throw new Error('Все строки rows должны быть одной длины (>= 10)');
  if (w * data.rows.length > 400 * 250) throw new Error('Карта слишком большая (максимум 400x250)');
  return { id: 'custom', name: String(data.name || 'Своя карта').slice(0, 40), rows: data.rows, area: data.area, seaRange: data.seaRange };
}

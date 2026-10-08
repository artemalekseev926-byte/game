export const NAV_SCALE = 4;
export const NAV_SEARCH = 6;
const CACHE_MAX = 500;
const SQ2 = Math.SQRT2;
const HEUR_W = 1.15;

function pairKey(a, b, R) {
  return a < b ? a * R + b : b * R + a;
}

function uniqueKeys(keys) {
  const arr = Float64Array.from(keys).sort();
  let n = 0;
  for (let k = 0; k < arr.length; k++) if (k === 0 || arr[k] !== arr[k - 1]) arr[n++] = arr[k];
  return arr.subarray(0, n);
}

function toCsr(keys, R) {
  const start = new Int32Array(R + 1);
  for (let k = 0; k < keys.length; k++) {
    const a = Math.floor(keys[k] / R), b = keys[k] - a * R;
    start[a + 1]++; start[b + 1]++;
  }
  for (let a = 0; a < R; a++) start[a + 1] += start[a];
  const fill = start.slice(0, R);
  const list = new Int32Array(start[R]);
  for (let k = 0; k < keys.length; k++) {
    const a = Math.floor(keys[k] / R), b = keys[k] - a * R;
    list[fill[a]++] = b; list[fill[b]++] = a;
  }
  for (let a = 0; a < R; a++) if (start[a + 1] - start[a] > 1) list.subarray(start[a], start[a + 1]).sort();
  return { start, list };
}

export function buildNav(map) {
  const { W, H, waterBody, oceanBodies } = map;
  const S = NAV_SCALE;
  const N = W * H;
  const cw = Math.ceil(W / S), ch = Math.ceil(H / S);
  let maxBody = -1;
  for (const b of oceanBodies) if (b > maxBody) maxBody = b;
  const isOcean = new Uint8Array(maxBody + 2);
  for (const b of oceanBodies) isOcean[b] = 1;
  const ocean = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const b = waterBody[i];
    if (b >= 0 && b <= maxBody && isOcean[b]) ocean[i] = 1;
  }
  const region = new Int32Array(N).fill(-1);
  const rCell = [], rRep = [], rBody = [];
  const water = new Uint8Array(cw * ch);
  const body = new Int32Array(cw * ch).fill(-1);
  const stack = new Int32Array(S * S);
  const cells = new Int32Array(S * S);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const c = cy * cw + cx;
      const x0 = cx * S, y0 = cy * S, x1 = Math.min(W, x0 + S), y1 = Math.min(H, y0 + S);
      if (x1 - x0 === S && y1 - y0 === S) {
        let full = true;
        for (let y = y0; y < y1 && full; y++) for (let x = x0; x < x1; x++) if (!ocean[y * W + x]) { full = false; break; }
        if (full) {
          const r = rCell.length;
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) region[y * W + x] = r;
          const rep = (y0 + (S >> 1) - 1) * W + x0 + (S >> 1) - 1;
          rCell.push(c); rRep.push(rep); rBody.push(waterBody[rep]);
          water[c] = 1; body[c] = waterBody[rep];
          continue;
        }
      }
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const s = y * W + x;
          if (!ocean[s] || region[s] >= 0) continue;
          const r = rCell.length;
          let sp = 0, n = 0, sx = 0, sy = 0;
          stack[sp++] = s; region[s] = r;
          while (sp) {
            const i = stack[--sp];
            cells[n++] = i;
            const ix = i % W, iy = (i - ix) / W;
            sx += ix; sy += iy;
            if (ix > x0 && ocean[i - 1] && region[i - 1] < 0) { region[i - 1] = r; stack[sp++] = i - 1; }
            if (ix < x1 - 1 && ocean[i + 1] && region[i + 1] < 0) { region[i + 1] = r; stack[sp++] = i + 1; }
            if (iy > y0 && ocean[i - W] && region[i - W] < 0) { region[i - W] = r; stack[sp++] = i - W; }
            if (iy < y1 - 1 && ocean[i + W] && region[i + W] < 0) { region[i + W] = r; stack[sp++] = i + W; }
          }
          const mx = sx / n, my = sy / n;
          let rep = cells[0], bd = Infinity;
          for (let k = 0; k < n; k++) {
            const i = cells[k], ix = i % W, iy = (i - ix) / W;
            const d = (ix - mx) * (ix - mx) + (iy - my) * (iy - my);
            if (d < bd || (d === bd && i < rep)) { bd = d; rep = i; }
          }
          rCell.push(c); rRep.push(rep); rBody.push(waterBody[rep]);
          if (!water[c]) { water[c] = 1; body[c] = waterBody[rep]; }
        }
      }
    }
  }
  const R = rCell.length;
  const okeys = [];
  let last = -1;
  const addKey = (a, b) => {
    const k = pairKey(a, b, R);
    if (k !== last) { okeys.push(k); last = k; }
  };
  for (let x = S - 1; x + 1 < W; x += S) {
    for (let y = 0; y < H; y++) {
      const i = y * W + x;
      if (ocean[i] && ocean[i + 1]) addKey(region[i], region[i + 1]);
    }
  }
  for (let y = S - 1; y + 1 < H; y += S) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (ocean[i] && ocean[i + W]) addKey(region[i], region[i + W]);
    }
  }
  const orth = toCsr(uniqueKeys(okeys), R);
  const dkeys = [];
  for (let a = 0; a < R; a++) {
    const ax = rCell[a] % cw, ay = (rCell[a] - ax) / cw;
    for (let k = orth.start[a]; k < orth.start[a + 1]; k++) {
      const c = orth.list[k];
      for (let m = orth.start[c]; m < orth.start[c + 1]; m++) {
        const b = orth.list[m];
        if (b <= a) continue;
        const bx = rCell[b] % cw, by = (rCell[b] - bx) / cw;
        if ((bx - ax === 1 || ax - bx === 1) && (by - ay === 1 || ay - by === 1)) dkeys.push(a * R + b);
      }
    }
  }
  const diag = toCsr(uniqueKeys(dkeys), R);
  const adjStart = new Int32Array(R + 1);
  for (let a = 0; a < R; a++) adjStart[a + 1] = adjStart[a] + (orth.start[a + 1] - orth.start[a]) + (diag.start[a + 1] - diag.start[a]);
  const adj = new Int32Array(adjStart[R]);
  const adjCost = new Float64Array(adjStart[R]);
  for (let a = 0; a < R; a++) {
    let k = adjStart[a];
    const k0 = k;
    for (let m = orth.start[a]; m < orth.start[a + 1]; m++) { adj[k] = orth.list[m]; adjCost[k++] = 1; }
    for (let m = diag.start[a]; m < diag.start[a + 1]; m++) { adj[k] = diag.list[m]; adjCost[k++] = SQ2; }
    for (let p = k0 + 1; p < k; p++) {
      const b = adj[p], c = adjCost[p];
      let q = p - 1;
      while (q >= k0 && adj[q] > b) { adj[q + 1] = adj[q]; adjCost[q + 1] = adjCost[q]; q--; }
      adj[q + 1] = b; adjCost[q + 1] = c;
    }
  }
  const shoreList = [];
  for (let i = 0; i < N; i++) {
    if (waterBody[i] >= 0) continue;
    const x = i % W;
    if ((x > 0 && ocean[i - 1]) || (x < W - 1 && ocean[i + 1]) || (i >= W && ocean[i - W]) || (i < N - W && ocean[i + W])) shoreList.push(i);
  }
  return {
    scale: S, cw, ch, water, body, ocean, region,
    rCell: Int32Array.from(rCell), rRep: Int32Array.from(rRep), rBody: Int32Array.from(rBody),
    adjStart, adj, adjCost, shore: Int32Array.from(shoreList),
    cache: new Map(), work: null,
  };
}

function workOf(map) {
  const nav = map.nav;
  if (!nav.work) {
    const R = nav.rCell.length, N = map.W * map.H;
    nav.work = {
      stamp: 0,
      g: new Float64Array(R), from: new Int32Array(R), seen: new Uint32Array(R), closed: new Uint32Array(R), corr: new Uint32Array(R),
      hf: new Float64Array(nav.adj.length + 2), hh: new Float64Array(nav.adj.length + 2), hn: new Int32Array(nav.adj.length + 2),
      visited: new Uint32Array(N), prev: new Int32Array(N), queue: new Int32Array(1024),
    };
  }
  const w = nav.work;
  w.stamp = (w.stamp + 1) >>> 0;
  if (w.stamp === 0) {
    w.seen.fill(0); w.closed.fill(0); w.corr.fill(0); w.visited.fill(0);
    w.stamp = 1;
  }
  return w;
}

export function nearestOceanTile(map, x, y, maxR = NAV_SEARCH * NAV_SCALE, body = -1) {
  const { W, H, nav } = map;
  const ocean = nav.ocean;
  const cx = Math.min(W - 1, Math.max(0, Math.floor(x))), cy = Math.min(H - 1, Math.max(0, Math.floor(y)));
  let best = -1, bd = Infinity;
  for (let r = 0; r <= maxR; r++) {
    if (r * r > bd) break;
    for (let dy = -r; dy <= r; dy++) {
      const yy = cy + dy;
      if (yy < 0 || yy >= H) continue;
      const edge = dy === -r || dy === r;
      const step = edge ? 1 : 2 * r;
      for (let dx = -r; dx <= r; dx += step || 1) {
        const xx = cx + dx;
        if (xx < 0 || xx >= W) continue;
        const i = yy * W + xx;
        if (!ocean[i] || (body >= 0 && map.waterBody[i] !== body)) continue;
        const d = dx * dx + dy * dy;
        if (d < bd || (d === bd && i < best)) { bd = d; best = i; }
      }
    }
  }
  return best;
}

export function coastBodies(map, i) {
  const { W, H, nav, waterBody } = map;
  const out = [];
  const x = i % W;
  const add = (j) => {
    if (nav.ocean[j] && !out.includes(waterBody[j])) out.push(waterBody[j]);
  };
  if (x > 0) add(i - 1);
  if (x < W - 1) add(i + 1);
  if (i >= W) add(i - W);
  if (i < W * H - W) add(i + W);
  return out;
}

export function nearestCoastTile(map, owner, pid1, x, y, maxR = Infinity, body = -1) {
  const { W } = map;
  const shore = map.nav.shore;
  const lim = maxR * maxR;
  let best = -1, bd = Infinity;
  for (let k = 0; k < shore.length; k++) {
    const i = shore[k];
    if (owner[i] !== pid1) continue;
    const ix = i % W, iy = (i - ix) / W;
    const dx = ix - x, dy = iy - y;
    const d = dx * dx + dy * dy;
    if (d > lim || d >= bd) continue;
    if (body >= 0 && !coastBodies(map, i).includes(body)) continue;
    bd = d; best = i;
  }
  return best;
}

function octile(dx, dy) {
  if (dx < 0) dx = -dx;
  if (dy < 0) dy = -dy;
  return dx > dy ? dx + (SQ2 - 1) * dy : dy + (SQ2 - 1) * dx;
}

function regionPath(nav, w, rs, rt) {
  const { rCell, cw, adjStart, adj, adjCost } = nav;
  const st = w.stamp;
  const tx = rCell[rt] % cw, ty = (rCell[rt] - tx) / cw;
  const hOf = (r) => {
    const c = rCell[r], x = c % cw;
    return octile(x - tx, (c - x) / cw - ty) * HEUR_W;
  };
  const hf = w.hf, hh = w.hh, hn = w.hn;
  let size = 0;
  const push = (f, h, n) => {
    let i = size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const pf = hf[p];
      if (pf < f || (pf === f && (hh[p] < h || (hh[p] === h && hn[p] < n)))) break;
      hf[i] = pf; hh[i] = hh[p]; hn[i] = hn[p];
      i = p;
    }
    hf[i] = f; hh[i] = h; hn[i] = n;
  };
  const pop = () => {
    const top = hn[0];
    size--;
    const f = hf[size], h = hh[size], n = hn[size];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= size) break;
      let m = l;
      const r = l + 1;
      if (r < size && (hf[r] < hf[l] || (hf[r] === hf[l] && (hh[r] < hh[l] || (hh[r] === hh[l] && hn[r] < hn[l]))))) m = r;
      if (f < hf[m] || (f === hf[m] && (h < hh[m] || (h === hh[m] && n < hn[m])))) break;
      hf[i] = hf[m]; hh[i] = hh[m]; hn[i] = hn[m];
      i = m;
    }
    hf[i] = f; hh[i] = h; hn[i] = n;
    return top;
  };
  w.g[rs] = 0; w.seen[rs] = st; w.from[rs] = -1;
  const h0 = hOf(rs);
  push(h0, h0, rs);
  while (size) {
    const a = pop();
    if (w.closed[a] === st) continue;
    w.closed[a] = st;
    if (a === rt) {
      const out = [];
      for (let r = rt; r >= 0; r = w.from[r]) out.push(r);
      return out.reverse();
    }
    const ga = w.g[a];
    for (let k = adjStart[a]; k < adjStart[a + 1]; k++) {
      const b = adj[k];
      if (w.closed[b] === st) continue;
      const g = ga + adjCost[k];
      if (w.seen[b] === st && g >= w.g[b]) continue;
      w.seen[b] = st; w.g[b] = g; w.from[b] = a;
      const h = hOf(b);
      push(g + h, h, b);
    }
  }
  return null;
}

function fineCorridorPath(map, w, regions, s, t) {
  const { W, H, nav } = map;
  const N = W * H;
  const { ocean, region, adjStart, adj } = nav;
  const st = w.stamp;
  for (const r of regions) {
    w.corr[r] = st;
    for (let k = adjStart[r]; k < adjStart[r + 1]; k++) w.corr[adj[k]] = st;
  }
  let q = w.queue;
  let head = 0, tail = 0;
  q[tail++] = s; w.visited[s] = st; w.prev[s] = -1;
  let found = false;
  while (head < tail) {
    const i = q[head++];
    if (i === t) { found = true; break; }
    const x = i % W;
    for (let k = 0; k < 4; k++) {
      let j;
      if (k === 0) { if (x === 0) continue; j = i - 1; }
      else if (k === 1) { if (x === W - 1) continue; j = i + 1; }
      else if (k === 2) { if (i < W) continue; j = i - W; }
      else { if (i >= N - W) continue; j = i + W; }
      if (!ocean[j] || w.visited[j] === st || w.corr[region[j]] !== st) continue;
      w.visited[j] = st; w.prev[j] = i;
      if (tail >= q.length) {
        const nq = new Int32Array(q.length * 2);
        nq.set(q); q = w.queue = nq;
      }
      q[tail++] = j;
    }
  }
  if (!found) return null;
  const out = [];
  for (let i = t; i >= 0; i = w.prev[i]) out.push(i);
  return out.reverse();
}

function los(map, ax, ay, bx, by) {
  const { W, H } = map;
  const ocean = map.nav.ocean;
  const ok = (x, y) => x >= 0 && y >= 0 && x < W && y < H && ocean[y * W + x] === 1;
  let x = Math.floor(ax), y = Math.floor(ay);
  const ex = Math.floor(bx), ey = Math.floor(by);
  if (!ok(x, y)) return false;
  const dx = bx - ax, dy = by - ay;
  const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0, sy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tdx = sx ? 1 / Math.abs(dx) : Infinity, tdy = sy ? 1 / Math.abs(dy) : Infinity;
  let tmx = sx > 0 ? (x + 1 - ax) * tdx : sx < 0 ? (ax - x) * tdx : Infinity;
  let tmy = sy > 0 ? (y + 1 - ay) * tdy : sy < 0 ? (ay - y) * tdy : Infinity;
  let guard = Math.abs(ex - x) + Math.abs(ey - y) + 2;
  while ((x !== ex || y !== ey) && guard-- > 0) {
    const diff = tmx - tmy;
    if (diff < -1e-9) { x += sx; tmx += tdx; }
    else if (diff > 1e-9) { y += sy; tmy += tdy; }
    else {
      if (!ok(x + sx, y) || !ok(x, y + sy)) return false;
      x += sx; y += sy; tmx += tdx; tmy += tdy;
    }
    if (!ok(x, y)) return false;
  }
  return x === ex && y === ey;
}

function pull(map, cells) {
  const W = map.W;
  const px = (i) => (i % W) + 0.5;
  const py = (i) => Math.floor(i / W) + 0.5;
  const m = cells.length;
  const out = [[px(cells[0]), py(cells[0])]];
  let a = 0;
  while (a < m - 1) {
    const ax = px(cells[a]), ay = py(cells[a]);
    const see = (j) => los(map, ax, ay, px(cells[j]), py(cells[j]));
    let good = a + 1, bad = m;
    let step = 1;
    for (;;) {
      const probe = Math.min(m - 1, a + 1 + step);
      if (probe <= good) break;
      if (see(probe)) {
        good = probe;
        if (probe === m - 1) break;
        step *= 2;
      } else { bad = probe; break; }
    }
    while (bad - good > 1) {
      const mid = (good + bad) >> 1;
      if (see(mid)) good = mid; else bad = mid;
    }
    out.push([px(cells[good]), py(cells[good])]);
    a = good;
  }
  return out;
}

function computePath(map, s, t) {
  const nav = map.nav;
  const w = workOf(map);
  if (s === t) return [[(s % map.W) + 0.5, Math.floor(s / map.W) + 0.5]];
  const regions = regionPath(nav, w, nav.region[s], nav.region[t]);
  if (!regions) return null;
  const cells = fineCorridorPath(map, w, regions, s, t);
  if (!cells) return null;
  return pull(map, cells);
}

export function findWaterPath(map, x0, y0, x1, y1) {
  const nav = map.nav;
  const R = NAV_SEARCH * NAV_SCALE;
  let s = nearestOceanTile(map, x0, y0, R, -1);
  if (s < 0) return null;
  let t = nearestOceanTile(map, x1, y1, R, map.waterBody[s]);
  if (t < 0) {
    t = nearestOceanTile(map, x1, y1, R, -1);
    if (t < 0) return null;
    s = nearestOceanTile(map, x0, y0, R, map.waterBody[t]);
    if (s < 0) return null;
  }
  const flip = s > t;
  const a = flip ? t : s, b = flip ? s : t;
  const key = a * map.W * map.H + b;
  let path;
  if (nav.cache.has(key)) {
    path = nav.cache.get(key);
    nav.cache.delete(key);
  } else {
    path = computePath(map, a, b);
  }
  nav.cache.set(key, path);
  if (nav.cache.size > CACHE_MAX) nav.cache.delete(nav.cache.keys().next().value);
  if (!path) return null;
  const out = new Array(path.length);
  for (let k = 0; k < path.length; k++) {
    const p = path[flip ? path.length - 1 - k : k];
    out[k] = [p[0], p[1]];
  }
  return out;
}

export function pathLength(path) {
  let len = 0;
  for (let k = 1; k < path.length; k++) {
    const dx = path[k][0] - path[k - 1][0], dy = path[k][1] - path[k - 1][1];
    len += Math.sqrt(dx * dx + dy * dy);
  }
  return len;
}

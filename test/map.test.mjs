import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAPS, TER, generateMap, buildMapFromLand, parseCustomMap, isLand, lonLatToTile } from '../src/core/map.js';
import { findWaterPath, nearestCoastTile, nearestOceanTile, coastBodies, pathLength } from '../src/core/nav.js';

const cache = new Map();
const get = (id, seed = 5) => {
  const key = id + ':' + seed;
  if (!cache.has(key)) cache.set(key, generateMap({ id, seed }));
  return cache.get(key);
};

const hashArr = (arr) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < arr.length; i++) h = Math.imul(h ^ (arr[i] & 0xff), 16777619);
  return h >>> 0;
};

const landNear = (map, lon, lat, r = 0) => {
  const [x, y] = lonLatToTile(map, lon, lat);
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx >= 0 && yy >= 0 && xx < map.W && yy < map.H && isLand(map.terrain[yy * map.W + xx])) return true;
  }
  return false;
};

const landInBox = (map, lon0, lat0, lon1, lat1) => {
  const [x0, y0] = lonLatToTile(map, lon0, lat1), [x1, y1] = lonLatToTile(map, lon1, lat0);
  let n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (isLand(map.terrain[y * map.W + x])) n++;
  return n;
};

const crossesLand = (map, path) => {
  for (let k = 1; k < path.length; k++) {
    const [ax, ay] = path[k - 1], [bx, by] = path[k];
    const n = Math.ceil(Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2) * 16) + 1;
    for (let s = 0; s <= n; s++) {
      const x = Math.floor(ax + ((bx - ax) * s) / n), y = Math.floor(ay + ((by - ay) * s) / n);
      if (isLand(map.terrain[y * map.W + x])) return true;
    }
  }
  return false;
};

const ocean = (map, lon, lat) => {
  const [x, y] = lonLatToTile(map, lon, lat);
  return map.waterBody[y * map.W + x];
};

test('все карты генерируются и согласованы', () => {
  for (const m of MAPS) {
    const map = get(m.id);
    assert.equal(map.W, m.w, m.id);
    assert.equal(map.H, m.h, m.id);
    assert.equal(map.terrain.length, map.W * map.H);
    let land = 0, coast = 0;
    for (let i = 0; i < map.terrain.length; i++) {
      const t = map.terrain[i];
      assert.ok(t >= 0 && t <= 7);
      if (isLand(t)) {
        land++;
        assert.equal(map.waterBody[i], -1);
        if (map.coast[i]) coast++;
      } else {
        assert.ok(map.waterBody[i] >= 0);
        assert.equal(map.coast[i], 0);
      }
    }
    assert.equal(map.landCount, land, m.id);
    assert.ok(land / (map.W * map.H) > 0.15 && land / (map.W * map.H) < 0.55, `${m.id}: доля суши ${land / (map.W * map.H)}`);
    assert.ok(coast > 0);
    assert.ok(map.oceanBodies.size >= 1, m.id);
    for (const b of map.oceanBodies) assert.ok(map.bodySize[b] >= 400);
    assert.ok(map.nav && map.nav.scale === 4 && map.nav.water.length === map.nav.cw * map.nav.ch);
    const kinds = new Set();
    for (let i = 0; i < map.terrain.length; i++) kinds.add(map.terrain[i]);
    for (const t of [TER.DEEP, TER.SHALLOW, TER.PLAINS, TER.FOREST, TER.HILLS]) assert.ok(kinds.has(t), `${m.id}: нет рельефа ${t}`);
  }
});

test('мелководье и береговые клетки', () => {
  const map = get('archipelago');
  const { W, H, terrain, coast } = map;
  for (let y = 1; y < H - 1; y += 3) {
    for (let x = 1; x < W - 1; x += 3) {
      const i = y * W + x;
      const nb = [i - 1, i + 1, i - W, i + W];
      if (isLand(terrain[i])) assert.equal(coast[i] === 1, nb.some((j) => !isLand(terrain[j])));
      if (terrain[i] === TER.DEEP) assert.ok(nb.every((j) => !isLand(terrain[j])));
    }
  }
});

test('карта мира 2000x800 с мелкими островами', () => {
  const map = get('world', 1);
  assert.equal(map.W, 2000);
  assert.equal(map.H, 800);
  const frac = map.landCount / (map.W * map.H);
  assert.ok(frac >= 0.25 && frac <= 0.32, `доля суши ${frac}`);
  assert.ok(landNear(map, -155.5, 19.6), 'Гавайи');
  assert.ok(landNear(map, -157.95, 21.45, 1), 'Оаху');
  assert.ok(landNear(map, -16.6, 28.25, 1), 'Тенерифе');
  assert.ok(landNear(map, -15.6, 27.95, 1), 'Гран-Канария');
  assert.ok(landInBox(map, 72.6, -0.8, 73.9, 7.2) >= 5, 'Мальдивы');
  assert.ok(landNear(map, -77.3, 18.1), 'Ямайка');
  assert.ok(landNear(map, 147.9, 45.0, 1), 'Курилы');
  assert.ok(landNear(map, 178.0, -17.8, 1), 'Фиджи');
  assert.ok(landNear(map, -25.5, 37.8, 1), 'Азорские острова');
  assert.ok(!landNear(map, -40, 30), 'Атлантика');
  assert.ok(!landNear(map, -140, 0), 'Тихий океан');
  for (const [lon, lat] of [[2, 47], [100, 60], [-100, 40], [-60, -10], [20, 0], [135, -25]]) assert.ok(landNear(map, lon, lat), `материк ${lon},${lat}`);
});

test('рельеф мира узнаваем', () => {
  const map = get('world', 1);
  const share = (lon0, lat0, lon1, lat1, t) => {
    const [x0, y0] = lonLatToTile(map, lon0, lat1), [x1, y1] = lonLatToTile(map, lon1, lat0);
    let n = 0, all = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const v = map.terrain[y * map.W + x];
      if (!isLand(v)) continue;
      all++;
      if (t.includes(v)) n++;
    }
    return n / Math.max(1, all);
  };
  assert.ok(share(-5, 18, 25, 28, [TER.DESERT]) > 0.6, 'Сахара');
  assert.ok(share(42, 18, 52, 26, [TER.DESERT]) > 0.5, 'Аравия');
  assert.ok(share(125, -28, 140, -20, [TER.DESERT]) > 0.4, 'Австралия');
  assert.ok(share(80, 27.5, 92, 31, [TER.MOUNTAIN, TER.HILLS, TER.SNOW]) > 0.4, 'Гималаи');
  assert.ok(share(-72, -35, -69, -20, [TER.MOUNTAIN, TER.HILLS, TER.SNOW]) > 0.35, 'Анды');
  assert.ok(share(70, 57, 120, 64, [TER.FOREST]) > 0.4, 'Сибирская тайга');
  assert.ok(share(-70, -10, -55, 0, [TER.FOREST]) > 0.5, 'Амазония');
  assert.ok(share(-50, 70, -30, 80, [TER.SNOW]) > 0.8, 'Гренландия');
});

test('проливы: Средиземное и Чёрное моря связаны с океаном', () => {
  const map = get('world', 1);
  const atl = ocean(map, -30, 35);
  assert.ok(map.oceanBodies.has(atl));
  assert.equal(ocean(map, 5, 40), atl, 'Средиземное море');
  assert.equal(ocean(map, 34, 43), atl, 'Чёрное море');
  assert.equal(ocean(map, 20, 57), atl, 'Балтийское море');
  assert.equal(ocean(map, 38, 20), atl, 'Красное море');
  assert.equal(ocean(map, 51, 27), atl, 'Персидский залив');
  assert.equal(ocean(map, -85, 60), atl, 'Гудзонов залив');
  assert.notEqual(ocean(map, 51, 42), atl, 'Каспий — отдельный водоём');
});

test('детерминизм генерации', () => {
  for (const id of ['world', 'random', 'archipelago']) {
    const a = generateMap({ id, seed: 42 });
    const b = generateMap({ id, seed: 42 });
    assert.equal(hashArr(a.terrain), hashArr(b.terrain), id);
    assert.equal(hashArr(a.elev), hashArr(b.elev), id);
    assert.equal(a.landCount, b.landCount);
    assert.equal(a.nav.rCell.length, b.nav.rCell.length);
  }
  const r1 = generateMap({ id: 'random', seed: 1 }), r2 = generateMap({ id: 'random', seed: 2 });
  assert.notEqual(hashArr(r1.terrain), hashArr(r2.terrain));
});

test('карта мира генерируется быстрее 1.5 с', () => {
  get('world', 1);
  let best = Infinity;
  for (let k = 0; k < 2; k++) {
    const t = performance.now();
    generateMap({ id: 'world', seed: 100 + k });
    best = Math.min(best, performance.now() - t);
  }
  assert.ok(best < 1500, `генерация ${best.toFixed(0)} мс`);
});

test('архипелаг состоит из множества островов', () => {
  const map = get('archipelago', 3);
  const { W, H, terrain } = map;
  const seen = new Uint8Array(W * H);
  let islands = 0, big = 0;
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || !isLand(terrain[s])) continue;
    const st = [s];
    seen[s] = 1;
    let n = 0;
    while (st.length) {
      const i = st.pop();
      n++;
      const x = i % W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
        if (j >= 0 && j < W * H && !seen[j] && isLand(terrain[j])) { seen[j] = 1; st.push(j); }
      }
    }
    islands++;
    if (n > 5000) big++;
  }
  assert.ok(islands >= 40, `островов ${islands}`);
  assert.ok(big >= 6, `крупных островов ${big}`);
});

test('острова от 2 клеток сохраняются, одиночные пиксели удаляются', () => {
  const W = 120, H = 80;
  const land = new Uint8Array(W * H);
  for (let y = 20; y < 60; y++) for (let x = 20; x < 70; x++) land[y * W + x] = 1;
  land[10 * W + 100] = 1;
  land[30 * W + 100] = 1; land[30 * W + 101] = 1;
  const map = buildMapFromLand({ id: 'custom', name: 'тест', seed: 1 }, W, H, land, 1);
  assert.ok(!isLand(map.terrain[10 * W + 100]));
  assert.ok(isLand(map.terrain[30 * W + 100]) && isLand(map.terrain[30 * W + 101]));
  const world = buildMapFromLand({ id: 'world', seed: 1 }, W, H, land, 1);
  assert.ok(isLand(world.terrain[10 * W + 100]));
});

test('пользовательские карты масштабируются', () => {
  for (const f of ['krest', 'shahmaty']) {
    const raw = JSON.parse(readFileSync(new URL(`../maps/${f}.json`, import.meta.url), 'utf8'));
    const desc = parseCustomMap(JSON.stringify(raw));
    assert.equal(desc.id, 'custom');
    const map = generateMap({ ...desc, seed: 3 });
    assert.equal(map.W, raw.rows[0].length * 8);
    assert.equal(map.H, raw.rows.length * 8);
    assert.equal(map.name, raw.name);
    let srcLand = 0;
    for (const r of raw.rows) for (const c of r) if (c === '#') srcLand++;
    const ratio = map.landCount / (srcLand * 64);
    assert.ok(ratio > 0.85 && ratio < 1.15, `${f}: ${ratio}`);
    assert.ok(map.oceanBodies.size >= 1);
  }
  const rows = Array.from({ length: 20 }, (_, y) => Array.from({ length: 30 }, (_, x) => ((x - 15) ** 2 + (y - 10) ** 2 < 70 ? '#' : '.')).join(''));
  const d2 = parseCustomMap({ name: 'Тест', rows, scale: 4 });
  const m2 = generateMap({ ...d2, seed: 1 });
  assert.equal(m2.W, 120);
  assert.equal(m2.H, 80);
  assert.throws(() => parseCustomMap('{"rows":["##"]}'));
  assert.throws(() => parseCustomMap({ rows: Array.from({ length: 12 }, () => '.'.repeat(12)) }));
  assert.throws(() => parseCustomMap('не json'));
});

test('навигация: путь по океану не пересекает сушу', () => {
  const map = get('world', 1);
  const pairs = [[[-70, 39], [-1, 50]], [[5, 42.5], [33, 43]], [[19, 57], [3, 56]], [[37, 22], [62, 15]], [[80, -10], [160, -10]], [[-157, 19], [-75, -30]], [[145, 35], [-125, 35]]];
  for (const [a, b] of pairs) {
    const [x0, y0] = lonLatToTile(map, ...a), [x1, y1] = lonLatToTile(map, ...b);
    const path = findWaterPath(map, x0 + 0.5, y0 + 0.5, x1 + 0.5, y1 + 0.5);
    assert.ok(path && path.length >= 2, `путь ${a} -> ${b}`);
    assert.ok(!crossesLand(map, path), `путь ${a} -> ${b} пересекает сушу`);
    assert.ok(Math.abs(path[0][0] - x0 - 0.5) <= 6 && Math.abs(path[path.length - 1][1] - y1 - 0.5) <= 6);
    const direct = Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2);
    assert.ok(pathLength(path) >= direct - 2);
    const again = findWaterPath(map, x0 + 0.5, y0 + 0.5, x1 + 0.5, y1 + 0.5);
    assert.deepEqual(again, path);
    again[0][0] = -1;
    assert.notEqual(findWaterPath(map, x0 + 0.5, y0 + 0.5, x1 + 0.5, y1 + 0.5)[0][0], -1);
  }
  const [cx, cy] = lonLatToTile(map, 51, 42);
  const [mx, my] = lonLatToTile(map, 20, 35);
  assert.equal(findWaterPath(map, cx + 0.5, cy + 0.5, mx + 0.5, my + 0.5), null, 'из Каспия в Средиземное море пути нет');
});

test('навигация на процедурных картах детерминирована', () => {
  for (const id of ['archipelago', 'ring']) {
    const a = get(id, 5), b = generateMap({ id, seed: 5 });
    const pts = [];
    for (let i = 0; i < a.W * a.H && pts.length < 6; i += 104729) if (a.nav.ocean[i]) pts.push(i);
    for (let k = 0; k + 1 < pts.length; k++) {
      const p = pts[k], q = pts[k + 1];
      const pa = findWaterPath(a, p % a.W + 0.5, Math.floor(p / a.W) + 0.5, q % a.W + 0.5, Math.floor(q / a.W) + 0.5);
      const pb = findWaterPath(b, p % b.W + 0.5, Math.floor(p / b.W) + 0.5, q % b.W + 0.5, Math.floor(q / b.W) + 0.5);
      assert.deepEqual(pa, pb);
      if (pa) assert.ok(!crossesLand(a, pa));
    }
  }
});

test('ближайшая береговая клетка игрока', () => {
  const map = get('ring', 5);
  const { W, H } = map;
  const owner = new Uint16Array(W * H);
  let some = -1;
  for (let i = 0; i < W * H; i++) if (isLand(map.terrain[i]) && i % W > 600 && i % W < 800 && Math.floor(i / W) < 260) { owner[i] = 3; if (some < 0 && map.coast[i]) some = i; }
  const tx = 700, ty = 400;
  const c = nearestCoastTile(map, owner, 3, tx, ty);
  assert.ok(c >= 0);
  assert.equal(owner[c], 3);
  assert.ok(coastBodies(map, c).length > 0);
  for (const i of map.nav.shore) {
    if (owner[i] !== 3) continue;
    const d = (i % W - tx) ** 2 + (Math.floor(i / W) - ty) ** 2;
    const dc = (c % W - tx) ** 2 + (Math.floor(c / W) - ty) ** 2;
    assert.ok(d >= dc);
  }
  assert.equal(nearestCoastTile(map, owner, 3, tx, ty, 5), -1);
  assert.equal(nearestCoastTile(map, owner, 4, tx, ty), -1);
  const body = coastBodies(map, c)[0];
  assert.equal(nearestCoastTile(map, owner, 3, tx, ty, Infinity, body), c);
  const w = nearestOceanTile(map, c % W, Math.floor(c / W));
  assert.ok(w >= 0 && map.nav.ocean[w] === 1);
});

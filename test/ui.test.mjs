import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMapFromLand } from '../src/core/map.js';
import { Game } from '../src/core/game.js';
import { createState } from '../src/core/state.js';
import { TICKS_PER_SEC } from '../src/core/config.js';
import { treaties } from '../src/core/diplomacy.js';
import { fleetSlots, fleetOrders, econGoalText, econMarkStage, breakLabel, treatyParts, plural } from '../src/client/hud.js';
import { smoothBiomes, paintSamples } from '../src/client/menus.js';
import { THEMES } from '../src/client/theme.js';

function landMap(w, h, fill) {
  const land = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) land[y * w + x] = fill(x, y) ? 1 : 0;
  return buildMapFromLand({ id: 'custom', name: 'Тест', rows: [], seed: 3 }, w, h, land, 3);
}

const inRect = (x, y, [x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1;
const SEA = landMap(220, 120, (x, y) => inRect(x, y, [10, 20, 80, 100]) && !inRect(x, y, [40, 50, 60, 70]));

function newGame(map, n = 2) {
  const players = Array.from({ length: n }, (_, i) => ({ name: 'Игрок ' + i, ai: null }));
  const g = new Game(map, createState(map, { seed: 5, players, settings: { spawnSeconds: 1 } }));
  g.tick([{ pid: 0, cmd: { c: 'spawn', x: 25, y: 40 } }, { pid: 1, cmd: { c: 'spawn', x: 25, y: 90 } }]);
  while (g.s.phase === 'spawn') g.tick([]);
  return g;
}

function fleet(g, n) {
  const W = g.W;
  for (let y = 20; y < 100; y++) for (let x = 62; x < 80; x++) if (g.isLandTile(y * W + x)) g.setOwner(y * W + x, 0);
  const p = g.s.players[0];
  p.gold = 1e7;
  const r = g.apply(0, { c: 'build', type: 'port', x: 79, y: 60 });
  assert.ok(r.ok, r.error);
  const port = g.buildingAt(60 * W + 79);
  port.build = 0;
  port.level = 3;
  const ships = [];
  for (let k = 0; k < n; k++) {
    const res = g.apply(0, { c: 'buildShip', port: port.id });
    assert.ok(res.ok, res.error);
  }
  for (const u of g.s.units) if (u.owner === 0 && u.type === 'warship') ships.push(u);
  return ships;
}

const cell = (g, x, y) => Math.floor(y) * g.W + Math.floor(x);

test('строй флота: разные клетки воды одного моря рядом с точкой приказа', () => {
  const map = SEA;
  const pts = fleetSlots(map, 150.5, 60.5, 9);
  assert.equal(pts.length, 9);
  const tiles = pts.map(([x, y]) => cell({ W: map.W }, x, y));
  assert.equal(new Set(tiles).size, 9, 'все точки в разных клетках');
  const body = map.waterBody[cell({ W: map.W }, 150, 60)];
  for (const [x, y] of pts) {
    const i = cell({ W: map.W }, x, y);
    assert.equal(map.nav.ocean[i], 1, 'точка на открытой воде');
    assert.equal(map.waterBody[i], body, 'то же море');
    assert.ok(Math.hypot(x - 150.5, y - 60.5) < 20, 'строй компактный');
  }
  assert.deepEqual(pts[0], [150.5, 60.5], 'первая точка — сама цель');
  const coast = fleetSlots(map, 82.5, 60.5, 12);
  assert.ok(coast.length >= 6, 'у берега строй тоже собирается');
  for (const [x, y] of coast) assert.equal(map.terrain[cell({ W: map.W }, x, y)] < 2, true, 'у берега точки только на воде');
  for (const [x, y] of coast) assert.ok(x > 80, 'строй не заходит на сушу и в озеро за ней');
  assert.deepEqual(fleetSlots(map, 50.5, 60.5, 0), []);
});

test('групповой приказ: каждый корабль получает свою точку, все доходят и не стоят в одной клетке', () => {
  const g = newGame(SEA);
  const ships = fleet(g, 6);
  assert.equal(ships.length, 6);
  const enemy = g.spawnUnit({ owner: 1, type: 'warship', x: 120.5, y: 100.5, path: [], pi: 0, hp: 1000, maxHp: 1000, heading: 0, order: 0, chase: -1 });
  const plan = fleetOrders(g, 0, [...ships.map((u) => u.id), enemy.id, 99999], 160.5, 40.5);
  assert.equal(plan.cmds.length, 6, 'чужой и несуществующий корабли не получают приказ');
  assert.equal(plan.failed.length, 0);
  const goals = plan.cmds.map((c) => cell(g, c.x, c.y));
  assert.equal(new Set(goals).size, 6, 'точки назначения разные');
  for (const c of plan.cmds) assert.ok(g.validate(0, c).ok);
  g.s.units = g.s.units.filter((u) => u !== enemy);
  g.tick(plan.cmds.map((cmd) => ({ pid: 0, cmd })));
  assert.equal(g.s.phase, 'play');
  for (let t = 0; t < 120 * TICKS_PER_SEC && ships.some((u) => u.order || (u.path && u.pi < u.path.length)); t++) g.tick([]);
  assert.ok(ships.every((u) => !u.order), 'все корабли дошли');
  const end = ships.map((u) => cell(g, u.x, u.y));
  assert.equal(new Set(end).size, 6, 'на месте корабли стоят в разных клетках');
  for (const u of ships) assert.ok(Math.hypot(u.x - 160.5, u.y - 40.5) < 20, 'строй у точки приказа');
});

test('групповой приказ: корабль из другого водоёма не получает команду, остальные получают', () => {
  const g = newGame(SEA);
  const ships = fleet(g, 2);
  const lake = g.spawnUnit({ owner: 0, type: 'warship', x: 50.5, y: 60.5, path: [], pi: 0, hp: 1000, maxHp: 1000, heading: 0, order: 0, chase: -1 });
  const plan = fleetOrders(g, 0, [...ships.map((u) => u.id), lake.id], 150.5, 60.5);
  assert.deepEqual(plan.failed, [lake.id]);
  assert.equal(plan.cmds.length, 2);
  const one = fleetOrders(g, 0, [ships[0].id], 150.5, 60.5);
  assert.equal(one.cmds.length, 1);
  assert.equal(one.cmds[0].x, 150.5, 'одиночный корабль плывёт точно в указанную точку');
});

test('экономическая цель: время впереди, без обрезания имени, пороги предупреждений', () => {
  assert.deepEqual(econGoalText(-1, false, 0, 1200), { text: 'цель 20:00', done: false });
  assert.deepEqual(econGoalText(3, false, 724, 1200), { text: '12:04 / 20:00', done: false });
  assert.deepEqual(econGoalText(0, true, 61, 300), { text: '1:01 / 5:00', done: true });
  assert.equal(econMarkStage(0.1), 0);
  assert.equal(econMarkStage(0.5), 1);
  assert.equal(econMarkStage(0.8), 2);
  assert.equal(econMarkStage(0.95), 3);
});

test('дипломатия в интерфейсе: торговля поверх пакта видна и разрывается вместе с ним', () => {
  const g = newGame(SEA);
  const tick = g.s.tick;
  g.tick([{ pid: 0, cmd: { c: 'propose', to: 1, type: 'pact' } }]);
  g.tick([{ pid: 1, cmd: { c: 'respond', id: g.s.requests[0].id, accept: true } }]);
  g.tick([{ pid: 0, cmd: { c: 'propose', to: 1, type: 'trade' } }]);
  g.tick([{ pid: 1, cmd: { c: 'respond', id: g.s.requests[0].id, accept: true } }]);
  const rel = treaties(g, 0, 1);
  assert.equal(rel.type, 'pact');
  assert.equal(rel.trade, true);
  const parts = treatyParts(rel, g.s.tick);
  assert.deepEqual(parts.map(([c]) => c), ['pact', 'trade']);
  assert.match(parts[0][1], /^Пакт · \d+:\d\d$/);
  assert.equal(parts[1][1], 'Торговый договор');
  assert.equal(treatyParts(rel, tick, true)[1][1], 'Торговля');
  assert.equal(breakLabel(rel), 'Разорвать пакт и торговлю');
  assert.equal(breakLabel({ type: 'none', trade: true }), 'Разорвать торговлю');
  assert.equal(breakLabel({ type: 'alliance', trade: false }), 'Разорвать союз');
  assert.deepEqual(treatyParts({ type: 'none', trade: false }, 0), []);
  assert.deepEqual(treatyParts({ type: 'alliance', trade: true }, 0), [['alliance', 'Союз']]);
  assert.equal(plural(1, ['корабль', 'корабля', 'кораблей']), 'корабль');
  assert.equal(plural(3, ['корабль', 'корабля', 'кораблей']), 'корабля');
  assert.equal(plural(12, ['корабль', 'корабля', 'кораблей']), 'кораблей');
});

test('фон меню: биомы сглаживаются без потери гор и одиночных островов', () => {
  const w = 64, h = 64;
  const ter = new Uint8Array(w * h);
  const step = (x, y) => Math.floor(x / 4) + Math.floor(y / 4) < 16;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ter[y * w + x] = step(x, y) ? 3 : 2;
  ter[10 * w + 10] = 4;
  for (let y = 40; y < 47; y++) for (let x = 2; x < 9; x++) ter[y * w + x] = 6;
  ter[43 * w + 5] = 7;
  ter[20 * w + 50] = 5;
  const out = smoothBiomes(ter, w, h, 3);
  assert.equal(out[10 * w + 10], 3, 'одиночный пиксель пустыни в лесу убран');
  assert.equal(out[43 * w + 5], 7, 'снежная вершина среди гор сохранена');
  assert.equal(out[20 * w + 50], 5, 'холмы не трогаются');
  const wobble = (t) => {
    const xs = [], ys = [];
    for (let y = 16; y < 48; y++) {
      let x = 0;
      while (x < w && t[y * w + x] !== 2) x++;
      xs.push(x);
      ys.push(y);
    }
    const n = xs.length, my = ys.reduce((a, b) => a + b) / n, mx = xs.reduce((a, b) => a + b) / n;
    let sxy = 0, syy = 0;
    for (let k = 0; k < n; k++) { sxy += (ys[k] - my) * (xs[k] - mx); syy += (ys[k] - my) ** 2; }
    const k1 = sxy / syy;
    let e = 0;
    for (let k = 0; k < n; k++) e += (xs[k] - (mx + k1 * (ys[k] - my))) ** 2;
    return Math.sqrt(e / n);
  };
  assert.ok(wobble(out) < wobble(ter) * 0.7, `граница лесенкой становится ровнее: ${wobble(ter).toFixed(2)} -> ${wobble(out).toFixed(2)}`);
  const sw = 9, sh = 9, N = sw * sh;
  const S = { w: sw, h: sh, K: 1, ter: new Uint8Array(N), elev: new Uint8Array(N).fill(40), lake: new Uint8Array(N) };
  S.ter[4 * sw + 4] = 2;
  const px = paintSamples(S, 'dark');
  const th = THEMES.dark;
  const k = th.landGain * (0.84 + (40 / 255) * 0.32);
  const at = (4 * sw + 4) * 4;
  let moved = 0, full = 0;
  for (let c = 0; c < 3; c++) {
    moved += Math.abs(px[at + c] - px[c]);
    full += Math.abs(th.land[2][c] * k - px[c]);
  }
  assert.ok(moved > full * 0.45, `островок в одну клетку остаётся заметным: ${(moved / full).toFixed(2)}`);
  const plain = { ...S, K: 1, ter: new Uint8Array(N).fill(2) };
  const solid = paintSamples(plain, 'dark');
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(solid[at + c] - th.land[2][c] * k) <= 1, 'сплошная суша без примеси воды');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMapFromLand } from '../src/core/map.js';
import { Game } from '../src/core/game.js';
import { createState, serializeState, deserializeState, hashState } from '../src/core/state.js';
import {
  SHIPS, STRIKES, TRADE, LAND_UNITS, WARHEAD, FALLOUT_TICKS, siloReload, interceptChance,
} from '../src/core/config.js';
import { shipCost, warshipHp, tradeCargo } from '../src/core/units.js';
import { megaTargets, megaCell, strikeCost } from '../src/core/strikes.js';
import { pathLength } from '../src/core/nav.js';
import { makeRng } from '../src/core/rng.js';

function rectMap(rects, w = 200, h = 100, seed = 1) {
  const land = new Uint8Array(w * h);
  for (const [x0, y0, x1, y1] of rects) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) land[y * w + x] = 1;
  return buildMapFromLand({ id: 'custom', name: 'Тест', rows: [], seed }, w, h, land, seed);
}

const RECTS = [[20, 20, 90, 80], [110, 20, 180, 80], [130, 85, 150, 95], [185, 4, 198, 16]];
const ISLES = rectMap(RECTS);
const SPOTS = [[50, 50], [150, 50], [191, 10]];
const BIG = rectMap([[10, 10, 290, 190]], 300, 200);

function newGame(map, n = 2, seed = 5) {
  const players = Array.from({ length: n }, (_, i) => ({ name: 'Игрок ' + i, ai: null }));
  return new Game(map, createState(map, { seed, players, settings: { spawnSeconds: 1 } }));
}

function begin(g, spots) {
  g.tick(spots.map(([x, y], pid) => ({ pid, cmd: { c: 'spawn', x, y } })));
  while (g.s.phase === 'spawn') g.tick([]);
}

function claim(g, pid, x0, y0, x1, y1) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * g.W + x;
    if (g.isLandTile(i)) g.setOwner(i, pid);
  }
}

function readyBuilding(g, pid, type, x, y) {
  g.s.players[pid].gold += 1e6;
  const r = g.apply(pid, { c: 'build', type, x, y });
  assert.ok(r.ok, r.error);
  const b = g.buildingAt(y * g.W + x);
  b.build = 0;
  return b;
}

function ally(g, a, b, type = 'alliance') {
  g.tick([{ pid: a, cmd: { c: 'propose', to: b, type } }]);
  const req = g.s.requests.find((r) => r.from === a && r.to === b);
  g.tick([{ pid: b, cmd: { c: 'respond', id: req.id, accept: true } }]);
  assert.equal(g.relation(a, b).type, type);
}

function run(g, n, collect) {
  for (let t = 0; t < n; t++) {
    g.tick([]);
    if (collect) collect.push(...g.events);
  }
}

function isles(n = 2) {
  const g = newGame(ISLES, n);
  begin(g, SPOTS.slice(0, n));
  claim(g, 0, 20, 20, 90, 80);
  claim(g, 1, 110, 20, 180, 80);
  return g;
}

const loop = (x, y0, y1, n) => {
  const out = [];
  for (let k = 0; k < n; k++) out.push([x, k % 2 ? y1 : y0]);
  return out;
};

test('военный корабль: постройка, цена, приказ движения по воде', () => {
  const g = isles();
  const p = g.s.players[0];
  const port = readyBuilding(g, 0, 'port', 89, 50);
  assert.match(g.validate(1, { c: 'buildShip', port: port.id }).error, /порт/);
  p.gold = 0;
  assert.match(g.validate(0, { c: 'buildShip', port: port.id }).error, /золота/);
  p.gold = 1e6;
  assert.equal(shipCost(g, 0), SHIPS.warship.cost);
  const gold0 = p.gold;
  assert.ok(g.apply(0, { c: 'buildShip', port: port.id }).ok);
  assert.equal(gold0 - p.gold, SHIPS.warship.cost);
  assert.equal(shipCost(g, 0), Math.round(SHIPS.warship.cost * 1.1));
  const ws = g.s.units.find((u) => u.type === 'warship');
  assert.ok(ws);
  assert.equal(ws.hp, warshipHp(0));
  assert.ok(Math.abs(ws.x - 90.5) < 2 && Math.abs(ws.y - 50.5) < 2, 'появляется у порта');
  for (let k = 1; k < 3 + port.level; k++) assert.ok(g.apply(0, { c: 'buildShip', port: port.id }).ok);
  assert.match(g.validate(0, { c: 'buildShip', port: port.id }).error, /максимум/);
  assert.equal(g.validate(0, { c: 'moveShip', id: ws.id, x: 50, y: 50 }).error, 'Корабль туда не доплывёт');
  assert.equal(g.validate(1, { c: 'moveShip', id: ws.id, x: 100, y: 5 }).error, 'Корабль не найден');
  g.tick([{ pid: 0, cmd: { c: 'moveShip', id: ws.id, x: 195, y: 97 } }]);
  assert.equal(ws.order, 1);
  assert.ok(ws.path.length >= 2);
  const ocean = ISLES.nav.ocean;
  for (let t = 0; t < 400 && ws.order; t++) {
    g.tick([]);
    assert.equal(ocean[Math.floor(ws.y) * g.W + Math.floor(ws.x)], 1, 'корабль идёт только по воде');
  }
  assert.equal(ws.order, 0, 'дошёл');
  assert.ok(Math.abs(ws.x - 195.5) < 1.5 && Math.abs(ws.y - 97.5) < 1.5);
  const before = [ws.x, ws.y];
  run(g, 30);
  assert.deepEqual([ws.x, ws.y], before, 'без приказа и без врагов стоит');
});

test('военный корабль топит транспорт и торговца врага, но не союзника', () => {
  const g = isles(3);
  ally(g, 0, 2);
  const port = readyBuilding(g, 0, 'port', 89, 50);
  assert.ok(g.apply(0, { c: 'buildShip', port: port.id }).ok);
  const ws = g.s.units.find((u) => u.type === 'warship');
  const P = g.s.players;
  const mk = (owner, type, x, extra) => g.spawnUnit({
    owner, type, x, y: 45.5, path: loop(x, 45.5, 55.5, 40), pi: 1, hp: 300, maxHp: 300, heading: 0, ...extra,
  });
  const tr = mk(1, 'transport', 100.5, { troops: 900, target: -1 });
  const tradeShip = mk(1, 'trade', 101.5, { cargo: 1000, from: -1, to: -1 });
  const friend = mk(2, 'transport', 99.5, { troops: 500, target: -1 });
  const gold0 = P[0].gold;
  const evs = [];
  run(g, 60, evs);
  assert.equal(g.unitById(tr.id), null, 'транспорт потоплен');
  assert.equal(g.unitById(tradeShip.id), null, 'торговец потоплен');
  assert.ok(g.unitById(friend.id), 'союзник цел');
  assert.equal(friend.hp, 300);
  assert.equal(P[0].stats.shipsSunk, 2);
  assert.ok(P[0].stats.kills >= 900, 'десант погиб');
  const sunk = evs.filter((e) => e.k === 'shipSunk');
  assert.deepEqual(sunk.map((e) => e.type).sort(), ['trade', 'transport']);
  assert.ok(evs.some((e) => e.k === 'shipFire' && e.id === ws.id));
  const income = (P[0].incBase - P[0].upkeep) * 6;
  assert.ok(Math.abs(P[0].gold - gold0 - income - 1000 * TRADE.sunkLoot) < 50, 'добыча — половина груза');
});

test('военные корабли сражаются, подходят к врагу в радиусе 25', () => {
  const g = isles();
  const pa = readyBuilding(g, 0, 'port', 89, 50);
  const pb = readyBuilding(g, 1, 'port', 110, 62);
  assert.ok(g.apply(0, { c: 'buildShip', port: pa.id }).ok);
  assert.ok(g.apply(1, { c: 'buildShip', port: pb.id }).ok);
  const [a, b] = g.s.units;
  const d0 = Math.hypot(a.x - b.x, a.y - b.y);
  assert.ok(d0 > SHIPS.warship.range && d0 < SHIPS.warship.chase, `стартовая дистанция ${d0}`);
  run(g, 20);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < SHIPS.warship.range, 'сблизились');
  run(g, 300);
  assert.equal(g.s.units.filter((u) => u.type === 'warship').length, 1, 'один потоплен');
  const st = g.s.players.map((p) => p.stats.shipsSunk);
  assert.equal(st[0] + st[1], 1);
});

test('высадка захватывает остров, лимиты и ошибки', () => {
  const g = isles(3);
  const P = g.s.players;
  P[0].troops = 20000;
  assert.equal(g.validate(0, { c: 'boat', x: 50, y: 50, ratio: 0.5 }).error, 'Это ваша территория');
  assert.equal(g.validate(0, { c: 'boat', x: 100, y: 50, ratio: 0.5 }).error, 'Выберите сушу для высадки');
  assert.ok(g.validate(0, { c: 'boat', x: 140, y: 90, ratio: 0.5 }).ok);
  g.tick([{ pid: 0, cmd: { c: 'boat', x: 140, y: 90, ratio: 0.5 } }]);
  const tr = g.s.units.find((u) => u.type === 'transport');
  assert.ok(tr, 'транспорт отправлен');
  assert.equal(tr.troops, 10000);
  assert.ok(P[0].troops < 11000);
  assert.ok(g.landId[tr.target] === g.landId[90 * g.W + 140], 'высадка на целевой остров');
  let landed = false;
  for (let t = 0; t < 400; t++) {
    g.tick([]);
    if (g.s.attacks.some((a) => a.attacker === 0)) landed = true;
  }
  assert.ok(landed, 'после прибытия началась атака с высадкой');
  let mine = 0;
  for (let y = 85; y < 95; y++) for (let x = 130; x < 150; x++) if (g.tileOwner(y * g.W + x) === 0) mine++;
  assert.equal(mine, 200, 'весь остров захвачен');
  assert.equal(g.s.units.filter((u) => u.type === 'transport').length, 0);

  ally(g, 0, 2, 'pact');
  claim(g, 2, 130, 85, 150, 95);
  assert.match(g.validate(0, { c: 'boat', x: 140, y: 90, ratio: 0.5 }).error, /союзника/);
  P[0].troops = 20000;
  const t1 = P[1].tiles;
  for (let k = 0; k < 3; k++) assert.ok(g.apply(0, { c: 'boat', x: 150, y: 30 + k * 20, ratio: 0.2 }).ok);
  assert.match(g.validate(0, { c: 'boat', x: 150, y: 40, ratio: 0.2 }).error, /Не больше 3/);
  run(g, 200);
  assert.ok(P[1].tiles < t1, 'высадка отбирает землю у врага');
});

test('игрок без земли жив, пока плывёт транспорт; высадка на свою клетку возвращает войска', () => {
  const g = isles();
  const P = g.s.players;
  P[0].troops = 10000;
  g.tick([{ pid: 0, cmd: { c: 'boat', x: 140, y: 90, ratio: 0.5 } }]);
  const tr = g.s.units.find((u) => u.type === 'transport');
  for (let y = 20; y < 80; y++) for (let x = 20; x < 90; x++) g.setOwner(y * g.W + x, -1);
  assert.equal(P[0].tiles, 0);
  run(g, 5);
  assert.ok(P[0].alive, 'жив, пока плывёт десант');
  for (let t = 0; t < 300 && g.unitById(tr.id); t++) g.tick([]);
  run(g, 50);
  assert.ok(P[0].alive);
  assert.ok(P[0].tiles > 150, 'остров захвачен десантом');

  const h = isles();
  const Q = h.s.players;
  Q[0].troops = 10000;
  h.tick([{ pid: 0, cmd: { c: 'boat', x: 140, y: 90, ratio: 0.5 } }]);
  const tr2 = h.s.units.find((u) => u.type === 'transport');
  claim(h, 0, 130, 85, 150, 95);
  for (let t = 0; t < 300 && h.unitById(tr2.id); t++) h.tick([]);
  const before = Q[0].troops;
  h.tick([]);
  assert.ok(Q[0].troops >= before + 5000 - 1, 'клетка высадки уже своя — войска вернулись');
});

function tradeSetup() {
  const g = isles();
  const a = readyBuilding(g, 0, 'port', 89, 50);
  const b = readyBuilding(g, 1, 'port', 110, 50);
  a.cd = 1;
  b.cd = 1e6;
  return { g, a, b };
}

function runTrade(g) {
  const P = g.s.players;
  for (let t = 0; t < 400; t++) {
    const g0 = P[0].gold, g1 = P[1].gold;
    g.tick([]);
    const ev = g.events.find((e) => e.k === 'trade');
    if (!ev) continue;
    const n0 = (P[0].incBase - P[0].upkeep) / 10, n1 = (P[1].incBase - P[1].upkeep) / 10;
    assert.ok(Math.abs(P[0].gold - g0 - n0 - ev.gold) < 1e-6, 'золото владельцу судна');
    assert.ok(Math.abs(P[1].gold - g1 - n1 - ev.goldTo) < 1e-6, 'золото владельцу порта');
    return ev;
  }
  return null;
}

test('торговля: золото обоим, договор +50%, склад, эмбарго блокирует', () => {
  const { g, a, b } = tradeSetup();
  g.tick([]);
  const ship = g.s.units.find((u) => u.type === 'trade');
  assert.ok(ship, 'порт отправил торговое судно');
  assert.equal(ship.to, b.id);
  assert.equal(ship.owner, 0);
  assert.equal(a.cd, TRADE.interval(1));
  const dist = Math.round(pathLength(ship.path));
  assert.equal(ship.cargo, tradeCargo(dist, 0));
  assert.equal(ship.cargo, TRADE.base + dist * TRADE.perTile);
  const ev = runTrade(g);
  assert.ok(ev, 'судно доплыло');
  assert.equal(ev.gold, ship.cargo);
  assert.equal(ev.goldTo, ship.cargo);
  assert.equal(ev.from, 0);
  assert.equal(ev.to, 1);

  ally(g, 0, 1, 'trade');
  a.cd = 1;
  a.stock = 5;
  g.tick([]);
  const ship2 = g.s.units.find((u) => u.type === 'trade');
  assert.equal(a.stock, 4, 'склад −1');
  assert.equal(ship2.cargo, Math.round(ship.cargo * 1.5), 'склад +10% за единицу');
  const ev2 = runTrade(g);
  assert.equal(ev2.gold, Math.round(ship2.cargo * (1 + TRADE.treaty)), 'договор +50%');
  assert.equal(ev2.goldTo, ev2.gold);

  a.cd = 1;
  g.tick([]);
  assert.ok(g.s.units.some((u) => u.type === 'trade'));
  g.tick([{ pid: 1, cmd: { c: 'embargo', with: 0, on: true } }]);
  const ev3 = runTrade(g);
  assert.equal(ev3, null, 'с эмбарго груз не оплачивается');
  assert.equal(g.s.units.filter((u) => u.type === 'trade').length, 0);
  a.cd = 1;
  b.cd = 1;
  run(g, 3);
  assert.equal(g.s.units.filter((u) => u.type === 'trade').length, 0, 'эмбарго блокирует отправку');
  g.tick([{ pid: 1, cmd: { c: 'embargo', with: 0, on: false } }]);
  a.cd = 1;
  g.tick([]);
  assert.equal(g.s.units.filter((u) => u.type === 'trade').length, 1, 'после снятия эмбарго торговля идёт');
});

test('поезд ровно в 2 раза быстрее грузовика', () => {
  const g = isles();
  const port = readyBuilding(g, 0, 'port', 89, 50);
  const f1 = readyBuilding(g, 0, 'factory', 40, 30);
  const f2 = readyBuilding(g, 0, 'factory', 40, 70);
  assert.ok(g.apply(0, { c: 'rail', a: f2.id, b: port.id }).ok);
  f1.cd = 1;
  f2.cd = 1;
  g.tick([]);
  const truck = g.s.units.find((u) => u.type === 'truck');
  const train = g.s.units.find((u) => u.type === 'train');
  assert.ok(truck && train);
  const t0 = [truck.x, truck.y], r0 = [train.x, train.y];
  run(g, 20);
  const dt = Math.hypot(truck.x - t0[0], truck.y - t0[1]);
  const dr = Math.hypot(train.x - r0[0], train.y - r0[1]);
  assert.ok(Math.abs(dr - 2 * dt) < 1e-9, `поезд ${dr}, грузовик ${dt}`);
  assert.equal(LAND_UNITS.train.speed, 2 * LAND_UNITS.truck.speed);
  assert.ok(Math.abs(dt - 20 * LAND_UNITS.truck.speed) < 1e-9);
});

function strikeSetup(n = 2) {
  const g = isles(n);
  const P = g.s.players;
  P[0].research.missile = 3;
  P[0].research.nuclear = 3;
  P[0].research.drone = 3;
  const silo = readyBuilding(g, 0, 'silo', 40, 40);
  const air = readyBuilding(g, 0, 'airbase', 40, 60);
  P[0].gold = 1e6;
  return { g, P, silo, air };
}

test('ПВО перехватывает удар (шанс 100%)', () => {
  const { g, P, silo } = strikeSetup();
  const sam = readyBuilding(g, 1, 'sam', 150, 50);
  g.rand = () => 0;
  const t1 = P[1].tiles;
  g.tick([{ pid: 0, cmd: { c: 'strike', kind: 'atom', from: silo.id, x: 150, y: 40 } }]);
  assert.equal(g.s.projectiles.length, 1);
  const evs = [];
  run(g, 120, evs);
  const ic = evs.filter((e) => e.k === 'intercept');
  assert.equal(ic.length, 1, 'перехват');
  assert.equal(ic[0].kind, 'atom');
  assert.ok(Math.hypot(ic[0].x - 150.5, ic[0].y - 50.5) <= 40 + 1e-9, 'в радиусе ПВО');
  assert.ok(!evs.some((e) => e.k === 'nuke'), 'взрыва нет');
  assert.equal(P[1].tiles, t1);
  assert.equal(g.s.projectiles.length, 0);
  assert.ok(sam.cd >= 0);
  assert.ok(interceptChance('hbomb', 0) < interceptChance('drone', 0));
});

test('камикадзе и крылатая ракета уничтожают конкретное здание', () => {
  const { g, P, silo, air } = strikeSetup();
  const house = readyBuilding(g, 1, 'house', 140, 40);
  const fac = readyBuilding(g, 1, 'factory', 147, 40);
  const fort = readyBuilding(g, 1, 'fort', 160, 60);
  assert.match(g.validate(0, { c: 'strike', kind: 'kamikaze', from: air.id, x: 120, y: 60 }).error, /нет вражеского здания/);
  assert.match(g.validate(0, { c: 'strike', kind: 'kamikaze', from: silo.id, x: 141, y: 41 }).error, /аэродром/);
  assert.match(g.validate(1, { c: 'strike', kind: 'kamikaze', from: air.id, x: 141, y: 41 }).error, /Нужно исследование|аэродром/);
  g.tick([{ pid: 0, cmd: { c: 'strike', kind: 'kamikaze', from: air.id, x: 141, y: 41 } }]);
  assert.equal(g.s.projectiles[0].targetBuilding, house.id);
  assert.match(g.validate(0, { c: 'strike', kind: 'kamikaze', from: air.id, x: 147, y: 41 }).error, /Перезарядка/);
  g.tick([{ pid: 0, cmd: { c: 'strike', kind: 'cruise', from: silo.id, x: 146, y: 39 } }]);
  assert.equal(g.s.projectiles[1].targetBuilding, fac.id);
  assert.equal(silo.cd, siloReload(1) - 1);
  const evs = [];
  run(g, 150, evs);
  assert.equal(g.buildingById(house.id), null, 'дом уничтожен');
  assert.equal(g.buildingById(fac.id), null, 'фабрика уничтожена');
  assert.ok(g.buildingById(fort.id), 'другие здания целы');
  assert.ok(evs.some((e) => e.k === 'destroyed' && e.id === house.id));
  assert.ok(evs.filter((e) => e.k === 'impact').length === 2);
  assert.equal(P[1].tiles > 4000, true, 'земля не меняется');
  P[0].research.missile = 1;
  P[0].research.drone = 1;
  assert.match(g.validate(0, { c: 'strike', kind: 'kamikaze', from: air.id, x: 160, y: 60 }).error, /исследование/);
});

test('крылатая ракета: ограничение дальности', () => {
  const map = rectMap([[10, 10, 50, 50], [400, 10, 440, 50]], 460, 60);
  const g = newGame(map);
  begin(g, [[30, 30], [420, 30]]);
  const P = g.s.players;
  P[0].research.missile = 1;
  const silo = readyBuilding(g, 0, 'silo', 30, 30);
  const house = readyBuilding(g, 1, 'house', 420, 30);
  assert.match(g.validate(0, { c: 'strike', kind: 'cruise', from: silo.id, x: house.x, y: house.y }).error, /досягаемости/);
  P[0].research.missile = 2;
  assert.ok(g.validate(0, { c: 'strike', kind: 'cruise', from: silo.id, x: house.x, y: house.y }).ok);
});

test('дрон убивает войска владельца клетки', () => {
  const { g, P, air } = strikeSetup();
  P[0].research.drone = 1;
  P[1].troops = 5000;
  assert.match(g.validate(0, { c: 'strike', kind: 'drone', from: air.id, x: 100, y: 50 }).error, /противника/);
  g.tick([{ pid: 0, cmd: { c: 'strike', kind: 'drone', from: air.id, x: 150, y: 50 } }]);
  const k0 = P[0].stats.kills;
  const evs = [];
  run(g, 100, evs);
  assert.ok(evs.some((e) => e.k === 'impact' && e.kind === 'drone'));
  assert.equal(P[0].stats.kills - k0, STRIKES.drone.killPerLevel, 'убито 1500 войск за уровень');
  assert.ok(evs.some((e) => e.k === 'msg' && e.to === 1 && /БПЛА/.test(e.text)));
});

test('атомная бомба: клетки ничьи, заражение, разрушения, разрыв союза', () => {
  const { g, P, silo } = strikeSetup(3);
  claim(g, 2, 110, 62, 130, 80);
  ally(g, 0, 2);
  const house = readyBuilding(g, 1, 'house', 125, 45);
  const far = readyBuilding(g, 1, 'house', 170, 30);
  P[0].gold = 1e6;
  assert.match(g.validate(0, { c: 'strike', kind: 'atom', from: silo.id, x: 50, y: 50 }).error, /своей/);
  assert.match(g.validate(0, { c: 'strike', kind: 'atom', from: silo.id, x: 120, y: 70 }).error, /союзнику/);
  const t1 = P[1].tiles, t2 = P[2].tiles;
  g.tick([{ pid: 0, cmd: { c: 'strike', kind: 'atom', from: silo.id, x: 120, y: 52 } }]);
  assert.equal(P[0].stats.nukes, 1);
  assert.equal(P[0].gold < 1e6 - STRIKES.atom.cost + 100, true);
  assert.ok(g.events.some((e) => e.k === 'launch' && e.kind === 'atom'));
  const mine = (x, y) => x >= 112 && x < 116 && y >= 40 && y < 44;
  let nuke = null, drop = 0, expect = 0;
  for (let t = 0; t < 100 && !nuke; t++) {
    const pr = g.s.projectiles[0];
    if (pr && pr.dur - pr.t <= 1) claim(g, 0, 112, 40, 116, 44);
    const T0 = P[1].troops, n0 = P[1].tiles;
    g.tick([]);
    nuke = g.events.find((e) => e.k === 'nuke');
    if (nuke) {
      drop = T0 - P[1].troops;
      expect = (n0 - P[1].tiles) * (T0 / n0) * 1.5;
    }
  }
  assert.ok(nuke);
  assert.ok(drop > expect - 300, `войска цели: −${drop}, ожидалось ≈${expect}`);
  assert.equal(nuke.r, STRIKES.atom.r);
  const r = STRIKES.atom.r;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (dx * dx + dy * dy > r * r) continue;
    const i = (52 + dy) * g.W + 120 + dx;
    if (!g.isLandTile(i)) continue;
    if (mine(120 + dx, 52 + dy)) {
      assert.equal(g.tileOwner(i), 0, 'своя земля запустившего не сгорает');
      assert.equal(g.s.fallout[i], 0);
      continue;
    }
    assert.equal(g.tileOwner(i), -1, 'клетка ничья');
    assert.ok(g.s.fallout[i] > 0 && g.s.fallout[i] <= FALLOUT_TICKS, 'заражение');
  }
  assert.equal(g.buildingById(house.id), null, 'здание в радиусе уничтожено');
  assert.ok(g.buildingById(far.id), 'здание вне радиуса цело');
  const lost1 = t1 - P[1].tiles;
  assert.ok(lost1 > 300, `потеряно ${lost1}`);
  assert.ok(P[2].tiles < t2, 'союзник задет');
  assert.equal(g.relation(0, 2).type, 'none', 'союз разорван');
  assert.ok(P[0].traitorUntil > g.s.tick, 'запустивший — предатель');
  run(g, FALLOUT_TICKS + 20);
  assert.equal(g.s.fallout[52 * g.W + 120], 0, 'заражение проходит');
});

test('мегабомба накрывает всю сушу врагов, не трогает союзника и не перехватывается', () => {
  const g = newGame(BIG, 4);
  begin(g, [[50, 50], [250, 50], [50, 150], [250, 150]]);
  claim(g, 0, 10, 10, 150, 100);
  claim(g, 1, 150, 10, 290, 100);
  claim(g, 2, 10, 100, 150, 190);
  claim(g, 3, 150, 100, 290, 190);
  const P = g.s.players;
  ally(g, 0, 1);
  P[0].research.missile = 1;
  P[0].research.nuclear = 3;
  const silo = readyBuilding(g, 0, 'silo', 40, 40);
  const factory = readyBuilding(g, 1, 'factory', 200, 50);
  const enemyHouse = readyBuilding(g, 2, 'house', 80, 140);
  readyBuilding(g, 3, 'sam', 200, 150);
  P[0].gold = 1e6;
  const targets = megaTargets(g, 0);
  const G = megaCell();
  const need = Math.ceil(140 / G) * Math.ceil(90 / G);
  assert.ok(targets.length >= need, `боеголовок ${targets.length}, клеток сетки ${need}`);
  assert.ok(targets.every((t) => t.pid === 2 || t.pid === 3));
  const cost = strikeCost(g, 0, 'mega');
  assert.ok(cost >= STRIKES.mega.cost);
  const t = P.map((p) => p.tiles);
  const gold0 = P[0].gold;
  g.tick([{ pid: 0, cmd: { c: 'strike', kind: 'mega', from: silo.id, x: 150, y: 100 } }]);
  assert.ok(Math.abs(gold0 - P[0].gold - cost) < 50, 'списана цена мегабомбы');
  assert.equal(g.s.projectiles.length, 1);
  const pr = g.s.projectiles[0];
  assert.equal(pr.type, 'mega');
  assert.ok(pr.dur <= 20, 'распад рядом с шахтой');
  g.rand = () => 0;
  const evs = [];
  let warheads = 0;
  for (let k = 0; k < 400 && g.s.phase === 'play' && (k === 0 || g.s.projectiles.length); k++) {
    g.tick([]);
    evs.push(...g.events);
    warheads = Math.max(warheads, g.s.projectiles.filter((q) => q.type === 'warhead').length);
  }
  assert.ok(!evs.some((e) => e.k === 'intercept' && e.kind === 'mega'), 'носитель не сбивается');
  assert.equal(warheads, targets.length);
  const ic = evs.filter((e) => e.k === 'intercept').length;
  assert.ok(ic > 0, 'ПВО сбивает часть боеголовок');
  assert.equal(evs.filter((e) => e.k === 'nuke').length + ic, targets.length);
  assert.equal(P[0].tiles, t[0], 'запустивший не задет');
  assert.equal(P[1].tiles, t[1], 'союзник не задет');
  assert.ok(g.buildingById(factory.id), 'здания союзника целы');
  assert.equal(P[2].tiles, 0, `враг 2 без ПВО уничтожен: ${t[2]} -> ${P[2].tiles}`);
  assert.ok(P[3].tiles < t[3] * 0.5, `враг 3: ${t[3]} -> ${P[3].tiles}`);
  assert.equal(g.buildingById(enemyHouse.id), null, 'здания врага уничтожены');
  assert.equal(g.relation(0, 1).type, 'alliance', 'союз сохранён');
  assert.equal(P[0].traitorUntil, 0);
  assert.equal(P[0].stats.megas, 1);
});

test('мегабомба: одна на партию, цена растёт с доходом', () => {
  const g = newGame(BIG, 2);
  begin(g, [[50, 50], [250, 50]]);
  claim(g, 0, 10, 10, 150, 190);
  claim(g, 1, 150, 10, 290, 190);
  const P = g.s.players;
  P[0].research.missile = 1;
  P[0].research.nuclear = 3;
  const silo = readyBuilding(g, 0, 'silo', 40, 40);
  const silo2 = readyBuilding(g, 0, 'silo', 60, 60);
  P[0].income = 0;
  assert.equal(strikeCost(g, 0, 'mega'), STRIKES.mega.cost);
  P[0].income = 10000;
  assert.equal(strikeCost(g, 0, 'mega'), 10000 * STRIKES.mega.incomeSec);
  P[0].gold = 1e7;
  const r = g.apply(0, { c: 'strike', kind: 'mega', from: silo.id });
  assert.ok(r.ok, r.error);
  const v = g.validate(0, { c: 'strike', kind: 'mega', from: silo2.id });
  assert.equal(v.ok, false);
  assert.match(v.error, /одна на партию/);
});

function script(g, rng) {
  const s = g.s, W = g.W, out = [];
  if (s.phase !== 'play') return out;
  for (const p of s.players) {
    if (!p.alive || rng.next() > 0.08) continue;
    const roll = rng.next();
    const mine = s.buildings.filter((b) => b.owner === p.id);
    if (roll < 0.25) {
      const port = mine.find((b) => b.type === 'port');
      if (port) out.push({ pid: p.id, cmd: { c: 'buildShip', port: port.id } });
    } else if (roll < 0.45) {
      const ships = s.units.filter((u) => u.owner === p.id && u.type === 'warship');
      if (ships.length) {
        const u = ships[Math.floor(rng.next() * ships.length)];
        out.push({ pid: p.id, cmd: { c: 'moveShip', id: u.id, x: rng.next() * W, y: rng.next() * g.H } });
      }
    } else if (roll < 0.65) {
      out.push({ pid: p.id, cmd: { c: 'boat', x: 110 + rng.next() * 90, y: rng.next() * 100, ratio: 0.1 + rng.next() * 0.3 } });
    } else if (roll < 0.8) {
      const src = mine.find((b) => b.type === 'silo');
      const kinds = ['cruise', 'atom', 'drone'];
      const kind = kinds[Math.floor(rng.next() * 3)];
      const from = kind === 'drone' ? mine.find((b) => b.type === 'airbase') : src;
      const enemy = s.buildings.filter((b) => b.owner !== p.id);
      if (from && enemy.length) {
        const t = enemy[Math.floor(rng.next() * enemy.length)];
        out.push({ pid: p.id, cmd: { c: 'strike', kind, from: from.id, x: t.x, y: t.y } });
      }
    } else {
      const border = g.borderList(p.id);
      if (border.length) {
        const i = border[Math.floor(rng.next() * border.length)];
        for (const j of [i - 1, i + 1, i - W, i + W]) {
          if (j >= 0 && j < g.N && g.isLandTile(j) && s.owner[j] !== p.id + 1) {
            out.push({ pid: p.id, cmd: { c: 'attack', x: j % W, y: Math.floor(j / W), ratio: 0.2 } });
            break;
          }
        }
      }
    }
  }
  return out;
}

function detGame(map) {
  const players = Array.from({ length: 3 }, (_, i) => ({ name: 'P' + i, ai: null }));
  const g = new Game(map, createState(map, { seed: 77, players, settings: { spawnSeconds: 1 } }));
  begin(g, SPOTS);
  claim(g, 0, 20, 20, 90, 80);
  claim(g, 1, 110, 20, 180, 80);
  const P = g.s.players;
  for (const p of P) {
    p.research.missile = 2;
    p.research.nuclear = 1;
    p.research.drone = 2;
    p.research.naval = 1;
    p.troops = 30000;
  }
  readyBuilding(g, 0, 'port', 89, 50);
  readyBuilding(g, 0, 'silo', 40, 40);
  readyBuilding(g, 0, 'airbase', 40, 60);
  readyBuilding(g, 0, 'sam', 70, 30);
  readyBuilding(g, 1, 'port', 110, 50);
  readyBuilding(g, 1, 'port', 110, 70);
  readyBuilding(g, 1, 'silo', 160, 40);
  readyBuilding(g, 1, 'sam', 140, 60);
  readyBuilding(g, 1, 'house', 170, 70);
  const coast = g.landList.find((i) => g.oceanCoast[i] && g.s.owner[i] === 3);
  readyBuilding(g, 2, 'port', coast % g.W, Math.floor(coast / g.W));
  for (const b of g.s.buildings) if (b.type === 'port') b.cd = 0;
  return g;
}

test('детерминизм с юнитами и ударами: две игры, сохранение посередине', () => {
  const A = detGame(ISLES);
  const B = detGame(rectMap(RECTS));
  const rng = makeRng(13);
  let C = null;
  let maxUnits = 0, maxProj = 0;
  const kinds = new Set();
  for (let t = 0; t < 2500; t++) {
    const intents = script(A, rng);
    A.tick(intents);
    B.tick(JSON.parse(JSON.stringify(intents)));
    if (C) C.tick(JSON.parse(JSON.stringify(intents)));
    for (const e of A.events) kinds.add(e.k);
    maxUnits = Math.max(maxUnits, A.s.units.length);
    maxProj = Math.max(maxProj, A.s.projectiles.length);
    if (t === 1200) {
      const json = JSON.stringify(serializeState(A.s));
      C = new Game(ISLES, deserializeState(JSON.parse(json), ISLES));
      assert.equal(hashState(C.s), hashState(A.s));
    }
    if (t % 250 === 0) assert.equal(hashState(A.s), hashState(B.s), `тик ${t}`);
  }
  assert.equal(hashState(A.s), hashState(B.s));
  assert.equal(hashState(A.s), hashState(C.s));
  assert.deepEqual(serializeState(A.s), serializeState(C.s));
  assert.ok(maxUnits >= 3, `юнитов ${maxUnits}`);
  assert.ok(maxProj >= 1, `снарядов ${maxProj}`);
  for (const k of ['ship', 'trade', 'launch', 'impact']) assert.ok(kinds.has(k), `событие ${k}`);
});

test('конфиг: боеголовка мегабомбы и перезарядки', () => {
  assert.equal(WARHEAD.r, 24);
  assert.equal(siloReload(1), 300);
  assert.equal(siloReload(2), 150);
});

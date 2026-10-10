import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMapFromLand, generateMap } from '../src/core/map.js';
import { Game } from '../src/core/game.js';
import { createState, serializeState, deserializeState, hashState } from '../src/core/state.js';
import { BUILDINGS, ECON, LAND_UNITS, TICKS_PER_SEC, researchCost, researchTicks } from '../src/core/config.js';
import { factoryInterval } from '../src/core/buildings.js';
import { makeRng } from '../src/core/rng.js';

function rectMap(rects, w = 200, h = 100, seed = 1) {
  const land = new Uint8Array(w * h);
  for (const [x0, y0, x1, y1] of rects) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) land[y * w + x] = 1;
  return buildMapFromLand({ id: 'custom', name: 'Тест', rows: [], seed }, w, h, land, seed);
}

const MAP1 = rectMap([[20, 20, 180, 80]]);
const MAP2 = rectMap([[20, 20, 90, 80], [110, 20, 180, 80]]);

function newGame(map, n = 2, settings = {}, seed = 5) {
  const players = Array.from({ length: n }, (_, i) => ({ name: 'Игрок ' + i, ai: null }));
  return new Game(map, createState(map, { seed, players, settings: { spawnSeconds: 1, ...settings } }));
}

function run(game, n, intents) {
  for (let t = 0; t < n; t++) game.tick(t === 0 && intents ? intents : []);
}

function begin(game, spots) {
  game.tick(spots.map(([x, y], pid) => ({ pid, cmd: { c: 'spawn', x, y } })));
  while (game.s.phase === 'spawn') game.tick([]);
}

function claim(game, pid, x0, y0, x1, y1) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * game.W + x;
    if (game.isLandTile(i)) game.setOwner(i, pid);
  }
}

function frontier(game, pid, target) {
  const { W, N } = game;
  const own = game.s.owner;
  for (const i of game.borderList(pid)) {
    for (const j of [i - 1, i + 1, i - W, i + W]) {
      if (j < 0 || j >= N || !game.isLandTile(j)) continue;
      if (Math.abs((j % W) - (i % W)) > 1) continue;
      if (own[j] === target + 1) return [j % W, Math.floor(j / W)];
    }
  }
  return null;
}

const cmd = (pid, c) => [{ pid, cmd: c }];

test('спавн: выбор, перевыбор, ИИ и случайное место', () => {
  const g = newGame(MAP1, 3, { spawnSeconds: 2 });
  g.s.players[2].ai = 'normal';
  assert.equal(g.s.phase, 'spawn');
  g.tick(cmd(0, { c: 'spawn', x: 40, y: 50 }));
  const p0 = g.s.players[0];
  assert.ok(p0.spawned);
  assert.ok(p0.tiles > 60 && p0.tiles <= 81, 'диск радиуса 5');
  assert.equal(g.tileOwner(50 * g.W + 40), 0);
  const ai = g.s.players[2];
  assert.ok(ai.spawned, 'ИИ выбирает место в первом тике');
  const ax = ai.capital % g.W, ay = Math.floor(ai.capital / g.W);
  assert.ok((ax - 40) ** 2 + (ay - 50) ** 2 >= ECON.spawnMinDist ** 2);
  assert.equal(g.validate(1, { c: 'spawn', x: 45, y: 50 }).ok, false);
  assert.equal(g.validate(1, { c: 'spawn', x: 5, y: 5 }).ok, false, 'вода');
  assert.equal(g.validate(0, { c: 'attack', x: 50, y: 50, ratio: 0.5 }).ok, false, 'атака во время спавна');
  let spot = null;
  for (let x = 40; x < 170 && !spot; x += 5) for (let y = 25; y < 76 && !spot; y += 5) {
    if ((x - 40) ** 2 > 900 && g.validate(0, { c: 'spawn', x, y }).ok) spot = [x, y];
  }
  assert.ok(spot);
  g.tick(cmd(0, { c: 'spawn', x: spot[0], y: spot[1] }));
  assert.equal(g.s.owner[50 * g.W + 40], 0, 'старое место освобождено');
  assert.equal(g.tileOwner(spot[1] * g.W + spot[0]), 0);
  while (g.s.phase === 'spawn') g.tick([]);
  assert.equal(g.s.phase, 'play');
  assert.equal(g.s.tick, 20);
  assert.ok(g.s.players[1].spawned && g.s.players[1].tiles > 0, 'не выбравший получает случайное место');
  assert.equal(g.validate(0, { c: 'spawn', x: 60, y: 60 }).ok, false);
  for (const p of g.s.players) {
    assert.ok(p.troops >= ECON.startTroops && p.troops < ECON.startTroops * 1.1);
    assert.ok(p.gold >= ECON.startGold && p.gold < ECON.startGold + 10);
  }
});

test('атака на ничью землю расширяет территорию', () => {
  const g = newGame(MAP1);
  begin(g, [[40, 50], [160, 50]]);
  const p = g.s.players[0];
  const t0 = p.tiles, tr0 = p.troops;
  const [x, y] = frontier(g, 0, -1);
  assert.equal(g.validate(0, { c: 'attack', x: 40, y: 50, ratio: 0.5 }).error, 'Это ваша территория');
  assert.equal(g.validate(0, { c: 'attack', x: 5, y: 5, ratio: 0.5 }).ok, false);
  g.tick(cmd(0, { c: 'attack', x, y, ratio: 0.5 }));
  assert.equal(g.s.attacks.length, 1);
  assert.equal(g.s.attacks[0].target, -1);
  assert.ok(p.troops < tr0 * 0.6);
  g.tick(cmd(0, { c: 'attack', x, y, ratio: 0.1 }));
  assert.equal(g.s.attacks.length, 1, 'войска добавляются к идущей атаке');
  run(g, 30);
  assert.ok(p.tiles > t0 + 60, `территория выросла: ${t0} -> ${p.tiles}`);
  run(g, 600);
  assert.equal(g.s.attacks.length, 0, 'атака закончилась');
  assert.ok(p.stats.tilesCaptured > 100);
});

test('нет общей границы — нужна высадка', () => {
  const g = newGame(MAP2);
  begin(g, [[50, 50], [150, 50]]);
  const r = g.validate(0, { c: 'attack', x: 130, y: 50, ratio: 0.5 });
  assert.equal(r.ok, false);
  assert.match(r.error, /высадк/);
});

test('атака на игрока: захват клеток и потери защитника', () => {
  const g = newGame(MAP1);
  begin(g, [[40, 50], [160, 50]]);
  claim(g, 0, 20, 20, 100, 80);
  claim(g, 1, 100, 20, 180, 80);
  const a = g.s.players[0], d = g.s.players[1];
  a.troops = 60000;
  d.troops = 3000;
  const d0 = d.tiles;
  const [x, y] = frontier(g, 0, 1);
  g.tick(cmd(0, { c: 'attack', x, y, ratio: 0.8 }));
  assert.equal(g.s.attacks[0].target, 1);
  run(g, 40);
  assert.ok(d.tiles < d0 - 50, `защитник потерял клетки: ${d0} -> ${d.tiles}`);
  assert.equal(d.stats.tilesLost, d0 - d.tiles);
  assert.ok(a.stats.kills > 0, 'защитник теряет войска');
  assert.ok(d.stats.kills > 0, 'атакующий теряет войска');
});

test('союз запрещает атаку, разрыв делает предателем', () => {
  const g = newGame(MAP1, 3);
  begin(g, [[40, 50], [160, 50], [100, 30]]);
  claim(g, 0, 20, 20, 100, 80);
  claim(g, 1, 100, 20, 180, 70);
  claim(g, 2, 100, 70, 180, 80);
  g.s.players[0].troops = 20000;
  const [x, y] = frontier(g, 0, 1);
  g.tick(cmd(0, { c: 'attack', x, y, ratio: 0.2 }));
  assert.equal(g.s.attacks.length, 1);
  const before = g.s.players[0].troops;
  g.tick(cmd(0, { c: 'propose', to: 1, type: 'alliance' }));
  assert.equal(g.s.requests.length, 1);
  assert.ok(g.events.some((e) => e.k === 'request'));
  assert.equal(g.validate(0, { c: 'propose', to: 1, type: 'alliance' }).ok, false, 'повторное предложение');
  const id = g.s.requests[0].id;
  assert.equal(g.validate(0, { c: 'respond', id, accept: true }).ok, false, 'отвечает только адресат');
  g.tick(cmd(1, { c: 'respond', id, accept: true }));
  assert.equal(g.relation(0, 1).type, 'alliance');
  assert.equal(g.s.attacks.length, 0, 'атаки между союзниками отменены');
  assert.ok(g.s.players[0].troops > before);
  assert.equal(g.isHostile(0, 1), false);
  const [x2, y2] = frontier(g, 0, 1);
  const r = g.validate(0, { c: 'attack', x: x2, y: y2, ratio: 0.2 });
  assert.equal(r.ok, false);
  assert.match(r.error, /союзник/);
  g.tick(cmd(0, { c: 'break', with: 1 }));
  assert.equal(g.relation(0, 1).type, 'none');
  assert.ok(g.s.players[0].traitorUntil > g.s.tick);
  assert.ok(g.validate(0, { c: 'attack', x: x2, y: y2, ratio: 0.2 }).ok);
});

test('пакт, торговый договор, истечение запросов, эмбарго', () => {
  const g = newGame(MAP1);
  begin(g, [[40, 50], [160, 50]]);
  g.tick(cmd(0, { c: 'propose', to: 1, type: 'pact' }));
  g.tick(cmd(1, { c: 'propose', to: 0, type: 'pact' }));
  assert.equal(g.relation(0, 1).type, 'pact', 'встречное предложение принимается сразу');
  assert.equal(g.s.requests.length, 0);
  const rel = g.relation(0, 1);
  assert.ok(rel.until > g.s.tick);
  assert.equal(g.isHostile(1, 0), false);
  rel.until = g.s.tick + 3;
  run(g, 20);
  assert.equal(g.relation(0, 1).type, 'none', 'пакт истёк');
  assert.equal(g.s.players[0].traitorUntil, 0);
  g.tick(cmd(0, { c: 'propose', to: 1, type: 'trade' }));
  assert.equal(g.s.requests.length, 1);
  run(g, 30 * TICKS_PER_SEC + 2);
  assert.equal(g.s.requests.length, 0, 'запрос живёт 30 с');
  g.tick(cmd(0, { c: 'propose', to: 1, type: 'trade' }));
  g.tick(cmd(1, { c: 'respond', id: g.s.requests[0].id, accept: true }));
  assert.equal(g.relation(0, 1).type, 'trade');
  assert.ok(g.hasTradeTreaty(0, 1));
  assert.equal(g.isHostile(0, 1), true);
  g.tick(cmd(0, { c: 'embargo', with: 1, on: true }));
  assert.equal(g.relation(1, 0).embargo, true);
  g.tick(cmd(1, { c: 'embargo', with: 0, on: true }));
  g.tick(cmd(0, { c: 'embargo', with: 1, on: false }));
  assert.equal(g.relation(0, 1).embargo, true, 'эмбарго второй стороны остаётся');
  g.tick(cmd(1, { c: 'embargo', with: 0, on: false }));
  assert.equal(g.relation(0, 1).embargo, false);
  g.tick(cmd(1, { c: 'break', with: 0 }));
  assert.equal(g.relation(0, 1).type, 'none');
  assert.equal(g.s.players[1].traitorUntil, 0, 'разрыв торговли — не предательство');
});

test('постройка, улучшение и снос зданий', () => {
  const g = newGame(MAP1);
  begin(g, [[40, 50], [160, 50]]);
  claim(g, 0, 20, 20, 100, 80);
  const p = g.s.players[0];
  p.gold = 100000;
  const max0 = p.maxTroops;
  g.tick(cmd(0, { c: 'build', type: 'house', x: 50, y: 50 }));
  assert.equal(g.s.buildings.length, 1);
  const h = g.s.buildings[0];
  assert.ok(Math.abs(p.gold - (100000 - BUILDINGS.house.cost + (p.incBase - p.upkeep) / TICKS_PER_SEC)) < 1e-6);
  assert.ok(h.build > 0);
  assert.equal(g.buildingAt(50 * g.W + 50), h);
  assert.match(g.validate(0, { c: 'build', type: 'factory', x: 53, y: 52 }).error, /близко/);
  assert.match(g.validate(0, { c: 'build', type: 'port', x: 60, y: 40 }).error, /берегу/);
  assert.match(g.validate(0, { c: 'build', type: 'silo', x: 70, y: 40 }).error, /исследование/);
  assert.match(g.validate(0, { c: 'build', type: 'house', x: 150, y: 50 }).error, /своей/);
  assert.equal(g.validate(0, { c: 'build', type: 'castle', x: 70, y: 40 }).ok, false);
  const gold1 = p.gold;
  g.tick(cmd(0, { c: 'build', type: 'house', x: 60, y: 60 }));
  assert.equal(Math.round(gold1 - p.gold + (p.incBase - p.upkeep) / TICKS_PER_SEC), Math.round(BUILDINGS.house.cost * 1.25), 'цена растёт с числом зданий');
  run(g, BUILDINGS.house.time * TICKS_PER_SEC + 1);
  assert.equal(h.build, 0);
  run(g, 1);
  assert.ok(p.maxTroops >= max0 + 2 * ECON.houseTroops - 1);
  g.tick(cmd(0, { c: 'build', type: 'house', x: 50, y: 50 }));
  assert.ok(h.build > 0 && h.up, 'повторная постройка — улучшение');
  assert.equal(h.level, 1);
  assert.equal(g.validate(0, { c: 'upgrade', id: h.id }).ok, false, 'уже улучшается');
  run(g, BUILDINGS.house.time * TICKS_PER_SEC + 1);
  assert.equal(h.level, 2);
  g.tick(cmd(0, { c: 'upgrade', id: h.id }));
  run(g, BUILDINGS.house.time * TICKS_PER_SEC + 1);
  assert.equal(h.level, 3);
  h.level = BUILDINGS.house.max;
  assert.match(g.validate(0, { c: 'upgrade', id: h.id }).error, /максимальн/);
  const spent = h.spent;
  const gold2 = p.gold;
  g.tick(cmd(0, { c: 'demolish', id: h.id }));
  assert.equal(g.buildingById(h.id), null);
  assert.equal(g.buildingAt(50 * g.W + 50), null);
  assert.ok(Math.abs(p.gold - gold2 - Math.round(spent * ECON.demolishRefund)) < 50, 'возврат 25%');
  p.research.missile = 1;
  assert.ok(g.validate(0, { c: 'build', type: 'silo', x: 70, y: 40 }).ok);
  let coast = -1;
  for (let i = 0; i < g.N && coast < 0; i++) {
    if (g.oceanCoast[i] && g.s.owner[i] === 1 && !g.s.buildings.some((b) => Math.abs(b.x - (i % g.W)) < 5 && Math.abs(b.y - Math.floor(i / g.W)) < 5)) coast = i;
  }
  assert.ok(coast >= 0);
  assert.ok(g.validate(0, { c: 'build', type: 'port', x: coast % g.W, y: Math.floor(coast / g.W) }).ok);
});

function readyBuilding(g, pid, type, x, y) {
  g.s.players[pid].gold += 50000;
  const r = g.apply(pid, { c: 'build', type, x, y });
  assert.ok(r.ok, r.error);
  const b = g.buildingAt(y * g.W + x);
  b.build = 0;
  return b;
}

test('ж/д: поезд ровно в 2 раза быстрее грузовика, груз приносит золото', () => {
  const g = newGame(MAP1);
  begin(g, [[40, 50], [160, 50]]);
  claim(g, 0, 20, 20, 100, 80);
  let coast = -1;
  for (let x = 20; x < 30 && coast < 0; x++) if (g.oceanCoast[50 * g.W + x]) coast = 50 * g.W + x;
  for (let y = 21; y < 79 && coast < 0; y++) if (g.oceanCoast[y * g.W + 20]) coast = y * g.W + 20;
  assert.ok(coast >= 0);
  const px = coast % g.W, py = Math.floor(coast / g.W);
  const port = readyBuilding(g, 0, 'port', px, py);
  const fac = readyBuilding(g, 0, 'factory', px + 60, py);
  fac.cd = 1;
  g.tick([]);
  const truck = g.s.units.find((u) => u.type === 'truck');
  assert.ok(truck, 'без ж/д едет грузовик');
  assert.equal(truck.cargo, ECON.cargoPerLevel);
  assert.equal(fac.cd, factoryInterval(1));
  g.s.players[0].gold = 100000;
  assert.ok(g.apply(0, { c: 'rail', a: fac.id, b: port.id }).ok);
  assert.equal(g.validate(0, { c: 'rail', a: port.id, b: fac.id }).ok, false, 'уже соединены');
  fac.cd = 1;
  g.tick([]);
  const train = g.s.units.find((u) => u.type === 'train');
  assert.ok(train, 'по ж/д едет поезд');
  const t0 = [truck.x, truck.y], r0 = [train.x, train.y];
  run(g, 10);
  const dt = Math.hypot(truck.x - t0[0], truck.y - t0[1]);
  const dr = Math.hypot(train.x - r0[0], train.y - r0[1]);
  assert.ok(Math.abs(dr - 2 * dt) < 1e-9, `поезд ${dr}, грузовик ${dt}`);
  assert.equal(LAND_UNITS.train.speed, 2 * LAND_UNITS.truck.speed);
  const gold = g.s.players[0].gold;
  const stock = port.stock;
  run(g, 120);
  assert.equal(g.s.units.filter((u) => u.type === 'train' || u.type === 'truck').length, 0, 'оба доехали');
  assert.equal(port.stock, stock + 2);
  assert.ok(g.s.players[0].gold > gold + 2 * ECON.cargoPerLevel - 1);
  assert.ok(g.events.length >= 0);
  const hx = px + 30;
  const house = readyBuilding(g, 0, 'house', hx, py);
  assert.ok(g.apply(0, { c: 'rail', a: port.id, b: house.id }).ok);
  g.setOwner(py * g.W + hx, -1);
  assert.equal(g.s.rails.filter((r) => r.a === house.id || r.b === house.id).length, 0, 'рельс удалён вместе с концом');
});

test('захват зданий: дома переходят, шахты уничтожаются', () => {
  const g = newGame(MAP1);
  begin(g, [[40, 50], [160, 50]]);
  claim(g, 1, 100, 20, 180, 80);
  g.s.players[1].research.missile = 1;
  const house = readyBuilding(g, 1, 'house', 120, 40);
  const silo = readyBuilding(g, 1, 'silo', 130, 40);
  const house2 = readyBuilding(g, 1, 'house', 140, 40);
  g.s.players[1].gold = 1e6;
  assert.ok(g.apply(1, { c: 'rail', a: house.id, b: house2.id }).ok);
  g.events = [];
  g.setOwner(40 * g.W + 120, 0);
  assert.equal(house.owner, 0);
  assert.equal(g.s.rails.length, 0);
  assert.ok(g.events.some((e) => e.k === 'capture' && e.id === house.id));
  g.setOwner(40 * g.W + 130, 0);
  assert.equal(g.buildingById(silo.id), null);
  assert.ok(g.events.some((e) => e.k === 'destroyed' && e.id === silo.id));
});

test('окружённый анклав переходит к окружающему', () => {
  const g = newGame(MAP1);
  begin(g, [[40, 50], [160, 50]]);
  claim(g, 0, 20, 20, 120, 80);
  claim(g, 1, 120, 20, 180, 80);
  claim(g, 1, 60, 45, 66, 51);
  const pocket = 47 * g.W + 62;
  assert.equal(g.tileOwner(pocket), 1);
  const t0 = g.s.players[1].tiles;
  run(g, ECON.enclaveEvery + 2);
  assert.equal(g.tileOwner(pocket), 0);
  assert.equal(g.s.players[1].tiles, t0 - 36);
  assert.ok(g.s.players[1].alive);
});

test('экономика: доход, прирост войск, исследования, состав армии, дезертирство', () => {
  const g = newGame(MAP1);
  begin(g, [[40, 50], [160, 50]]);
  claim(g, 0, 20, 20, 100, 80);
  const p = g.s.players[0];
  run(g, 20);
  assert.ok(p.income > 0 && p.income === p.incBase + p.eventIncome);
  const gold0 = p.gold, troops0 = p.troops;
  run(g, 100);
  assert.ok(p.gold > gold0 + p.incBase * 9);
  assert.ok(p.troops > troops0);
  assert.ok(p.troops <= p.maxTroops);
  assert.ok(Math.abs(p.maxTroops - (ECON.troopsBase + p.tiles * ECON.troopsPerTile)) < 1e-6);
  assert.match(g.validate(0, { c: 'research', key: 'nuclear' }).error, /Ракеты/);
  assert.equal(g.validate(0, { c: 'research', key: 'toString' }).ok, false);
  p.gold = 1e6;
  g.tick(cmd(0, { c: 'research', key: 'armor' }));
  assert.equal(p.gold, 1e6 - researchCost('armor', 0) + (p.incBase - p.upkeep) / TICKS_PER_SEC);
  assert.equal(g.validate(0, { c: 'research', key: 'econ' }).ok, false, 'одно исследование за раз');
  run(g, researchTicks(0));
  assert.equal(p.research.armor, 1);
  assert.equal(p.researching, null);
  assert.equal(p.composition.tank, 0, 'без фабрики танков нет');
  readyBuilding(g, 0, 'factory', 60, 50);
  run(g, 50);
  assert.ok(p.composition.tank > 0, 'танки появляются');
  run(g, 300);
  assert.ok(Math.abs(p.composition.tank - 0.08) < 1e-9, 'доля растёт до целевой');
  assert.ok(Math.abs(p.composition.inf + p.composition.tank + p.composition.art - 1) < 1e-12);
  assert.ok(g.attackMult(0) > 1.1);
  p.gold = -1000;
  const tr = p.troops;
  run(g, 10);
  assert.ok(p.troops < tr, 'дезертирство при долге');
});

test('победа по территории, экономике и последний выживший', () => {
  const g = newGame(MAP1, 2, { victory: { territory: true, territoryPct: 40 } });
  begin(g, [[40, 50], [160, 50]]);
  claim(g, 0, 20, 20, 100, 80);
  g.tick([]);
  assert.equal(g.s.phase, 'over');
  assert.equal(g.s.winner, 0);
  assert.equal(g.s.winReason, 'territory');
  assert.ok(g.events.some((e) => e.k === 'victory' && e.pid === 0));
  assert.equal(g.validate(0, { c: 'research', key: 'econ' }).ok, false);

  const e = newGame(MAP1, 2, { victory: { territory: false, economy: true, economyMinutes: 5 } });
  begin(e, [[40, 50], [160, 50]]);
  claim(e, 0, 20, 20, 120, 80);
  run(e, 100);
  assert.equal(e.s.econLeader, 0);
  run(e, 5 * 60 * TICKS_PER_SEC);
  assert.equal(e.s.phase, 'over');
  assert.equal(e.s.winner, 0);
  assert.equal(e.s.winReason, 'economy');

  const v = newGame(MAP1, 3);
  begin(v, [[40, 50], [100, 50], [160, 50]]);
  v.tick(cmd(1, { c: 'surrender' }));
  assert.equal(v.s.players[1].alive, false);
  assert.equal(v.s.players[1].tiles, 0);
  assert.equal(v.validate(1, { c: 'research', key: 'econ' }).error, 'Вы выбыли из игры');
  assert.equal(v.s.phase, 'play');
  const t2 = v.s.players[2];
  for (let i = 0; i < v.N; i++) if (v.s.owner[i] === 3) v.setOwner(i, 0);
  assert.equal(t2.tiles, 0);
  v.tick([]);
  assert.equal(t2.alive, false);
  assert.equal(v.s.phase, 'over');
  assert.equal(v.s.winner, 0);
  assert.equal(v.s.winReason, 'survivor');

  const c = newGame(MAP1, 3);
  begin(c, [[40, 50], [100, 50], [160, 50]]);
  claim(c, 2, 130, 20, 180, 80);
  c.tick(cmd(1, { c: 'propose', to: 2, type: 'alliance' }));
  c.tick(cmd(2, { c: 'respond', id: c.s.requests[0].id, accept: true }));
  assert.equal(c.s.phase, 'play');
  c.tick(cmd(0, { c: 'surrender' }));
  assert.equal(c.s.phase, 'over');
  assert.equal(c.s.winner, 2, 'лидер коалиции по территории');
});

test('передача под управление компьютера и game.dirty', () => {
  const g = newGame(MAP1);
  begin(g, [[40, 50], [160, 50]]);
  g.tick(cmd(1, { c: '_ai', pid: 1, level: 'hard' }));
  assert.equal(g.s.players[1].ai, 'hard');
  const [x, y] = frontier(g, 0, -1);
  g.tick(cmd(0, { c: 'attack', x, y, ratio: 0.5 }));
  g.tick([]);
  assert.ok(g.dirty.length > 0);
  for (const i of g.dirty) assert.equal(g.tileOwner(i), 0);
  const d = g.drainDirty();
  assert.equal(d.all, true);
  g.tick([]);
  const d2 = g.drainDirty();
  assert.equal(d2.all, false);
  assert.deepEqual(d2.tiles, g.dirty);
});

function script(game, rng) {
  const s = game.s, W = game.W, out = [];
  if (s.phase !== 'play') return out;
  for (const p of s.players) {
    if (!p.alive || rng.next() > 0.12) continue;
    const roll = rng.next();
    if (roll < 0.6) {
      const border = game.borderList(p.id);
      if (!border.length) continue;
      const i = border[Math.floor(rng.next() * border.length)];
      for (const j of [i - 1, i + 1, i - W, i + W]) {
        if (j >= 0 && j < game.N && game.isLandTile(j) && s.owner[j] !== p.id + 1) {
          out.push({ pid: p.id, cmd: { c: 'attack', x: j % W, y: Math.floor(j / W), ratio: 0.2 + rng.next() * 0.3 } });
          break;
        }
      }
    } else if (roll < 0.8) {
      const border = game.borderList(p.id);
      if (!border.length) continue;
      const i = border[Math.floor(rng.next() * border.length)];
      const types = ['house', 'factory', 'port', 'fort'];
      out.push({ pid: p.id, cmd: { c: 'build', type: types[Math.floor(rng.next() * 4)], x: (i % W) + 2, y: Math.floor(i / W) } });
    } else if (roll < 0.9) {
      out.push({ pid: p.id, cmd: { c: 'research', key: ['econ', 'inf', 'armor', 'logistics'][Math.floor(rng.next() * 4)] } });
    } else {
      const q = Math.floor(rng.next() * s.players.length);
      out.push({ pid: p.id, cmd: { c: 'propose', to: q, type: rng.next() < 0.5 ? 'pact' : 'trade' } });
      if (s.requests.length) out.push({ pid: s.requests[0].to, cmd: { c: 'respond', id: s.requests[0].id, accept: rng.next() < 0.5 } });
    }
  }
  return out;
}

test('детерминизм: две игры, одинаковые интенты, 3000 тиков; сохранение и загрузка', () => {
  const mapA = generateMap({ id: 'twin', seed: 11 });
  const mapB = generateMap({ id: 'twin', seed: 11 });
  const players = Array.from({ length: 6 }, (_, i) => ({ name: 'P' + i, ai: null }));
  const opts = { seed: 42, players, settings: { spawnSeconds: 3 } };
  const A = new Game(mapA, createState(mapA, opts));
  const B = new Game(mapB, createState(mapB, opts));
  const rng = makeRng(7);
  let C = null;
  for (let t = 0; t < 3000; t++) {
    const intents = script(A, rng);
    A.tick(intents);
    B.tick(JSON.parse(JSON.stringify(intents)));
    if (C) C.tick(intents);
    if (t === 1500) {
      const json = JSON.stringify(serializeState(A.s));
      C = new Game(mapA, deserializeState(JSON.parse(json), mapA));
      assert.equal(hashState(C.s), hashState(A.s));
      assert.ok(json.length < 400000, `размер сохранения ${json.length}`);
    }
    if (t % 500 === 0) assert.equal(hashState(A.s), hashState(B.s), `тик ${t}`);
  }
  assert.equal(A.s.tick, 3000);
  assert.equal(hashState(A.s), hashState(B.s));
  assert.equal(hashState(A.s), hashState(C.s));
  assert.deepEqual(serializeState(A.s), serializeState(C.s));
  const total = A.s.players.reduce((n, p) => n + p.tiles, 0);
  assert.ok(total > mapA.landCount * 0.05, 'игроки расширялись');
  assert.ok(A.s.buildings.length > 0, 'здания строились');
});

test('serialize -> deserialize -> hash совпадает (RLE)', () => {
  const g = newGame(MAP1);
  begin(g, [[40, 50], [160, 50]]);
  const [x, y] = frontier(g, 0, -1);
  g.tick(cmd(0, { c: 'attack', x, y, ratio: 0.5 }));
  readyBuilding(g, 1, 'house', 160, 50);
  run(g, 25);
  const obj = serializeState(g.s);
  assert.equal(typeof obj.owner.rle, 'string');
  const back = deserializeState(JSON.parse(JSON.stringify(obj)), MAP1);
  assert.ok(back.owner instanceof Uint16Array);
  assert.deepEqual([...back.owner], [...g.s.owner]);
  assert.equal(hashState(back), hashState(g.s));
  const g2 = new Game(MAP1, back);
  run(g, 50);
  run(g2, 50);
  assert.equal(hashState(g2.s), hashState(g.s));
  assert.throws(() => deserializeState(obj, rectMap([[10, 10, 50, 50]], 60, 60)));
});

test('производительность и темп захвата: world, 12 игроков, ручные атаки', () => {
  const map = generateMap({ id: 'world', seed: 3 });
  const players = Array.from({ length: 12 }, (_, i) => ({ name: 'P' + i, ai: null }));
  const g = new Game(map, createState(map, { seed: 3, players, settings: { spawnSeconds: 1 } }));
  while (g.s.phase === 'spawn') g.tick([]);
  const rng = makeRng(9);
  const W = map.W;
  let total = 0;
  const T = 1200;
  for (let t = 0; t < T; t++) {
    const intents = [];
    if (t % 10 === 0) {
      for (const p of g.s.players) {
        const border = g.borderList(p.id);
        for (let k = 0; k < 30 && border.length; k++) {
          const i = border[Math.floor(rng.next() * border.length)];
          const j = [i - 1, i + 1, i - W, i + W].find((q) => g.isLandTile(q) && g.s.owner[q] !== p.id + 1);
          if (j !== undefined) {
            intents.push({ pid: p.id, cmd: { c: 'attack', x: j % W, y: Math.floor(j / W), ratio: 0.3 } });
            break;
          }
        }
      }
    }
    const a = performance.now();
    g.tick(intents);
    total += performance.now() - a;
  }
  const avg = total / T;
  assert.ok(avg <= 8, `средний тик ${avg.toFixed(2)} мс`);
  const owned = g.s.players.reduce((n, p) => n + p.tiles, 0) / map.landCount;
  const minutes = T / TICKS_PER_SEC / 60;
  assert.ok(owned > 0.03 && owned < 0.6, `за ${minutes} мин занято ${(owned * 100).toFixed(1)}% суши`);
  for (const p of g.s.players) assert.ok(p.tiles > 500, `${p.name}: ${p.tiles} клеток`);
});

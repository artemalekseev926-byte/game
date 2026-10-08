import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMap, MAPS, parseCustomMap } from '../src/core/mapgen.js';
import { createState, Game, troopCount } from '../src/core/game.js';
import { runAI } from '../src/core/ai.js';
import { TICK } from '../src/core/config.js';

const setup = (id = 'pangaea', n = 4) => {
  const map = generateMap({ id, seed: 99 });
  const players = Array.from({ length: n }, (_, i) => ({ name: 'P' + i, ai: i ? 'normal' : null }));
  return { map, game: new Game(map, createState(map, { seed: 99, players })) };
};

test('все карты генерируются, связны и детерминированы', () => {
  for (const m of MAPS) {
    const a = generateMap({ id: m.id, seed: 5 });
    const b = generateMap({ id: m.id, seed: 5 });
    assert.ok(a.provinces.length > 50, m.id);
    assert.deepEqual(a.provinces.map((p) => p.adj), b.provinces.map((p) => p.adj));
    const seen = new Set([0]);
    const q = [0];
    while (q.length) for (const n of a.provinces[q.pop()].adj) if (!seen.has(n)) { seen.add(n); q.push(n); }
    assert.equal(seen.size, a.provinces.length, `карта ${m.id} должна быть связной`);
  }
});

test('пользовательская карта разбирается', () => {
  const rows = Array.from({ length: 20 }, (_, y) => Array.from({ length: 30 }, (_, x) => ((x - 15) ** 2 + (y - 10) ** 2 < 70 ? '#' : '.')).join(''));
  const desc = parseCustomMap(JSON.stringify({ name: 'Тест', rows }));
  const map = generateMap({ ...desc, seed: 1 });
  assert.ok(map.provinces.length >= 2);
  assert.throws(() => parseCustomMap('{"rows":["##"]}'));
});

test('стартовые позиции и экономика', () => {
  const { game } = setup();
  const owned = game.s.provs.filter((P) => P.o === 0);
  assert.equal(owned.length, 1);
  const m0 = game.s.players[0].money;
  for (let i = 0; i < 40; i++) game.tick();
  assert.ok(game.s.players[0].money > m0, 'доход положительный');
  assert.ok(game.s.players[0].income > 0);
});

test('найм, строительство и исследования', () => {
  const { game } = setup();
  const home = game.s.provs.findIndex((P) => P.o === 0);
  game.s.players[0].money = 5000;
  assert.ok(game.command(0, { c: 'recruit', p: home, u: 'tank', n: 5 }).ok);
  assert.equal(game.s.provs[home].t.tank, 9);
  assert.ok(game.command(0, { c: 'build', p: home, k: 'aa' }).ok);
  assert.equal(game.command(0, { c: 'build', p: home, k: 'fort' }).ok, false, 'одна стройка за раз');
  assert.equal(game.command(0, { c: 'build', p: home, k: 'silo' }).ok, false, 'шахта требует исследования');
  for (let i = 0; i < 60; i++) game.tick();
  assert.equal(game.s.provs[home].b.aa, 1);
  assert.ok(game.command(0, { c: 'research', k: 'missile' }).ok);
  for (let i = 0; i < 4 * 20; i++) game.tick();
  assert.equal(game.s.players[0].research.missile, 1);
  assert.ok(game.command(0, { c: 'build', p: home, k: 'silo' }).ok);
});

test('атака захватывает слабую провинцию', () => {
  const { game, map } = setup();
  const home = game.s.provs.findIndex((P) => P.o === 0);
  const target = map.provinces[home].adj[0];
  game.s.provs[home].t = { inf: 500, tank: 50, art: 10 };
  assert.ok(game.command(0, { c: 'move', from: home, to: target, frac: 1 }).ok);
  for (let i = 0; i < 400 && game.s.armies.length; i++) game.tick();
  assert.equal(game.s.provs[target].o, 0);
  assert.ok(troopCount(game.s.provs[target].t) > 0);
});

test('ракеты и ПВО', () => {
  const { game, map } = setup();
  const home = game.s.provs.findIndex((P) => P.o === 0);
  const enemy = game.s.provs.findIndex((P) => P.o === 1);
  const pl = game.s.players[0];
  pl.money = 10000; pl.research.missile = 3;
  game.s.provs[home].b.silo = 1;
  game.s.provs[enemy].t.inf = 1000;
  assert.ok(game.command(0, { c: 'missile', from: home, to: enemy }).ok);
  assert.equal(game.command(0, { c: 'missile', from: home, to: enemy }).ok, false, 'перезарядка');
  for (let i = 0; i < 400 && game.s.shots.length; i++) game.tick();
  assert.ok(game.s.provs[enemy].t.inf < 700, 'ракета уничтожила войска');
  // ПВО со 100% шансом перехвата
  pl.research.drone = 3;
  game.s.provs[home].b.airbase = 2;
  game.s.provs[enemy].b.aa = 3;
  game.s.players[1].research.aa = 10;
  game.s.provs[home].cd = 0;
  const before = game.s.provs[enemy].t.inf;
  const r = game.command(0, { c: 'drone', from: home, to: enemy, d: 'strike' });
  if (r.ok) {
    for (let i = 0; i < 400 && game.s.shots.length; i++) game.tick();
    assert.equal(game.s.provs[enemy].t.inf, before, 'дрон сбит');
  }
});

test('ИИ доигрывает партию до победителя', () => {
  const map = generateMap({ id: 'ring', seed: 3 });
  const players = Array.from({ length: 4 }, (_, i) => ({ name: 'AI' + i, ai: 'hard' }));
  const game = new Game(map, createState(map, { seed: 3, players, victoryShare: 0.5 }));
  for (let i = 0; i < 4 * 60 * 40 && game.s.winner === null; i++) { game.tick(); runAI(game, TICK); }
  assert.notEqual(game.s.winner, null);
  JSON.parse(JSON.stringify(game.s)); // состояние сериализуемо
});

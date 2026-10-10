import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMap, buildMapFromLand } from '../src/core/map.js';
import { Game } from '../src/core/game.js';
import { createState, serializeState, deserializeState, hashState } from '../src/core/state.js';
import { DIFFICULTY, BUILDING_KEYS, TICKS_PER_SEC, STRIKES } from '../src/core/config.js';
import { makeGradNoise } from '../src/core/rng.js';
import { runAI, aiTurn, aiRespond, AI_PROFILES } from '../src/core/ai.js';

function smallMap(seed, W = 360, H = 220) {
  const n = makeGradNoise(seed);
  const land = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const nx = x / W - 0.5, ny = y / H - 0.5;
      const e = Math.max(Math.abs(nx) * 2, Math.abs(ny) * 2);
      land[y * W + x] = n.fbm(x / 60, y / 60, 4) + 0.3 - e * e * e * 0.9 > 0 ? 1 : 0;
    }
  }
  return buildMapFromLand({ id: 'custom', name: 'Тест', rows: [], seed }, W, H, land, seed);
}

function rectMap(rects, w, h, seed = 1) {
  const land = new Uint8Array(w * h);
  for (const [x0, y0, x1, y1] of rects) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) land[y * w + x] = 1;
  return buildMapFromLand({ id: 'custom', name: 'Тест', rows: [], seed }, w, h, land, seed);
}

function aiGame(map, levels, seed, settings = {}) {
  const players = levels.map((ai, i) => ({ name: 'ИИ ' + (i + 1), ai }));
  return new Game(map, createState(map, { seed, players, settings: { spawnSeconds: 5, ...settings } }));
}

function claim(g, pid, x0, y0, x1, y1) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * g.W + x;
    if (g.isLandTile(i)) g.setOwner(i, pid);
  }
}

function readyBuilding(g, pid, type, x, y) {
  const p = g.s.players[pid];
  p.gold += 1e6;
  const r = g.apply(pid, { c: 'build', type, x, y });
  assert.ok(r.ok, r.error);
  p.gold -= 1e6;
  const b = g.buildingAt(y * g.W + x);
  b.build = 0;
  return b;
}

const SMALL = smallMap(7);

test('ИИ: партия 6 ИИ на маленькой карте доигрывается до победы по территории', () => {
  const limit = 40 * 60 * TICKS_PER_SEC;
  for (const [map, seed] of [[SMALL, 11], [smallMap(8), 12]]) {
    const g = aiGame(map, ['easy', 'normal', 'hard', 'normal', 'hard', 'easy'], seed, { victory: { territory: true, territoryPct: 70 } });
    const seen = { built: 0, research: 0, capture: 0 };
    while (g.s.phase !== 'over' && g.s.tick < limit) {
      g.tick([]);
      for (const e of g.events) if (seen[e.k] !== undefined) seen[e.k]++;
    }
    assert.equal(g.aiError, undefined, String(g.aiError && g.aiError.stack));
    assert.equal(g.s.phase, 'over', 'партия не закончилась за 40 минут');
    assert.equal(g.s.winReason, 'territory');
    const w = g.s.players[g.s.winner];
    assert.ok(w.tiles * 100 >= map.landCount * 70 - 1e-9, `победитель держит ${(w.tiles * 100 / map.landCount).toFixed(1)}%`);
    assert.ok(g.s.tick <= limit);
    assert.ok(seen.built > 5 && seen.research > 3 && seen.capture > 0, JSON.stringify(seen));
  }
});

test('ИИ: world, 8 ИИ, 15 минут — все здания, высадки, флот, торговля, исследования, бюджет хода', () => {
  const map = generateMap({ id: 'world', seed: 3 });
  const g = aiGame(map, ['normal', 'normal', 'hard', 'easy', 'normal', 'hard', 'normal', 'easy'], 3, { victory: { territory: false } });
  const think = Object.fromEntries(Object.entries(DIFFICULTY).map(([k, v]) => [k, v.think]));
  for (const k of Object.keys(DIFFICULTY)) DIFFICULTY[k].think = 1e9;
  const types = new Set();
  const count = { transport: 0, warship: 0, trade: 0, research: 0, launch: 0 };
  const turns = [];
  const levels = [];
  const researchSum = () => g.s.players.reduce((n, p) => n + Object.values(p.research).reduce((a, b) => a + b, 0), 0);
  let tickMs = 0;
  const T = 15 * 60 * TICKS_PER_SEC;
  try {
    while (g.s.phase === 'spawn') g.tick([]);
    for (let t = 0; t < T && g.s.phase === 'play'; t++) {
      for (const p of g.s.players) {
        if (!p.ai || !p.alive || (g.s.tick + p.id * 3) % think[p.ai] !== 0) continue;
        const k0 = g.events.length;
        const a = performance.now();
        aiTurn(g, p.id);
        turns.push(performance.now() - a);
        for (let k = k0; k < g.events.length; k++) {
          const e = g.events[k];
          if (e.k === 'launch') count.launch++;
          else if (e.k === 'ship') count[e.type]++;
        }
      }
      const a = performance.now();
      g.tick([]);
      tickMs += performance.now() - a;
      for (const e of g.events) {
        if (e.k === 'built') {
          const b = g.buildingById(e.id);
          if (b) types.add(b.type);
        } else if (e.k === 'trade') count.trade++;
        else if (e.k === 'research') count.research++;
      }
      if (t % 3000 === 2999) levels.push(researchSum());
    }
  } finally {
    for (const k of Object.keys(DIFFICULTY)) DIFFICULTY[k].think = think[k];
  }
  assert.equal(g.aiError, undefined, String(g.aiError && g.aiError.stack));
  assert.equal(g.s.tick >= T, true, 'партия идёт все 15 минут');
  for (const type of BUILDING_KEYS) assert.ok(types.has(type), `ИИ не построили: ${type}`);
  assert.ok(count.transport >= 1, 'нет высадок');
  assert.ok(count.warship >= 1, 'нет военных кораблей');
  assert.ok(count.trade >= 1, 'нет торговых поставок');
  assert.ok(count.launch >= 1, 'нет ударов');
  assert.ok(g.s.rails.length > 0, 'нет железных дорог');
  assert.equal(levels.length, 3);
  assert.ok(levels[0] < levels[1] && levels[1] < levels[2], `исследования растут: ${levels}`);
  const best = Math.max(...g.s.players.map((p) => Object.values(p.research).reduce((a, b) => a + b, 0)));
  assert.ok(count.research >= 40 && best >= 10, `исследования: ${count.research}, лучший ${best}`);
  turns.sort((a, b) => a - b);
  const avgTurn = turns.reduce((a, b) => a + b, 0) / turns.length;
  assert.ok(avgTurn <= 2, `средний ход ИИ ${avgTurn.toFixed(3)} мс`);
  assert.ok(turns[Math.floor(turns.length * 0.9)] <= 4, `90% ходов ИИ дольше ${turns[Math.floor(turns.length * 0.9)].toFixed(2)} мс`);
  assert.ok(tickMs / T <= 8, `средний тик ${(tickMs / T).toFixed(2)} мс`);
});

test('ИИ: детерминизм — две партии и сохранение посреди партии дают один hash', () => {
  const levels = ['normal', 'hard', 'easy', 'normal', 'hard', 'normal'];
  const a = aiGame(smallMap(5), levels, 21, { victory: { territory: false } });
  const b = aiGame(smallMap(5), levels, 21, { victory: { territory: false } });
  let c = null;
  for (let t = 0; t < 4500; t++) {
    a.tick([]);
    b.tick([]);
    if (c) c.tick([]);
    if (t % 500 === 499) assert.equal(hashState(a.s), hashState(b.s), `тик ${a.s.tick}`);
    if (t === 1999) c = new Game(smallMap(5), deserializeState(JSON.parse(JSON.stringify(serializeState(a.s))), a.map));
  }
  assert.equal(hashState(a.s), hashState(c.s), 'после загрузки ИИ играет так же');
  assert.deepEqual(a.s.players.map((p) => p.aiState), c.s.players.map((p) => p.aiState));
  assert.ok(a.s.attacks.length + a.s.buildings.length > 0);
  assert.equal(a.aiError, undefined);
});

test('ИИ: ответы на предложения, предатели, союз, смена владельца', () => {
  const map = rectMap([[10, 10, 190, 90]], 200, 100);
  const g = aiGame(map, [null, 'normal', 'normal'], 4, { spawnSeconds: 1 });
  g.tick([{ pid: 0, cmd: { c: 'spawn', x: 30, y: 50 } }]);
  while (g.s.phase === 'spawn') g.tick([]);
  const P = g.s.players;
  for (let y = 40; y < 60; y++) for (let x = 20; x < 40; x++) if (!g.s.owner[y * g.W + x]) g.setOwner(y * g.W + x, 0);
  P[0].troops = P[1].troops;
  assert.equal(aiRespond(g, 1, { id: 1, from: 0, to: 1, type: 'trade' }), true, 'торговля выгодна');
  assert.equal(aiRespond(g, 1, { id: 2, from: 0, to: 1, type: 'pact' }), true, 'пакт с равным');
  P[0].traitorUntil = g.s.tick + 100;
  assert.equal(aiRespond(g, 1, { id: 3, from: 0, to: 1, type: 'trade' }), false, 'предателю отказ');
  P[0].traitorUntil = 0;
  g.s.relations['0:1'] = { type: 'pact', until: g.s.tick + 1000, embargo: false, emb: 0 };
  assert.equal(aiRespond(g, 1, { id: 5, from: 0, to: 1, type: 'trade' }), false, 'торговля не заменяет действующий пакт');
  delete g.s.relations['0:1'];
  g.s.relations['0:1'] = { type: 'alliance', until: 0, embargo: false, emb: 0 };
  g.s.relations['0:2'] = { type: 'alliance', until: 0, embargo: false, emb: 0 };
  assert.equal(aiRespond(g, 1, { id: 4, from: 2, to: 1, type: 'alliance' }), false, 'союз всех живых не нужен не-лидеру');
  delete g.s.relations['0:1'];
  delete g.s.relations['0:2'];
  g.tick([{ pid: 0, cmd: { c: 'propose', to: 1, type: 'trade' } }]);
  for (let t = 0; t < 30 && g.s.requests.length; t++) g.tick([]);
  assert.equal(g.relation(0, 1).type, 'trade', 'ИИ принял торговый договор');
  const before = P[0].tiles;
  g.tick([{ pid: 0, cmd: { c: '_ai', pid: 0, level: 'hard' } }]);
  for (let t = 0; t < 400; t++) g.tick([]);
  assert.equal(P[0].ai, 'hard');
  assert.ok(P[0].aiState.turn > 10, 'ИИ ходит за отключившегося');
  assert.ok(P[0].tiles > before, 'ИИ расширяет территорию');
  assert.equal(g.aiError, undefined);
});

test('ИИ: удары по ценным зданиям, атомная бомба и мегабомба у сложного ИИ', () => {
  const map = rectMap([[10, 10, 140, 110], [160, 10, 290, 110]], 300, 120);
  const g = aiGame(map, ['hard', null], 9, { spawnSeconds: 1, victory: { territory: false } });
  g.tick([{ pid: 1, cmd: { c: 'spawn', x: 220, y: 60 } }]);
  while (g.s.phase === 'spawn') g.tick([]);
  claim(g, 0, 10, 10, 140, 110);
  claim(g, 1, 160, 10, 290, 110);
  const P = g.s.players;
  Object.assign(P[0].research, { drone: 2, missile: 3, nuclear: 2 });
  const silo = readyBuilding(g, 0, 'silo', 60, 60);
  const air = readyBuilding(g, 0, 'airbase', 40, 30);
  for (const [x, y] of [[200, 30], [240, 80], [270, 40], [180, 90]]) readyBuilding(g, 1, 'factory', x, y);
  P[0].gold = 5e5;
  const seen = new Set();
  const step = () => {
    g.tick([]);
    for (const e of g.events) if (e.k === 'launch') seen.add(e.kind);
  };
  for (let t = 0; t < 300; t++) step();
  assert.ok(seen.has('kamikaze') || seen.has('drone'), [...seen].join(','));
  assert.ok(seen.has('hbomb') || seen.has('atom') || seen.has('cruise'), [...seen].join(','));
  P[0].research.nuclear = 3;
  P[0].gold = 1e6;
  silo.cd = 0;
  P[0].aiState.nukeAt = 0;
  for (let t = 0; t < 120 && !seen.has('mega'); t++) step();
  assert.ok(seen.has('mega'), 'сложный ИИ применяет мегабомбу');
  assert.ok(air.id > 0);
  assert.ok(AI_PROFILES.normal.nukes < 3 && AI_PROFILES.easy.nukes === 0, 'мегабомба только у сложного');
  assert.ok(STRIKES.mega.cost > 0);
  assert.equal(g.aiError, undefined);
});

test('ИИ: runAI не трогает людей и фазу спавна', () => {
  const g = aiGame(SMALL, [null, null], 2);
  const h = hashState(g.s);
  runAI(g);
  assert.equal(hashState(g.s), h);
  g.tick([]);
  assert.equal(g.s.players[0].aiState.turn, undefined);
});

function fill(g, pid, x0, y0, x1, y1) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * g.W + x;
    if (g.isLandTile(i)) g.setOwner(i, pid);
  }
}

test('ИИ: высадки — малый десант на ничий остров, затем вторжение на остров врага', () => {
  const map = rectMap([[10, 10, 90, 90], [130, 35, 160, 65], [178, 78, 196, 94]], 200, 100);
  const g = aiGame(map, ['hard', null], 5, { spawnSeconds: 1, victory: { territory: false } });
  while (g.s.phase === 'spawn') g.tick([]);
  fill(g, -1, 0, 0, 200, 100);
  fill(g, 0, 10, 10, 90, 90);
  fill(g, 1, 178, 78, 196, 94);
  const P = g.s.players;
  const islandB = (pid) => {
    let n = 0;
    for (let y = 35; y < 65; y++) for (let x = 130; x < 160; x++) if (g.s.owner[y * g.W + x] === pid + 1) n++;
    return n;
  };
  P[0].troops = 200000;
  P[1].troops = 500;
  let first = null;
  for (let t = 0; t < 400 && !first; t++) {
    g.tick([]);
    for (const e of g.events) if (e.k === 'ship' && e.type === 'transport' && e.pid === 0) first = g.unitById(e.id);
  }
  assert.ok(first, 'ИИ отправил десант');
  assert.equal(g.landId[first.target], g.landId[(50 * g.W) + 145], 'цель — ближайший ничий остров');
  assert.ok(first.troops > 1000 && first.troops < 40000, `размер десанта по размеру острова: ${first.troops}`);
  for (let t = 0; t < 600 && islandB(0) < 800; t++) g.tick([]);
  assert.ok(islandB(0) >= 800, `остров занят: ${islandB(0)}`);
  const hum0 = P[1].tiles;
  for (let t = 0; t < 2500 && P[1].alive && P[1].tiles >= hum0; t++) g.tick([]);
  assert.ok(!P[1].alive || P[1].tiles < hum0, 'ИИ высадился на остров врага');
  assert.equal(g.aiError, undefined);
});

test('ИИ: сложный ИИ без целей разрывает пакт со слабым соседом, обычный — нет', () => {
  for (const level of ['hard', 'normal']) {
    const map = rectMap([[10, 10, 190, 90]], 200, 100);
    const g = aiGame(map, [level, null], 6, { spawnSeconds: 1, victory: { territory: false } });
    g.tick([{ pid: 1, cmd: { c: 'spawn', x: 170, y: 50 } }]);
    while (g.s.phase === 'spawn') g.tick([]);
    fill(g, 0, 0, 0, 150, 100);
    fill(g, 1, 150, 0, 200, 100);
    g.s.relations['0:1'] = { type: 'pact', until: g.s.tick + 30000, embargo: false, emb: 0 };
    const P = g.s.players;
    P[1].troops = 300;
    for (let t = 0; t < 1500 && g.relation(0, 1).type === 'pact'; t++) {
      P[0].troops = P[0].maxTroops;
      P[1].troops = 300;
      g.tick([]);
    }
    if (level === 'hard') {
      assert.equal(g.relation(0, 1).type, 'none', 'пакт разорван');
      assert.ok(P[0].traitorUntil > g.s.tick, 'предатель');
      for (let t = 0; t < 100 && !g.s.attacks.some((a) => a.attacker === 0 && a.target === 1); t++) g.tick([]);
      assert.ok(g.s.attacks.some((a) => a.attacker === 0 && a.target === 1), 'нападение после разрыва');
    } else {
      assert.equal(g.relation(0, 1).type, 'pact', 'обычный ИИ соблюдает пакт');
    }
    assert.equal(g.aiError, undefined);
  }
});

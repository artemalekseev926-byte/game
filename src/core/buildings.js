import {
  BUILDINGS, ECON, RAIL_TYPES, CAPTURABLE, RESEARCH, LAND_UNITS, TRADE, TICKS_PER_SEC, sec, heading,
} from './config.js';

const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

export const INTENTS = {
  build: { check: checkBuild, run: runBuild },
  upgrade: { check: checkUpgrade, run: runUpgrade },
  demolish: { check: checkDemolish, run: runDemolish },
  rail: { check: checkRail, run: runRail },
};

export function countBuildings(game, pid, type) {
  let n = 0;
  for (const b of game.s.buildings) if (b.owner === pid && b.type === type) n++;
  return n;
}

export function buildCost(game, pid, type) {
  return Math.round(BUILDINGS[type].cost * (1 + ECON.buildCostStep * countBuildings(game, pid, type)));
}

export function upgradeCost(game, b) {
  return Math.round(BUILDINGS[b.type].cost * (1 + ECON.upgradeStep * b.level));
}

export const buildTicks = (type) => sec(BUILDINGS[type].time);

export const factoryInterval = (level) => Math.max(1, Math.round((ECON.factoryInterval * TICKS_PER_SEC) / Math.max(1, level)));

export const railCost = (len) => Math.round(ECON.railCostPerTile * len);

const dist = (a, b) => Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));

export function placeError(game, pid, type, i) {
  const s = game.s, def = BUILDINGS[type];
  if (i < 0) return 'Точка вне карты';
  if (!game.isLandTile(i)) return 'Стройте на суше';
  if (s.owner[i] !== pid + 1) return 'Стройте только на своей территории';
  if (s.fallout[i]) return 'Земля заражена радиацией';
  if (def.req && s.players[pid].research[def.req[0]] < def.req[1]) {
    return `Нужно исследование «${RESEARCH[def.req[0]].name}» ${def.req[1]} ур.`;
  }
  if (def.coast && !game.oceanCoast[i]) return 'Порт строится только на морском берегу';
  const W = game.W, x = i % W, y = (i - x) / W, D = ECON.buildMinDist;
  for (const b of s.buildings) {
    if (Math.abs(b.x - x) < D && Math.abs(b.y - y) < D) return `Слишком близко к другому зданию (нужно ${D} клеток)`;
  }
  return null;
}

export function upgradeError(game, pid, b) {
  if (!b || b.owner !== pid) return 'Здание не найдено';
  if (b.build > 0) return b.up ? 'Здание уже улучшается' : 'Здание ещё строится';
  if (b.level >= BUILDINGS[b.type].max) return 'Достигнут максимальный уровень';
  const cost = upgradeCost(game, b);
  if (game.s.players[pid].gold < cost) return `Нужно ${cost} золота`;
  return null;
}

function sameTypeAt(game, pid, type, i) {
  const b = i >= 0 ? game.buildingAt(i) : null;
  return b && b.owner === pid && b.type === type ? b : null;
}

export function buildError(game, pid, type, x, y) {
  if (!has(BUILDINGS, type)) return 'Неизвестное здание';
  const i = game.tileAt(x, y);
  const ex = sameTypeAt(game, pid, type, i);
  if (ex) return upgradeError(game, pid, ex);
  const err = placeError(game, pid, type, i);
  if (err) return err;
  const cost = buildCost(game, pid, type);
  if (game.s.players[pid].gold < cost) return `Нужно ${cost} золота`;
  return null;
}

function checkBuild(game, pid, cmd) {
  return buildError(game, pid, cmd.type, cmd.x, cmd.y);
}

function addBuilding(game, b) {
  game.s.buildings.push(b);
  game.bAt[b.y * game.W + b.x] = b.id;
  game.bById.set(b.id, b);
}

function runBuild(game, pid, cmd) {
  const i = game.tileAt(cmd.x, cmd.y);
  const ex = sameTypeAt(game, pid, cmd.type, i);
  if (ex) { startUpgrade(game, ex); return; }
  const p = game.s.players[pid];
  const cost = buildCost(game, pid, cmd.type);
  const t = buildTicks(cmd.type);
  p.gold -= cost;
  const x = i % game.W, y = (i - x) / game.W;
  const b = { id: game.nextId(), owner: pid, type: cmd.type, x, y, level: 1, build: t, total: t, up: 0, cd: 0, spent: cost };
  if (cmd.type === 'port') b.stock = 0;
  addBuilding(game, b);
}

function startUpgrade(game, b) {
  const p = game.s.players[b.owner];
  const cost = upgradeCost(game, b);
  const t = buildTicks(b.type);
  p.gold -= cost;
  b.spent += cost;
  b.build = t;
  b.total = t;
  b.up = 1;
}

function checkUpgrade(game, pid, cmd) {
  return upgradeError(game, pid, game.buildingById(cmd.id));
}

function runUpgrade(game, pid, cmd) {
  startUpgrade(game, game.buildingById(cmd.id));
}

function checkDemolish(game, pid, cmd) {
  const b = game.buildingById(cmd.id);
  if (!b || b.owner !== pid) return 'Здание не найдено';
  return null;
}

export const demolishRefund = (b) => Math.round((b.spent || 0) * ECON.demolishRefund);

function runDemolish(game, pid, cmd) {
  const b = game.buildingById(cmd.id);
  game.addGold(pid, demolishRefund(b), false);
  destroyBuilding(game, b, pid, true);
}

export function railBetween(game, a, b) {
  for (const r of game.s.rails) if ((r.a === a && r.b === b) || (r.a === b && r.b === a)) return r;
  return null;
}

export function railOwnShare(game, pid, A, B) {
  const own = game.s.owner, W = game.W, me = pid + 1;
  const ax = A.x + 0.5, ay = A.y + 0.5, bx = B.x + 0.5, by = B.y + 0.5;
  const steps = Math.max(1, Math.ceil(dist(A, B)));
  let mine = 0;
  for (let k = 0; k <= steps; k++) {
    const x = Math.floor(ax + ((bx - ax) * k) / steps), y = Math.floor(ay + ((by - ay) * k) / steps);
    if (own[y * W + x] === me) mine++;
  }
  return mine / (steps + 1);
}

export function railError(game, pid, aId, bId) {
  const A = game.buildingById(aId), B = game.buildingById(bId);
  if (!A || !B || A === B) return 'Выберите два разных здания';
  if (A.owner !== pid || B.owner !== pid) return 'Оба здания должны быть вашими';
  if (!RAIL_TYPES[A.type] || !RAIL_TYPES[B.type]) return 'Ж/д соединяет только фабрики, порты и жилые кварталы';
  if (!game.buildingActive(A) || !game.buildingActive(B)) return 'Здание ещё строится';
  if (railBetween(game, A.id, B.id)) return 'Эти здания уже соединены';
  const len = dist(A, B);
  if (len > ECON.railMaxLen) return `Слишком длинная дорога (не больше ${ECON.railMaxLen} клеток)`;
  if (railOwnShare(game, pid, A, B) < ECON.railOwnShare) return 'Дорога должна идти по вашей территории (не менее 80%)';
  const cost = railCost(len);
  if (game.s.players[pid].gold < cost) return `Нужно ${cost} золота`;
  return null;
}

function checkRail(game, pid, cmd) {
  return railError(game, pid, Number(cmd.a), Number(cmd.b));
}

function runRail(game, pid, cmd) {
  const A = game.buildingById(cmd.a), B = game.buildingById(cmd.b);
  const len = dist(A, B);
  game.s.players[pid].gold -= railCost(len);
  game.s.rails.push({ id: game.nextId(), owner: pid, a: A.id, b: B.id, len });
}

export function removeRails(game, id) {
  const s = game.s;
  let n = 0;
  for (const r of s.rails) if (r.a === id || r.b === id) n++;
  if (n) s.rails = s.rails.filter((r) => r.a !== id && r.b !== id);
  return n;
}

export function railRoute(game, pid, fromId, toId) {
  if (fromId === toId) return [fromId];
  const adj = new Map();
  const link = (u, v) => {
    let l = adj.get(u);
    if (!l) { l = []; adj.set(u, l); }
    l.push(v);
  };
  for (const r of game.s.rails) {
    if (r.owner !== pid) continue;
    link(r.a, r.b);
    link(r.b, r.a);
  }
  if (!adj.has(fromId) || !adj.has(toId)) return null;
  for (const l of adj.values()) l.sort((p, q) => p - q);
  const prev = new Map([[fromId, -1]]);
  const queue = [fromId];
  for (let h = 0; h < queue.length; h++) {
    const u = queue[h];
    if (u === toId) break;
    for (const v of adj.get(u)) {
      if (prev.has(v)) continue;
      prev.set(v, u);
      queue.push(v);
    }
  }
  if (!prev.has(toId)) return null;
  const route = [];
  for (let v = toId; v !== -1; v = prev.get(v)) route.push(v);
  return route.reverse();
}

export function destroyBuilding(game, b, by = -1, silent = false) {
  const s = game.s;
  const idx = s.buildings.indexOf(b);
  if (idx < 0) return false;
  s.buildings.splice(idx, 1);
  const i = b.y * game.W + b.x;
  if (game.bAt[i] === b.id) game.bAt[i] = -1;
  game.bById.delete(b.id);
  removeRails(game, b.id);
  game.emit({ k: 'destroyed', id: b.id, x: b.x, y: b.y, type: b.type, owner: b.owner, by });
  if (!silent && s.players[b.owner]) {
    game.msg(b.owner, `Уничтожено здание: ${BUILDINGS[b.type].name}`, 'danger');
  }
  return true;
}

export function onTileOwnerChanged(game, b, prev, next) {
  if (next < 0 || !CAPTURABLE[b.type]) {
    destroyBuilding(game, b, next);
    return;
  }
  if (b.owner === next) return;
  const s = game.s, from = b.owner;
  removeRails(game, b.id);
  b.owner = next;
  game.emit({ k: 'capture', pid: next, from, x: b.x, y: b.y, id: b.id, type: b.type });
  const name = BUILDINGS[b.type].name;
  if (s.players[from]) game.msg(from, `${s.players[next].name} захватил ваше здание: ${name}`, 'danger');
  game.msg(next, `Захвачено здание: ${name}`, 'good');
}

function complete(game, b) {
  const name = BUILDINGS[b.type].name;
  if (b.up) {
    b.level = Math.min(BUILDINGS[b.type].max, b.level + 1);
    b.up = 0;
    game.msg(b.owner, `${name}: улучшено до ур. ${b.level}`, 'good');
  } else {
    game.msg(b.owner, `Построено: ${name}`, 'good');
  }
  if (b.type === 'factory') b.cd = Math.min(b.cd > 0 ? b.cd : Infinity, factoryInterval(b.level));
  game.emit({ k: 'built', pid: b.owner, id: b.id });
}

export function nearestPort(game, pid, x, y) {
  let best = null, bd = Infinity;
  for (const b of game.s.buildings) {
    if (b.owner !== pid || b.type !== 'port' || !game.buildingActive(b)) continue;
    const d = (b.x - x) * (b.x - x) + (b.y - y) * (b.y - y);
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}

export function railLength(game, route) {
  let L = 0;
  for (let k = 1; k < route.length; k++) {
    const a = game.buildingById(route[k - 1]), b = game.buildingById(route[k]);
    if (a && b) L += dist(a, b);
  }
  return L;
}

export function factoryRoute(game, f) {
  let best = null;
  for (const b of game.s.buildings) {
    if (b.owner !== f.owner || b.type !== 'port' || !game.buildingActive(b)) continue;
    const route = railRoute(game, f.owner, f.id, b.id);
    if (!route) continue;
    const len = railLength(game, route);
    if (!best || len < best.len || (len === best.len && b.id < best.port.id)) best = { port: b, route, type: 'train', len };
  }
  if (best) return best;
  const port = nearestPort(game, f.owner, f.x, f.y);
  if (!port) return null;
  return { port, route: null, type: 'truck', len: dist(f, port) };
}

export function factoryCycle(level, len, type) {
  const trip = Math.ceil((2 * len) / LAND_UNITS[type].speed);
  return Math.max(factoryInterval(level), trip);
}

export function factoryOutlook(game, f) {
  const plan = factoryRoute(game, f);
  if (!plan) return null;
  const cargo = ECON.cargoPerLevel * f.level;
  const perMin = (ticks) => (cargo * 60 * TICKS_PER_SEC) / ticks;
  const cycle = factoryCycle(f.level, plan.len, plan.type);
  const out = { ...plan, cargo, cycle, perMin: perMin(cycle), railPerMin: 0 };
  if (plan.type === 'truck') out.railPerMin = perMin(factoryCycle(f.level, plan.len, 'train')) - out.perMin;
  return out;
}

export function shipCargo(game, f) {
  const plan = factoryRoute(game, f);
  if (!plan) return null;
  const stops = plan.route ? plan.route.map((id) => game.buildingById(id)) : [f, plan.port];
  const path = stops.map((b) => [b.x + 0.5, b.y + 0.5]);
  const u = {
    owner: f.owner, type: plan.type, x: path[0][0], y: path[0][1], path, pi: 1, hp: 1, maxHp: 1,
    cargo: ECON.cargoPerLevel * f.level, from: f.id, to: plan.port.id, back: 0,
    heading: heading(path[1][0] - path[0][0], path[1][1] - path[0][1]),
  };
  game.spawnUnit(u);
  f.veh = u.id;
  return u;
}

function vehicleOut(game, b) {
  if (!b.veh) return false;
  const u = game.unitById(b.veh);
  if (u && u.from === b.id && (u.type === 'train' || u.type === 'truck')) return true;
  b.veh = 0;
  return false;
}

function tickFactory(game, b) {
  if (b.cd > 0) b.cd--;
  if (b.cd > 0 || vehicleOut(game, b)) return;
  b.cd = factoryInterval(b.level);
  shipCargo(game, b);
}

export function deliverCargo(game, u) {
  const port = game.buildingById(u.to);
  if (!port || port.type !== 'port' || port.owner !== u.owner) return false;
  const p = game.s.players[u.owner];
  if (!p || !p.alive) return false;
  const gold = Math.round(u.cargo * game.incomeMult(u.owner));
  game.addGold(u.owner, gold);
  port.stock = Math.min(TRADE.maxStock, (port.stock || 0) + 1);
  game.emit({ k: 'cargo', pid: u.owner, id: port.id, x: port.x, y: port.y, gold, by: u.type });
  return true;
}

export function stepLandUnit(u) {
  let left = LAND_UNITS[u.type].speed;
  while (left > 0 && u.pi < u.path.length) {
    const t = u.path[u.pi];
    const dx = t[0] - u.x, dy = t[1] - u.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 0) u.heading = heading(dx, dy);
    if (d <= left) {
      u.x = t[0];
      u.y = t[1];
      left -= d;
      u.pi++;
    } else {
      u.x += (dx / d) * left;
      u.y += (dy / d) * left;
      left = 0;
    }
  }
  return u.pi >= u.path.length;
}

function turnBack(u) {
  u.back = 1;
  u.cargo = 0;
  u.path = u.path.slice().reverse();
  u.pi = 1;
}

function tickLandUnits(game) {
  const s = game.s;
  let done = null;
  for (const u of s.units) {
    if (u.type !== 'train' && u.type !== 'truck') continue;
    if (!stepLandUnit(u)) continue;
    if (!u.back) {
      deliverCargo(game, u);
      if (u.path.length > 1) {
        turnBack(u);
        continue;
      }
    }
    const f = game.buildingById(u.from);
    if (f && f.veh === u.id) f.veh = 0;
    (done || (done = new Set())).add(u);
  }
  if (done) s.units = s.units.filter((u) => !done.has(u));
}

export function tickBuildings(game) {
  const s = game.s;
  if (s.phase !== 'play') return;
  for (const b of s.buildings) {
    if (b.build > 0) {
      b.build--;
      if (b.build === 0) complete(game, b);
    }
    if (b.type === 'factory' && game.buildingActive(b)) tickFactory(game, b);
  }
  tickLandUnits(game);
}

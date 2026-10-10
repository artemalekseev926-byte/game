import { SHIPS, TRADE, heading } from './config.js';
import {
  findWaterPath, nearestCoastTile, nearestOceanTile, coastBodies, pathLength, NAV_SCALE, NAV_SEARCH,
} from './nav.js';

const WS = SHIPS.warship;
const SHIP_TYPES = { warship: true, transport: true, trade: true };
const SEARCH = NAV_SCALE * NAV_SEARCH;

export const INTENTS = {
  buildShip: { check: checkBuildShip, run: runBuildShip },
  moveShip: { check: checkMoveShip, run: runMoveShip },
  boat: { check: checkBoat, run: runBoat },
};

export const isShip = (u) => !!u && SHIP_TYPES[u.type] === true;

function clampRatio(r) {
  const v = Number(r);
  if (!Number.isFinite(v)) return 0.3;
  return Math.min(1, Math.max(0.01, v));
}

const cellOf = (game, x, y) => game.tileAt(x, y);
const center = (game, i) => [(i % game.W) + 0.5, Math.floor(i / game.W) + 0.5];

export function countUnits(game, pid, type) {
  let n = 0;
  for (const u of game.s.units) if (u.owner === pid && u.type === type) n++;
  return n;
}

export function portShips(game, port) {
  let n = 0;
  for (const u of game.s.units) if (u.type === 'warship' && u.from === port.id && u.owner === port.owner) n++;
  return n;
}

export const portShipCap = (port) => WS.perPortBase + port.level;

export function shipCost(game, pid) {
  return Math.round(WS.cost * (1 + WS.costStep * countUnits(game, pid, 'warship')));
}

export const warshipHp = (naval) => Math.round(WS.hp * (1 + WS.navalBonus * naval));
export const warshipDamage = (naval) => Math.round(WS.dmg * (1 + WS.navalBonus * naval));

const BERTH_R = 5;

function berthTaken(game, pid, i, skip) {
  const W = game.W;
  for (const u of game.s.units) {
    if (u === skip || u.type !== 'warship' || u.owner !== pid || u.hp <= 0) continue;
    if (Math.floor(u.y) * W + Math.floor(u.x) === i) return true;
    if (u.dest && Math.floor(u.dest[1]) * W + Math.floor(u.dest[0]) === i) return true;
  }
  return false;
}

export function freeBerth(game, pid, i0, skip = null) {
  const map = game.map, W = game.W, H = game.H, ocean = map.nav.ocean;
  if (i0 < 0 || !ocean[i0]) return -1;
  if (!berthTaken(game, pid, i0, skip)) return i0;
  const body = map.waterBody[i0];
  const x0 = i0 % W, y0 = (i0 - x0) / W;
  const cands = [];
  for (let dy = -BERTH_R; dy <= BERTH_R; dy++) {
    const y = y0 + dy;
    if (y < 0 || y >= H) continue;
    for (let dx = -BERTH_R; dx <= BERTH_R; dx++) {
      const x = x0 + dx;
      if (x < 0 || x >= W || dx * dx + dy * dy > BERTH_R * BERTH_R) continue;
      const i = y * W + x;
      if (ocean[i] && map.waterBody[i] === body && clearWater(map, x0 + 0.5, y0 + 0.5, x + 0.5, y + 0.5)) cands.push(dx * dx + dy * dy, i);
    }
  }
  let best = -1, bd = Infinity;
  for (let k = 0; k < cands.length; k += 2) {
    const d = cands[k], i = cands[k + 1];
    if (d < bd || (d === bd && i < best)) {
      if (berthTaken(game, pid, i, skip)) continue;
      bd = d;
      best = i;
    }
  }
  return best;
}

export function shipSpawnTile(game, port) {
  const base = nearestOceanTile(game.map, port.x + 0.5, port.y + 0.5, 3);
  if (base < 0) return -1;
  const free = freeBerth(game, port.owner, base);
  return free >= 0 ? free : base;
}

function spreadOut(game, u) {
  const here = cellOf(game, u.x, u.y);
  if (here < 0 || !berthTaken(game, u.owner, here, u)) return;
  const t = freeBerth(game, u.owner, here, u);
  if (t < 0 || t === here) return;
  const c = center(game, t);
  u.path = [c];
  u.pi = 0;
  u.order = 1;
  u.dest = [c[0], c[1]];
}

export function buildShipError(game, pid, portId) {
  const b = game.buildingById(portId);
  if (!b || b.owner !== pid || b.type !== 'port') return 'Выберите свой порт';
  if (!game.buildingActive(b)) return 'Порт ещё строится';
  const cap = portShipCap(b);
  if (portShips(game, b) >= cap) return `Порт уже спустил на воду максимум кораблей (${cap})`;
  if (shipSpawnTile(game, b) < 0) return 'У порта нет выхода в море';
  const cost = shipCost(game, pid);
  if (game.s.players[pid].gold < cost) return `Нужно ${cost} золота`;
  return null;
}

function checkBuildShip(game, pid, cmd) {
  return buildShipError(game, pid, cmd.port);
}

function runBuildShip(game, pid, cmd) {
  const s = game.s, p = s.players[pid];
  const b = game.buildingById(cmd.port);
  const cost = shipCost(game, pid);
  p.gold -= cost;
  const [x, y] = center(game, shipSpawnTile(game, b));
  const hp = warshipHp(p.research.naval);
  const u = game.spawnUnit({
    owner: pid, type: 'warship', x, y, path: [], pi: 0, hp, maxHp: hp,
    from: b.id, dest: null, order: 0, chase: -1, heading: heading(x - b.x - 0.5, y - b.y - 0.5),
  });
  game.emit({ k: 'ship', pid, id: u.id, type: 'warship', x, y });
  game.msg(pid, `${WS.name} спущен на воду`, 'good');
}

export function waterPath(game, a, b, body) {
  const map = game.map, W = game.W;
  const s0 = nearestOceanTile(map, (a % W) + 0.5, Math.floor(a / W) + 0.5, 1, body);
  const t0 = nearestOceanTile(map, (b % W) + 0.5, Math.floor(b / W) + 0.5, 1, body);
  if (s0 < 0 || t0 < 0) return null;
  const [sx, sy] = center(game, s0), [tx, ty] = center(game, t0);
  const path = findWaterPath(map, sx, sy, tx, ty);
  return path && path.length ? path : null;
}

export function shipPath(game, u, x, y) {
  const map = game.map;
  const here = cellOf(game, u.x, u.y);
  if (here < 0) return null;
  const body = map.waterBody[here];
  const t = nearestOceanTile(map, Number(x), Number(y), SEARCH, body);
  if (t < 0) return null;
  const [tx, ty] = center(game, t);
  const path = findWaterPath(map, u.x, u.y, tx, ty);
  if (!path || !path.length) return null;
  const first = cellOf(game, path[0][0], path[0][1]);
  if (first < 0 || map.waterBody[first] !== body) return null;
  return path;
}

function checkMoveShip(game, pid, cmd) {
  const u = game.unitById(cmd.id);
  if (!u || u.owner !== pid || u.type !== 'warship') return 'Корабль не найден';
  if (game.tileAt(cmd.x, cmd.y) < 0) return 'Точка вне карты';
  if (!shipPath(game, u, cmd.x, cmd.y)) return 'Корабль туда не доплывёт';
  return null;
}

function runMoveShip(game, pid, cmd) {
  const u = game.unitById(cmd.id);
  const path = shipPath(game, u, cmd.x, cmd.y);
  u.path = path;
  u.pi = 0;
  u.order = 1;
  u.chase = -1;
  const end = path[path.length - 1];
  u.dest = [end[0], end[1]];
}

export function boatPlan(game, pid, x, y) {
  const s = game.s, map = game.map, W = game.W;
  const i = game.tileAt(x, y);
  if (i < 0) return { error: 'Точка вне карты' };
  if (!game.isLandTile(i)) return { error: 'Выберите сушу для высадки' };
  const target = s.owner[i] - 1;
  if (target === pid) return { error: 'Это ваша территория' };
  if (target >= 0 && !game.isHostile(pid, target)) return { error: 'Нельзя высаживаться на земле союзника или партнёра по пакту' };
  const ix = i % W, iy = (i - ix) / W;
  const landing = game.oceanCoast[i] ? i : nearestCoastTile(map, s.owner, s.owner[i], ix, iy);
  if (landing < 0) return { error: 'Нет берега для высадки' };
  const lx = landing % W, ly = (landing - lx) / W;
  const bodies = coastBodies(map, landing).sort((a, b) => a - b);
  let start = -1, sea = -1, bd = Infinity;
  for (const body of bodies) {
    const st = nearestCoastTile(map, s.owner, pid + 1, lx, ly, Infinity, body);
    if (st < 0) continue;
    const sx = st % W, sy = (st - sx) / W;
    const d = (sx - lx) * (sx - lx) + (sy - ly) * (sy - ly);
    if (d < bd || (d === bd && st < start)) { bd = d; start = st; sea = body; }
  }
  if (start < 0) return { error: 'Нет своего берега у этого моря' };
  const path = waterPath(game, start, landing, sea);
  if (!path) return { error: 'Нет морского пути к цели' };
  return { error: null, landing, start, path, target };
}

export function boatError(game, pid, x, y, ratio) {
  const p = game.s.players[pid];
  const troops = Math.floor(p.troops * clampRatio(ratio));
  if (troops < 1) return 'Недостаточно войск';
  const max = SHIPS.transport.maxActive;
  if (countUnits(game, pid, 'transport') >= max) return `Не больше ${max} десантных кораблей одновременно`;
  return boatPlan(game, pid, x, y).error;
}

function checkBoat(game, pid, cmd) {
  return boatError(game, pid, cmd.x, cmd.y, cmd.ratio);
}

function runBoat(game, pid, cmd) {
  const s = game.s, p = s.players[pid];
  const plan = boatPlan(game, pid, cmd.x, cmd.y);
  if (plan.error) return;
  const troops = Math.floor(p.troops * clampRatio(cmd.ratio));
  p.troops -= troops;
  const path = plan.path;
  const [x, y] = path[0];
  const nx = path.length > 1 ? path[1] : center(game, plan.landing);
  const hp = SHIPS.transport.hp;
  const u = game.spawnUnit({
    owner: pid, type: 'transport', x, y, path, pi: 1, hp, maxHp: hp,
    troops, target: plan.landing, tp: plan.target, heading: heading(nx[0] - x, nx[1] - y),
  });
  game.emit({ k: 'ship', pid, id: u.id, type: 'transport', x, y });
  if (plan.target >= 0) game.msg(plan.target, `${p.name} отправил к вашим берегам десант`, 'danger');
}

export function sharedSea(game, a, b) {
  const W = game.W;
  const mine = coastBodies(game.map, a.y * W + a.x);
  if (!mine.length) return -1;
  let best = -1;
  for (const body of coastBodies(game.map, b.y * W + b.x)) if (mine.includes(body) && (best < 0 || body < best)) best = body;
  return best;
}

export function tradePartners(game, port) {
  const s = game.s;
  const out = [];
  for (const q of s.buildings) {
    if (q.type !== 'port' || q.owner === port.owner || !game.buildingActive(q)) continue;
    const o = s.players[q.owner];
    if (!o || !o.alive) continue;
    if (game.relation(port.owner, q.owner).embargo) continue;
    if (sharedSea(game, port, q) >= 0) out.push(q);
  }
  return out;
}

export function tradeCargo(dist, stock) {
  return Math.round((TRADE.base + dist * TRADE.perTile) * (1 + TRADE.stockBonus * stock));
}

export function sendTrade(game, port) {
  const cands = tradePartners(game, port);
  if (!cands.length) return null;
  const dst = cands.length === 1 ? cands[0] : cands[game.randInt(cands.length)];
  const W = game.W;
  const path = waterPath(game, port.y * W + port.x, dst.y * W + dst.x, sharedSea(game, port, dst));
  if (!path) return null;
  const stock = port.stock | 0;
  if (stock > 0) port.stock = stock - 1;
  const cargo = tradeCargo(Math.round(pathLength(path)), stock);
  const [x, y] = path[0];
  const nx = path.length > 1 ? path[1] : [dst.x + 0.5, dst.y + 0.5];
  const hp = SHIPS.trade.hp;
  return game.spawnUnit({
    owner: port.owner, type: 'trade', x, y, path, pi: 1, hp, maxHp: hp,
    cargo, from: port.id, to: dst.id, toOwner: dst.owner, heading: heading(nx[0] - x, nx[1] - y),
  });
}

function tickPort(game, b) {
  if (b.cd > 1) { b.cd--; return; }
  const iv = TRADE.interval(b.level);
  if (!(b.cd > 0)) { b.cd = iv; return; }
  b.cd = iv;
  sendTrade(game, b);
}

function tickPorts(game) {
  const s = game.s;
  for (const b of s.buildings) {
    if (b.type !== 'port' || !game.buildingActive(b)) continue;
    const p = s.players[b.owner];
    if (p && p.alive) tickPort(game, b);
  }
}

export function tradeIncome(game, u, dst) {
  const a = u.owner, b = dst.owner;
  const mul = game.hasTradeTreaty(a, b) ? 1 + TRADE.treaty : 1;
  return u.cargo * mul;
}

function arriveTrade(game, u) {
  const s = game.s, P = s.players;
  const dst = game.buildingById(u.to);
  if (!dst || dst.type !== 'port') return;
  const a = u.owner, b = dst.owner;
  if (a !== b && game.relation(a, b).embargo) return;
  const base = tradeIncome(game, u, dst);
  let ga = 0, gb = 0;
  if (P[a] && P[a].alive) {
    ga = Math.round(base * game.incomeMult(a));
    game.addGold(a, ga);
  }
  if (b !== a && P[b] && P[b].alive) {
    gb = Math.round(base * game.incomeMult(b));
    game.addGold(b, gb);
  }
  game.emit({ k: 'trade', from: a, to: b, gold: ga, goldTo: gb, x: dst.x, y: dst.y, id: u.id });
}

function arriveTransport(game, u) {
  const s = game.s;
  const p = s.players[u.owner];
  if (!p || !p.alive || !(u.troops > 0)) return;
  const i = u.target;
  if (!game.isLandTile(i)) {
    p.troops += u.troops;
    return;
  }
  const o = s.owner[i] - 1;
  game.createAttack(u.owner, o, u.troops, i);
  u.troops = 0;
}

export function advance(u, speed) {
  const P = u.path;
  let left = speed;
  while (left > 0 && u.pi < P.length) {
    const t = P[u.pi];
    const dx = t[0] - u.x, dy = t[1] - u.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 1e-9) u.heading = heading(dx, dy);
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
  return u.pi >= P.length;
}

export function clearWater(map, ax, ay, bx, by) {
  const { W, H } = map;
  const ocean = map.nav.ocean;
  const ok = (x, y) => x >= 0 && y >= 0 && x < W && y < H && ocean[y * W + x] === 1;
  let x = Math.floor(ax), y = Math.floor(ay);
  const ex = Math.floor(bx), ey = Math.floor(by);
  if (!ok(x, y) || !ok(ex, ey)) return false;
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

export function canEngage(game, me, t) {
  if (!isShip(t) || t.hp <= 0 || t.owner === me) return false;
  if (!game.isHostile(me, t.owner)) return false;
  if (t.type === 'trade') {
    const dst = game.buildingById(t.to);
    if (dst && dst.owner === me) return false;
    if (game.hasTradeTreaty(me, t.owner)) return false;
  }
  return true;
}

function nearestEnemy(game, u, radius) {
  const r2 = radius * radius;
  let best = null, bd = Infinity;
  for (const t of game.s.units) {
    if (t === u || !canEngage(game, u.owner, t)) continue;
    const dx = t.x - u.x, dy = t.y - u.y;
    const d = dx * dx + dy * dy;
    if (d <= r2 && d < bd) { bd = d; best = t; }
  }
  return best ? { t: best, d2: bd } : null;
}

export function sinkUnit(game, t, by = -1, loot = true) {
  const s = game.s, P = s.players;
  t.hp = 0;
  const q = by >= 0 && by !== t.owner ? P[by] : null;
  if (q && isShip(t)) q.stats.shipsSunk++;
  if (t.type === 'transport' && t.troops > 0) {
    if (q) q.stats.kills += t.troops;
    t.troops = 0;
  }
  if (t.type === 'trade' && loot && q && q.alive) {
    const g = Math.round((t.cargo || 0) * TRADE.sunkLoot);
    if (g > 0) game.addGold(by, g);
  }
  if (isShip(t)) {
    game.emit({ k: 'shipSunk', x: t.x, y: t.y, type: t.type, id: t.id, owner: t.owner, by });
    if (P[t.owner] && P[t.owner].alive) game.msg(t.owner, `Потоплен ваш корабль: ${SHIPS[t.type].name}`, 'danger');
  }
}

export function sinkUnitsIn(game, x, y, r, by, pred) {
  const s = game.s, r2 = r * r;
  const keep = [];
  let n = 0;
  for (const u of s.units) {
    const dx = u.x - x, dy = u.y - y;
    if (dx * dx + dy * dy <= r2 && (!pred || pred(u))) {
      sinkUnit(game, u, by, false);
      n++;
    } else keep.push(u);
  }
  if (n) s.units = keep;
  return n;
}

function chasePath(game, u, t) {
  if (clearWater(game.map, u.x, u.y, t.x, t.y)) return [[t.x, t.y]];
  return shipPath(game, u, t.x, t.y);
}

function warshipTurn(game, u) {
  const p = game.s.players[u.owner];
  const enemy = nearestEnemy(game, u, u.order ? WS.range : WS.chase);
  if (enemy && enemy.d2 <= WS.range * WS.range) {
    const t = enemy.t;
    t.hp -= warshipDamage(p ? p.research.naval : 0);
    game.emit({ k: 'shipFire', id: u.id, x: u.x, y: u.y, tx: t.x, ty: t.y });
    if (t.hp <= 0) sinkUnit(game, t, u.owner, true);
  }
  if (u.order) return;
  const close = WS.range * 0.6;
  if (enemy && enemy.t.hp > 0 && enemy.d2 > close * close) {
    const path = chasePath(game, u, enemy.t);
    if (path) {
      u.path = path;
      u.pi = 0;
      u.chase = enemy.t.id;
      return;
    }
  }
  if (u.chase >= 0 || u.path.length) {
    u.chase = -1;
    u.path = [];
    u.pi = 0;
  }
}

function tickCombat(game) {
  const s = game.s, every = WS.fireEvery;
  for (const u of s.units) {
    if (u.type !== 'warship' || u.hp <= 0 || (s.tick + u.id) % every !== 0) continue;
    warshipTurn(game, u);
  }
}

function moveShips(game) {
  const s = game.s;
  let gone = null;
  for (const u of s.units) {
    if (!isShip(u)) continue;
    if (u.hp <= 0) {
      (gone || (gone = new Set())).add(u);
      continue;
    }
    if (u.type === 'warship' && u.pi >= u.path.length) continue;
    if (u.pi < u.path.length && !advance(u, SHIPS[u.type].speed)) continue;
    if (u.type === 'warship') {
      u.path = [];
      u.pi = 0;
      u.dest = null;
      if (u.order) u.order = 0;
      spreadOut(game, u);
      continue;
    }
    if (u.type === 'transport') arriveTransport(game, u);
    else arriveTrade(game, u);
    (gone || (gone = new Set())).add(u);
  }
  if (gone) s.units = s.units.filter((u) => !gone.has(u));
}

export function tickUnits(game) {
  const s = game.s;
  if (s.phase !== 'play') return;
  tickPorts(game);
  if (!s.units.length) return;
  tickCombat(game);
  moveShips(game);
}

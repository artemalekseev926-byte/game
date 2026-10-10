import {
  STRIKES, WARHEAD, FALLOUT_TICKS, NUKE_TROOP_LOSS, SAM, RESEARCH, INTERCEPT, cruiseRange, siloReload, airbaseReload,
  interceptChance, TICKS_PER_SEC,
} from './config.js';
import { sinkUnitsIn } from './units.js';

const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

export const INTENTS = {
  strike: { check: checkStrike, run: runStrike },
};

export const THREAT = { mega: 6, hbomb: 5, atom: 4, warhead: 4, cruise: 3, kamikaze: 2, drone: 1 };
export const strikeName = (kind) => (kind === 'warhead' ? 'Ядерная боеголовка' : STRIKES[kind] ? STRIKES[kind].name : kind);

export const strikeRange = (game, pid, kind) => (kind === 'cruise' ? cruiseRange(game.s.players[pid].research.missile) : Infinity);

export function strikeTarget(game, pid, x, y, pick = 2) {
  const cx = Math.floor(Number(x)), cy = Math.floor(Number(y));
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  let best = null, bd = Infinity;
  for (const b of game.s.buildings) {
    const dx = b.x - cx, dy = b.y - cy;
    if (Math.abs(dx) > pick || Math.abs(dy) > pick) continue;
    if (b.owner === pid || !game.isHostile(pid, b.owner)) continue;
    const d = dx * dx + dy * dy;
    if (d < bd || (d === bd && b.id < best.id)) { bd = d; best = b; }
  }
  return best;
}

export function aimPoint(game, kind, x, y) {
  const fx = Number(x), fy = Number(y);
  if (kind === 'mega' && (x === undefined || y === undefined || !Number.isFinite(fx) || !Number.isFinite(fy))) {
    return { x: Math.floor(game.W / 2) + 0.5, y: Math.floor(game.H / 2) + 0.5 };
  }
  const i = game.tileAt(fx, fy);
  if (i < 0) return null;
  return { x: (i % game.W) + 0.5, y: Math.floor(i / game.W) + 0.5 };
}

export function reloadOf(b) {
  return b.type === 'silo' ? siloReload(b.level) : airbaseReload(b.level);
}

export const megasUsed = (p) => (p && p.stats ? p.stats.megas | 0 : 0);

export function strikeCost(game, pid, kind) {
  const def = STRIKES[kind];
  if (!def) return 0;
  if (!def.incomeSec) return def.cost;
  const p = game.s.players[pid];
  const inc = p && Number.isFinite(p.income) ? Math.max(0, p.income) : 0;
  return Math.max(def.cost, Math.ceil((inc * def.incomeSec) / 1000) * 1000);
}

function hostileVictims(game, pid) {
  const out = [];
  for (const q of game.s.players) if (q.alive && q.id !== pid && game.isHostile(pid, q.id) && q.tiles > 0) out.push(q.id);
  return out;
}

export function strikeError(game, pid, kind, fromId, x, y) {
  if (!has(STRIKES, kind)) return 'Неизвестный тип удара';
  const def = STRIKES[kind];
  const s = game.s, p = s.players[pid];
  const [rk, rl] = def.req;
  if (p.research[rk] < rl) return `Нужно исследование «${RESEARCH[rk].name}» ${rl} ур.`;
  const b = game.buildingById(fromId);
  if (!b || b.owner !== pid) return def.src === 'silo' ? 'Выберите свою ракетную шахту' : 'Выберите свой аэродром БПЛА';
  if (b.type !== def.src) return def.src === 'silo' ? 'Запуск только из ракетной шахты' : 'Запуск только с аэродрома БПЛА';
  if (!game.buildingActive(b)) return 'Здание ещё строится';
  if (b.cd > 0) return `Перезарядка: ${Math.ceil(b.cd / TICKS_PER_SEC)} с`;
  if (def.perGame && megasUsed(p) >= def.perGame) return 'Мегабомба уже применена: она одна на партию';
  const cost = strikeCost(game, pid, kind);
  if (p.gold < cost) return `Нужно ${cost} золота`;
  const aim = aimPoint(game, kind, x, y);
  if (!aim) return 'Точка вне карты';
  if (kind === 'mega') return hostileVictims(game, pid).length ? null : 'Нет враждебных стран для удара';
  if (def.point) {
    const t = strikeTarget(game, pid, x, y, def.pick);
    if (!t) return 'В точке удара нет вражеского здания';
    const range = strikeRange(game, pid, kind);
    const dx = t.x - b.x, dy = t.y - b.y;
    if (dx * dx + dy * dy > range * range) return `Цель вне досягаемости (${range} кл.)`;
    return null;
  }
  const i = game.tileAt(aim.x, aim.y);
  const o = s.owner[i] - 1;
  if (o === pid) return 'Нельзя наносить удар по своей территории';
  if (o >= 0 && !game.isHostile(pid, o)) return 'Нельзя наносить удар по союзнику или партнёру по пакту';
  if (kind === 'drone' && o < 0) return 'Цель дрона — территория противника';
  return null;
}

function checkStrike(game, pid, cmd) {
  return strikeError(game, pid, cmd.kind, cmd.from, cmd.x, cmd.y);
}

export function makeProjectile(game, owner, type, sx, sy, tx, ty, extra) {
  const speed = type === 'warhead' ? WARHEAD.speed : STRIKES[type].speed;
  const dx = tx - sx, dy = ty - sy;
  const dur = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy) / speed));
  return {
    id: game.nextId(), owner, type, sx, sy, tx, ty, x: sx, y: sy, t: 0, dur,
    targetBuilding: -1, intercepted: false, from: -1, lvl: 0, victim: -1, sel: 0, ...extra,
  };
}

function boostPoint(game, def, sx, sy, aim) {
  let dx = aim.x - sx, dy = aim.y - sy;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 1) { dx = 0; dy = -1; } else { dx /= d; dy /= d; }
  const L = def.boost || 0;
  const x = Math.min(game.W - 0.5, Math.max(0.5, sx + dx * L)), y = Math.min(game.H - 0.5, Math.max(0.5, sy + dy * L));
  return { x, y };
}

function runStrike(game, pid, cmd) {
  const s = game.s, p = s.players[pid];
  const kind = cmd.kind, def = STRIKES[kind];
  const b = game.buildingById(cmd.from);
  const aim = aimPoint(game, kind, cmd.x, cmd.y);
  let tx = aim.x, ty = aim.y, targetBuilding = -1;
  if (def.point) {
    const t = strikeTarget(game, pid, cmd.x, cmd.y, def.pick);
    tx = t.x + 0.5;
    ty = t.y + 0.5;
    targetBuilding = t.id;
  }
  const sx = b.x + 0.5, sy = b.y + 0.5;
  if (kind === 'mega') {
    const bp = boostPoint(game, def, sx, sy, aim);
    tx = bp.x;
    ty = bp.y;
  }
  p.gold -= strikeCost(game, pid, kind);
  b.cd = reloadOf(b);
  const pr = makeProjectile(game, pid, kind, sx, sy, tx, ty, { targetBuilding, from: b.id, lvl: p.research[def.req[0]] });
  s.projectiles.push(pr);
  if (def.nuke) p.stats.nukes++;
  game.emit({ k: 'launch', pid, kind, x: sx, y: sy, tx, ty, id: pr.id });
  if (kind === 'mega') {
    p.stats.megas = megasUsed(p) + 1;
    game.msg(-1, `${p.name} запустил мегабомбу «Судный день»! Через ${Math.ceil(pr.dur / TICKS_PER_SEC)} с она распадётся на боеголовки`, 'danger');
    return;
  }
  const i = game.tileAt(tx, ty);
  const o = i >= 0 ? s.owner[i] - 1 : -1;
  if (o >= 0 && o !== pid) game.msg(o, `${p.name} наносит по вам удар: ${def.name}!`, 'danger');
  game.msg(pid, `Запуск: ${def.name}`, 'info');
}

function reload(game) {
  for (const b of game.s.buildings) {
    if (b.cd > 0 && (b.type === 'silo' || b.type === 'airbase' || b.type === 'sam')) b.cd--;
  }
}

function interceptPoint(pr, bx, by, R) {
  const dx = pr.x - bx, dy = pr.y - by;
  if (dx * dx + dy * dy <= R * R) return { x: pr.x, y: pr.y };
  const ex = pr.x - pr.tx, ey = pr.y - pr.ty;
  const L = Math.sqrt(ex * ex + ey * ey) || 1;
  const k = Math.min(L, R * 0.5) / L;
  return { x: pr.tx + ex * k, y: pr.ty + ey * k };
}

function samDefense(game) {
  const s = game.s, P = s.players;
  let hit = false;
  for (const b of s.buildings) {
    if (b.type !== 'sam' || b.cd > 0 || !game.buildingActive(b)) continue;
    const owner = P[b.owner];
    if (!owner || !owner.alive) continue;
    const R = SAM.radius(b.level), R2 = R * R;
    const bx = b.x + 0.5, by = b.y + 0.5;
    let best = null, bp = -1, bd = Infinity;
    for (const pr of s.projectiles) {
      if (pr.intercepted || !INTERCEPT[pr.type] || pr.owner === b.owner || !game.isHostile(b.owner, pr.owner)) continue;
      const dx = pr.x - bx, dy = pr.y - by;
      let d = dx * dx + dy * dy;
      if (d > R2 && pr.type === 'warhead' && pr.dur - pr.t <= WARHEAD.terminal) {
        const ex = pr.tx - bx, ey = pr.ty - by;
        d = ex * ex + ey * ey;
      }
      if (d > R2) continue;
      const th = THREAT[pr.type] || 0;
      if (th > bp || (th === bp && d < bd)) { best = pr; bp = th; bd = d; }
    }
    if (!best) continue;
    b.cd = SAM.reload(b.level);
    const ok = game.rand() < interceptChance(best.type, owner.research.aa);
    const aimAt = interceptPoint(best, bx, by, R);
    game.emit({ k: 'samShot', id: b.id, x: bx, y: by, tx: aimAt.x, ty: aimAt.y, hit: ok });
    if (!ok) continue;
    best.intercepted = true;
    hit = true;
    const at = interceptPoint(best, bx, by, R);
    game.emit({ k: 'intercept', x: at.x, y: at.y, kind: best.type, by: b.owner, owner: best.owner });
    game.msg(b.owner, `ПВО сбила цель: ${strikeName(best.type)}`, 'good');
    if (P[best.owner] && P[best.owner].alive) game.msg(best.owner, `${owner.name}: ПВО перехватила ваш удар`, 'danger');
  }
  if (hit) s.projectiles = s.projectiles.filter((pr) => !pr.intercepted);
}

function droneHit(game, pr) {
  const s = game.s;
  const i = game.tileAt(pr.tx, pr.ty);
  const o = i >= 0 ? s.owner[i] - 1 : -1;
  game.emit({ k: 'impact', kind: pr.type, x: pr.tx, y: pr.ty, r: STRIKES.drone.r, owner: pr.owner });
  if (o < 0 || o === pr.owner || !game.isHostile(pr.owner, o)) return;
  const d = s.players[o];
  const k = game.killTroops(o, Math.min(d.troops, STRIKES.drone.killPerLevel * Math.max(1, pr.lvl)), pr.owner);
  if (k > 0) game.msg(o, `Удар БПЛА: потеряно ${Math.round(k)} войск`, 'danger');
}

function pointHit(game, pr) {
  const b = game.buildingById(pr.targetBuilding);
  game.emit({ k: 'impact', kind: pr.type, x: pr.tx, y: pr.ty, r: 1, owner: pr.owner });
  if (!b || b.owner === pr.owner || !game.isHostile(pr.owner, b.owner)) return;
  game.destroyBuilding(b, pr.owner);
}

export function nukeArea(game, pr, r, selective) {
  const s = game.s, P = s.players, own = s.owner, W = game.W, H = game.H;
  const by = pr.owner;
  const spare = (o) => o === by || (selective && !game.isHostile(by, o));
  const dens = P.map((q) => q.troops / Math.max(1, q.tiles));
  const lost = new Float64Array(P.length);
  const cx = Math.floor(pr.tx), cy = Math.floor(pr.ty), r2 = r * r;
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= H) continue;
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const x = cx + dx;
      if (x < 0 || x >= W) continue;
      const i = y * W + x;
      if (!game.isLandTile(i)) continue;
      const o = own[i] - 1;
      if (o >= 0) {
        if (spare(o)) continue;
        lost[o]++;
        game.setOwner(i, -1);
      }
      game.setFallout(i, FALLOUT_TICKS);
    }
  }
  const sunk = new Float64Array(P.length);
  sinkUnitsIn(game, pr.tx, pr.ty, r, by, (u) => {
    if (spare(u.owner)) return false;
    if (u.owner >= 0 && u.owner < sunk.length) sunk[u.owner]++;
    return true;
  });
  for (const q of P) {
    const n = lost[q.id];
    if (n > 0) {
      q.stats.tilesLost += n;
      game.killTroops(q.id, Math.min(q.troops, n * dens[q.id] * NUKE_TROOP_LOSS), by);
      if (q.id !== by && q.alive && pr.type !== 'warhead') game.msg(q.id, `Ядерный удар! Потеряно ${n} клеток`, 'danger');
    }
    if (selective || q.id === by || (!n && !sunk[q.id])) continue;
    const t = game.relation(by, q.id).type;
    if ((t === 'alliance' || t === 'pact') && P[by] && P[by].alive) game.breakRelation(by, q.id, true);
  }
  game.emit({ k: 'nuke', x: pr.tx, y: pr.ty, r, kind: pr.type, owner: by });
  game.emit({ k: 'impact', kind: pr.type, x: pr.tx, y: pr.ty, r, owner: by });
  return lost;
}

export const megaCell = () => Math.max(1, Math.floor(Math.sqrt(WARHEAD.perTiles)));

const SPREAD = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];

export function megaTargets(game, pid) {
  const s = game.s, W = game.W, H = game.H, own = s.owner, P = s.players;
  const vic = hostileVictims(game, pid);
  if (!vic.length) return [];
  const G = megaCell();
  const gw = Math.ceil(W / G), gh = Math.ceil(H / G), C = gw * gh;
  const slot = new Int32Array(P.length).fill(-1);
  vic.forEach((q, k) => { slot[q] = k; });
  const per = new Int32Array(vic.length * C);
  const land = game.landList;
  for (let k = 0; k < land.length; k++) {
    const i = land[k];
    const o = own[i];
    if (!o) continue;
    const v = slot[o - 1];
    if (v < 0) continue;
    const x = i % W, y = (i - x) / W;
    per[v * C + Math.floor(y / G) * gw + Math.floor(x / G)]++;
  }
  const center = (c, k) => {
    const gx = c % gw, gy = (c - gx) / gw;
    const x0 = gx * G, y0 = gy * G, x1 = Math.min(W, x0 + G), y1 = Math.min(H, y0 + G);
    const [ox, oy] = SPREAD[k % SPREAD.length];
    const d = Math.floor(G / 3);
    const x = Math.min(W - 1, Math.max(0, Math.floor((x0 + x1 - 1) / 2) + ox * d));
    const y = Math.min(H - 1, Math.max(0, Math.floor((y0 + y1 - 1) / 2) + oy * d));
    return { x: x + 0.5, y: y + 0.5 };
  };
  const out = [];
  const count = new Int32Array(vic.length);
  for (let c = 0; c < C; c++) {
    let best = -1, bn = 0;
    for (let v = 0; v < vic.length; v++) {
      const n = per[v * C + c];
      if (n > bn) { bn = n; best = v; }
    }
    if (best < 0) continue;
    out.push({ pid: vic[best], ...center(c, 0) });
    count[best]++;
  }
  for (let v = 0; v < vic.length; v++) {
    if (count[v] >= WARHEAD.min) continue;
    const cells = [];
    for (let c = 0; c < C; c++) if (per[v * C + c] > 0) cells.push(c);
    cells.sort((a, b) => per[v * C + b] - per[v * C + a] || a - b);
    for (let k = 0; count[v] < WARHEAD.min; k++) {
      const c = cells[k % cells.length];
      out.push({ pid: vic[v], ...center(c, 1 + Math.floor(k / cells.length)) });
      count[v]++;
    }
  }
  return out;
}

export function warheadFlight(sx, sy, tx, ty, k) {
  const dx = tx - sx, dy = ty - sy;
  const base = Math.ceil(Math.sqrt(dx * dx + dy * dy) / WARHEAD.speed);
  return Math.min(WARHEAD.maxFlight, Math.max(WARHEAD.minFlight, base)) + ((k * 7) % WARHEAD.stagger);
}

function splitMega(game, pr, spawned) {
  const s = game.s, P = s.players;
  const targets = megaTargets(game, pr.owner);
  const per = new Int32Array(P.length);
  targets.forEach((t, k) => {
    const dur = warheadFlight(pr.x, pr.y, t.x, t.y, k);
    spawned.push(makeProjectile(game, pr.owner, 'warhead', pr.x, pr.y, t.x, t.y, { victim: t.pid, sel: 1, from: pr.from, dur }));
    per[t.pid]++;
  });
  game.emit({ k: 'impact', kind: 'mega', x: pr.x, y: pr.y, r: 0, owner: pr.owner, warheads: targets.length });
  for (const q of P) {
    if (per[q.id] > 0 && q.alive) game.msg(q.id, `«Судный день»: на вашу страну летят ${per[q.id]} ядерных боеголовок!`, 'danger');
  }
  if (P[pr.owner]) game.msg(pr.owner, `Мегабомба распалась на ${targets.length} боеголовок`, 'info');
}

function impact(game, pr, spawned) {
  switch (pr.type) {
    case 'drone': droneHit(game, pr); break;
    case 'kamikaze':
    case 'cruise': pointHit(game, pr); break;
    case 'atom':
    case 'hbomb': nukeArea(game, pr, STRIKES[pr.type].r, false); break;
    case 'warhead': nukeArea(game, pr, WARHEAD.r, true); break;
    case 'mega': splitMega(game, pr, spawned); break;
    default: break;
  }
}

function fly(game) {
  const s = game.s;
  const list = s.projectiles;
  const keep = [], spawned = [];
  for (const pr of list) {
    if (pr.intercepted) continue;
    pr.t++;
    const k = pr.t >= pr.dur ? 1 : pr.t / pr.dur;
    pr.x = pr.sx + (pr.tx - pr.sx) * k;
    pr.y = pr.sy + (pr.ty - pr.sy) * k;
    if (pr.t < pr.dur) keep.push(pr);
    else impact(game, pr, spawned);
  }
  s.projectiles = spawned.length ? keep.concat(spawned) : keep;
}

export function tickStrikes(game) {
  const s = game.s;
  if (s.phase !== 'play') return;
  reload(game);
  if (!s.projectiles.length) return;
  if (s.tick % SAM.every === 0) samDefense(game);
  fly(game);
}

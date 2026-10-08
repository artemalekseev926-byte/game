import { ECON, TERRAIN_COST, TERRAIN_DEF, TICKS_PER_SEC } from './config.js';

const NO_BORDER = 'Нет общей границы — используйте высадку';
const KEEP = 0, END = 1, DROP = 2;

export const spawnTicks = (s) => s.settings.spawnSeconds * TICKS_PER_SEC;

export const INTENTS = {
  spawn: { phase: 'spawn', check: checkSpawn, run: runSpawn },
  attack: { check: checkAttack, run: runAttack },
};

function clampRatio(r) {
  const v = Number(r);
  if (!Number.isFinite(v)) return 0.3;
  return Math.min(1, Math.max(0.01, v));
}

function spawnError(game, pid, i) {
  const s = game.s, W = game.W;
  if (i < 0) return 'Точка вне карты';
  if (!game.isLandTile(i)) return 'Выберите клетку суши';
  const o = s.owner[i];
  if (o && o !== pid + 1) return 'Эта земля уже занята';
  if (s.fallout[i]) return 'Эта земля заражена';
  const x = i % W, y = (i - x) / W;
  const md = ECON.spawnMinDist * ECON.spawnMinDist;
  for (const q of s.players) {
    if (q.id === pid || q.capital < 0) continue;
    const cx = q.capital % W, cy = (q.capital - cx) / W;
    if ((cx - x) * (cx - x) + (cy - y) * (cy - y) < md) return 'Слишком близко к другому игроку';
  }
  return null;
}

function checkSpawn(game, pid, cmd) {
  return spawnError(game, pid, game.tileAt(cmd.x, cmd.y));
}

function clearSpawn(game, pid) {
  const p = game.s.players[pid];
  if (p.capital < 0) return;
  const W = game.W, R = ECON.spawnRadius + 1;
  const cx = p.capital % W, cy = (p.capital - cx) / W;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const i = game.tileAt(cx + dx, cy + dy);
      if (i >= 0 && game.s.owner[i] === pid + 1) game.setOwner(i, -1);
    }
  }
  p.capital = -1;
}

function claimDisk(game, pid, i) {
  const s = game.s, W = game.W, R = ECON.spawnRadius;
  const cx = i % W, cy = (i - cx) / W;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy > R * R) continue;
      const j = game.tileAt(cx + dx, cy + dy);
      if (j < 0 || !game.isLandTile(j) || s.owner[j] || s.fallout[j]) continue;
      game.setOwner(j, pid);
    }
  }
}

export function placeSpawn(game, pid, i) {
  const p = game.s.players[pid];
  clearSpawn(game, pid);
  claimDisk(game, pid, i);
  p.capital = i;
  p.spawned = true;
  game.markDirty(i);
}

function runSpawn(game, pid, cmd) {
  placeSpawn(game, pid, game.tileAt(cmd.x, cmd.y));
}

export function pickSpawn(game, pid, tries = 96) {
  const s = game.s, W = game.W, land = game.landList;
  if (!land.length) return -1;
  const caps = [];
  for (const q of s.players) if (q.id !== pid && q.capital >= 0) caps.push(q.capital % W, Math.floor(q.capital / W));
  const minD = ECON.spawnMinDist * ECON.spawnMinDist;
  let best = -1, bestScore = -1, fallback = -1, fbScore = -1;
  for (let t = 0; t < tries; t++) {
    const i = land[Math.floor(game.rand() * land.length)];
    if (s.owner[i] || s.fallout[i]) continue;
    const x = i % W, y = (i - x) / W;
    let d = 1e12;
    for (let k = 0; k < caps.length; k += 2) {
      const dd = (caps[k] - x) * (caps[k] - x) + (caps[k + 1] - y) * (caps[k + 1] - y);
      if (dd < d) d = dd;
    }
    const size = game.landSizes[game.landId[i]];
    const sizeMul = size >= 2000 ? 1 : size >= 300 ? 0.6 : 0.15;
    const score = Math.sqrt(Math.min(d, 640000)) * sizeMul;
    if (d >= minD) {
      if (score > bestScore) { bestScore = score; best = i; }
    } else if (score > fbScore) { fbScore = score; fallback = i; }
  }
  if (best >= 0) return best;
  if (fallback >= 0) return fallback;
  for (let k = 0; k < land.length; k++) if (!s.owner[land[k]] && !s.fallout[land[k]]) return land[k];
  return -1;
}

function finishSpawn(game) {
  const s = game.s;
  for (const p of s.players) {
    if (!p.alive || p.spawned) continue;
    const i = pickSpawn(game, p.id);
    if (i >= 0) placeSpawn(game, p.id, i);
  }
  s.phase = 'play';
  game.emit({ k: 'phase', phase: 'play' });
  game.msg(-1, 'Места выбраны — в бой!', 'good');
}

export function bordersByLand(game, pid, i) {
  if (!game.isLandTile(i) || !game.borders[pid]) return false;
  const s = game.s, own = s.owner, W = game.W, N = game.N;
  const lm = game.landId[i];
  if (!game.ownsOnLandmass(pid, lm)) return false;
  const tOwner = own[i];
  if (tOwner === pid + 1) return false;
  const fo = s.fallout;
  const okTile = (j) => own[j] === tOwner && game.landId[j] === lm && (tOwner === 0 || fo[j] === 0);
  for (const j of game.borders[pid]) {
    if (game.landId[j] !== lm) continue;
    const x = j % W;
    if ((x > 0 && okTile(j - 1)) || (x < W - 1 && okTile(j + 1)) || (j >= W && okTile(j - W)) || (j < N - W && okTile(j + W))) return true;
  }
  return false;
}

function checkAttack(game, pid, cmd) {
  const s = game.s;
  const i = game.tileAt(cmd.x, cmd.y);
  if (i < 0) return 'Точка вне карты';
  if (!game.isLandTile(i)) return 'Здесь вода — выберите сушу';
  const target = s.owner[i] - 1;
  if (target === pid) return 'Это ваша территория';
  if (target >= 0 && !game.isHostile(pid, target)) return 'Нельзя нападать на союзника или партнёра по пакту';
  const troops = Math.floor(s.players[pid].troops * clampRatio(cmd.ratio));
  if (troops < 1) return 'Недостаточно войск';
  if (!bordersByLand(game, pid, i)) return NO_BORDER;
  return null;
}

function runAttack(game, pid, cmd) {
  const s = game.s, p = s.players[pid];
  const i = game.tileAt(cmd.x, cmd.y);
  const troops = Math.floor(p.troops * clampRatio(cmd.ratio));
  p.troops -= troops;
  startAttack(game, pid, s.owner[i] - 1, troops, -1);
}

export function startAttack(game, pid, target, troops, landing = -1) {
  const s = game.s;
  troops = Math.max(0, Number(troops) || 0);
  if (landing < 0) {
    for (const a of s.attacks) {
      if (a.attacker === pid && a.target === target && a.landing < 0 && !a.local) {
        a.troops += troops;
        return a;
      }
    }
  }
  const a = { id: s.nextId++, attacker: pid, target, troops, landing, local: landing >= 0, front: [], scan: 0 };
  if (landing < 0) rescan(game, a);
  s.attacks.push(a);
  if (target >= 0 && s.players[target]) {
    game.msg(target, `${s.players[pid].name} нападает на вас!`, 'danger');
  }
  return a;
}

function rescan(game, a) {
  const s = game.s, own = s.owner, fo = s.fallout, terrain = game.map.terrain, W = game.W, N = game.N;
  const tOwner = a.target + 1;
  const mark = game.mark, st = game.nextStamp();
  const out = [];
  const add = (j) => {
    if (own[j] !== tOwner || terrain[j] < 2 || mark[j] === st) return;
    if (tOwner && fo[j]) return;
    mark[j] = st;
    out.push(j);
  };
  const border = game.borders[a.attacker];
  if (border) {
    for (const j of border) {
      const x = j % W;
      if (x > 0) add(j - 1);
      if (x < W - 1) add(j + 1);
      if (j >= W) add(j - W);
      if (j < N - W) add(j + W);
    }
  }
  out.sort((p, q) => p - q);
  a.front = out;
  a.scan = s.tick + ECON.frontRescan;
}

function nbCount(own, W, N, i, v) {
  const x = i % W;
  let n = 0;
  if (x > 0 && own[i - 1] === v) n++;
  if (x < W - 1 && own[i + 1] === v) n++;
  if (i >= W && own[i - W] === v) n++;
  if (i < N - W && own[i + W] === v) n++;
  return n;
}

function gather(game, a, k, out) {
  const s = game.s, own = s.owner, fo = s.fallout, terrain = game.map.terrain, W = game.W, N = game.N;
  const tOwner = a.target + 1, me = a.attacker + 1;
  const F = a.front;
  const mark = game.mark, st = game.nextStamp();
  const valid = (i) => own[i] === tOwner && terrain[i] >= 2 && (tOwner === 0 || fo[i] === 0) && nbCount(own, W, N, i, me) > 0;
  out.length = 0;
  if (F.length <= k) {
    let w = 0;
    for (let r = 0; r < F.length; r++) {
      const i = F[r];
      if (mark[i] === st || !valid(i)) continue;
      mark[i] = st;
      F[w++] = i;
      out.push(i);
    }
    F.length = w;
  } else {
    for (let t = 0; t < k && F.length; t++) {
      const r = Math.floor(game.rand() * F.length);
      const i = F[r];
      if (!valid(i)) {
        F[r] = F[F.length - 1];
        F.pop();
        continue;
      }
      if (mark[i] === st) continue;
      mark[i] = st;
      out.push(i);
    }
  }
  return out;
}

function fortBonus(game, pid, i) {
  const list = game.fortList(pid);
  if (!list.length) return 1;
  const W = game.W, x = i % W, y = (i - x) / W;
  const R2 = ECON.fortRadius * ECON.fortRadius;
  let best = 1;
  for (let k = 0; k < list.length; k += 3) {
    const dx = list[k] - x, dy = list[k + 1] - y;
    if (dx * dx + dy * dy > R2) continue;
    const v = ECON.fortBonus * (1 + ECON.fortLevelBonus * (list[k + 2] - 1));
    if (v > best) best = v;
  }
  return best;
}

export function tileCost(game, attacker, target, i, atkMul, defMul) {
  const t = game.map.terrain[i];
  if (target < 0) return ECON.neutralCost * TERRAIN_COST[t] * (game.s.fallout[i] ? ECON.falloutCostMul : 1);
  const d = game.s.players[target];
  const density = d.troops / Math.max(1, d.tiles);
  const am = atkMul === undefined ? game.attackMult(attacker) : atkMul;
  const dm = defMul === undefined ? game.defenseMult(target) : defMul;
  return ((ECON.tileCost + density * ECON.densityCost) * TERRAIN_COST[t] * TERRAIN_DEF[t] * fortBonus(game, target, i) * dm) / am;
}

function capture(game, a, i, cost) {
  const s = game.s, att = s.players[a.attacker];
  a.troops -= cost;
  if (a.target >= 0) {
    const d = s.players[a.target];
    const density = d.troops / Math.max(1, d.tiles);
    const loss = Math.min(d.troops, density * ECON.defenderLoss);
    d.troops -= loss;
    att.stats.kills += loss;
    d.stats.kills += cost;
    d.stats.tilesLost++;
  }
  game.setOwner(i, a.attacker);
  att.stats.tilesCaptured++;
}

function pushNeighbors(game, a, i) {
  const s = game.s, own = s.owner, fo = s.fallout, terrain = game.map.terrain, W = game.W, N = game.N;
  const tOwner = a.target + 1, F = a.front;
  const x = i % W;
  const add = (j) => {
    if (own[j] === tOwner && terrain[j] >= 2 && (tOwner === 0 || fo[j] === 0)) F.push(j);
  };
  if (x > 0) add(i - 1);
  if (x < W - 1) add(i + 1);
  if (i >= W) add(i - W);
  if (i < N - W) add(i + W);
}

const scratch = { cands: [], b2: [], b1: [] };

function stepLanding(game, a) {
  const s = game.s, i = a.landing;
  if (!game.isLandTile(i)) return END;
  const o = s.owner[i];
  if (o === a.attacker + 1) return END;
  a.target = o - 1;
  if (a.target >= 0) {
    const d = s.players[a.target];
    if (!d.alive || !game.isHostile(a.attacker, a.target)) return END;
  }
  const cost = tileCost(game, a.attacker, a.target, i);
  if (a.troops < cost) return END;
  capture(game, a, i, cost);
  a.landing = -1;
  a.local = true;
  a.front = [];
  pushNeighbors(game, a, i);
  a.scan = s.tick + ECON.frontRescan;
  return KEEP;
}

function stepAttack(game, a) {
  const s = game.s, P = s.players;
  const att = P[a.attacker];
  if (!att || !att.alive) return DROP;
  if (a.target >= 0) {
    const d = P[a.target];
    if (!d || !d.alive || !game.isHostile(a.attacker, a.target)) return END;
  }
  if (a.troops < 1) return END;
  if (a.landing >= 0) return stepLanding(game, a);
  if (!a.local && s.tick >= a.scan) rescan(game, a);
  const speed = 1 + ECON.logisticsSpeed * att.research.logistics;
  const n = Math.max(1, Math.floor(Math.sqrt(a.troops) * ECON.captureRate * speed));
  let cands = gather(game, a, n * ECON.sampleMul, scratch.cands);
  if (!cands.length) {
    if (a.local || a.scan === s.tick + ECON.frontRescan) return END;
    rescan(game, a);
    cands = gather(game, a, n * ECON.sampleMul, scratch.cands);
    if (!cands.length) return END;
  }
  const own = s.owner, W = game.W, N = game.N, me = a.attacker + 1;
  const b2 = scratch.b2, b1 = scratch.b1;
  b2.length = 0; b1.length = 0;
  for (let k = 0; k < cands.length; k++) {
    const i = cands[k];
    const c = nbCount(own, W, N, i, me);
    if (c >= 2) b2.push(c * 16777216 + k);
    else b1.push(i);
  }
  if (b2.length > 1) b2.sort((p, q) => (q >> 0) - (p >> 0) || 0);
  const atkMul = a.target >= 0 ? game.attackMult(a.attacker) : 1;
  const defMul = a.target >= 0 ? game.defenseMult(a.target) : 1;
  let taken = 0;
  for (let k = 0; k < b2.length && taken < n; k++) {
    const i = cands[b2[k] % 16777216];
    if (own[i] !== a.target + 1) continue;
    const cost = tileCost(game, a.attacker, a.target, i, atkMul, defMul);
    if (a.troops < cost) return END;
    capture(game, a, i, cost);
    pushNeighbors(game, a, i);
    taken++;
  }
  let m = b1.length;
  while (taken < n && m > 0) {
    const r = Math.floor(game.rand() * m);
    const i = b1[r];
    b1[r] = b1[m - 1];
    m--;
    if (own[i] !== a.target + 1) continue;
    const cost = tileCost(game, a.attacker, a.target, i, atkMul, defMul);
    if (a.troops < cost) return END;
    capture(game, a, i, cost);
    pushNeighbors(game, a, i);
    taken++;
  }
  return KEEP;
}

function tickAttacks(game) {
  const s = game.s;
  if (!s.attacks.length) return;
  const keep = [];
  for (let k = 0; k < s.attacks.length; k++) {
    const a = s.attacks[k];
    const r = stepAttack(game, a);
    if (r === KEEP) { keep.push(a); continue; }
    if (r === END) {
      const p = s.players[a.attacker];
      if (p && p.alive && a.troops > 0) p.troops += a.troops;
    }
    a.troops = 0;
  }
  if (keep.length !== s.attacks.length) s.attacks = keep;
}

export function cancelAttacks(game, pred, refund = true) {
  const s = game.s;
  const keep = [];
  for (const a of s.attacks) {
    if (!pred(a)) { keep.push(a); continue; }
    const p = s.players[a.attacker];
    if (refund && p && p.alive && a.troops > 0) p.troops += a.troops;
    a.troops = 0;
  }
  if (keep.length !== s.attacks.length) s.attacks = keep;
}

function tickFallout(game) {
  const s = game.s;
  if (s.tick % 10 !== 0 || !game.falloutList.length) return;
  const L = game.falloutList, fo = s.fallout;
  let w = 0;
  for (let r = 0; r < L.length; r++) {
    const i = L[r];
    const v = fo[i];
    if (v <= 10) {
      if (v) game.markDirty(i);
      fo[i] = 0;
    } else {
      fo[i] = v - 10;
      L[w++] = i;
    }
  }
  L.length = w;
}

function enclavesOf(game, pid, out) {
  const s = game.s, own = s.owner, terrain = game.map.terrain, W = game.W, N = game.N;
  const me = pid + 1;
  const vis = game.mark, big = game.mark2;
  const st = game.nextStamp();
  const max = ECON.enclaveMax;
  for (const start of game.borders[pid]) {
    if (vis[start] === st) continue;
    vis[start] = st;
    const comp = [start];
    let large = false, water = false, other = -2;
    const look = (j) => {
      const o = own[j];
      if (o === me) {
        if (vis[j] === st) {
          if (big[j] === st) large = true;
          return;
        }
        vis[j] = st;
        comp.push(j);
        if (comp.length >= max) large = true;
      } else if (terrain[j] < 2) water = true;
      else if (o === 0) other = -1;
      else if (other === -2) other = o - 1;
      else if (other !== o - 1) other = -1;
    };
    for (let h = 0; h < comp.length && !large; h++) {
      const i = comp[h], x = i % W;
      if (x > 0) look(i - 1);
      if (x < W - 1) look(i + 1);
      if (i >= W) look(i - W);
      if (i < N - W) look(i + W);
    }
    if (large) {
      for (const i of comp) big[i] = st;
      continue;
    }
    if (water || other < 0) continue;
    if (!s.players[other].alive || !game.isHostile(pid, other)) continue;
    out.push(other, comp);
  }
}

function tickEnclaves(game) {
  const s = game.s, E = ECON.enclaveEvery;
  for (const p of s.players) {
    if (!p.alive || !p.tiles || (s.tick + p.id * 7) % E !== 0) continue;
    const found = [];
    enclavesOf(game, p.id, found);
    for (let k = 0; k < found.length; k += 2) {
      const q = found[k], comp = found[k + 1];
      for (const i of comp) game.setOwner(i, q);
      s.players[q].stats.tilesCaptured += comp.length;
      p.stats.tilesLost += comp.length;
      game.msg(p.id, `Окружённый анклав (${comp.length} кл.) отошёл к ${s.players[q].name}`, 'danger');
      game.msg(q, `Окружённый анклав ${p.name} (${comp.length} кл.) присоединён`, 'good');
    }
  }
}

export function tickTerritory(game) {
  const s = game.s;
  if (s.phase === 'spawn') {
    if (s.tick + 1 >= spawnTicks(s)) finishSpawn(game);
    return;
  }
  if (s.phase !== 'play') return;
  tickAttacks(game);
  tickFallout(game);
  tickEnclaves(game);
}

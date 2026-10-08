import { UNITS, UNIT_KEYS, BUILDINGS, RESEARCH, researchCost, DRONES, droneRange, missileRange, MISSILE, DIFFICULTY } from './config.js';
import { troopCount } from './game.js';

const RESEARCH_PLAN = ['econ', 'inf', 'armor', 'fort', 'econ', 'drone', 'aa', 'logistics', 'armor', 'art', 'missile', 'econ', 'inf', 'drone', 'aa', 'armor', 'missile', 'econ', 'drone', 'fort', 'art', 'inf', 'missile', 'armor', 'aa', 'econ', 'logistics', 'art', 'inf', 'armor', 'art', 'fort', 'logistics', 'art'];

export function runAI(game, dt) {
  for (const pl of game.s.players) {
    if (!pl.ai || !pl.alive) continue;
    pl.aiT -= dt;
    if (pl.aiT > 0) continue;
    pl.aiT = DIFFICULTY[pl.ai].think * (0.8 + game.rand() * 0.4);
    think(game, pl.id);
  }
}

function think(game, pid) {
  const s = game.s, map = game.map, pl = s.players[pid];
  const diff = DIFFICULTY[pl.ai];
  const owned = [];
  s.provs.forEach((P, i) => { if (P.o === pid) owned.push(i); });
  if (!owned.length) return;

  const isBorder = (i) => map.provinces[i].adj.some((n) => s.provs[n].o !== pid);
  const enemyThreat = (i) => {
    let t = 0;
    for (const n of map.provinces[i].adj) {
      const o = s.provs[n].o;
      if (o >= 0 && o !== pid) t += game.attackPower(o, s.provs[n].t);
    }
    return t;
  };
  const border = owned.filter(isBorder);
  const net = () => pl.income - pl.upkeep;

  let saving = false;
  if (!pl.rs) {
    const done = {};
    for (const k of RESEARCH_PLAN) {
      done[k] = (done[k] || 0) + 1;
      if (pl.research[k] < done[k] && pl.research[k] < RESEARCH[k].max) {
        if (pl.money > researchCost(k, pl.research[k]) * 1.4) game.command(pid, { c: 'research', k });
        else saving = owned.length > 2;
        break;
      }
    }
  }

  const factories = game.buildingCount(pid, 'factory');
  const tryBuild = (p, k, reserve = 1.2) => {
    if (game.canBuild(pid, p, k)) return false;
    if (pl.money < game.buildCost(pid, k, s.provs[p].b[k] + 1) * reserve) return false;
    return game.command(pid, { c: 'build', p, k }).ok;
  };
  const byPop = [...owned].sort((a, b) => s.provs[b].pop - s.provs[a].pop);
  let builds = 0;
  for (const p of byPop) {
    if (builds >= 2) break;
    if (s.provs[p].build) continue;
    if (factories < Math.ceil(owned.length / 3) && tryBuild(p, 'factory')) { builds++; continue; }
    if (s.provs[p].b.house < 2 && s.provs[p].pop > 30 && tryBuild(p, 'house', 1.5)) { builds++; continue; }
  }
  const threatened = border.map((p) => [p, enemyThreat(p)]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]);
  for (const [p] of threatened.slice(0, 2)) {
    if (builds >= 3) break;
    if (s.provs[p].b.fort < 2 && tryBuild(p, 'fort', 1.3)) builds++;
  }
  const enemiesHaveAir = s.players.some((o) => o.id !== pid && o.alive && (o.research.drone > 0 || o.research.missile > 0));
  if (enemiesHaveAir && byPop.length) {
    const p = byPop[Math.floor(game.rand() * Math.min(3, byPop.length))];
    if (s.provs[p].b.aa < 2) tryBuild(p, 'aa', 2);
  }
  if (pl.research.drone >= 1 && game.buildingCount(pid, 'airbase') < 1 + Math.floor(owned.length / 15)) {
    const p = (threatened[0] || [byPop[0]])[0];
    tryBuild(p, 'airbase', 1.6);
  }
  if (pl.research.missile >= 1 && game.buildingCount(pid, 'silo') < 1 + Math.floor(owned.length / 25)) tryBuild(byPop[0], 'silo', 1.8);

  const targets = threatened.length ? threatened.map((x) => x[0]) : border.length ? border : owned;
  let budget = pl.money * (saving ? 0.2 : 0.55);
  for (const p of targets.slice(0, 4)) {
    const P = s.provs[p];
    const u = P.b.factory > 0 && game.rand() < 0.6 ? (game.rand() < 0.7 ? 'tank' : 'art') : 'inf';
    const U = UNITS[u];
    const maxByUpkeep = Math.max(0, (net() - 0.5) / U.upkeep);
    const n = Math.floor(Math.min(budget / U.cost / Math.max(1, targets.length > 2 ? 2 : 1), maxByUpkeep, pl.mp / U.mp));
    if (n >= 1 && game.command(pid, { c: 'recruit', p, u, n }).ok) budget -= n * U.cost;
  }

  for (const p of border) {
    const P = s.provs[p];
    if (troopCount(P.t) < 4) continue;
    const send = { inf: Math.floor(P.t.inf * 0.85), tank: Math.floor(P.t.tank * 0.85), art: Math.floor(P.t.art * 0.85) };
    const power = game.attackPower(pid, send);
    let best = -1, bestScore = -Infinity;
    for (const n of map.provinces[p].adj) {
      const o = s.provs[n].o;
      if (o === pid) continue;
      const def = game.defensePower(n, pid, send);
      if (power < def * diff.aggression) continue;
      const value = map.provinces[n].size + s.provs[n].pop * 0.5 + s.provs[n].b.factory * 30 + (o < 0 ? 10 : 0);
      const score = value / (def + 5);
      if (score > bestScore) { bestScore = score; best = n; }
    }
    if (best >= 0) game.command(pid, { c: 'move', from: p, to: best, frac: 0.85 });
  }

  const cands = new Map();
  for (const p of border) {
    for (const n of map.provinces[p].adj) {
      if (s.provs[n].o === pid) continue;
      if (!cands.has(n)) cands.set(n, []);
      cands.get(n).push(p);
    }
  }
  let staged = 0;
  for (const [target, from] of cands) {
    if (staged >= 2 || from.length < 2) continue;
    let total = 0, hub = from[0];
    for (const p of from) {
      total += game.attackPower(pid, s.provs[p].t) * 0.85;
      if (troopCount(s.provs[p].t) > troopCount(s.provs[hub].t)) hub = p;
    }
    if (total < game.defensePower(target, pid, s.provs[hub].t) * diff.aggression * 1.1) continue;
    for (const p of from) if (p !== hub && troopCount(s.provs[p].t) >= 3) game.command(pid, { c: 'move', from: p, to: hub, frac: 0.85 });
    staged++;
  }

  for (const p of owned) {
    if (isBorder(p) || troopCount(s.provs[p].t) < 5) continue;
    const dest = nearestBorder(game, pid, p);
    if (dest >= 0) game.command(pid, { c: 'move', from: p, to: dest, frac: 1 });
  }

  const enemyProvs = [];
  s.provs.forEach((P, i) => { if (P.o >= 0 && P.o !== pid) enemyProvs.push(i); });
  if (!enemyProvs.length) return;
  for (const p of owned) {
    const P = s.provs[p];
    if (P.cd > 0) continue;
    if (P.b.airbase > 0 && pl.research.drone > 0) {
      const range = droneRange(P.b.airbase, pl.research.drone);
      const t = bestTarget(game, enemyProvs, p, range);
      if (t >= 0) {
        const d = pl.research.drone >= 3 && pl.money > 300 ? 'swarm' : pl.research.drone >= 2 && s.provs[t].b.aa > 0 ? 'kamikaze' : 'strike';
        if (pl.money > DRONES[d].cost * 2) game.command(pid, { c: 'drone', from: p, to: t, d });
      }
    }
    if (P.b.silo > 0 && pl.money > MISSILE.cost * 2.5) {
      const t = bestTarget(game, enemyProvs, p, missileRange(pl.research.missile));
      if (t >= 0) game.command(pid, { c: 'missile', from: p, to: t });
    }
  }
}

function bestTarget(game, list, from, range) {
  let best = -1, bestV = 0;
  for (const i of list) {
    if (game.dist(from, i) > range) continue;
    const P = game.s.provs[i];
    const v = troopCount(P.t) + (P.b.silo + P.b.airbase + P.b.factory) * 20;
    if (v > bestV) { bestV = v; best = i; }
  }
  return best;
}

function nearestBorder(game, pid, from) {
  const s = game.s, adj = game.map.provinces;
  const seen = new Set([from]);
  const q = [from];
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    for (const n of adj[c].adj) {
      if (seen.has(n) || s.provs[n].o !== pid) continue;
      seen.add(n);
      if (adj[n].adj.some((m) => s.provs[m].o !== pid)) return n;
      q.push(n);
    }
  }
  return -1;
}

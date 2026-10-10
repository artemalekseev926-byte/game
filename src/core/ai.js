import {
  BUILDINGS, RESEARCH, STRIKES, DIFFICULTY, ECON, SAM, researchCost, cruiseRange,
} from './config.js';
import {
  buildError, buildCost, upgradeCost, upgradeError, railError, railRoute, railCost, nearestPort,
} from './buildings.js';
import { proposeError, embargoBy } from './diplomacy.js';
import { shipCost, portShips, portShipCap, canEngage, sharedSea } from './units.js';
import { coastBodies } from './nav.js';
import { strikeError } from './strikes.js';

const PLAN = [
  ['econ', 1], ['inf', 1], ['armor', 1], ['logistics', 1], ['econ', 2], ['drone', 1], ['missile', 1], ['art', 1],
  ['inf', 2], ['fort', 1], ['naval', 1], ['armor', 2], ['econ', 3], ['nuclear', 1], ['aa', 1], ['drone', 2],
  ['logistics', 2], ['art', 2], ['inf', 3], ['armor', 3], ['econ', 4], ['missile', 2], ['nuclear', 2], ['fort', 2],
  ['aa', 2], ['armor', 4], ['inf', 4], ['art', 3], ['naval', 2], ['econ', 5], ['logistics', 3], ['drone', 3],
  ['nuclear', 3], ['armor', 5], ['inf', 5], ['art', 4], ['fort', 3], ['aa', 3], ['missile', 3], ['naval', 3], ['art', 5],
];

export const AI_PROFILES = {
  easy: {
    expand: 0.2, expandMin: 0.4, attack: 0.25, warAt: 0.8, edge: 2.0, capPush: 0.97, reserve: 0.45, warGap: 300,
    builds: 1, houseEvery: 1400, maxHouses: 8, maxFactories: 3, maxPorts: 2, airbases: 1, silos: 1,
    ships: 0.5, maxShips: 3, nukes: 0, nukeEvery: 0, maxNuclear: 0, allies: 0, betray: 0,
    boatSend: 0.15, boatLocked: 0.4, boatRange: 150, boatEvery: 600, dipEvery: 900, strikeEvery: 3,
  },
  normal: {
    expand: 0.28, expandMin: 0.3, attack: 0.3, warAt: 0.6, edge: 1.6, capPush: 0.95, reserve: 0.35, warGap: 150,
    builds: 2, houseEvery: 900, maxHouses: 16, maxFactories: 6, maxPorts: 4, airbases: 1, silos: 2,
    ships: 1, maxShips: 6, nukes: 2, nukeEvery: 900, maxNuclear: 2, allies: 1, betray: 0,
    boatSend: 0.2, boatLocked: 0.5, boatRange: 220, boatEvery: 400, dipEvery: 600, strikeEvery: 1,
  },
  hard: {
    expand: 0.33, expandMin: 0.25, attack: 0.45, warAt: 0.55, edge: 1.15, capPush: 0.9, reserve: 0.25, warGap: 40,
    builds: 3, houseEvery: 650, maxHouses: 24, maxFactories: 8, maxPorts: 5, airbases: 2, silos: 2,
    ships: 1.5, maxShips: 10, nukes: 3, nukeEvery: 450, maxNuclear: 3, allies: 1, betray: 1,
    boatSend: 0.25, boatLocked: 0.6, boatRange: 300, boatEvery: 250, dipEvery: 400, strikeEvery: 1,
  },
};

const VALUE = { silo: 9, sam: 6, airbase: 6, factory: 7, port: 6, house: 5, fort: 3 };
const SURVEY_MAX = 6000;
const COAST_PICK = 24;
const BAD_TICKS = 1200;
const OK = (r) => !!(r && r.ok);

function rnd(st) {
  let t = (st.rng = (st.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function brain(game, p) {
  let st = p.aiState;
  if (!st || typeof st !== 'object' || st.v !== 1) {
    st = {
      v: 1, rng: (Math.imul(p.id + 1, 0x9e3779b1) ^ game.s.rngState ^ 0x5bd1e995) >>> 0,
      turn: 0, war: -1, warAt: 0, bad: [], prop: [], dipAt: 0, boatAt: 0, nukeAt: 0, boats: 0, ships: 0,
    };
    st.agg = Math.round((0.85 + rnd(st) * 0.35) * 100) / 100;
    st.sea = Math.round((0.7 + rnd(st) * 0.7) * 100) / 100;
    p.aiState = st;
  }
  return st;
}

export const profileOf = (p) => AI_PROFILES[p && p.ai] || AI_PROFILES.normal;

export function runAI(game) {
  const s = game.s;
  if (s.phase !== 'play') return;
  for (const p of s.players) {
    if (!p.ai || !p.alive) continue;
    const d = DIFFICULTY[p.ai] || DIFFICULTY.normal;
    if ((s.tick + p.id * 3) % d.think !== 0) continue;
    try {
      aiTurn(game, p.id);
    } catch (e) {
      game.aiError = e;
    }
  }
}

export function aiTurn(game, pid) {
  const p = game.s.players[pid];
  if (!p || !p.alive || game.s.phase !== 'play') return;
  const prof = profileOf(p);
  const st = brain(game, p);
  st.turn++;
  if (!p.tiles) return;
  const v = survey(game, p, st);
  military(game, p, st, v, prof);
  const phase = st.turn % 4;
  if (phase === 0 || phase === 2) economy(game, p, st, v, prof, phase === 2);
  else if (phase === 1) {
    if ((st.turn >> 2) % 2 === 0 || !boats(game, p, st, v, prof)) navy(game, p, st, v, prof);
  } else {
    if ((st.turn >> 2) % prof.strikeEvery === 0) strikes(game, p, st, v, prof);
    diplomacy(game, p, st, v, prof);
  }
}

const hashTile = (i, salt) => {
  let h = Math.imul(i ^ salt, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  return (h ^ (h >>> 13)) >>> 0;
};

function survey(game, p, st) {
  const s = game.s, own = s.owner, fo = s.fallout, terr = game.map.terrain, oc = game.oceanCoast;
  const W = game.W, N = game.N, P = s.players.length, me = p.id + 1;
  const border = game.playerBorder(p.id);
  const L = border.size;
  const cnt = new Int32Array(P + 1);
  const tile = new Int32Array(P + 1).fill(-1);
  const key = new Float64Array(P + 1).fill(Infinity);
  const ck = [], ct = [];
  let cmax = -1, cmaxK = -1;
  let minX = W, minY = game.H, maxX = 0, maxY = 0, sx = 0, sy = 0, n = 0, coastN = 0;
  const step = L > SURVEY_MAX ? Math.ceil(L / SURVEY_MAX) : 1;
  const pick = st.turn % step;
  const salt = Math.imul(st.turn + 1, 0x632be5ab) ^ (p.id * 0x1b873593);
  const look = (j) => {
    if (terr[j] < 2) return;
    const o = own[j];
    if (o === me || (o && fo[j])) return;
    cnt[o]++;
    const h = hashTile(j, salt);
    if (h < key[o] || (h === key[o] && j < tile[o])) { key[o] = h; tile[o] = j; }
  };
  for (const i of border) {
    if (step > 1 && hashTile(i, 0x51ed27) % step !== pick) continue;
    const x = i % W, y = (i - x) / W;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    sx += x; sy += y; n++;
    if (oc[i]) {
      coastN++;
      const h = hashTile(i, salt ^ 0x7f4a7c15);
      if (ck.length < COAST_PICK) {
        ck.push(h); ct.push(i);
        if (h > cmax || (h === cmax && i > ct[cmaxK])) { cmax = h; cmaxK = ck.length - 1; }
      } else if (h < cmax || (h === cmax && i < ct[cmaxK])) {
        ck[cmaxK] = h; ct[cmaxK] = i;
        cmax = -1;
        for (let k = 0; k < ck.length; k++) if (ck[k] > cmax || (ck[k] === cmax && ct[k] > ct[cmaxK])) { cmax = ck[k]; cmaxK = k; }
      }
    }
    if (x > 0) look(i - 1);
    if (x < W - 1) look(i + 1);
    if (i >= W) look(i - W);
    if (i < N - W) look(i + W);
  }
  const coast = ct.slice().sort((a, b) => a - b);
  const inc = new Float64Array(P), out = new Float64Array(P + 1);
  let incoming = 0;
  for (const a of s.attacks) {
    if (a.target === p.id && a.attacker !== p.id) { inc[a.attacker] += a.troops; incoming += a.troops; }
    if (a.attacker === p.id) out[a.target + 1] += a.troops;
  }
  for (const u of s.units) {
    if (u.type === 'transport' && u.tp === p.id && u.owner !== p.id) { inc[u.owner] += u.troops || 0; incoming += u.troops || 0; }
  }
  const lead = leaderOf(s);
  let landBorder = 0, hostileLand = 0;
  for (let q = 0; q <= P; q++) {
    landBorder += cnt[q];
    if (q > 0 && cnt[q] && q !== me && s.players[q - 1].alive && game.isHostile(p.id, q - 1)) hostileLand += cnt[q];
  }
  return {
    cnt, tile, coast, coastN, minX, minY, maxX, maxY,
    cx: n ? sx / n : (p.capital >= 0 ? p.capital % W : W / 2),
    cy: n ? sy / n : (p.capital >= 0 ? Math.floor(p.capital / W) : game.H / 2),
    inc, out, incoming, landBorder, hostileLand, lead, dom: dominant(game, lead) && lead.id !== p.id,
  };
}

function leaderOf(s) {
  let best = null, second = null;
  for (const q of s.players) {
    if (!q.alive) continue;
    if (!best || q.tiles > best.tiles) { second = best; best = q; } else if (!second || q.tiles > second.tiles) second = q;
  }
  return { id: best ? best.id : -1, tiles: best ? best.tiles : 0, second: second ? second.tiles : 0 };
}

const atkPower = (game, q) => Math.max(1, q.troops) * game.attackMult(q.id);
const defPower = (game, q) => Math.max(1, q.troops) * game.defenseMult(q.id);

function attackAt(game, pid, i, ratio) {
  const W = game.W;
  return OK(game.apply(pid, { c: 'attack', x: i % W, y: Math.floor(i / W), ratio: Math.min(1, Math.max(0.01, ratio)) }));
}

function military(game, p, st, v, prof) {
  const s = game.s, T = p.troops, M = Math.max(1, p.maxTroops);
  const fill = T / M;
  const danger = v.incoming > 0;
  if (st.war >= 0) {
    const q = s.players[st.war];
    if (!q || !q.alive || !game.isHostile(p.id, st.war) || (v.cnt[st.war + 1] === 0 && s.tick - st.warAt > 600)) st.war = -1;
  }
  const neutral = v.cnt[0];
  if (neutral > 0 && fill >= prof.expandMin && v.out[0] < T * 0.12) {
    let r = prof.expand + (fill > 0.85 ? 0.15 : 0);
    if (danger) r *= 0.6;
    attackAt(game, p.id, v.tile[0], r);
  }
  const pick = pickWar(game, p, st, v, prof);
  if (!pick) return;
  const q = pick.q;
  const agg = st.agg || 1;
  const scarce = neutral === 0 || neutral * 12 < v.landBorder;
  const capped = p.troops / M >= prof.capPush;
  const counter = v.inc[q] > 0 && pick.pow >= 0.9;
  const strong = pick.pow * agg >= prof.edge * (scarce ? 1 : 2.5);
  if (!(capped || counter || (strong && p.troops / M >= prof.warAt))) return;
  if (!capped && !counter && s.tick - (st.atkAt || 0) < prof.warGap / agg) return;
  if (v.out[q + 1] > p.troops * (capped ? 0.6 : 0.35)) return;
  let r = prof.attack * agg * (pick.pow >= 3 ? 1.2 : 1) + (capped ? 0.1 : 0);
  if (danger && v.inc[q] === 0) r *= 0.7;
  if (!capped) r = Math.min(r, (p.troops - M * prof.reserve * (danger ? 1.4 : 1)) / Math.max(1, p.troops));
  if (r < 0.05) return;
  if (attackAt(game, p.id, v.tile[q + 1], r)) {
    st.atkAt = s.tick;
    if (st.war !== q) { st.war = q; st.warAt = s.tick; }
  }
}

function pickWar(game, p, st, v, prof) {
  const s = game.s, P = s.players, T = Math.max(1, p.troops);
  const atk = game.attackMult(p.id);
  const lead = v.lead;
  let best = null, bs = 0;
  for (let q = 0; q < P.length; q++) {
    if (q === p.id || v.cnt[q + 1] === 0 || v.tile[q + 1] < 0) continue;
    const Q = P[q];
    if (!Q.alive || !game.isHostile(p.id, q)) continue;
    const def = game.defenseMult(q);
    const pow = (T * atk) / Math.max(1, Q.troops * def);
    const dens = Q.troops / Math.max(1, Q.tiles);
    const cost = ((ECON.tileCost + dens * ECON.densityCost) * def * 1.3) / atk;
    const gain = (T * prof.attack) / cost;
    if (gain < 8) continue;
    let sc = pow * (1 + Math.min(1, gain / 400));
    if (st.war === q) sc *= 1.5;
    if (v.inc[q] > 0) sc *= 1.4;
    if (Q.traitorUntil > s.tick) sc *= 1.2;
    if (lead.id === q && lead.tiles > p.tiles * 1.3 && prof.allies > 0) sc *= v.dom ? 1.7 : 1.3;
    if (Q.tiles < p.tiles * 0.3) sc *= 1.2;
    if (sc > bs) { bs = sc; best = { q, pow, gain }; }
  }
  return best;
}

function mineByType(game, pid) {
  const by = { house: [], factory: [], port: [], fort: [], sam: [], airbase: [], silo: [] };
  for (const b of game.s.buildings) if (b.owner === pid && by[b.type]) by[b.type].push(b);
  return by;
}

function depthAt(game, me, x, y, d) {
  const own = game.s.owner, W = game.W, H = game.H;
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const xx = x + dx * d, yy = y + dy * d;
      if (xx >= 0 && yy >= 0 && xx < W && yy < H && own[yy * W + xx] === me) n++;
    }
  }
  return n;
}

function tryBuild(game, pid, type, x, y) {
  if (buildError(game, pid, type, x, y)) return false;
  return OK(game.apply(pid, { c: 'build', type, x, y }));
}

function placeInterior(game, p, st, v, type) {
  const W = game.W, own = game.s.owner, me = p.id + 1;
  const bw = v.maxX - v.minX + 1, bh = v.maxY - v.minY + 1;
  const d = Math.max(2, Math.min(10, Math.floor(Math.sqrt(p.tiles) / 6)));
  let fb = -1, fd = 4;
  for (let k = 0; k < 48; k++) {
    const x = v.minX + Math.floor(rnd(st) * bw), y = v.minY + Math.floor(rnd(st) * bh);
    const i = y * W + x;
    if (own[i] !== me) continue;
    const dd = depthAt(game, me, x, y, d);
    if (dd < 8) {
      if (dd > fd && !buildError(game, p.id, type, x, y)) { fd = dd; fb = i; }
      continue;
    }
    if (tryBuild(game, p.id, type, x, y)) return true;
  }
  return fb >= 0 && tryBuild(game, p.id, type, fb % W, Math.floor(fb / W));
}

function placeNear(game, p, st, type, x0, y0, r0, r1) {
  const W = game.W, own = game.s.owner, me = p.id + 1;
  for (let k = 0; k < 24; k++) {
    const r = r0 + rnd(st) * (r1 - r0);
    const a = rnd(st) * 4 - 2, b = rnd(st) * 4 - 2;
    const len = Math.sqrt(a * a + b * b) || 1;
    const x = Math.floor(x0 + (a / len) * r), y = Math.floor(y0 + (b / len) * r);
    const i = game.tileAt(x, y);
    if (i < 0 || own[i] !== me) continue;
    if (tryBuild(game, p.id, type, x, y)) return true;
  }
  return false;
}

function placePort(game, p, st, v, mine) {
  const W = game.W;
  const ref = mine.factory.length ? mine.factory : null;
  const cands = v.coast.map((i) => {
    const x = i % W, y = (i - x) / W;
    let d = (x - v.cx) * (x - v.cx) + (y - v.cy) * (y - v.cy);
    if (ref) {
      d = Infinity;
      for (const f of ref) d = Math.min(d, (f.x - x) * (f.x - x) + (f.y - y) * (f.y - y));
    }
    return { i, d: d * (0.8 + 0.4 * rnd(st)) };
  });
  cands.sort((a, b) => a.d - b.d || a.i - b.i);
  for (let k = 0; k < cands.length && k < 10; k++) {
    const i = cands[k].i;
    if (tryBuild(game, p.id, 'port', i % W, Math.floor(i / W))) return true;
  }
  return false;
}

function placeFront(game, p, st, v, type, q) {
  const W = game.W, own = game.s.owner, me = p.id + 1;
  const t = v.tile[q + 1];
  if (t < 0) return placeInterior(game, p, st, v, type);
  const tx = t % W, ty = (t - tx) / W;
  const dx = v.cx - tx, dy = v.cy - ty;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  for (const r of [6, 9, 4, 12, 15]) {
    const x = Math.floor(tx + (dx / len) * r), y = Math.floor(ty + (dy / len) * r);
    const i = game.tileAt(x, y);
    if (i < 0 || own[i] !== me) continue;
    if (tryBuild(game, p.id, type, x, y)) return true;
    if (placeNear(game, p, st, type, x, y, 2, 6)) return true;
  }
  return false;
}

function samCovered(game, pid, x, y, hostileOnly) {
  let n = 0;
  for (const b of game.s.buildings) {
    if (b.type !== 'sam' || !game.buildingActive(b)) continue;
    if (hostileOnly ? !game.isHostile(pid, b.owner) || b.owner === pid : b.owner !== pid) continue;
    const R = SAM.radius(b.level);
    const dx = b.x - x, dy = b.y - y;
    if (dx * dx + dy * dy <= R * R) n++;
  }
  return n;
}

function routeCover(game, pid, x0, y0, x1, y1) {
  const ex = x1 - x0, ey = y1 - y0, L2 = ex * ex + ey * ey;
  let n = 0;
  for (const b of game.s.buildings) {
    if (b.type !== 'sam' || b.owner === pid || !game.buildingActive(b) || !game.isHostile(pid, b.owner)) continue;
    const R = SAM.radius(b.level) + 2;
    let k = L2 > 0 ? ((b.x - x0) * ex + (b.y - y0) * ey) / L2 : 0;
    k = k < 0 ? 0 : k > 1 ? 1 : k;
    const dx = x0 + ex * k - b.x, dy = y0 + ey * k - b.y;
    if (dx * dx + dy * dy <= R * R) n++;
  }
  return n;
}

function placeSam(game, p, st, v, mine) {
  let best = null, bs = 0;
  for (const type of ['silo', 'factory', 'port', 'airbase', 'house']) {
    for (const b of mine[type]) {
      const cover = samCovered(game, p.id, b.x, b.y, false);
      const sc = (VALUE[type] * b.level) / (1 + cover * 3);
      if (sc > bs) { bs = sc; best = b; }
    }
  }
  if (!best) return placeInterior(game, p, st, v, 'sam');
  return placeNear(game, p, st, 'sam', best.x + 0.5, best.y + 0.5, 5, 12) || placeInterior(game, p, st, v, 'sam');
}

function placeFactory(game, p, st, v, mine) {
  const ports = mine.port.filter((b) => game.buildingActive(b));
  if (ports.length) {
    const b = ports[Math.floor(rnd(st) * ports.length)];
    if (placeNear(game, p, st, 'factory', b.x + 0.5, b.y + 0.5, 8, 30)) return true;
  }
  return placeInterior(game, p, st, v, 'factory');
}

function hostileThreats(game, p, v) {
  const s = game.s, P = s.players;
  const mine = defPower(game, p);
  const out = [];
  for (let q = 0; q < P.length; q++) {
    if (q === p.id || !v.cnt[q + 1] || !P[q].alive || !game.isHostile(p.id, q)) continue;
    const r = atkPower(game, P[q]) / mine;
    if (r >= 0.6 || v.inc[q] > 0) out.push({ q, r: r + (v.inc[q] > 0 ? 1 : 0) });
  }
  out.sort((a, b) => b.r - a.r || a.q - b.q);
  return out;
}

function strikeThreat(game, pid) {
  let t = 0;
  for (const b of game.s.buildings) {
    if ((b.type === 'silo' || b.type === 'airbase') && b.owner !== pid && game.isHostile(pid, b.owner)) {
      if (b.type === 'silo') return 2;
      t = 1;
    }
  }
  return t;
}

const NUKE_PLAN = [['missile', 1], ['nuclear', 1], ['nuclear', 2], ['nuclear', 3]];


function researchOk(p, prof, mine, key, lvl) {
  const R = p.research;
  if (R[key] >= lvl) return false;
  if (key === 'nuclear' && lvl > prof.maxNuclear) return false;
  if (key === 'naval' && !mine.port.length) return false;
  if ((key === 'armor' || key === 'art') && !mine.factory.length) return false;
  const req = RESEARCH[key].req;
  return !req || R[req[0]] >= req[1];
}

function nextResearch(game, p, prof, mine, threat) {
  if (p.researching) return null;
  if (threat && researchOk(p, prof, mine, 'aa', threat)) return { key: 'aa', pri: 72 };
  if (prof.maxNuclear && p.gold >= 60000) {
    for (const [key, lvl] of NUKE_PLAN) {
      if (lvl >= 3 && p.gold < 150000) break;
      if (researchOk(p, prof, mine, key, lvl)) return { key, pri: 75 };
    }
  }
  for (let k = 0; k < PLAN.length; k++) {
    const [key, lvl] = PLAN[k];
    if (researchOk(p, prof, mine, key, lvl)) return { key, pri: 76 - k * 0.7 };
  }
  return null;
}

function railWish(game, p, mine) {
  const pid = p.id;
  for (const f of mine.factory) {
    if (!game.buildingActive(f)) continue;
    const port = nearestPort(game, pid, f.x, f.y);
    if (!port || railRoute(game, pid, f.id, port.id)) continue;
    if (!railError(game, pid, f.id, port.id)) return { a: f.id, b: port.id, cost: railCost(dist(f, port)) };
    for (const hub of [...mine.port, ...mine.factory, ...mine.house]) {
      if (hub === f || !game.buildingActive(hub) || !railRoute(game, pid, hub.id, port.id)) continue;
      if (!railError(game, pid, f.id, hub.id)) return { a: f.id, b: hub.id, cost: railCost(dist(f, hub)) };
    }
  }
  return null;
}

const dist = (a, b) => Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));

function cheapestUpgrade(game, pid, list, maxLevel) {
  let best = null, bc = Infinity;
  for (const b of list) {
    if (b.level >= maxLevel || b.build > 0) continue;
    const c = upgradeCost(game, b);
    if (c < bc) { bc = c; best = b; }
  }
  return best;
}

function economy(game, p, st, v, prof, withRails) {
  const pid = p.id, t = p.tiles, R = p.research;
  const mine = mineByType(game, pid);
  const rich = Math.min(3, Math.floor(p.gold / 40000));
  const wishes = [];
  const wish = (pri, cost, run, save = false) => { wishes.push({ pri, cost, run, save }); };
  const threat = strikeThreat(game, pid);
  const nr = nextResearch(game, p, prof, mine, threat);
  if (nr) wish(nr.pri, researchCost(nr.key, R[nr.key]), () => OK(game.apply(pid, { c: 'research', key: nr.key })), nr.pri >= 66);
  const upgrade = (b) => !upgradeError(game, pid, b) && OK(game.apply(pid, { c: 'upgrade', id: b.id }));
  const wantH = Math.min(prof.maxHouses + rich * 4, 1 + Math.floor(t / prof.houseEvery));
  if (mine.house.length < wantH) {
    wish(mine.house.length ? 70 - mine.house.length : 82, buildCost(game, pid, 'house'), () => placeInterior(game, p, st, v, 'house'), true);
  }
  const hu = cheapestUpgrade(game, pid, mine.house, BUILDINGS.house.max);
  if (hu) wish(64 - hu.level * 3, upgradeCost(game, hu), () => upgrade(hu));
  const wantF = t >= 300 ? Math.min(prof.maxFactories + rich, 1 + Math.floor(t / 3500)) : 0;
  if (mine.factory.length < wantF) {
    wish(mine.factory.length ? 54 : 78, buildCost(game, pid, 'factory'), () => placeFactory(game, p, st, v, mine), !mine.factory.length);
  }
  if (mine.port.length) {
    const fu = cheapestUpgrade(game, pid, mine.factory, BUILDINGS.factory.max);
    if (fu) wish(52, upgradeCost(game, fu), () => upgrade(fu));
  }
  if (v.coast.length) {
    const wantP = Math.min(prof.maxPorts + rich, 1 + Math.floor(t / 6000));
    if (mine.port.length < wantP) {
      wish(mine.port.length ? 50 : 77, buildCost(game, pid, 'port'), () => placePort(game, p, st, v, mine), !mine.port.length);
    }
    const pu = cheapestUpgrade(game, pid, mine.port, BUILDINGS.port.max);
    if (pu) wish(44, upgradeCost(game, pu), () => upgrade(pu));
  }
  const threats = hostileThreats(game, p, v);
  if (threats.length) {
    const wantFort = Math.min(1 + Math.floor(t / 4000), threats.length + (v.incoming > 0 ? 1 : 0), 8);
    if (mine.fort.length < wantFort) {
      const q = threats[0].q;
      wish(v.inc[q] > 0 ? 74 : 47, buildCost(game, pid, 'fort'), () => placeFront(game, p, st, v, 'fort', q));
    }
    const fo = cheapestUpgrade(game, pid, mine.fort, BUILDINGS.fort.max);
    if (fo && v.incoming > 0) wish(46, upgradeCost(game, fo), () => upgrade(fo));
  }
  const wantS = (threat ? Math.min(6, 1 + Math.floor(t / 7000)) : (mine.silo.length || mine.factory.length > 2 ? 1 : 0)) + rich;
  if (mine.sam.length < wantS) wish(threat ? 66 : 42, buildCost(game, pid, 'sam'), () => placeSam(game, p, st, v, mine));
  if (threat || rich) {
    const su = cheapestUpgrade(game, pid, mine.sam, BUILDINGS.sam.max);
    if (su) wish(40, upgradeCost(game, su), () => upgrade(su));
  }
  if (R.drone >= 1 && mine.airbase.length < prof.airbases) {
    wish(65, buildCost(game, pid, 'airbase'), () => placeInterior(game, p, st, v, 'airbase'), true);
  }
  if (R.missile >= 1 && mine.silo.length < (t > 8000 ? prof.silos : 1)) {
    wish(63, buildCost(game, pid, 'silo'), () => placeInterior(game, p, st, v, 'silo'), true);
  }
  if (R.drone >= 2) {
    const au = cheapestUpgrade(game, pid, mine.airbase, BUILDINGS.airbase.max);
    if (au) wish(38, upgradeCost(game, au), () => upgrade(au));
  }
  if (R.nuclear >= 2) {
    const so = cheapestUpgrade(game, pid, mine.silo, BUILDINGS.silo.max);
    if (so) wish(38, upgradeCost(game, so), () => upgrade(so));
  }
  if (withRails && mine.port.length && mine.factory.length) {
    const rw = railWish(game, p, mine);
    if (rw) wish(48, rw.cost, () => OK(game.apply(pid, { c: 'rail', a: rw.a, b: rw.b })));
  }
  wishes.sort((a, b) => b.pri - a.pri);
  let done = 0;
  for (const w of wishes) {
    if (done >= prof.builds + rich) break;
    if (w.cost <= p.gold) {
      if (w.run()) done++;
      continue;
    }
    if (w.save && w.cost <= p.gold + Math.max(30, p.income - p.upkeep) * 60) break;
  }
}

function coastSamples(game) {
  const map = game.map;
  let c = coastCache.get(map);
  if (c) return c;
  const W = game.W, oc = game.oceanCoast;
  const cell = W >= 1000 ? 12 : 6;
  const cw = Math.ceil(W / cell), ch = Math.ceil(game.H / cell);
  const pick = new Int32Array(cw * ch).fill(-1);
  const src = map.nav && map.nav.shore ? map.nav.shore : null;
  const n = src ? src.length : game.N;
  for (let k = 0; k < n; k++) {
    const i = src ? src[k] : k;
    if (!oc[i]) continue;
    const x = i % W, y = (i - x) / W;
    const q = Math.floor(y / cell) * cw + Math.floor(x / cell);
    if (pick[q] < 0 || i < pick[q]) pick[q] = i;
  }
  const out = [], body = [];
  for (const i of pick) {
    if (i < 0) continue;
    const bs = coastBodies(map, i);
    if (!bs.length) continue;
    out.push(i);
    body.push(Math.min(...bs));
  }
  c = { tiles: Int32Array.from(out), body: Int32Array.from(body) };
  coastCache.set(map, c);
  return c;
}

const coastCache = new WeakMap();

function isBad(st, i, tick) {
  const b = st.bad;
  for (let k = 0; k < b.length; k += 2) if (b[k] === i && b[k + 1] > tick) return true;
  return false;
}

function markBad(st, i, tick) {
  const b = st.bad;
  for (let k = b.length - 2; k >= 0; k -= 2) if (b[k + 1] <= tick) b.splice(k, 2);
  b.push(i, tick + BAD_TICKS);
  if (b.length > 48) b.splice(0, b.length - 48);
}

function countOwn(game, pid, type) {
  let n = 0;
  for (const u of game.s.units) if (u.owner === pid && u.type === type) n++;
  return n;
}

function freeLand(game, lm) {
  let n = game.landSizes[lm];
  for (const c of game.lmCount) n -= c[lm];
  return n;
}

const NEUTRAL_TILE = ECON.neutralCost * 1.35;

function tileCostOf(game, p, q) {
  const dens = q.troops / Math.max(1, q.tiles);
  return ((ECON.tileCost + dens * ECON.densityCost) * 1.35 * game.defenseMult(q.id)) / game.attackMult(p.id);
}

function pickLanding(game, p, st, v, prof, locked, noNeutral) {
  const s = game.s, own = s.owner, fo = s.fallout, W = game.W, P = s.players;
  const cs = coastSamples(game);
  const range = prof.boatRange * (locked ? 4 : 1) * (W >= 1000 ? 1 : 0.6);
  const R2 = range * range;
  const send = Math.max(1, p.troops) * (locked ? prof.boatLocked : prof.boatSend);
  const myPow = atkPower(game, p);
  const bodies = [];
  const cx = [], cy = [];
  for (const i of v.coast) {
    cx.push(i % W);
    cy.push(Math.floor(i / W));
    for (const b of coastBodies(game.map, i)) if (!bodies.includes(b)) bodies.push(b);
  }
  const per = new Float64Array(P.length).fill(-1);
  for (const q of P) {
    if (q.id === p.id || !q.alive || !q.tiles || !game.isHostile(p.id, q.id)) continue;
    if (myPow / Math.max(1, defPower(game, q)) < (locked ? 0.5 : 1.8)) continue;
    per[q.id] = tileCostOf(game, p, q);
  }
  const free = new Map();
  let best = null, bs = 0;
  for (let k = 0; k < cs.tiles.length; k++) {
    if (!bodies.includes(cs.body[k])) continue;
    const t = cs.tiles[k];
    const o = own[t] - 1;
    if (o === p.id) continue;
    const lm = game.landId[t];
    let gain, need, mul = 1;
    if (o < 0) {
      if (fo[t] || (!noNeutral && game.ownsOnLandmass(p.id, lm))) continue;
      let f = free.get(lm);
      if (f === undefined) { f = freeLand(game, lm); free.set(lm, f); }
      if (f <= 0) continue;
      gain = Math.min(f, send / NEUTRAL_TILE);
      need = f * NEUTRAL_TILE * 1.4 + 600;
    } else {
      const c = per[o];
      if (c < 0) continue;
      const have = game.lmCount[o][lm];
      gain = Math.min(have, send / c);
      need = have * c * 1.3 + 1500;
      if (o === st.war) mul *= 1.5;
      if (P[o].traitorUntil > s.tick) mul *= 1.2;
      if (o === v.lead.id && v.lead.tiles > p.tiles) mul *= 1.3;
      if (!locked) mul *= 0.6;
    }
    if (gain < 3) continue;
    const x = t % W, y = (t - x) / W;
    let d = Infinity;
    for (let j = 0; j < cx.length; j++) {
      const dd = (cx[j] - x) * (cx[j] - x) + (cy[j] - y) * (cy[j] - y);
      if (dd < d) d = dd;
    }
    if (d > R2) continue;
    const sc = (gain * mul) / (Math.sqrt(d) + 120);
    if (sc > bs && !isBad(st, t, s.tick)) { bs = sc; best = { tile: t, target: o, troops: Math.min(send, need) }; }
  }
  return best;
}

function boats(game, p, st, v, prof) {
  const s = game.s, pid = p.id;
  if (!v.coast.length || countOwn(game, pid, 'transport') >= 3) return false;
  const fill = p.troops / Math.max(1, p.maxTroops);
  const noNeutral = v.cnt[0] === 0;
  const idle = s.tick - (st.atkAt || 0) > 150;
  const locked = noNeutral && (v.hostileLand === 0 || (idle && fill >= prof.capPush));
  if (fill < (locked ? 0.4 : 0.55)) return false;
  if (s.tick < st.boatAt) return false;
  const pick = pickLanding(game, p, st, v, prof, locked, noNeutral);
  st.boatAt = s.tick + (locked ? 40 : Math.round(prof.boatEvery / (st.sea || 1)));
  if (!pick) return false;
  const W = game.W, t = pick.tile;
  const ratio = Math.min(1, Math.max(0.01, pick.troops / Math.max(1, p.troops)));
  if (OK(game.apply(pid, { c: 'boat', x: t % W, y: Math.floor(t / W), ratio }))) {
    st.boats++;
    if (pick.target >= 0 && st.war < 0) { st.war = pick.target; st.warAt = s.tick; }
  } else {
    markBad(st, t, s.tick);
    st.boatAt = s.tick + 20;
  }
  return true;
}

function bodyAt(game, x, y) {
  const i = game.tileAt(x, y);
  return i >= 0 ? game.map.waterBody[i] : -1;
}

function navy(game, p, st, v, prof) {
  const s = game.s, pid = p.id;
  const ports = [];
  for (const b of s.buildings) if (b.owner === pid && b.type === 'port' && game.buildingActive(b)) ports.push(b);
  if (!ports.length) return;
  const ships = [], prey = [];
  for (const u of s.units) {
    if (u.owner === pid) { if (u.type === 'warship') ships.push(u); continue; }
    if (u.type === 'warship' || u.type === 'transport' || u.type === 'trade') {
      if (canEngage(game, pid, u)) prey.push(u);
    }
  }
  const enemyPorts = [];
  for (const b of s.buildings) {
    if (b.type !== 'port' || b.owner === pid || !game.buildingActive(b) || !game.isHostile(pid, b.owner)) continue;
    for (const m of ports) if (sharedSea(game, m, b) >= 0) { enemyPorts.push(b); break; }
  }
  let want = 0;
  if (enemyPorts.length || prey.length) {
    want = Math.min(Math.round(prof.maxShips * (st.sea || 1)), Math.max(1, Math.round((1 + p.tiles / 9000) * prof.ships * (st.sea || 1))));
    if (prey.some((u) => u.type === 'transport' && u.tp === pid)) want++;
  }
  if (ships.length < want) {
    const cost = shipCost(game, pid);
    if (p.gold >= cost + 1500) {
      for (const b of ports) {
        if (portShips(game, b) >= portShipCap(b)) continue;
        if (OK(game.apply(pid, { c: 'buildShip', port: b.id }))) { st.ships++; break; }
      }
    }
  }
  let orders = 0;
  for (const u of ships) {
    if (orders >= 1) break;
    if (u.order || u.chase >= 0 || u.path.length) continue;
    const body = bodyAt(game, u.x, u.y);
    if (body < 0) continue;
    let best = null, bd = 260 * 260;
    for (const t of prey) {
      if (bodyAt(game, t.x, t.y) !== body) continue;
      const pt = t.path && t.pi < t.path.length ? t.path[Math.min(t.path.length - 1, t.pi + 1)] : [t.x, t.y];
      const dx = pt[0] - u.x, dy = pt[1] - u.y;
      const d = (dx * dx + dy * dy) * (t.type === 'transport' ? 0.5 : 1);
      if (d < bd) { bd = d; best = pt; }
    }
    if (!best) {
      let bp = null, pd = Infinity;
      for (const b of enemyPorts) {
        const dx = b.x - u.x, dy = b.y - u.y;
        const d = dx * dx + dy * dy;
        if (d < pd && d > 100 && coastBodies(game.map, b.y * game.W + b.x).includes(body)) { pd = d; bp = b; }
      }
      if (bp && pd < 500 * 500) best = [bp.x + 0.5, bp.y + 0.5];
    }
    if (!best) continue;
    orders++;
    game.apply(pid, { c: 'moveShip', id: u.id, x: best[0], y: best[1] });
  }
}

function warTarget(game, p, st, v) {
  const s = game.s, P = s.players;
  if (st.war >= 0 && P[st.war].alive && game.isHostile(p.id, st.war)) return st.war;
  let best = -1, bv = 0;
  for (let q = 0; q < P.length; q++) {
    if (v.inc[q] > bv && P[q].alive && game.isHostile(p.id, q)) { bv = v.inc[q]; best = q; }
  }
  if (best >= 0) return best;
  for (let q = 0; q < P.length; q++) {
    if (q === p.id || !P[q].alive || !game.isHostile(p.id, q)) continue;
    if (P[q].tiles > bv) { bv = P[q].tiles; best = q; }
  }
  return best;
}

function enemyBuildingTarget(game, p, from, range, pref, maxCover) {
  const s = game.s;
  let best = null, bs = 0;
  for (const b of s.buildings) {
    if (b.owner === p.id || !game.isHostile(p.id, b.owner) || !s.players[b.owner].alive) continue;
    if (b.type === 'fort' && b.owner !== pref) continue;
    const dx = b.x - from.x, dy = b.y - from.y;
    if (range < Infinity && dx * dx + dy * dy > range * range) continue;
    let sc = (VALUE[b.type] || 1) * (1 + b.level);
    if (b.owner === pref) sc *= 2;
    if (b.build > 0 && !b.up) sc *= 0.5;
    if (sc <= bs) continue;
    const cover = routeCover(game, p.id, from.x, from.y, b.x, b.y);
    if (cover > maxCover) continue;
    sc /= 1 + 2 * cover;
    if (sc > bs) { bs = sc; best = b; }
  }
  return best;
}

function droneTile(game, p, v, q, from) {
  const s = game.s, W = game.W;
  const ok = (i) => i >= 0 && !routeCover(game, p.id, from.x, from.y, i % W, Math.floor(i / W));
  const t = v.tile[q + 1];
  if (ok(t)) return t;
  const Q = s.players[q];
  if (Q.capital >= 0 && s.owner[Q.capital] === q + 1 && ok(Q.capital)) return Q.capital;
  for (const b of s.buildings) if (b.owner === q && ok(b.y * W + b.x)) return b.y * W + b.x;
  return -1;
}

function nukeSpot(game, p, r, pref, from) {
  const s = game.s, own = s.owner, W = game.W, H = game.H, P = s.players;
  const cands = [];
  for (const b of s.buildings) {
    if (b.owner === p.id || !game.isHostile(p.id, b.owner)) continue;
    if (pref >= 0 && b.owner !== pref) continue;
    cands.push(b.x, b.y);
    if (cands.length >= 60) break;
  }
  if (pref >= 0 && P[pref].capital >= 0 && own[P[pref].capital] === pref + 1) {
    cands.push(P[pref].capital % W, Math.floor(P[pref].capital / W));
  }
  const step = Math.max(2, Math.floor(r / 5));
  let best = -1, bs = 0;
  for (let k = 0; k < cands.length; k += 2) {
    const cx = cands[k], cy = cands[k + 1];
    const cover = routeCover(game, p.id, from.x, from.y, cx, cy);
    if (cover > 1) continue;
    let enemy = 0, safe = true;
    const R = r + 3, R2 = R * R;
    for (let dy = -R; dy <= R && safe; dy += step) {
      const y = cy + dy;
      if (y < 0 || y >= H) continue;
      for (let dx = -R; dx <= R; dx += step) {
        if (dx * dx + dy * dy > R2) continue;
        const x = cx + dx;
        if (x < 0 || x >= W) continue;
        const o = own[y * W + x] - 1;
        if (o < 0) continue;
        if (o === p.id || !game.isHostile(p.id, o)) { safe = false; break; }
        enemy++;
      }
    }
    if (!safe) continue;
    let val = enemy;
    for (const b of s.buildings) {
      if (b.owner === p.id) continue;
      const dx = b.x - cx, dy = b.y - cy;
      if (dx * dx + dy * dy <= r * r) val += (VALUE[b.type] || 1) * b.level * 3;
    }
    val /= 1 + 2 * cover;
    if (val > bs) { bs = val; best = cy * W + cx; }
  }
  return best;
}

function strike(game, pid, kind, from, x, y) {
  if (strikeError(game, pid, kind, from.id, x, y)) return false;
  return OK(game.apply(pid, { c: 'strike', kind, from: from.id, x, y }));
}

const MEGA_GAP = 3000;

function rivalOf(game, p) {
  let best = null;
  for (const q of game.s.players) {
    if (q.id === p.id || !q.alive || !q.tiles || !game.isHostile(p.id, q.id)) continue;
    if (!best || q.tiles > best.tiles) best = q;
  }
  return best;
}

function launchNuke(game, p, st, v, prof, sl, war) {
  const s = game.s, R = p.research, W = game.W, gold = p.gold;
  if (s.tick < st.nukeAt || prof.nukes < 1) return false;
  if (prof.nukes >= 3 && R.nuclear >= 3 && gold >= STRIKES.mega.cost + 20000 && s.tick >= (st.megaAt || 0)) {
    const rival = rivalOf(game, p);
    const stuck = v.cnt[0] === 0 && v.hostileLand === 0 && p.troops >= p.maxTroops * prof.capPush;
    if (rival && (rival.tiles * 5 >= p.tiles * 3 || stuck)) {
      const tgt = rival.capital >= 0 && s.owner[rival.capital] === rival.id + 1 ? rival.capital : -1;
      const x = tgt >= 0 ? tgt % W : undefined, y = tgt >= 0 ? Math.floor(tgt / W) : undefined;
      if (strike(game, p.id, 'mega', sl, x, y)) {
        st.nukeAt = s.tick + 600;
        st.megaAt = s.tick + MEGA_GAP;
        return true;
      }
    }
  }
  if (war < 0) return false;
  const kinds = [];
  if (prof.nukes >= 2 && R.nuclear >= 2 && gold >= STRIKES.hbomb.cost * 1.5 + 10000) kinds.push('hbomb');
  if (R.nuclear >= 1 && gold >= STRIKES.atom.cost * 1.6 + 5000) kinds.push('atom');
  for (const kind of kinds) {
    const spot = nukeSpot(game, p, STRIKES[kind].r, war, sl);
    if (spot < 0 || !strike(game, p.id, kind, sl, spot % W, Math.floor(spot / W))) continue;
    st.nukeAt = s.tick + (gold > 400000 ? 200 : prof.nukeEvery);
    return true;
  }
  return false;
}

function strikes(game, p, st, v, prof) {
  const s = game.s, pid = p.id, R = p.research, W = game.W;
  const air = [], silos = [];
  for (const b of s.buildings) {
    if (b.owner !== pid || b.cd > 0 || !game.buildingActive(b)) continue;
    if (b.type === 'airbase') air.push(b);
    else if (b.type === 'silo') silos.push(b);
  }
  if (!air.length && !silos.length) return;
  const war = warTarget(game, p, st, v);
  for (const a of air) {
    const spare = p.gold - 1500;
    if (R.drone >= 2 && spare >= STRIKES.kamikaze.cost) {
      const b = enemyBuildingTarget(game, p, a, Infinity, war, 0);
      if (b && (b.owner === war || VALUE[b.type] * b.level >= 10) && strike(game, pid, 'kamikaze', a, b.x, b.y)) continue;
    }
    if (war >= 0 && spare >= STRIKES.drone.cost) {
      const t = droneTile(game, p, v, war, a);
      if (t >= 0) strike(game, pid, 'drone', a, t % W, Math.floor(t / W));
    }
  }
  for (const sl of silos) {
    if (launchNuke(game, p, st, v, prof, sl, war)) continue;
    if (R.missile >= 1 && p.gold >= STRIKES.cruise.cost + 3000) {
      const b = enemyBuildingTarget(game, p, sl, cruiseRange(R.missile), war, R.missile >= 2 ? 1 : 0);
      if (b && (b.owner === war || VALUE[b.type] * b.level >= 12)) strike(game, pid, 'cruise', sl, b.x, b.y);
    }
  }
}

function attacksBetween(game, a, b) {
  let ab = 0, ba = 0;
  for (const x of game.s.attacks) {
    if (x.attacker === a && x.target === b) ab += x.troops;
    else if (x.attacker === b && x.target === a) ba += x.troops;
  }
  return { ab, ba };
}

function alliesOf(game, pid) {
  let n = 0;
  for (const q of game.s.players) if (q.id !== pid && q.alive && game.isAllied(pid, q.id)) n++;
  return n;
}

function unitesAll(game, a, b) {
  const alive = game.s.players.filter((q) => q.alive);
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const x = alive[i].id, y = alive[j].id;
      if ((x === a && y === b) || (x === b && y === a)) continue;
      if (!game.isAllied(x, y)) return false;
    }
  }
  return true;
}

function dominant(game, lead) {
  return lead.id >= 0 && lead.tiles > lead.second * 1.5 && lead.tiles * 5 > game.map.landCount;
}

function propose(game, p, st, q, type) {
  const s = game.s;
  const last = st.prop[q] || 0;
  if (last && s.tick - last < 1800) return false;
  if (proposeError(game, p.id, q, type)) return false;
  if (!OK(game.apply(p.id, { c: 'propose', to: q, type }))) return false;
  while (st.prop.length <= q) st.prop.push(0);
  st.prop[q] = s.tick;
  return true;
}

function betray(game, p, st, v, prof) {
  const s = game.s, P = s.players;
  if (v.cnt[0] > 0 || v.hostileLand > 0 || p.troops < p.maxTroops * prof.capPush) return false;
  if (p.traitorUntil > s.tick) return false;
  const me = atkPower(game, p);
  let best = -1, bs = 0;
  for (const q of P) {
    if (q.id === p.id || !q.alive || !v.cnt[q.id + 1] || game.isHostile(p.id, q.id)) continue;
    const pow = me / Math.max(1, defPower(game, q));
    if (pow < 2.5) continue;
    const sc = pow * v.cnt[q.id + 1];
    if (sc > bs) { bs = sc; best = q.id; }
  }
  if (best < 0 || !OK(game.apply(p.id, { c: 'break', with: best }))) return false;
  st.war = best;
  st.warAt = s.tick;
  return true;
}

function embargoes(game, p, st) {
  const s = game.s;
  for (const q of s.players) {
    if (q.id === p.id || !q.alive) continue;
    const on = embargoBy(game, p.id, q.id);
    const hot = st.war === q.id && s.tick - st.warAt > 600 && q.tiles > p.tiles * 0.8 && game.relation(p.id, q.id).type === 'none';
    if (hot === on) continue;
    if (!hot && st.war === q.id) continue;
    return OK(game.apply(p.id, { c: 'embargo', with: q.id, on: hot }));
  }
  return false;
}

function diplomacy(game, p, st, v, prof) {
  const s = game.s, P = s.players, pid = p.id;
  if (s.tick < st.dipAt) return;
  st.dipAt = s.tick + prof.dipEvery + Math.floor(rnd(st) * 200);
  const lead = v.lead;
  const me = atkPower(game, p);
  for (const q of P) {
    if (q.id === pid || !q.alive || !game.isAllied(pid, q.id)) continue;
    if (lead.id === q.id && q.tiles > p.tiles * 1.4 && dominant(game, lead)) {
      game.apply(pid, { c: 'break', with: q.id });
      return;
    }
  }
  if (prof.betray && betray(game, p, st, v, prof)) return;
  if (prof.allies && embargoes(game, p, st)) return;
  const myPorts = [];
  for (const b of s.buildings) if (b.owner === pid && b.type === 'port' && game.buildingActive(b)) myPorts.push(b);
  if (myPorts.length) {
    for (const b of s.buildings) {
      if (b.type !== 'port' || b.owner === pid || !game.buildingActive(b)) continue;
      const q = P[b.owner];
      if (!q.alive || q.traitorUntil > s.tick || game.relation(pid, q.id).type !== 'none' || embargoBy(game, pid, q.id)) continue;
      if (st.war === q.id || v.inc[q.id] > 0) continue;
      if (!myPorts.some((m) => sharedSea(game, m, b) >= 0)) continue;
      if (propose(game, p, st, q.id, 'trade')) return;
    }
  }
  const front = v.dom && v.cnt[lead.id + 1] > 0;
  for (const q of P) {
    if (q.id === pid || !q.alive || q.traitorUntil > s.tick || !v.cnt[q.id + 1]) continue;
    if (game.relation(pid, q.id).type !== 'none' && game.relation(pid, q.id).type !== 'trade') continue;
    const ratio = atkPower(game, q) / Math.max(1, me);
    const calm = front && q.id !== lead.id && ratio >= 0.25;
    if ((ratio >= 1.6 || calm || (v.inc[q.id] > 0 && ratio >= 1)) && st.war !== q.id) {
      if (propose(game, p, st, q.id, 'pact')) return;
    }
  }
  if (prof.allies > alliesOf(game, pid) && dominant(game, lead) && lead.id !== pid) {
    let best = -1, bs = 0;
    for (const q of P) {
      if (q.id === pid || q.id === lead.id || !q.alive || q.traitorUntil > s.tick) continue;
      if (st.war === q.id || game.isAllied(pid, q.id) || unitesAll(game, pid, q.id)) continue;
      const sc = q.tiles + (v.cnt[q.id + 1] ? q.tiles : 0);
      if (sc > bs) { bs = sc; best = q.id; }
    }
    if (best >= 0) propose(game, p, st, best, 'alliance');
  }
}

export function aiRespond(game, pid, req) {
  const s = game.s, me = s.players[pid], from = s.players[req.from];
  if (!me || !from || !me.alive || !from.alive) return false;
  if (from.traitorUntil > s.tick) return false;
  const prof = profileOf(me);
  const st = brain(game, me);
  const lead = leaderOf(s);
  const mine = atkPower(game, me), theirs = atkPower(game, from);
  const ratio = theirs / Math.max(1, mine);
  const war = attacksBetween(game, pid, req.from);
  const cur = game.relation(pid, req.from).type;
  if (req.type === 'trade') {
    if (cur === 'pact' || cur === 'alliance') return false;
    if (war.ba > 0 && ratio < 1) return false;
    return st.war !== req.from || ratio >= 1.2;
  }
  if (req.type === 'pact') {
    if (lead.id === req.from && dominant(game, lead) && lead.id !== pid && ratio < 2) return false;
    if (lead.id === pid && dominant(game, lead) && ratio < 1.2) return false;
    if (war.ab > 0 && ratio < 0.8) return false;
    if (ratio >= 0.7) return true;
    if (dominant(game, lead) && lead.id !== pid && lead.id !== req.from) return true;
    return st.war >= 0 && st.war !== req.from;
  }
  if (req.type === 'alliance') {
    if (prof.allies <= alliesOf(game, pid)) return false;
    if (unitesAll(game, pid, req.from) && lead.id !== pid) return false;
    if (lead.id === req.from && dominant(game, lead)) return false;
    if (war.ab > 0 && ratio < 1) return false;
    return ratio >= 0.5 || (dominant(game, lead) && lead.id !== pid);
  }
  return false;
}

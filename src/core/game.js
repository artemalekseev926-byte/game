import { ARMY, BUILDINGS, ECON, TICKS_PER_SEC, LAND_UNITS } from './config.js';
import { hashState } from './state.js';
import * as territory from './territory.js';
import * as economy from './economy.js';
import * as buildings from './buildings.js';
import * as units from './units.js';
import * as strikes from './strikes.js';
import * as diplomacy from './diplomacy.js';
import * as victory from './victory.js';
import * as AI from './ai.js';

const HANDLERS = new Map();
export const SYSTEMS = [];

export function registerIntents(table) {
  if (!table) return;
  for (const k of Object.keys(table)) {
    const h = table[k];
    if (h && typeof h.check === 'function' && typeof h.run === 'function') HANDLERS.set(k, h);
  }
}

export function registerSystem(fn, before) {
  if (typeof fn !== 'function' || SYSTEMS.includes(fn)) return;
  const at = before ? SYSTEMS.indexOf(before) : -1;
  if (at >= 0) SYSTEMS.splice(at, 0, fn);
  else SYSTEMS.push(fn);
}

export const intentNames = () => [...HANDLERS.keys()];

const CORE_INTENTS = {
  _ai: {
    phase: 'any',
    anyone: true,
    check(game, pid, cmd) {
      const t = cmd.pid === undefined ? pid : Number(cmd.pid);
      if (!Number.isInteger(t) || !game.s.players[t]) return 'Неизвестный игрок';
      return null;
    },
    run(game, pid, cmd) {
      const t = cmd.pid === undefined ? pid : Number(cmd.pid);
      const p = game.s.players[t];
      const lvl = typeof cmd.level === 'string' && ['easy', 'normal', 'hard'].includes(cmd.level) ? cmd.level : 'normal';
      p.ai = cmd.level === null ? null : lvl;
      p.netId = null;
      if (p.alive) game.msg(-1, `${p.name} передан под управление компьютера`, 'info');
    },
  },
};

registerIntents(CORE_INTENTS);
for (const m of [territory, economy, buildings, units, strikes, diplomacy, victory]) registerIntents(m.INTENTS);
for (const fn of [territory.tickTerritory, economy.tickEconomy, buildings.tickBuildings, units.tickUnits, strikes.tickStrikes, diplomacy.tickDiplomacy, victory.tickVictory]) registerSystem(fn);

const extrasCache = new WeakMap();

export function mapExtras(map) {
  let ex = extrasCache.get(map);
  if (ex) return ex;
  const { W, H, terrain } = map;
  const N = W * H;
  const landId = new Int32Array(N).fill(-1);
  const sizes = [];
  let landN = 0;
  for (let i = 0; i < N; i++) if (terrain[i] >= 2) landN++;
  const landList = new Int32Array(landN);
  let li = 0;
  const stack = new Int32Array(Math.max(1, landN));
  for (let s0 = 0; s0 < N; s0++) {
    if (terrain[s0] >= 2) landList[li++] = s0;
    if (terrain[s0] < 2 || landId[s0] >= 0) continue;
    const id = sizes.length;
    let sp = 0, n = 0;
    stack[sp++] = s0; landId[s0] = id;
    while (sp) {
      const i = stack[--sp];
      n++;
      const x = i % W;
      if (x > 0 && terrain[i - 1] >= 2 && landId[i - 1] < 0) { landId[i - 1] = id; stack[sp++] = i - 1; }
      if (x < W - 1 && terrain[i + 1] >= 2 && landId[i + 1] < 0) { landId[i + 1] = id; stack[sp++] = i + 1; }
      if (i >= W && terrain[i - W] >= 2 && landId[i - W] < 0) { landId[i - W] = id; stack[sp++] = i - W; }
      if (i < N - W && terrain[i + W] >= 2 && landId[i + W] < 0) { landId[i + W] = id; stack[sp++] = i + W; }
    }
    sizes.push(n);
  }
  const oceanCoast = new Uint8Array(N);
  const ocean = map.nav && map.nav.ocean;
  if (ocean) {
    for (let i = 0; i < N; i++) {
      if (!map.coast[i]) continue;
      const x = i % W;
      if ((x > 0 && ocean[i - 1]) || (x < W - 1 && ocean[i + 1]) || (i >= W && ocean[i - W]) || (i < N - W && ocean[i + W])) oceanCoast[i] = 1;
    }
  }
  ex = { landId, landSizes: Int32Array.from(sizes), landList, oceanCoast };
  extrasCache.set(map, ex);
  return ex;
}

const NO_REL = Object.freeze({ type: 'none', until: 0, embargo: false });
const OK = Object.freeze({ ok: true });
const fail = (error) => ({ ok: false, error });

export const relKey = (a, b) => (a < b ? a + ':' + b : b + ':' + a);

export class Game {
  constructor(map, state) {
    this.map = map;
    this.s = state;
    this.W = map.W;
    this.H = map.H;
    this.N = map.W * map.H;
    this.events = [];
    this.dirty = [];
    this.lastError = null;
    this.rebuild();
  }

  rebuild() {
    const { W, N, s } = this;
    const ex = mapExtras(this.map);
    this.landId = ex.landId;
    this.landSizes = ex.landSizes;
    this.landList = ex.landList;
    this.oceanCoast = ex.oceanCoast;
    const P = s.players.length;
    this.borders = [];
    this.borderCache = [];
    this.lmCount = [];
    for (let p = 0; p < P; p++) {
      this.borders.push(new Set());
      this.borderCache.push(null);
      this.lmCount.push(new Int32Array(this.landSizes.length));
    }
    this.isBorder = new Uint8Array(N);
    this.mark = new Uint32Array(N);
    this.mark2 = new Uint32Array(N);
    this.stampN = 0;
    const own = s.owner, land = this.landId;
    const tiles = new Int32Array(P);
    for (let i = 0; i < N; i++) {
      const o = own[i];
      if (!o) continue;
      if (land[i] < 0 || o > P) { own[i] = 0; continue; }
      tiles[o - 1]++;
      this.lmCount[o - 1][land[i]]++;
    }
    for (let i = 0; i < N; i++) {
      const o = own[i];
      if (!o) continue;
      const x = i % W;
      if ((x > 0 && own[i - 1] !== o) || (x < W - 1 && own[i + 1] !== o) || (i >= W && own[i - W] !== o) || (i < N - W && own[i + W] !== o)) {
        this.isBorder[i] = 1;
        this.borders[o - 1].add(i);
      }
    }
    for (let p = 0; p < P; p++) s.players[p].tiles = tiles[p];
    this.bAt = new Int32Array(N).fill(-1);
    this.bById = new Map();
    for (const b of s.buildings) {
      this.bAt[b.y * W + b.x] = b.id;
      this.bById.set(b.id, b);
    }
    this.falloutList = [];
    const fo = s.fallout;
    for (let i = 0; i < N; i++) if (fo[i]) this.falloutList.push(i);
    this.dirtyAcc = [];
    this.dirtyAll = true;
    this.tickCache = new Map();
  }

  rand() {
    let t = (this.s.rngState = (this.s.rngState + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  randInt(n) { return Math.floor(this.rand() * n); }

  nextId() { return this.s.nextId++; }

  nextStamp() {
    this.stampN = (this.stampN + 1) >>> 0;
    if (this.stampN === 0) {
      this.mark.fill(0);
      this.mark2.fill(0);
      this.stampN = 1;
    }
    return this.stampN;
  }

  tileAt(x, y) {
    const xi = Math.floor(Number(x)), yi = Math.floor(Number(y));
    if (!Number.isFinite(xi) || !Number.isFinite(yi) || xi < 0 || yi < 0 || xi >= this.W || yi >= this.H) return -1;
    return yi * this.W + xi;
  }

  isLandTile(i) { return i >= 0 && i < this.N && this.map.terrain[i] >= 2; }

  tileOwner(i) { return this.s.owner[i] - 1; }

  landmassOf(i) { return this.landId[i]; }

  ownsOnLandmass(pid, lm) { return lm >= 0 && !!this.lmCount[pid] && this.lmCount[pid][lm] > 0; }

  markDirty(i) {
    this.dirty.push(i);
    if (this.dirtyAll) return;
    this.dirtyAcc.push(i);
    if (this.dirtyAcc.length > 4000000) { this.dirtyAll = true; this.dirtyAcc = []; }
  }

  drainDirty() {
    if (this.dirtyAll) {
      this.dirtyAll = false;
      this.dirtyAcc = [];
      return { all: true, tiles: [] };
    }
    const tiles = this.dirtyAcc;
    this.dirtyAcc = [];
    return { all: false, tiles };
  }

  refreshBorder(j) {
    const own = this.s.owner, W = this.W, N = this.N;
    const o = own[j];
    let b = 0;
    if (o) {
      const x = j % W;
      b = (x > 0 && own[j - 1] !== o) || (x < W - 1 && own[j + 1] !== o) || (j >= W && own[j - W] !== o) || (j < N - W && own[j + W] !== o) ? 1 : 0;
    }
    if (b !== this.isBorder[j]) {
      this.isBorder[j] = b;
      if (b) this.borders[o - 1].add(j);
      else this.borders[o - 1].delete(j);
      this.borderCache[o - 1] = null;
    }
  }

  setOwner(i, pid) {
    const s = this.s, own = s.owner, W = this.W;
    if (this.landId[i] < 0) return false;
    const prev = own[i];
    const next = pid >= 0 ? pid + 1 : 0;
    if (prev === next) return false;
    if (prev) {
      const p = s.players[prev - 1];
      p.tiles--;
      this.lmCount[prev - 1][this.landId[i]]--;
      if (this.isBorder[i]) {
        this.isBorder[i] = 0;
        this.borders[prev - 1].delete(i);
        this.borderCache[prev - 1] = null;
      }
      if (p.capital === i) {
        p.capital = -1;
        if (next) {
          this.emit({ k: 'capture', pid: next - 1, from: prev - 1, x: i % W, y: Math.floor(i / W), capital: true });
          this.msg(prev - 1, `${s.players[next - 1].name} захватил вашу столицу!`, 'danger');
        }
      }
    }
    own[i] = next;
    if (next) {
      s.players[next - 1].tiles++;
      this.lmCount[next - 1][this.landId[i]]++;
    }
    this.markDirty(i);
    const x = i % W;
    this.refreshBorder(i);
    if (x > 0) this.refreshBorder(i - 1);
    if (x < W - 1) this.refreshBorder(i + 1);
    if (i >= W) this.refreshBorder(i - W);
    if (i < this.N - W) this.refreshBorder(i + W);
    if (this.bAt[i] >= 0) {
      const b = this.bById.get(this.bAt[i]);
      if (b) buildings.onTileOwnerChanged(this, b, prev - 1, next - 1);
    }
    return true;
  }

  setFallout(i, ticks) {
    const fo = this.s.fallout;
    const t = Math.min(65535, Math.max(0, Math.round(ticks)));
    if (!t) return;
    if (!fo[i]) this.falloutList.push(i);
    if (t > fo[i]) fo[i] = t;
    this.markDirty(i);
  }

  playerBorder(pid) { return this.borders[pid] || new Set(); }

  borderList(pid) {
    if (!this.borders[pid]) return [];
    let c = this.borderCache[pid];
    if (!c) {
      c = Int32Array.from(this.borders[pid]).sort();
      this.borderCache[pid] = c;
    }
    return c;
  }

  relation(a, b) {
    if (a === b || a < 0 || b < 0) return NO_REL;
    return this.s.relations[relKey(a, b)] || NO_REL;
  }

  isAllied(a, b) {
    if (a === b) return true;
    const t = this.relation(a, b).type;
    return t === 'alliance';
  }

  isHostile(a, b) {
    if (a === b) return false;
    if (a < 0 || b < 0) return true;
    const t = this.relation(a, b).type;
    return t !== 'alliance' && t !== 'pact';
  }

  emit(ev) { this.events.push(ev); }

  msg(to, text, kind = 'info') { this.events.push({ k: 'msg', to, text, kind }); }

  buildingAt(i) {
    const id = this.bAt[i];
    return id >= 0 ? this.bById.get(id) || null : null;
  }

  buildingById(id) { return this.bById.get(Number(id)) || null; }

  buildingsOf(pid, type) {
    const out = [];
    for (const b of this.s.buildings) if (b.owner === pid && (!type || b.type === type)) out.push(b);
    return out;
  }

  buildingActive(b) { return !!b && (b.build === 0 || !!b.up); }

  fortList(pid) {
    const key = 'f' + pid;
    let list = this.tickCache.get(key);
    if (!list) {
      list = [];
      for (const b of this.s.buildings) {
        if (b.owner === pid && b.type === 'fort' && this.buildingActive(b)) list.push(b.x, b.y, b.level);
      }
      this.tickCache.set(key, list);
    }
    return list;
  }

  attackMult(pid) {
    const p = this.s.players[pid];
    if (!p) return 1;
    const r = p.research, c = p.composition;
    return (1 + ARMY.infBonus * r.inf) * (1 + c.tank * ARMY.tankAtk * (1 + ARMY.armorBonus * r.armor) + c.art * ARMY.artAtk * (1 + ARMY.artBonus * r.art));
  }

  defenseMult(pid) {
    const p = this.s.players[pid];
    if (!p) return 1;
    const r = p.research, c = p.composition;
    return (1 + ARMY.infBonus * r.inf) * (1 + c.art * ARMY.artDef + ARMY.fortDef * r.fort);
  }

  goldRate(pid) {
    const p = this.s.players[pid];
    return p ? p.income - p.upkeep : 0;
  }

  addGold(pid, amount, earned = true) {
    const p = this.s.players[pid];
    if (!p || !Number.isFinite(amount)) return;
    p.gold = Math.min(ECON.maxGold, p.gold + amount);
    if (earned && amount > 0) {
      p.eventAcc += amount;
      p.stats.goldEarned += amount;
    }
  }

  addTroops(pid, n) {
    const p = this.s.players[pid];
    if (p && p.alive && n > 0) p.troops += n;
  }

  spawnUnit(u) {
    u.id = this.s.nextId++;
    if (u.pi === undefined) u.pi = 0;
    if (u.heading === undefined) u.heading = 0;
    this.s.units.push(u);
    return u;
  }

  unitById(id) {
    for (const u of this.s.units) if (u.id === id) return u;
    return null;
  }

  createAttack(pid, target, troops, landing = -1) {
    return territory.startAttack(this, pid, target, troops, landing);
  }

  destroyBuilding(b, by = -1, silent = false) { buildings.destroyBuilding(this, b, by, silent); }

  deliverCargo(u) { return buildings.deliverCargo(this, u); }

  breakRelation(a, b, traitor = false) { diplomacy.breakRelation(this, a, b, traitor); }

  markTraitor(pid) {
    const p = this.s.players[pid];
    if (p) p.traitorUntil = this.s.tick + diplomacy.TRAITOR_TICKS;
  }

  eliminate(pid, reason = '') { victory.eliminate(this, pid, reason); }

  landUnitSpeed(type) { return LAND_UNITS[type] ? LAND_UNITS[type].speed : 0; }

  bordersByLand(pid, i) { return territory.bordersByLand(this, pid, i); }

  countryStats() {
    const s = this.s;
    const out = s.players.map((p) => ({
      id: p.id, name: p.name, color: p.color, alive: p.alive, ai: p.ai,
      tiles: p.tiles, pct: this.map.landCount ? (p.tiles * 100) / this.map.landCount : 0,
      troops: p.troops, maxTroops: p.maxTroops, gold: p.gold, income: p.income, upkeep: p.upkeep,
      house: 0, factory: 0, port: 0, fort: 0, sam: 0, airbase: 0, silo: 0, warship: 0, transport: 0, trade: 0,
      composition: p.composition, research: p.research, traitor: p.traitorUntil > s.tick,
    }));
    for (const b of s.buildings) if (out[b.owner] && BUILDINGS[b.type]) out[b.owner][b.type]++;
    for (const u of s.units) if (out[u.owner] && out[u.owner][u.type] !== undefined) out[u.owner][u.type]++;
    return out;
  }

  validate(pid, cmd) {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.c !== 'string') return fail('Неверная команда');
    const h = HANDLERS.get(cmd.c);
    if (!h) return fail('Неизвестная команда');
    const s = this.s;
    if (!Number.isInteger(pid) || pid < 0 || pid >= s.players.length) return fail('Неизвестный игрок');
    if (s.phase === 'over') return fail('Игра окончена');
    if (!h.anyone && !s.players[pid].alive) return fail('Вы выбыли из игры');
    const ph = h.phase || 'play';
    if (ph === 'play' && s.phase !== 'play') return fail('Дождитесь окончания выбора места старта');
    if (ph === 'spawn' && s.phase !== 'spawn') return fail('Выбор места старта уже завершён');
    const err = h.check(this, pid, cmd);
    return err ? fail(err) : OK;
  }

  apply(pid, cmd) {
    const r = this.validate(pid, cmd);
    if (!r.ok) return r;
    try {
      HANDLERS.get(cmd.c).run(this, pid, cmd);
    } catch (e) {
      this.lastError = e;
      return fail('Ошибка команды: ' + (e && e.message ? e.message : String(e)));
    }
    return OK;
  }

  tick(intents) {
    const s = this.s;
    this.events = [];
    this.dirty = [];
    if (s.phase === 'over') return;
    this.tickCache.clear();
    if (intents && intents.length) {
      for (const it of intents) {
        if (!it || !it.cmd) continue;
        const pid = Number(it.pid);
        const r = this.apply(pid, it.cmd);
        if (!r.ok && s.players[pid] && !s.players[pid].ai) this.msg(pid, r.error, 'danger');
      }
    }
    if (typeof AI.runAI === 'function') AI.runAI(this);
    for (const fn of SYSTEMS) {
      fn(this);
      if (s.phase === 'over') break;
    }
    s.tick++;
  }

  hash() { return hashState(this.s); }

  get seconds() { return this.s.tick / TICKS_PER_SEC; }
}

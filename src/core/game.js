import {
  TICK, VERSION, PLAYER_COLORS, TERRAIN, UNITS, UNIT_KEYS, ARMY_BASE_SPEED, BUILDINGS, BUILDING_KEYS,
  RESEARCH, RESEARCH_KEYS, researchCost, researchTime, DRONES, DRONE_SPEED, droneRange, droneCooldown,
  MISSILE, missileRange, missileTroopLoss, siloCooldown, aaRadius, aaCooldown, aaHitChance, ECON, DIFFICULTY,
} from './config.js';
import { makeRng } from './rng.js';

export const emptyTroops = () => ({ inf: 0, tank: 0, art: 0 });
export const troopCount = (t) => t.inf + t.tank + t.art;
const emptyBuildings = () => Object.fromEntries(BUILDING_KEYS.map((k) => [k, 0]));
const emptyResearch = () => Object.fromEntries(RESEARCH_KEYS.map((k) => [k, 0]));

export function popCap(mp, prov) {
  return (ECON.popBase + mp.size * ECON.popPerTile) * (1 + 0.35 * prov.b.house);
}

export function createState(map, opts) {
  const rng = makeRng((opts.seed ^ 0x7777) >>> 0);
  const players = opts.players.map((p, i) => ({
    id: i,
    name: p.name || `Игрок ${i + 1}`,
    color: p.color || PLAYER_COLORS[i % PLAYER_COLORS.length],
    ai: p.ai || null,
    netId: p.netId || null,
    alive: true,
    money: ECON.startMoney,
    mp: ECON.startManpower,
    income: 0, upkeep: 0, mpRate: 0,
    research: emptyResearch(),
    rs: null,
    stats: { captured: 0, lost: 0, kills: 0 },
    aiT: rng.range(0, 1.5),
  }));

  const provs = map.provinces.map((mp) => {
    const P = { o: -1, t: emptyTroops(), b: emptyBuildings(), pop: 0, unrest: 0, build: null, cd: 0, aacd: 0 };
    P.pop = Math.round(popCap(mp, P) * 0.6);
    P.t.inf = Math.round(3 + mp.size * ECON.neutralGarrison * TERRAIN[mp.terrain].def);
    return P;
  });

  const candidates = map.provinces.filter((p) => p.adj.length >= 2 && p.size >= 15);
  const pool = candidates.length >= players.length ? candidates : map.provinces;
  const starts = [];
  starts.push(pool[Math.floor(rng.next() * pool.length)].id);
  while (starts.length < players.length) {
    let best = null, bestD = -1;
    for (const c of pool) {
      if (starts.includes(c.id)) continue;
      let d = Infinity;
      for (const s of starts) d = Math.min(d, Math.hypot(c.cx - map.provinces[s].cx, c.cy - map.provinces[s].cy));
      d += rng.next() * 3;
      if (d > bestD) { bestD = d; best = c; }
    }
    starts.push(best.id);
  }
  players.forEach((pl, i) => {
    const P = provs[starts[i]];
    P.o = pl.id;
    P.t = { inf: 40, tank: 4, art: 2 };
    P.b.fort = 1; P.b.factory = 1; P.b.house = 1;
    P.pop = Math.round(popCap(map.provinces[starts[i]], P));
  });

  return {
    version: VERSION,
    time: 0,
    tickN: 0,
    nextId: 1,
    rngState: (opts.seed * 2654435761) >>> 0,
    mapDesc: map.desc,
    victoryShare: opts.victoryShare || 0.7,
    winner: null,
    players,
    provs,
    armies: [],
    shots: [],
  };
}

export class Game {
  constructor(map, state) {
    this.map = map;
    this.s = state;
    this.fx = [];
  }

  rand() {
    let t = (this.s.rngState = (this.s.rngState + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  emit(e) { this.fx.push(e); }
  msg(to, text, kind = 'info') { this.fx.push({ k: 'msg', to, text, kind }); }

  dist(a, b) {
    const A = this.map.provinces[a], B = this.map.provinces[b];
    return Math.hypot(A.cx - B.cx, A.cy - B.cy);
  }
  ownedCount(pid) {
    let n = 0;
    for (const P of this.s.provs) if (P.o === pid) n++;
    return n;
  }
  buildingCount(pid, k) {
    let n = 0;
    for (const P of this.s.provs) if (P.o === pid) n += P.b[k] + (P.build && P.build.k === k ? 1 : 0);
    return n;
  }
  buildCost(pid, k, nextLvl) {
    return Math.round(BUILDINGS[k].cost * nextLvl * (1 + ECON.buildingScale * this.buildingCount(pid, k)));
  }
  researchMul(pid, key) {
    if (pid < 0) return 1;
    return 1 + 0.15 * this.s.players[pid].research[key];
  }
  attackPower(pid, t) {
    let s = 0;
    for (const k of UNIT_KEYS) s += t[k] * UNITS[k].atk * this.researchMul(pid, UNITS[k].research);
    return s;
  }
  rawDefense(pid, t) {
    let s = 0;
    for (const k of UNIT_KEYS) s += t[k] * UNITS[k].def * this.researchMul(pid, UNITS[k].research);
    return s;
  }
  fortMul(pIdx, attacker, attTroops) {
    const P = this.s.provs[pIdx];
    if (!P.b.fort) return 1;
    const fortRes = P.o >= 0 ? this.s.players[P.o].research.fort : 0;
    let pierce = 0;
    if (attacker >= 0 && attTroops) {
      const total = troopCount(attTroops);
      if (total > 0) pierce = Math.min(0.9, (attTroops.art / total) * 2 * UNITS.art.fortPierce * (1 + 0.1 * this.s.players[attacker].research.art));
    }
    return 1 + P.b.fort * 0.35 * (1 + 0.1 * fortRes) * (1 - pierce);
  }
  defensePower(pIdx, attacker = -1, attTroops = null) {
    const P = this.s.provs[pIdx], mp = this.map.provinces[pIdx];
    const militia = 1 + mp.size * 0.1;
    return (this.rawDefense(P.o, P.t) + militia) * TERRAIN[mp.terrain].def * this.fortMul(pIdx, attacker, attTroops);
  }
  armySpeed(pid, t) {
    let spd = Infinity;
    for (const k of UNIT_KEYS) if (t[k] > 0) spd = Math.min(spd, UNITS[k].speed);
    if (!isFinite(spd)) spd = 1;
    return spd * ARMY_BASE_SPEED * (1 + 0.12 * this.s.players[pid].research.logistics);
  }
  canBuild(pid, pIdx, k) {
    const P = this.s.provs[pIdx], B = BUILDINGS[k];
    if (!B || P.o !== pid) return 'Не ваша провинция';
    if (P.build) return 'Уже идёт строительство';
    if (P.b[k] >= B.max) return 'Максимальный уровень';
    if (B.req && this.s.players[pid].research[B.req[0]] < B.req[1]) return `Нужно исследование «${RESEARCH[B.req[0]].name}» ур. ${B.req[1]}`;
    const cost = this.buildCost(pid, k, P.b[k] + 1);
    if (this.s.players[pid].money < cost) return 'Недостаточно денег';
    return null;
  }

  findPath(pid, from, to) {
    if (from === to) return null;
    const provs = this.s.provs, adj = this.map.provinces;
    const prev = new Int32Array(provs.length).fill(-2);
    prev[from] = -1;
    const q = [from];
    for (let h = 0; h < q.length; h++) {
      const c = q[h];
      for (const n of adj[c].adj) {
        if (prev[n] !== -2) continue;
        prev[n] = c;
        if (n === to) {
          const path = [to];
          let x = c;
          while (x !== -1) { path.push(x); x = prev[x]; }
          return path.reverse();
        }
        if (provs[n].o === pid) q.push(n);
      }
    }
    return null;
  }

  command(pid, cmd) {
    const pl = this.s.players[pid];
    if (!pl || !pl.alive || this.s.winner !== null) return { ok: false, error: 'Недоступно' };
    const fn = this['cmd_' + cmd.c];
    if (!fn) return { ok: false, error: 'Неизвестная команда' };
    try {
      const err = fn.call(this, pid, cmd);
      return err ? { ok: false, error: err } : { ok: true };
    } catch (e) {
      return { ok: false, error: 'Ошибка команды: ' + e.message };
    }
  }

  validProv(p) { return Number.isInteger(p) && p >= 0 && p < this.s.provs.length; }

  cmd_build(pid, { p, k }) {
    if (!this.validProv(p)) return 'Неверная провинция';
    const err = this.canBuild(pid, p, k);
    if (err) return err;
    const P = this.s.provs[p], lvl = P.b[k] + 1;
    const cost = this.buildCost(pid, k, lvl);
    this.s.players[pid].money -= cost;
    P.build = { k, t: 0, total: BUILDINGS[k].time * lvl, cost };
    return null;
  }

  cmd_cancelBuild(pid, { p }) {
    if (!this.validProv(p)) return 'Неверная провинция';
    const P = this.s.provs[p];
    if (P.o !== pid || !P.build) return 'Нечего отменять';
    this.s.players[pid].money += Math.round(P.build.cost * 0.5);
    P.build = null;
    return null;
  }

  cmd_recruit(pid, { p, u, n }) {
    if (!this.validProv(p)) return 'Неверная провинция';
    const P = this.s.provs[p], U = UNITS[u], pl = this.s.players[pid];
    if (!U) return 'Неизвестный тип войск';
    if (P.o !== pid) return 'Не ваша провинция';
    if (U.needs && P.b[U.needs] < 1) return `Нужна постройка «${BUILDINGS[U.needs].name}»`;
    n = Math.floor(Math.min(Number(n) || 0, 10000, pl.money / U.cost, pl.mp / U.mp));
    if (n < 1) return 'Недостаточно денег или людских резервов';
    pl.money -= n * U.cost;
    pl.mp -= n * U.mp;
    P.t[u] += n;
    return null;
  }

  cmd_move(pid, { from, to, frac, units }) {
    if (!this.validProv(from) || !this.validProv(to)) return 'Неверная провинция';
    const P = this.s.provs[from];
    if (P.o !== pid) return 'Не ваша провинция';
    const path = this.findPath(pid, from, to);
    if (!path) return 'Нет пути (нужен общий рубеж или морской путь)';
    frac = Math.max(0, Math.min(1, Number(frac) || 0));
    const t = emptyTroops();
    for (const k of UNIT_KEYS) {
      if (units && units[k] === false) continue;
      t[k] = Math.floor(P.t[k] * frac + 1e-9);
      if (frac >= 1) t[k] = P.t[k];
    }
    if (troopCount(t) < 1) return 'Нет войск для отправки';
    for (const k of UNIT_KEYS) P.t[k] -= t[k];
    this.s.armies.push({ id: this.s.nextId++, o: pid, path, i: 0, p: 0, t, spd: this.armySpeed(pid, t) });
    return null;
  }

  cmd_research(pid, { k }) {
    const pl = this.s.players[pid], R = RESEARCH[k];
    if (!R) return 'Неизвестное исследование';
    if (pl.rs) return 'Уже идёт исследование';
    const lvl = pl.research[k];
    if (lvl >= R.max) return 'Исследовано полностью';
    const cost = researchCost(k, lvl);
    if (pl.money < cost) return 'Недостаточно денег';
    pl.money -= cost;
    pl.rs = { k, t: 0, total: researchTime(lvl) };
    return null;
  }

  cmd_drone(pid, { from, to, d }) {
    if (!this.validProv(from) || !this.validProv(to)) return 'Неверная провинция';
    const P = this.s.provs[from], pl = this.s.players[pid], D = DRONES[d];
    if (!D) return 'Неизвестный тип БПЛА';
    if (P.o !== pid) return 'Не ваша провинция';
    if (P.b.airbase < 1) return 'Нужен аэродром БПЛА';
    if (pl.research.drone < D.lvl) return `Нужно исследование «БПЛА» ур. ${D.lvl}`;
    if (this.s.provs[to].o === pid) return 'Нельзя атаковать свою провинцию';
    if (P.cd > 0) return `Перезарядка: ${Math.ceil(P.cd)} с`;
    if (this.dist(from, to) > droneRange(P.b.airbase, pl.research.drone)) return 'Цель вне радиуса действия';
    if (pl.money < D.cost) return 'Недостаточно денег';
    pl.money -= D.cost;
    P.cd = droneCooldown(P.b.airbase);
    const A = this.map.provinces[from], B = this.map.provinces[to];
    for (let i = 0; i < D.count; i++) {
      const off = D.count > 1 ? (i - (D.count - 1) / 2) * 1.2 : 0;
      this.s.shots.push({
        id: this.s.nextId++, o: pid, kind: 'drone', d, from, to,
        x: A.cx + 0.5 + off, y: A.cy + 0.5 - Math.abs(off) * 0.5, tx: B.cx + 0.5, ty: B.cy + 0.5,
        sp: DRONE_SPEED * (1 - i * 0.03), lvl: pl.research.drone, hit: [],
      });
    }
    this.emit({ k: 'launch', kind: 'drone', p: from, o: pid });
    return null;
  }

  cmd_missile(pid, { from, to }) {
    if (!this.validProv(from) || !this.validProv(to)) return 'Неверная провинция';
    const P = this.s.provs[from], pl = this.s.players[pid];
    if (P.o !== pid) return 'Не ваша провинция';
    if (P.b.silo < 1) return 'Нужна ракетная шахта';
    if (this.s.provs[to].o === pid) return 'Нельзя атаковать свою провинцию';
    if (P.cd > 0) return `Перезарядка: ${Math.ceil(P.cd)} с`;
    if (this.dist(from, to) > missileRange(pl.research.missile)) return 'Цель вне радиуса действия';
    if (pl.money < MISSILE.cost) return 'Недостаточно денег';
    pl.money -= MISSILE.cost;
    P.cd = siloCooldown(P.b.silo);
    const A = this.map.provinces[from], B = this.map.provinces[to];
    this.s.shots.push({
      id: this.s.nextId++, o: pid, kind: 'missile', from, to,
      x: A.cx + 0.5, y: A.cy + 0.5, sx: A.cx + 0.5, sy: A.cy + 0.5, tx: B.cx + 0.5, ty: B.cy + 0.5,
      sp: MISSILE.speed, lvl: pl.research.missile, hit: [],
    });
    this.emit({ k: 'launch', kind: 'missile', p: from, o: pid });
    const target = this.s.provs[to].o;
    if (target >= 0) this.msg(target, `${pl.name} запустил ракету по вашей территории!`, 'danger');
    return null;
  }

  tick() {
    const s = this.s;
    if (s.winner !== null) return;
    this.fx = [];
    const dt = TICK;
    s.time += dt;
    s.tickN++;
    this.tickEconomy(dt);
    this.tickProvinces(dt);
    this.tickArmies(dt);
    this.tickShots(dt);
    if (s.tickN % 4 === 0) this.checkVictory();
  }

  tickEconomy(dt) {
    const s = this.s;
    const acc = s.players.map(() => ({ tax: 0, fac: 0, mp: 0, up: 0, n: 0, pop: 0 }));
    s.provs.forEach((P) => {
      if (P.o < 0) return;
      const a = acc[P.o];
      a.n++;
      a.pop += P.pop;
      a.tax += P.pop * ECON.taxPerPop * (P.unrest > 0 ? 0.5 : 1);
      a.fac += P.b.factory * ECON.factoryIncome;
      a.mp += P.pop * ECON.manpowerPerPop;
      for (const k of UNIT_KEYS) a.up += P.t[k] * UNITS[k].upkeep;
      for (const k of BUILDING_KEYS) a.up += P.b[k] * BUILDINGS[k].upkeep;
    });
    for (const A of s.armies) for (const k of UNIT_KEYS) acc[A.o].up += A.t[k] * UNITS[k].upkeep;

    s.players.forEach((pl, i) => {
      if (!pl.alive) return;
      const a = acc[i];
      const eff = 1 / (1 + Math.max(0, a.n - ECON.overextensionFree) * ECON.overextension);
      const diff = pl.ai ? DIFFICULTY[pl.ai].income : 1;
      const econ = 1 + 0.1 * pl.research.econ;
      pl.income = (a.tax + a.fac) * eff * econ * diff;
      pl.upkeep = a.up * (1 - 0.1 * pl.research.logistics);
      pl.mpRate = a.mp * (pl.ai ? diff : 1);
      pl.money = Math.min(ECON.maxMoney, pl.money + (pl.income - pl.upkeep) * dt);
      pl.mp = Math.min(60 + a.pop * 3, pl.mp + pl.mpRate * dt);
      if (pl.money < 0) {
        const loss = ECON.debtDesertion * dt;
        for (const P of s.provs) if (P.o === i) for (const k of UNIT_KEYS) P.t[k] = Math.floor(P.t[k] * (1 - loss));
        for (const A of s.armies) if (A.o === i) for (const k of UNIT_KEYS) A.t[k] = Math.floor(A.t[k] * (1 - loss));
        if (s.tickN % 40 === 0) this.msg(i, 'Казна пуста! Войска дезертируют — сократите армию или постройте фабрики.', 'danger');
      }
      if (pl.rs) {
        pl.rs.t += dt;
        if (pl.rs.t >= pl.rs.total) {
          pl.research[pl.rs.k]++;
          this.msg(i, `Исследовано: ${RESEARCH[pl.rs.k].name} ур. ${pl.research[pl.rs.k]}`, 'good');
          this.emit({ k: 'research', o: i });
          pl.rs = null;
        }
      }
    });
  }

  tickProvinces(dt) {
    this.s.provs.forEach((P, i) => {
      const mp = this.map.provinces[i];
      const cap = popCap(mp, P);
      const g = ECON.growth * TERRAIN[mp.terrain].grow * (1 + 0.25 * P.b.house);
      P.pop += (cap - P.pop) * g * dt;
      if (P.unrest > 0) P.unrest = Math.max(0, P.unrest - dt);
      if (P.cd > 0) P.cd = Math.max(0, P.cd - dt);
      if (P.aacd > 0) P.aacd = Math.max(0, P.aacd - dt);
      if (P.build) {
        P.build.t += dt;
        if (P.build.t >= P.build.total) {
          P.b[P.build.k]++;
          if (P.o >= 0) this.msg(P.o, `Построено: ${BUILDINGS[P.build.k].name} ур. ${P.b[P.build.k]}`, 'good');
          this.emit({ k: 'built', p: i });
          P.build = null;
        }
      }
    });
  }

  tickArmies(dt) {
    const s = this.s, provs = this.map.provinces;
    const done = [];
    for (const A of s.armies) {
      if (troopCount(A.t) <= 0) { done.push(A); continue; }
      const a = A.path[A.i], b = A.path[A.i + 1];
      const sea = !provs[a].neighbors.includes(b);
      const len = Math.max(1, this.dist(a, b));
      A.p += (A.spd * (sea ? 0.6 : 1) * dt) / len;
      if (A.p < 1) continue;
      A.i++; A.p = 0;
      const here = A.path[A.i];
      const last = A.i >= A.path.length - 1;
      if (!last && s.provs[here].o === A.o) continue;
      this.arrive(A, here);
      done.push(A);
    }
    if (done.length) s.armies = s.armies.filter((A) => !done.includes(A));
  }

  applyLoss(t, frac) {
    let lost = 0;
    for (const k of UNIT_KEYS) {
      const n = Math.round(t[k] * (1 - frac));
      lost += t[k] - n;
      t[k] = Math.max(0, n);
    }
    return lost;
  }

  arrive(A, pIdx) {
    const s = this.s, P = s.provs[pIdx];
    if (P.o === A.o) {
      for (const k of UNIT_KEYS) P.t[k] += A.t[k];
      return;
    }
    const att = this.attackPower(A.o, A.t);
    const def = this.defensePower(pIdx, A.o, A.t);
    const mp = this.map.provinces[pIdx];
    const attacker = s.players[A.o];
    const defender = P.o;
    this.emit({ k: 'battle', p: pIdx, x: mp.cx, y: mp.cy });
    if (att > def) {
      const lossFrac = Math.min(0.95, Math.pow(def / att, 1.3) * 0.9);
      const lostA = this.applyLoss(A.t, lossFrac);
      const lostD = troopCount(P.t);
      if (defender >= 0) {
        s.players[defender].stats.lost++;
        s.players[defender].stats.kills += lostA;
        this.msg(defender, `${attacker.name} захватил вашу провинцию!`, 'danger');
      }
      attacker.stats.captured++;
      attacker.stats.kills += lostD;
      P.o = A.o;
      P.t = { ...A.t };
      if (troopCount(P.t) === 0) P.t.inf = 1;
      if (P.b.fort > 0) P.b.fort--;
      P.pop *= 0.7;
      P.unrest = ECON.unrestTime;
      P.build = null;
      P.cd = Math.max(P.cd, 10);
      this.emit({ k: 'capture', p: pIdx, o: A.o, from: defender });
    } else {
      const lossFrac = Math.min(0.95, Math.pow(att / def, 1.3) * 0.9);
      const lostD = this.applyLoss(P.t, lossFrac);
      attacker.stats.kills += lostD;
      if (defender >= 0) {
        s.players[defender].stats.kills += troopCount(A.t);
        this.msg(defender, `Атака ${attacker.name} отбита!`, 'good');
      }
      this.msg(A.o, 'Атака отбита — не хватило сил.', 'danger');
      this.emit({ k: 'repelled', p: pIdx, o: A.o });
    }
  }

  tickShots(dt) {
    const s = this.s;
    const done = new Set();
    const aaSites = [];
    s.provs.forEach((P, i) => { if (P.o >= 0 && P.b.aa > 0) aaSites.push(i); });
    for (const S of s.shots) {
      const dx = S.tx - S.x, dy = S.ty - S.y, d = Math.hypot(dx, dy);
      const step = S.sp * dt;
      if (d <= step) {
        S.x = S.tx; S.y = S.ty;
        this.impact(S);
        done.add(S.id);
        continue;
      }
      S.x += (dx / d) * step; S.y += (dy / d) * step;
      for (const i of aaSites) {
        const P = s.provs[i];
        if (P.o === S.o || P.aacd > 0 || S.hit.includes(i)) continue;
        const mp = this.map.provinces[i];
        if (Math.hypot(mp.cx + 0.5 - S.x, mp.cy + 0.5 - S.y) > aaRadius(P.b.aa)) continue;
        const res = s.players[P.o].research.aa;
        S.hit.push(i);
        P.aacd = aaCooldown(P.b.aa, res);
        this.emit({ k: 'aafire', p: i, x: S.x, y: S.y });
        if (this.rand() < aaHitChance(S.kind, P.b.aa, res)) {
          this.emit({ k: 'intercept', x: S.x, y: S.y, kind: S.kind });
          if (S.kind === 'missile') this.msg(P.o, 'ПВО сбила вражескую ракету!', 'good');
          done.add(S.id);
          break;
        }
      }
    }
    if (done.size) s.shots = s.shots.filter((S) => !done.has(S.id));
  }

  impact(S) {
    const s = this.s, P = s.provs[S.to], mp = this.map.provinces[S.to];
    if (P.o === S.o) return;
    const victim = P.o;
    if (S.kind === 'drone') {
      const D = DRONES[S.d];
      const dmg = D.dmg * (1 + 0.25 * (S.lvl - 1)) / (1 + 0.1 * P.b.fort);
      const raw = this.rawDefense(P.o, P.t);
      const frac = raw > 0 ? Math.min(1, dmg / raw) : 0;
      const killed = this.applyLoss(P.t, frac);
      s.players[S.o].stats.kills += killed;
      if (D.bldg) this.damageBuilding(P, ['aa', 'silo', 'airbase', 'factory', 'fort', 'house']);
      this.emit({ k: 'boom', x: S.tx, y: S.ty, big: false });
    } else {
      const killed = this.applyLoss(P.t, missileTroopLoss(S.lvl));
      s.players[S.o].stats.kills += killed;
      const order = BUILDING_KEYS.filter((k) => P.b[k] > 0).sort(() => this.rand() - 0.5);
      for (const k of order.slice(0, S.lvl >= 3 ? 3 : 2)) P.b[k]--;
      P.build = null;
      P.pop *= 0.75;
      this.emit({ k: 'boom', x: S.tx, y: S.ty, big: true });
      if (victim >= 0) this.msg(victim, `Ракетный удар по провинции! Потери: ${killed}`, 'danger');
    }
  }

  damageBuilding(P, priority) {
    for (const k of priority) {
      if (P.b[k] > 0) { P.b[k]--; return k; }
    }
    if (P.build) P.build = null;
    return null;
  }

  checkVictory() {
    const s = this.s;
    const counts = s.players.map(() => 0);
    for (const P of s.provs) if (P.o >= 0) counts[P.o]++;
    const armyOwners = new Set(s.armies.map((A) => A.o));
    s.players.forEach((pl, i) => {
      if (pl.alive && counts[i] === 0 && !armyOwners.has(i)) {
        pl.alive = false;
        this.emit({ k: 'eliminated', o: i });
        this.msg(-1, `${pl.name} выбывает из игры`, 'info');
      }
    });
    const alive = s.players.filter((p) => p.alive);
    const total = s.provs.length;
    const leader = counts.indexOf(Math.max(...counts));
    if (alive.length <= 1 || counts[leader] >= total * s.victoryShare) {
      s.winner = alive.length === 1 ? alive[0].id : leader;
      this.emit({ k: 'victory', o: s.winner });
    }
  }
}

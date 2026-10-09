import {
  ECON, ARMY, RESEARCH, BUILDINGS, SHIPS, TICKS_PER_SEC, DIFFICULTY, researchCost, researchTicks, dpow,
} from './config.js';

const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

export const INTENTS = {
  research: { phase: 'any', check: checkResearch, run: runResearch },
};

export function researchError(game, pid, key) {
  if (!has(RESEARCH, key)) return 'Неизвестное исследование';
  const p = game.s.players[pid];
  const def = RESEARCH[key];
  if (p.researching) return 'Уже идёт другое исследование';
  const lvl = p.research[key];
  if (lvl >= def.max) return 'Достигнут максимальный уровень';
  if (def.req && p.research[def.req[0]] < def.req[1]) return `Сначала исследуйте «${RESEARCH[def.req[0]].name}» до ${def.req[1]} ур.`;
  const cost = researchCost(key, lvl);
  if (p.gold < cost) return `Нужно ${cost} золота`;
  return null;
}

function checkResearch(game, pid, cmd) {
  return researchError(game, pid, cmd.key);
}

function runResearch(game, pid, cmd) {
  const p = game.s.players[pid];
  const lvl = p.research[cmd.key];
  p.gold -= researchCost(cmd.key, lvl);
  p.researching = { key: cmd.key, progress: 0, total: researchTicks(lvl) };
}

const emptyAssets = () => ({
  houseLv: 0, factoryLv: 0, factories: 0, ports: 0, forts: 0, samLv: 0, airbases: 0, silos: 0,
  warships: 0, transports: 0, trade: 0,
});

export function playerAssets(game) {
  const s = game.s;
  const out = s.players.map(emptyAssets);
  for (const b of s.buildings) {
    const a = out[b.owner];
    if (!a || !game.buildingActive(b)) continue;
    switch (b.type) {
      case 'house': a.houseLv += b.level; break;
      case 'factory': a.factoryLv += b.level; a.factories++; break;
      case 'port': a.ports++; break;
      case 'fort': a.forts++; break;
      case 'sam': a.samLv += b.level; break;
      case 'airbase': a.airbases++; break;
      case 'silo': a.silos++; break;
      default: break;
    }
  }
  for (const u of s.units) {
    const a = out[u.owner];
    if (!a) continue;
    if (u.type === 'warship') a.warships++;
    else if (u.type === 'transport') a.transports++;
    else if (u.type === 'trade') a.trade++;
  }
  return out;
}

export function incomeMult(p) {
  const diff = p.ai ? (DIFFICULTY[p.ai] || DIFFICULTY.normal).income : 1;
  return (1 + ECON.incomeEcon * p.research.econ) * diff;
}

export function maxTroopsOf(p, a) {
  return ECON.troopsBase + p.tiles * ECON.troopsPerTile + a.houseLv * ECON.houseTroops;
}

export function troopGrowth(p) {
  const T = Math.max(0, p.troops), M = p.maxTroops;
  if (T >= M) return -Math.min(T - M, (T * ECON.overCapDecay) / TICKS_PER_SEC);
  return (ECON.growthBase + dpow(T, ECON.growthExp) / ECON.growthDiv) * (1 - T / M) * (1 + ECON.growthEcon * p.research.econ);
}

function updateIncome(p, a) {
  const base = p.tiles * ECON.incomePerTile
    + Math.sqrt(Math.max(0, p.troops)) * ECON.incomeTroops
    + a.houseLv * ECON.houseIncome
    + (a.ports ? 0 : a.factoryLv * ECON.factoryDirect);
  p.incBase = base * incomeMult(p);
  p.eventIncome = p.eventIncome * (1 - ECON.eventIncomeAlpha) + p.eventAcc * ECON.eventIncomeAlpha;
  p.eventAcc = 0;
  p.income = p.incBase + p.eventIncome;
  p.upkeep = a.warships * SHIPS.warship.upkeep
    + a.samLv * BUILDINGS.sam.upkeep
    + a.silos * BUILDINGS.silo.upkeep
    + a.airbases * BUILDINGS.airbase.upkeep;
}

const approach = (v, target, step) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));

export function targetComposition(p, a) {
  const r = p.research;
  const fac = a.factories;
  const tank = r.armor >= 1 && fac > 0 ? Math.min(ARMY.tankMax, ARMY.tankPerArmor * r.armor + ARMY.tankPerFactory * fac) : 0;
  const art = r.art >= 1 && fac > 0 ? Math.min(ARMY.artMax, ARMY.artPerLevel * r.art) : 0;
  return { tank, art };
}

function updateComposition(p, a) {
  const t = targetComposition(p, a);
  const c = p.composition;
  c.tank = approach(c.tank, t.tank, ARMY.shiftPerSec);
  c.art = approach(c.art, t.art, ARMY.shiftPerSec);
  c.inf = 1 - c.tank - c.art;
}

function tickResearch(game, p) {
  const r = p.researching;
  if (!r) return;
  r.progress++;
  if (r.progress < r.total) return;
  p.research[r.key] = Math.min(RESEARCH[r.key].max, p.research[r.key] + 1);
  p.researching = null;
  game.emit({ k: 'research', pid: p.id, key: r.key });
  game.msg(p.id, `Исследование завершено: ${RESEARCH[r.key].name}, ур. ${p.research[r.key]}`, 'good');
}

export function tickEconomy(game) {
  const s = game.s;
  if (s.phase === 'over') return;
  const assets = playerAssets(game);
  const play = s.phase === 'play';
  const second = s.tick % TICKS_PER_SEC === 0;
  for (const p of s.players) {
    if (!p.alive) continue;
    const a = assets[p.id];
    p.maxTroops = maxTroopsOf(p, a);
    if (!play) continue;
    if (second) {
      updateIncome(p, a);
      updateComposition(p, a);
      if (p.tiles > p.stats.peakTiles) p.stats.peakTiles = p.tiles;
    }
    if (p.spawned) p.troops = Math.max(0, p.troops + troopGrowth(p));
    const net = (p.incBase - p.upkeep) / TICKS_PER_SEC;
    p.gold = Math.min(ECON.maxGold, p.gold + net);
    if (p.incBase > 0) p.stats.goldEarned += p.incBase / TICKS_PER_SEC;
    if (p.gold < 0) p.troops -= (p.troops * ECON.desertion) / TICKS_PER_SEC;
    tickResearch(game, p);
  }
}

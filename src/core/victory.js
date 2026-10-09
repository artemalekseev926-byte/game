import { VICTORY, WIN_REASONS, TICKS_PER_SEC } from './config.js';
import { cancelAttacks } from './territory.js';

export const INTENTS = {
  surrender: { phase: 'any', check: () => null, run: runSurrender },
};

function runSurrender(game, pid) {
  const s = game.s, own = s.owner, me = pid + 1, land = game.landList;
  for (let k = 0; k < land.length; k++) if (own[land[k]] === me) game.setOwner(land[k], -1);
  eliminate(game, pid, 'surrender');
}

export function eliminate(game, pid, reason = '') {
  const s = game.s, p = s.players[pid];
  if (!p || !p.alive) return;
  p.alive = false;
  p.eliminatedAt = s.tick;
  p.researching = null;
  p.troops = 0;
  cancelAttacks(game, (a) => a.attacker === pid, false);
  s.requests = s.requests.filter((r) => r.from !== pid && r.to !== pid);
  if (s.units.some((u) => u.owner === pid)) s.units = s.units.filter((u) => u.owner !== pid);
  for (const b of s.buildings.filter((q) => q.owner === pid)) game.destroyBuilding(b, -1, true);
  game.emit({ k: 'eliminated', pid, reason });
  game.msg(-1, reason === 'surrender' ? `${p.name} сдался` : `${p.name} выбывает из игры`, 'danger');
}

function hasForcesAfloat(game, pid) {
  const s = game.s;
  for (const u of s.units) if (u.owner === pid && u.type === 'transport') return true;
  for (const a of s.attacks) if (a.attacker === pid && a.landing >= 0) return true;
  return false;
}

function checkEliminations(game) {
  for (const p of game.s.players) {
    if (p.alive && p.tiles === 0 && !hasForcesAfloat(game, p.id)) eliminate(game, p.id, 'territory');
  }
}

export function finish(game, pid, reason) {
  const s = game.s;
  if (s.phase === 'over') return;
  s.phase = 'over';
  s.winner = pid;
  s.winReason = reason;
  game.emit({ k: 'victory', pid, reason });
  const p = s.players[pid];
  game.msg(-1, p ? `Победа: ${p.name} — ${WIN_REASONS[reason]}` : 'Игра окончена: победителей нет', 'good');
}

function allAllied(game, alive) {
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) if (!game.isAllied(alive[i].id, alive[j].id)) return false;
  }
  return true;
}

function leaderByTiles(alive) {
  let best = alive[0];
  for (const p of alive) if (p.tiles > best.tiles) best = p;
  return best.id;
}

export function territoryGoal(game) {
  return Math.ceil((game.map.landCount * game.s.settings.victory.territoryPct) / 100);
}

export function econStanding(alive) {
  let best = -1, bv = -Infinity, sv = -Infinity;
  for (const p of alive) {
    const r = p.income - p.upkeep;
    if (r > bv) { sv = bv; bv = r; best = p.id; } else if (r > sv) sv = r;
  }
  const lead = best >= 0 && bv > 0 && bv >= sv * (1 + VICTORY.econLead) && bv > sv;
  return { leader: lead ? best : -1, best, value: bv, second: sv };
}

function checkEconomy(game, alive) {
  const s = game.s, v = s.settings.victory;
  const st = econStanding(alive);
  if (st.leader < 0) {
    s.econLeader = -1;
    s.econLeadTicks = 0;
    return;
  }
  if (s.econLeader !== st.leader) {
    s.econLeader = st.leader;
    s.econLeadTicks = 0;
  }
  s.econLeadTicks += VICTORY.econCheckEvery;
  if (s.econLeadTicks >= v.economyMinutes * 60 * TICKS_PER_SEC) finish(game, st.leader, 'economy');
}

export function tickVictory(game) {
  const s = game.s;
  if (s.phase !== 'play') return;
  checkEliminations(game);
  const alive = s.players.filter((p) => p.alive);
  if (s.players.length > 1) {
    if (!alive.length) { finish(game, -1, 'survivor'); return; }
    if (alive.length === 1) { finish(game, alive[0].id, 'survivor'); return; }
    if (allAllied(game, alive)) { finish(game, leaderByTiles(alive), 'survivor'); return; }
  }
  const v = s.settings.victory;
  if (v.territory && game.map.landCount > 0) {
    const need = territoryGoal(game);
    let best = null;
    for (const p of alive) if (p.tiles >= need && (!best || p.tiles > best.tiles)) best = p;
    if (best) { finish(game, best.id, 'territory'); return; }
  }
  if (v.economy && s.tick % VICTORY.econCheckEvery === 0) checkEconomy(game, alive);
}

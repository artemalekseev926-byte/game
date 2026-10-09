import { DIPLO, PROPOSALS, RELATIONS } from './config.js';
import { cancelAttacks } from './territory.js';

export const TRAITOR_TICKS = DIPLO.traitorTicks;

export const relKey = (a, b) => (a < b ? a + ':' + b : b + ':' + a);

const TYPE_ACC = { alliance: 'союз', pact: 'пакт о ненападении', trade: 'торговый договор' };

export const INTENTS = {
  propose: { phase: 'any', check: checkPropose, run: runPropose },
  respond: { phase: 'any', check: checkRespond, run: runRespond },
  break: { phase: 'any', check: checkBreak, run: runBreak },
  embargo: { phase: 'any', check: checkEmbargo, run: runEmbargo },
};

function otherPlayer(game, pid, v) {
  const q = Number(v);
  if (!Number.isInteger(q) || q === pid || !game.s.players[q]) return -1;
  return q;
}

export function hasTradeTreaty(game, a, b) {
  const t = game.relation(a, b).type;
  return t === 'trade' || t === 'alliance';
}

function pendingRequest(game, a, b, type) {
  for (const r of game.s.requests) {
    if (r.type === type && ((r.from === a && r.to === b) || (r.from === b && r.to === a))) return r;
  }
  return null;
}

export function proposeError(game, pid, to, type) {
  const q = otherPlayer(game, pid, to);
  if (q < 0) return 'Неизвестный игрок';
  if (!game.s.players[q].alive) return 'Этот игрок выбыл';
  if (typeof type !== 'string' || !PROPOSALS[type]) return 'Неизвестный тип договора';
  const cur = game.relation(pid, q).type;
  if (cur === type) return 'Такой договор уже действует';
  if (cur === 'alliance') return 'Союз уже включает пакт и торговлю';
  const r = pendingRequest(game, pid, q, type);
  if (r && r.from === pid) return 'Предложение уже отправлено';
  return null;
}

function checkPropose(game, pid, cmd) {
  return proposeError(game, pid, cmd.to, cmd.type);
}

function runPropose(game, pid, cmd) {
  const s = game.s;
  const to = Number(cmd.to);
  const back = pendingRequest(game, pid, to, cmd.type);
  if (back) {
    s.requests = s.requests.filter((r) => r !== back);
    establish(game, pid, to, cmd.type);
    return;
  }
  const req = { id: game.nextId(), from: pid, to, type: cmd.type, expires: s.tick + DIPLO.requestTicks, at: s.tick };
  s.requests.push(req);
  game.emit({ k: 'request', req: { ...req } });
  game.msg(to, `${s.players[pid].name} предлагает ${TYPE_ACC[req.type]}`, 'info');
  game.msg(pid, `Предложение отправлено: ${s.players[to].name}`, 'info');
}

function checkRespond(game, pid, cmd) {
  const id = Number(cmd.id);
  const r = game.s.requests.find((q) => q.id === id);
  if (!r || r.to !== pid) return 'Предложение не найдено';
  return null;
}

function runRespond(game, pid, cmd) {
  const id = Number(cmd.id);
  const r = game.s.requests.find((q) => q.id === id);
  answer(game, r, !!cmd.accept);
}

export function answer(game, r, accept) {
  const s = game.s;
  s.requests = s.requests.filter((q) => q !== r);
  const from = s.players[r.from], to = s.players[r.to];
  if (!from || !to || !from.alive || !to.alive) return;
  if (accept) {
    establish(game, r.from, r.to, r.type);
  } else {
    game.msg(r.from, `${to.name} отклонил ${TYPE_ACC[r.type]}`, 'info');
  }
}

export function establish(game, a, b, type) {
  const s = game.s;
  const key = relKey(a, b);
  const prev = s.relations[key];
  const emb = prev ? prev.emb | 0 : 0;
  s.relations[key] = { type, until: type === 'pact' ? s.tick + DIPLO.pactTicks : 0, embargo: emb !== 0, emb };
  if (type === 'alliance' || type === 'pact') {
    cancelAttacks(game, (x) => (x.attacker === a && x.target === b) || (x.attacker === b && x.target === a));
  }
  game.emit({ k: 'relation', a, b, type });
  const A = s.players[a], B = s.players[b];
  const text = RELATIONS[type];
  game.msg(a, `${text}: ${B.name}`, 'good');
  game.msg(b, `${text}: ${A.name}`, 'good');
}

export function markTraitor(game, pid) {
  const p = game.s.players[pid];
  if (!p) return;
  p.traitorUntil = game.s.tick + TRAITOR_TICKS;
}

export function breakRelation(game, a, b, traitor = false) {
  const s = game.s;
  const key = relKey(a, b);
  const r = s.relations[key];
  if (!r || r.type === 'none') return false;
  const was = r.type;
  r.type = 'none';
  r.until = 0;
  if (!r.embargo) delete s.relations[key];
  if (traitor) {
    markTraitor(game, a);
    game.msg(-1, `${s.players[a].name} нарушил договор и считается предателем`, 'danger');
  }
  game.emit({ k: 'relation', a, b, type: 'none' });
  game.msg(b, `${s.players[a].name} разорвал договор (${RELATIONS[was]})`, 'danger');
  game.msg(a, `Договор разорван: ${s.players[b].name}`, 'info');
  return true;
}

function checkBreak(game, pid, cmd) {
  const q = otherPlayer(game, pid, cmd.with);
  if (q < 0) return 'Неизвестный игрок';
  if (game.relation(pid, q).type === 'none') return 'Нет действующего договора';
  return null;
}

function runBreak(game, pid, cmd) {
  const q = Number(cmd.with);
  const r = game.relation(pid, q);
  const traitor = r.type === 'alliance' || (r.type === 'pact' && r.until > game.s.tick);
  breakRelation(game, pid, q, traitor);
}

function checkEmbargo(game, pid, cmd) {
  if (otherPlayer(game, pid, cmd.with) < 0) return 'Неизвестный игрок';
  return null;
}

export function embargoBy(game, pid, q) {
  const r = game.relation(pid, q);
  return !!((r.emb | 0) & (pid < q ? 1 : 2));
}

function runEmbargo(game, pid, cmd) {
  const s = game.s;
  const q = Number(cmd.with);
  const key = relKey(pid, q);
  const on = cmd.on === undefined ? !embargoBy(game, pid, q) : !!cmd.on;
  let r = s.relations[key];
  if (!r) r = s.relations[key] = { type: 'none', until: 0, embargo: false, emb: 0 };
  const bit = pid < q ? 1 : 2;
  r.emb = on ? (r.emb | 0) | bit : (r.emb | 0) & ~bit;
  r.embargo = r.emb !== 0;
  if (r.type === 'none' && !r.embargo) delete s.relations[key];
  game.emit({ k: 'relation', a: pid, b: q, type: r.type, embargo: r.embargo });
  const P = s.players;
  if (on) {
    game.msg(q, `${P[pid].name} ввёл против вас эмбарго`, 'danger');
    game.msg(pid, `Эмбарго против ${P[q].name} введено`, 'info');
  } else {
    game.msg(q, `${P[pid].name} снял эмбарго`, 'good');
    game.msg(pid, `Эмбарго против ${P[q].name} снято`, 'info');
  }
}

function tickRequests(game) {
  const s = game.s;
  const list = s.requests.slice();
  for (const r of list) {
    if (!s.requests.includes(r)) continue;
    const from = s.players[r.from], to = s.players[r.to];
    if (!from || !to || !from.alive || !to.alive) {
      s.requests = s.requests.filter((q) => q !== r);
      continue;
    }
    if (s.tick >= r.expires) {
      s.requests = s.requests.filter((q) => q !== r);
      game.msg(r.from, `${to.name} не ответил на предложение`, 'info');
      continue;
    }
    if (to.ai && s.tick - (r.at ?? r.expires - DIPLO.requestTicks) >= DIPLO.aiReplyEvery) {
      const v = game.aiRespond(r.to, r);
      if (v === true || v === false) answer(game, r, v);
    }
  }
}

function tickPacts(game) {
  const s = game.s;
  const keys = Object.keys(s.relations).sort();
  for (const key of keys) {
    const r = s.relations[key];
    if (r.type !== 'pact' || !r.until || r.until > s.tick) continue;
    const [a, b] = key.split(':').map(Number);
    r.type = 'none';
    r.until = 0;
    if (!r.embargo) delete s.relations[key];
    game.emit({ k: 'relation', a, b, type: 'none' });
    if (s.players[a]) game.msg(a, `Пакт о ненападении с ${s.players[b].name} истёк`, 'info');
    if (s.players[b]) game.msg(b, `Пакт о ненападении с ${s.players[a].name} истёк`, 'info');
  }
}

export function tickDiplomacy(game) {
  const s = game.s;
  if (s.phase === 'over') return;
  if (s.requests.length) tickRequests(game);
  if (s.tick % 10 === 0) tickPacts(game);
}

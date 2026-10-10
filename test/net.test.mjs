import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { HostLobby, ClientLobby, mergeSettings, defaultLobbySettings, LOBBY_BURST, LOBBY_CHAT_BURST } from '../src/client/lobby.js';
import {
  Session, createMatch, startOffline, loadOffline, cleanCmd, HASH_EVERY, GAP_WAIT, STALL_WAIT, STATE_GAP, PEER_INTENTS, PEER_QUEUE, CHAT_BURST, READY_RETRY,
} from '../src/client/session.js';
import { packMessage, Reassembler, RateLimit, NET_VERSION, MAX_ASSEMBLY, SteamTransport } from '../src/client/net.js';
import { parseCustomMap, generateMap } from '../src/core/map.js';
import { hashState, serializeState } from '../src/core/state.js';

function makeHub() {
  const queue = [];
  const nodes = new Map();
  const stats = { msgs: 0, bytes: 0, types: {} };
  let dropRule = null;
  const mk = (selfId, isHost, hostId) => {
    const t = {
      kind: 'test', isHost, selfId, hostId, lobbyId: 'L1', peers: new Set(), closed: false,
      onMessage() {}, onPeerJoin() {}, onPeerLeave() {}, onTrouble() {},
      send(peer, obj) {
        if (this.closed) return;
        if (dropRule && dropRule(selfId, peer, obj)) return;
        const data = JSON.stringify(obj);
        const type = obj && typeof obj === 'object' ? obj.t : typeof obj;
        stats.msgs++;
        stats.bytes += data.length;
        stats.types[type] = (stats.types[type] || 0) + 1;
        queue.push(() => {
          const dst = nodes.get(peer);
          if (dst && !dst.closed) dst.deliver(selfId, data);
        });
      },
      broadcast(obj) { for (const p of this.peers) this.send(p, obj); },
      deliver(from, data) {
        if (this.isHost && !this.peers.has(from)) { this.peers.add(from); this.onPeerJoin(from); }
        this.onMessage(from, JSON.parse(data));
      },
      close() { this.closed = true; },
    };
    nodes.set(selfId, t);
    return t;
  };
  const host = mk('H', true, 'H');
  const client = (id) => {
    const t = mk(id, false, 'H');
    t.peers.add('H');
    return t;
  };
  const flush = () => { let k = 0; while (queue.length) { queue.shift()(); k++; } return k; };
  const drop = (id) => {
    const t = nodes.get(id);
    t.closed = true;
    if (host.peers.delete(id)) host.onPeerLeave(id);
  };
  return { host, client, flush, drop, stats, queue, nodes, setDrop: (f) => { dropRule = f; } };
}

function testRows() {
  const rows = [];
  for (let y = 0; y < 32; y++) {
    let r = '';
    for (let x = 0; x < 72; x++) {
      const main = x >= 3 && x < 60 && y >= 4 && y < 28;
      const isle = x >= 63 && x < 70 && y >= 10 && y < 20;
      r += main || isle ? '#' : '.';
    }
    rows.push(r);
  }
  return parseCustomMap({ name: 'Тестовая', rows, scale: 4 });
}

const CUSTOM = testRows();

function setup({ clients = 2, bots = 1, spawnSeconds = 2, hashEvery } = {}) {
  const hub = makeHub();
  const hl = new HostLobby(hub.host, 'Хост');
  const cls = [];
  for (let k = 0; k < clients; k++) {
    const cl = new ClientLobby(hub.client('C' + (k + 1)), 'Друг ' + (k + 1));
    cls.push(cl);
  }
  hub.flush();
  for (let k = 0; k < bots; k++) hl.addAI('easy');
  hl.set({ custom: CUSTOM, seed: 4242, spawnSeconds, victory: { territory: true, territoryPct: 90, economy: true, economyMinutes: 30 } });
  hub.flush();
  const sessions = [];
  cls.forEach((cl, k) => { cl.onStart = (s) => { sessions[k] = s; }; });
  const host = hl.start({ hashEvery });
  hub.flush();
  return { hub, hl, cls, host, clients: sessions };
}

function frame(ctx, dt = 0.1) {
  ctx.host.update(dt);
  ctx.hub.flush();
  for (const c of ctx.clients) if (!c.ended) c.update(dt);
  ctx.hub.flush();
}

function settle(ctx) {
  ctx.hub.flush();
  for (const c of ctx.clients) if (!c.ended) c.catchUp();
  ctx.hub.flush();
}

function findSpawn(session, x0, y0) {
  const g = session.game;
  for (let r = 0; r < 60; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const cmd = { c: 'spawn', x: x0 + dx, y: y0 + dy };
      if (g.validate(session.localPid, cmd).ok) return cmd;
    }
  }
  return null;
}

function neutralTarget(session) {
  const g = session.game, pid = session.localPid, W = g.W, N = g.N, own = g.s.owner;
  for (const i of g.borderList(pid)) {
    const x = i % W;
    for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
      if (j < 0 || j >= N || !g.isLandTile(j) || own[j] !== 0) continue;
      return { x: j % W, y: Math.floor(j / W) };
    }
  }
  return null;
}

function buildSpot(session, type) {
  const g = session.game, pid = session.localPid, W = g.W;
  const cap = g.s.players[pid].capital;
  const cx = cap % W, cy = Math.floor(cap / W);
  for (let r = 0; r < 12; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const cmd = { c: 'build', type, x: cx + dx, y: cy + dy };
      if (g.validate(pid, cmd).ok) return cmd;
    }
  }
  return null;
}

const allSessions = (ctx) => [ctx.host, ...ctx.clients];

function assertInSync(ctx, label) {
  settle(ctx);
  const h = ctx.host.hash();
  for (const c of ctx.clients) {
    if (c.ended) continue;
    assert.equal(c.n, ctx.host.n, `${label}: номер хода клиента ${c.localPid}`);
    assert.equal(c.hash(), h, `${label}: хэш клиента ${c.localPid}`);
  }
  return h;
}

test('лобби: подключение, настройки, боты и цвета', () => {
  const hub = makeHub();
  const hl = new HostLobby(hub.host, 'Хост');
  const views = [];
  hl.onChange = (v) => views.push(v);
  const c1 = new ClientLobby(hub.client('C1'), 'Аня', { color: '#3d7ee6' });
  const c2 = new ClientLobby(hub.client('C2'), 'Боря', { color: '#3d7ee6' });
  hub.flush();
  assert.equal(hl.slots.length, 3);
  assert.equal(c1.you, 1);
  assert.equal(c2.you, 2);
  assert.equal(c1.view.slots[2].name, 'Боря');
  assert.equal(hl.slots[1].color, '#3d7ee6', 'желаемый цвет');
  assert.notEqual(hl.slots[2].color, '#3d7ee6', 'занятый цвет не выдаётся второй раз');
  assert.equal(new Set(hl.slots.map((s) => s.color)).size, 3);
  assert.equal(c1.view.v, NET_VERSION);

  const bot = hl.addAI('hard');
  assert.equal(bot, 3);
  assert.equal(hl.slots[3].ai, 'hard');
  assert.ok(hl.setAI(3, 'easy'));
  assert.equal(hl.setAI(1, 'easy'), false, 'человека нельзя сделать ботом');
  hl.set({ map: 'pangaea', seed: 77, victory: { territoryPct: 55, economy: true, economyMinutes: 12 }, spawnSeconds: 7 });
  hub.flush();
  const v = c2.view;
  assert.equal(v.settings.map, 'pangaea');
  assert.equal(v.settings.seed, 77);
  assert.deepEqual(v.settings.victory, { territory: true, territoryPct: 55, economy: true, economyMinutes: 12 });
  assert.equal(v.settings.spawnSeconds, 7);
  assert.equal(v.slots[3].ai, 'easy');
  assert.equal(v.slots.length, 4);
  hl.set({ victory: { territoryPct: 5, economyMinutes: 1000 } });
  assert.equal(hl.settings.victory.territoryPct, 30, 'ограничение снизу');
  assert.equal(hl.settings.victory.economyMinutes, 60, 'ограничение сверху');

  const errors = [];
  c2.onError = (e) => errors.push(e);
  c2.setColor(hl.slots[1].color);
  hub.flush();
  assert.equal(errors.length, 1, 'занятый цвет отклонён');
  c2.setColor('#123456');
  hub.flush();
  assert.equal(hl.slots[2].color, '#123456');
  assert.equal(c1.view.slots[2].color, '#123456');
  assert.ok(hl.setColor(3, '#abcdef'));
  assert.equal(hl.setColor(3, '#123456'), false);

  const chats = [];
  c1.onChat = (c) => chats.push(c);
  c2.sendChat('всем привет');
  hub.flush();
  assert.equal(chats.length, 1);
  assert.equal(chats[0].name, 'Боря');

  hl.set({ custom: CUSTOM });
  hub.flush();
  assert.equal(c1.view.settings.map, 'custom');
  assert.equal(c1.view.settings.custom.name, 'Тестовая');
  assert.deepEqual(c1.customDesc.rows, CUSTOM.rows, 'клиент получает пользовательскую карту для превью');
  assert.equal(hl.maxPlayers, 12);

  let reason = null;
  c2.onClosed = (r) => { reason = r; };
  hl.remove(2);
  hub.flush();
  assert.equal(hl.slots.length, 3);
  assert.match(reason, /исключил/);
  assert.equal(c1.view.slots.length, 3);

  c1.close();
  hub.flush();
  assert.equal(hl.slots.length, 2, 'вышедший игрок удалён из лобби');
  assert.ok(views.length > 5);
  assert.equal(hl.canStart(), null);
});

test('лобби: отказ при несовпадении версии, переполнении и после старта', () => {
  const hub = makeHub();
  const hl = new HostLobby(hub.host, 'Хост');
  hl.set({ custom: CUSTOM });
  const bad = hub.client('X');
  const got = [];
  bad.onMessage = (_p, m) => got.push(m);
  bad.send('H', { t: 'hello', v: 999, name: 'Старый' });
  hub.flush();
  assert.equal(got[0].t, 'reject');
  assert.equal(hl.slots.length, 1);
  assert.match(hl.canStart(), /минимум 2/);
  for (let k = 0; k < 11; k++) hl.addAI();
  assert.equal(hl.slots.length, 12);
  assert.equal(hl.addAI(), -1);
  let reason = null;
  const late = new ClientLobby(hub.client('Y'), 'Поздний');
  late.onClosed = (r) => { reason = r; };
  hub.flush();
  assert.match(reason, /заполнено/);
  hl.remove(11);
  const host = hl.start();
  assert.equal(host.mode, 'host');
  let reason2 = null;
  const after = new ClientLobby(hub.client('Z'), 'После');
  after.onClosed = (r) => { reason2 = r; };
  hub.flush();
  assert.match(reason2, /началась/);
  assert.throws(() => hl.start(), /началась/);
});

test('старт: хост и 2 клиента создают одинаковое состояние', () => {
  const ctx = setup();
  assert.equal(ctx.clients.length, 2);
  const [a, b] = ctx.clients;
  assert.equal(a.localPid, 1);
  assert.equal(b.localPid, 2);
  assert.equal(a.mode, 'client');
  for (const s of allSessions(ctx)) {
    assert.equal(s.map.W, ctx.host.map.W);
    assert.equal(s.map.H, ctx.host.map.H);
    assert.equal(s.s.players.length, 4);
    assert.equal(s.s.players[3].ai, 'easy');
    assert.equal(s.s.players[1].name, 'Друг 1');
    assert.equal(s.s.settings.victory.territoryPct, 90);
    assert.equal(s.s.settings.victory.economy, true);
    assert.equal(s.s.settings.spawnSeconds, 2);
    assert.equal(s.hash(), ctx.host.hash());
  }
  assert.equal(ctx.host.s.players[1].netId, 'C1');
  assert.deepEqual(ctx.host.s.players.map((p) => p.color), ctx.hl.slots.map((sl) => sl.color));
  assert.equal(ctx.host.waiting, 0, 'клиенты сообщили о готовности');
  assert.ok(ctx.host.started);
});

test('lockstep: интенты клиентов применяются у всех, 300 ходов — хэши совпадают', () => {
  const ctx = setup();
  const [a, b] = ctx.clients;
  const events = { host: 0, a: 0 };
  ctx.host.on((e) => { if (e.type === 'events') events.host++; });
  a.on((e) => { if (e.type === 'events') events.a++; });
  const desyncs = [];
  for (const s of allSessions(ctx)) s.on((e) => { if (e.type === 'desync' || e.type === 'error') desyncs.push(e); });

  const spots = [[40, 60], [130, 60], [210, 60]];
  allSessions(ctx).forEach((s, k) => {
    const cmd = findSpawn(s, spots[k][0], spots[k][1]);
    assert.ok(cmd, 'место старта найдено');
    assert.deepEqual(s.send(cmd), { ok: true });
  });
  frame(ctx);
  assert.ok(ctx.host.s.players[0].spawned, 'интент хоста — в ближайшем ходе');
  assert.ok(!ctx.host.s.players[1].spawned, 'интент клиента — в следующем ходе');
  frame(ctx);
  for (const s of allSessions(ctx)) {
    for (let p = 0; p < 3; p++) assert.ok(s.s.players[p].spawned, `игрок ${p} выбрал место (у ${s.localPid})`);
  }
  assert.ok(ctx.host.s.players[1].tiles > 20);
  assert.equal(a.s.players[2].tiles, ctx.host.s.players[2].tiles);

  let turns = 2;
  while (ctx.host.s.phase === 'spawn') { frame(ctx); turns++; }
  assert.equal(a.s.phase, 'play');

  const bad = a.send({ c: 'attack', x: -5, y: -5, ratio: 0.5 });
  assert.equal(bad.ok, false);
  assert.ok(bad.error);

  const tiles0 = ctx.host.s.players.map((p) => p.tiles);
  for (const s of allSessions(ctx)) {
    const t = neutralTarget(s);
    assert.ok(t);
    assert.deepEqual(s.send({ c: 'attack', x: t.x, y: t.y, ratio: 0.4 }), { ok: true });
  }
  const house = buildSpot(a, 'house');
  assert.ok(house);
  assert.deepEqual(a.send(house), { ok: true });
  const fort = buildSpot(b, 'fort');
  assert.ok(fort);
  assert.deepEqual(b.send(fort), { ok: true });

  for (; turns < 300; turns++) {
    frame(ctx);
    if (turns % 40 === 0) {
      for (const s of allSessions(ctx)) {
        const t = neutralTarget(s);
        if (t) s.send({ c: 'attack', x: t.x, y: t.y, ratio: 0.3 });
      }
    }
  }
  const h = assertInSync(ctx, '300 ходов');
  assert.ok(ctx.host.n >= 300);
  assert.equal(h, hashState(b.s));
  for (const s of allSessions(ctx)) {
    for (let p = 0; p < 3; p++) assert.ok(s.s.players[p].tiles > tiles0[p] + 50, `территория игрока ${p} выросла`);
    const hs = s.s.buildings.filter((x) => x.owner === 1 && x.type === 'house');
    const fs = s.s.buildings.filter((x) => x.owner === 2 && x.type === 'fort');
    assert.equal(hs.length, 1, 'дом клиента 1 есть у всех');
    assert.equal(fs.length, 1, 'форт клиента 2 есть у всех');
    assert.equal(hs[0].x, house.x);
  }
  assert.equal(desyncs.length, 0, 'без рассинхронизации');
  assert.ok(a.lastHash && a.lastHash.n >= HASH_EVERY, 'клиент сверял хэш');
  assert.equal(events.host, ctx.host.n);
  assert.equal(events.a, a.n);
  assert.ok(ctx.hub.stats.types.turn >= 600);
});

test('рассинхронизация: испорченное состояние клиента восстанавливается (чанки)', () => {
  const ctx = setup({ hashEvery: 20 });
  ctx.hub.host.chunkSize = 512;
  const [a, b] = ctx.clients;
  const seen = { desync: 0, resync: 0, hostDesync: 0 };
  a.on((e) => { if (e.type === 'desync') seen.desync++; if (e.type === 'resync') seen.resync++; });
  ctx.host.on((e) => { if (e.type === 'desync') seen.hostDesync++; });
  allSessions(ctx).forEach((s, k) => s.send(findSpawn(s, [40, 130, 210][k], 60)));
  for (let k = 0; k < 45; k++) frame(ctx);
  assertInSync(ctx, 'до порчи');
  const oldGame = a.game;
  a.s.players[0].gold += 12345;
  a.s.players[2].troops *= 3;
  const cap = a.s.players[1].capital;
  for (let d = 1; d < 6; d++) a.s.owner[cap + d] = 3;
  assert.notEqual(a.hash(), ctx.host.hash());
  for (let k = 0; k < 30; k++) frame(ctx);
  assert.equal(seen.desync, 1, 'клиент заметил расхождение');
  assert.equal(seen.hostDesync, 1, 'хост получил запрос');
  assert.equal(seen.resync, 1, 'состояние загружено');
  assert.ok(ctx.hub.stats.types.chunk > 3, 'состояние пришло чанками');
  assert.notEqual(a.game, oldGame);
  assert.equal(a.desyncs, 1);
  assert.equal(b.desyncs, 0);
  assertInSync(ctx, 'после восстановления');
  for (const s of allSessions(ctx)) {
    const t = neutralTarget(s);
    if (t) s.send({ c: 'attack', x: t.x, y: t.y, ratio: 0.5 });
  }
  for (let k = 0; k < 150; k++) frame(ctx);
  assertInSync(ctx, 'через 150 ходов после восстановления');
  assert.equal(a.desyncs, 1, 'повторных расхождений нет');
});

test('отключение клиента: его страной у всех управляет ИИ', () => {
  const ctx = setup();
  const [a, b] = ctx.clients;
  const left = [];
  ctx.host.on((e) => { if (e.type === 'peerLeft') left.push(e); });
  allSessions(ctx).forEach((s, k) => s.send(findSpawn(s, [40, 130, 210][k], 60)));
  for (let k = 0; k < 30; k++) frame(ctx);
  assert.equal(ctx.host.s.players[2].ai, null);
  ctx.hub.drop('C2');
  b.onPeerLeave('H');
  assert.equal(b.ended, true);
  assert.equal(left.length, 1);
  assert.equal(left[0].pid, 2);
  const msgs = [];
  a.on((e) => { if (e.type === 'events') for (const ev of e.events) if (ev.k === 'msg') msgs.push(ev.text); });
  frame(ctx);
  frame(ctx);
  assert.equal(ctx.host.s.players[2].ai, 'normal');
  assert.equal(a.s.players[2].ai, 'normal');
  assert.equal(a.s.players[2].netId, null);
  assert.ok(msgs.some((t) => /компьютер/.test(t)));
  for (let k = 0; k < 60; k++) frame(ctx);
  ctx.clients = [a];
  assertInSync(ctx, 'после отключения');
  ctx.host.update(0.1);
  ctx.hub.flush();
  assert.ok(!ctx.host.peers.has('C2'));
});

test('пауза и скорость хоста доходят до клиентов', () => {
  const ctx = setup();
  const [a] = ctx.clients;
  const evs = [];
  a.on((e) => { if (e.type === 'pause' || e.type === 'speed') evs.push(e); });
  for (let k = 0; k < 5; k++) frame(ctx);
  const n0 = ctx.host.n;
  assert.ok(ctx.host.setPaused(true));
  ctx.hub.flush();
  assert.equal(a.paused, true);
  assert.equal(a.speed, 0);
  for (let k = 0; k < 10; k++) frame(ctx);
  assert.equal(ctx.host.n, n0, 'на паузе ходы не идут');
  assert.equal(a.n, n0);
  assert.equal(a.setPaused(false), false, 'клиент не управляет паузой');
  assert.equal(a.setSpeed(2), false);
  ctx.host.togglePause();
  ctx.hub.flush();
  assert.equal(a.paused, false);
  frame(ctx);
  assert.equal(ctx.host.n, n0 + 1);
  ctx.host.setSpeed(2);
  ctx.hub.flush();
  assert.equal(a.speed, 2);
  frame(ctx);
  assert.equal(ctx.host.n, n0 + 3, 'скорость 2× — 2 хода за 100 мс');
  ctx.host.setSpeed(5);
  assert.equal(ctx.host.speed, 2, 'в сети максимум 2×');
  ctx.host.setSpeed(0);
  ctx.hub.flush();
  assert.equal(a.paused, true);
  ctx.host.setSpeed(1);
  ctx.hub.flush();
  assert.equal(a.paused, false);
  assert.equal(a.speed, 1);
  assert.ok(evs.some((e) => e.type === 'pause' && e.on));
  assert.ok(evs.some((e) => e.type === 'pause' && !e.on));
  assertInSync(ctx, 'после паузы');
});

test('чат в игре и отклонение служебных команд клиента', () => {
  const ctx = setup();
  const [a, b] = ctx.clients;
  const got = [];
  b.on((e) => { if (e.type === 'chat') got.push(e.chat); });
  const hostGot = [];
  ctx.host.on((e) => { if (e.type === 'chat') hostGot.push(e.chat); });
  assert.ok(a.sendChat('  привет, мир  '));
  assert.equal(a.sendChat('   '), false);
  ctx.host.sendChat('х'.repeat(500));
  ctx.hub.flush();
  assert.equal(got.length, 2);
  const fromA = got.find((c) => c.from === 1);
  assert.equal(fromA.text, 'привет, мир');
  assert.equal(fromA.name, 'Друг 1');
  assert.equal(got.find((c) => c.from === 0).text.length, 200);
  assert.equal(hostGot.length, 2);
  assert.equal(a.chat.length, 2);

  assert.equal(a.send({ c: '_ai', pid: 0, level: 'easy' }).ok, false);
  a.transport.send('H', { t: 'intent', cmd: { c: '_ai', pid: 0, level: 'easy' } });
  a.transport.send('H', { t: 'intent', cmd: 'мусор' });
  a.transport.send('H', { t: 'intent', cmd: { c: 'build', junk: 'x'.repeat(10000) } });
  for (let k = 0; k < 3; k++) frame(ctx);
  assert.equal(ctx.host.s.players[0].ai, null, 'хост отбрасывает _ai от клиента');
  assert.equal(cleanCmd({ c: '_ai' }), null);
  assert.deepEqual(cleanCmd({ c: 'attack', x: 1, y: 2, ratio: 0.5 }), { c: 'attack', x: 1, y: 2, ratio: 0.5 });
  for (let k = 0; k < 40; k++) a.transport.send('H', { t: 'intent', cmd: { c: 'research', key: 'econ' } });
  ctx.hub.flush();
  assert.equal(ctx.host.backlog, 40, 'команды клиента ждут своего хода, а не теряются');
  ctx.host.step();
  assert.equal(ctx.host.backlog, 40 - PEER_INTENTS, 'не больше PEER_INTENTS команд клиента за ход');
  ctx.host.step();
  assert.equal(ctx.host.backlog, 0);
  assertInSync(ctx, 'после мусора');
});

test('отстающий клиент догоняет несколькими тиками за кадр', () => {
  const ctx = setup();
  const [a, b] = ctx.clients;
  for (let k = 0; k < 3; k++) frame(ctx);
  for (let k = 0; k < 12; k++) ctx.host.update(0.1);
  ctx.hub.flush();
  assert.equal(a.lag, 12);
  assert.ok(a.alpha() >= 0 && a.alpha() <= 1);
  a.update(0.016);
  assert.ok(ctx.host.n - a.n <= 1, 'догнал за один кадр');
  b.update(0.016);
  ctx.clients = [a, b];
  assertInSync(ctx, 'после догоняния');
  const n = a.n;
  a.update(0.05);
  assert.equal(a.n, n, 'ждёт следующего хода');
  assert.ok(a.alpha() > 0.4 && a.alpha() <= 1);
});

test('хост ждёт готовности клиентов перед первым ходом', () => {
  const hub = makeHub();
  const hl = new HostLobby(hub.host, 'Хост');
  const cl = new ClientLobby(hub.client('C1'), 'Друг');
  hub.flush();
  hl.set({ custom: CUSTOM, seed: 9 });
  const host = hl.start();
  assert.equal(host.waiting, 1);
  host.update(0.5);
  assert.equal(host.n, 0, 'ходы не идут, пока клиент грузит карту');
  let client = null;
  cl.onStart = (s) => { client = s; };
  hub.flush();
  assert.ok(client);
  assert.equal(host.waiting, 0);
  host.update(0.1);
  assert.equal(host.n, 1);
  hub.flush();
  client.update(0.1);
  assert.equal(client.n, 1);
});

test('хост закрывает игру — клиент получает отключение', () => {
  const ctx = setup({ clients: 1, bots: 1 });
  const [a] = ctx.clients;
  let reason = null;
  a.on((e) => { if (e.type === 'disconnected') reason = e.reason; });
  frame(ctx);
  ctx.host.close(0);
  ctx.hub.flush();
  assert.match(reason, /завершил/);
  assert.equal(a.ended, true);
  assert.equal(a.send({ c: 'research', key: 'econ' }).ok, false);
});

test('офлайн-сессия: очередь интентов, скорости, сохранение', () => {
  const s = startOffline({ mapDesc: CUSTOM, seed: 3, players: [{ name: 'Я' }, { name: 'Бот', ai: 'normal' }], settings: { spawnSeconds: 1 } });
  assert.equal(s.mode, 'offline');
  assert.deepEqual(s.speeds, [0, 1, 2, 3, 5]);
  assert.equal(s.send({ c: 'spawn', x: -1, y: -1 }).ok, false);
  assert.equal(s.send({ c: 'нет такой' }).ok, false);
  assert.equal(s.send(null).ok, false);
  const sp = findSpawn(s, 60, 60);
  assert.deepEqual(s.send(sp), { ok: true });
  assert.equal(s.s.players[0].spawned, false, 'интент ждёт хода');
  s.update(0.1);
  assert.equal(s.n, 1);
  assert.ok(s.s.players[0].spawned);
  s.setSpeed(0);
  assert.ok(s.paused);
  s.update(1);
  assert.equal(s.n, 1);
  s.setSpeed(5);
  s.update(0.1);
  assert.equal(s.n, 6);
  s.setSpeed(3);
  s.update(0.1);
  assert.equal(s.n, 9);
  s.setSpeed(1);
  s.update(0.05);
  assert.ok(Math.abs(s.alpha() - 0.5) < 1e-6);
  for (let k = 0; k < 20; k++) s.update(0.1);
  assert.equal(s.s.phase, 'play');
  const snap = JSON.parse(JSON.stringify(s.snapshot()));
  const r = loadOffline(snap, s.map);
  assert.equal(r.hash(), s.hash());
  assert.equal(r.n, s.n);
  const t = neutralTarget(s);
  const cmd = { c: 'attack', x: t.x, y: t.y, ratio: 0.5 };
  s.send(cmd);
  r.send(cmd);
  for (let k = 0; k < 50; k++) { s.update(0.1); r.update(0.1); }
  assert.equal(r.hash(), s.hash(), 'загруженная игра идёт так же');
  let fired = 0;
  const off = s.on(() => fired++);
  s.update(0.1);
  off();
  s.update(0.1);
  assert.equal(fired, 1);
});

test('чанки: разбиение и сборка больших сообщений', () => {
  const big = { t: 'state', n: 5, state: { text: 'ж'.repeat(5000) + '"\\', list: Array.from({ length: 300 }, (_, i) => i) } };
  const parts = packMessage(big, 1000);
  assert.ok(parts.length > 5);
  assert.ok(parts.every((p) => p.t === 'chunk' && JSON.stringify(p).length < 1500));
  const r = new Reassembler();
  let out = null;
  for (const p of parts.slice().reverse()) {
    const m = r.accept('peer', JSON.parse(JSON.stringify(p)));
    if (m) out = m;
  }
  assert.deepEqual(out, big);
  assert.equal(r.pending.size, 0);
  assert.deepEqual(packMessage({ t: 'x' }, 1000), [{ t: 'x' }]);
  assert.equal(r.accept('p', { t: 'chunk', id: 'a', i: 5, of: 2, data: '' }), null);
  assert.equal(r.accept('p', { t: 'chunk', id: 1, i: 0, of: 1, data: '{}' }), null);
  assert.deepEqual(r.accept('p', { t: 'chunk', id: 'b', i: 0, of: 1, data: '{"t":"ok"}' }), { t: 'ok' });
  for (let k = 0; k < 10; k++) r.accept('p', { t: 'chunk', id: 'z' + k, i: 0, of: 2, data: 'x' });
  assert.ok(r.pending.size <= 4, 'старые незавершённые наборы выбрасываются');
});

test('настройки лобби: нормализация', () => {
  const d = defaultLobbySettings();
  assert.equal(d.map, 'world');
  const s1 = mergeSettings(d, { map: 'нет-такой', seed: -5, difficulty: 'ультра', spawnSeconds: 500 });
  assert.equal(s1.map, 'world');
  assert.equal(s1.seed, 5);
  assert.equal(s1.difficulty, 'normal');
  assert.equal(s1.spawnSeconds, 120);
  const s2 = mergeSettings(s1, { custom: { name: 'X', rows: CUSTOM.rows } });
  assert.equal(s2.map, 'custom');
  const s3 = mergeSettings(s2, { map: 'ring' });
  assert.equal(s3.custom, null);
  assert.equal(s3.map, 'ring');
  assert.throws(() => mergeSettings(s3, { custom: { rows: ['..'] } }));
});

test('старт на процедурной карте: состояние у всех одинаковое', () => {
  const hub = makeHub();
  const hl = new HostLobby(hub.host, 'Хост');
  const cl = new ClientLobby(hub.client('C1'), 'Друг');
  hub.flush();
  hl.set({ map: 'twin', seed: 31337, spawnSeconds: 1 });
  hl.addAI('normal');
  let client = null;
  cl.onStart = (s) => { client = s; };
  const pre = generateMap({ id: 'twin', seed: 31337 });
  const host = hl.start({ map: pre });
  hub.flush();
  assert.ok(client);
  assert.equal(client.map.landCount, host.map.landCount);
  assert.equal(client.hash(), host.hash());
  const ctx = { hub, host, clients: [client] };
  host.send(findSpawn(host, 300, 400));
  client.send(findSpawn(client, 1100, 400));
  for (let k = 0; k < 60; k++) frame(ctx);
  assertInSync(ctx, 'twin');
  assert.ok(host.s.players[2].spawned);
  assert.ok(serializeState(host.s).owner.rle.length > 0);
});

test('потерянный ход: клиент замечает разрыв в номерах и загружает состояние с хоста', () => {
  const ctx = setup();
  const [a, b] = ctx.clients;
  allSessions(ctx).forEach((s, k) => s.send(findSpawn(s, [40, 130, 210][k], 60)));
  for (let k = 0; k < 30; k++) frame(ctx);
  assertInSync(ctx, 'до потери');
  const seen = [];
  a.on((e) => { if (e.type === 'desync' || e.type === 'resync') seen.push(e.type + ':' + (e.reason || '')); });
  const lostTurn = ctx.host.n + 1;
  ctx.hub.setDrop((from, to, obj) => obj.t === 'turn' && obj.n === lostTurn && to === 'C1');
  let frames = 0;
  while (!a.lost && frames < 50) { frame(ctx); frames++; }
  ctx.hub.setDrop(null);
  assert.equal(a.lost, 1, 'разрыв обнаружен');
  assert.ok(frames * 0.1 <= GAP_WAIT + 0.5, `состояние запрошено через ${(frames * 0.1).toFixed(1)} с`);
  assert.deepEqual(seen, ['desync:lost', 'resync:'], 'клиент запросил и сразу получил состояние');
  assert.equal(a.awaitingState, false);
  assert.equal(b.lost, 0, 'второй клиент не затронут');
  assert.equal(ctx.host.desyncs, 1, 'хост отправил одно состояние');
  assertInSync(ctx, 'после потерянного хода');
  for (let k = 0; k < 60; k++) frame(ctx);
  assertInSync(ctx, 'через 60 ходов');
  assert.equal(a.lost, 1, 'повторных запросов нет');
  assert.equal(a.desyncs, 0, 'хэши не расходились');
});

test('таймаут ожидания: без ходов дольше STALL_WAIT клиент запрашивает состояние, на паузе ждёт', () => {
  const ctx = setup({ clients: 1, bots: 1 });
  const [a] = ctx.clients;
  allSessions(ctx).forEach((s, k) => s.send(findSpawn(s, [40, 130][k], 60)));
  for (let k = 0; k < 20; k++) frame(ctx);
  ctx.host.setPaused(true);
  ctx.hub.flush();
  for (let k = 0; k < STALL_WAIT * 25; k++) frame(ctx);
  assert.equal(a.lost, 0, 'на паузе тишина — это норма');
  ctx.host.setPaused(false);
  ctx.hub.flush();
  ctx.hub.setDrop((from, to, obj) => from === 'H' && obj.t === 'turn');
  let frames = 0;
  while (!a.lost && frames < 100) { frame(ctx); frames++; }
  ctx.hub.setDrop(null);
  assert.equal(a.lost, 1, 'клиент не завис навсегда');
  assert.ok(Math.abs(frames * 0.1 - STALL_WAIT) < 0.5, `запрос через ${(frames * 0.1).toFixed(1)} с`);
  assert.equal(a.resyncs, 1);
  for (let k = 0; k < 30; k++) frame(ctx);
  assertInSync(ctx, 'после таймаута');
  const n = a.n;
  ctx.hub.setDrop((from, to, obj) => obj.t === 'pause');
  ctx.host.setPaused(true);
  for (let k = 0; k < (STALL_WAIT + 1) * 10; k++) frame(ctx);
  ctx.hub.setDrop(null);
  assert.equal(a.lost, 2, 'потерянное сообщение о паузе — клиент спросил состояние');
  assert.equal(a.paused, true, 'из состояния клиент узнал о паузе');
  for (let k = 0; k < STALL_WAIT * 20; k++) frame(ctx);
  assert.equal(a.lost, 2, 'дальше ждёт молча');
  assert.equal(a.n, n);
  assertInSync(ctx, 'на паузе');
});

test('потерянное сообщение ready: клиент повторяет его и игра стартует сразу', () => {
  const hub = makeHub();
  const hl = new HostLobby(hub.host, 'Хост');
  const cl = new ClientLobby(hub.client('C1'), 'Друг');
  hub.flush();
  hl.set({ custom: CUSTOM, seed: 9 });
  let client = null;
  cl.onStart = (s) => { client = s; };
  hub.setDrop((from, to, obj) => obj.t === 'ready');
  const host = hl.start();
  hub.flush();
  hub.setDrop(null);
  assert.ok(client);
  host.update(1);
  assert.equal(host.waiting, 1, 'первый ready потерян');
  assert.equal(host.n, 0);
  client.update(READY_RETRY + 0.1);
  hub.flush();
  assert.equal(host.waiting, 0, 'повторный ready дошёл');
  host.update(0.1);
  assert.equal(host.n, 1);
  hub.flush();
  client.update(0.1);
  assert.equal(client.n, 1);
  assert.equal(client.lost, 0);
});

test('пауза: все команды клиента выполняются после паузы, переполнение очереди — ошибка в интерфейсе', () => {
  const ctx = setup({ clients: 1, bots: 1 });
  const [a] = ctx.clients;
  allSessions(ctx).forEach((s, k) => s.send(findSpawn(s, [40, 130][k], 60)));
  while (ctx.host.s.phase === 'spawn') frame(ctx);
  ctx.host.setPaused(true);
  ctx.hub.flush();
  let ok = 0;
  for (let k = 0; k < 40; k++) if (a.send({ c: 'embargo', with: 0, on: k % 2 === 0 }).ok) ok++;
  for (let k = 0; k < 10; k++) frame(ctx);
  assert.equal(ok, 40);
  assert.equal(ctx.host.backlog, 40, 'на паузе команды ждут');
  let applied = 0;
  ctx.host.on((ev) => { if (ev.type === 'events') for (const e of ev.events) if (e.k === 'relation' && e.a === 1 && e.b === 0) applied++; });
  ctx.host.setPaused(false);
  ctx.hub.flush();
  frame(ctx);
  assert.equal(ctx.host.backlog, 40 - PEER_INTENTS);
  frame(ctx);
  assert.equal(ctx.host.backlog, 0);
  assert.equal(applied, 40, 'применены все команды, на которые send() ответил ok');
  assertInSync(ctx, 'после паузы');

  const errs = [];
  a.on((e) => { if (e.type === 'error') errs.push(e.error); });
  ctx.host.setPaused(true);
  ctx.hub.flush();
  for (let k = 0; k < PEER_QUEUE + 50; k++) a.transport.send('H', { t: 'intent', cmd: { c: 'embargo', with: 0, on: k % 2 === 0 } });
  ctx.hub.flush();
  assert.equal(ctx.host.backlog, PEER_QUEUE, 'очередь одного клиента ограничена');
  assert.equal(errs.length, 1, 'клиент получил одно сообщение об ошибке');
  assert.match(errs[0], /Слишком много команд/);
  ctx.host.setPaused(false);
  ctx.hub.flush();
  for (let k = 0; k < Math.ceil(PEER_QUEUE / PEER_INTENTS); k++) frame(ctx);
  assert.equal(ctx.host.backlog, 0);
  assertInSync(ctx, 'после переполнения');
});

test('спам desync и чата от клиента ограничен по частоте', () => {
  const ctx = setup();
  const [a, b] = ctx.clients;
  allSessions(ctx).forEach((s, k) => s.send(findSpawn(s, [40, 130, 210][k], 60)));
  for (let k = 0; k < 30; k++) frame(ctx);
  const c1 = ctx.hub.nodes.get('C1');
  const before = ctx.hub.stats.types.state || 0;
  for (let k = 0; k < 100; k++) c1.send('H', { t: 'desync', n: 0 });
  ctx.hub.flush();
  assert.equal(ctx.host.desyncs, 1, 'на 100 запросов — одно состояние сразу');
  for (let k = 0; k < STATE_GAP * 10 + 2; k++) frame(ctx);
  assert.equal(ctx.host.desyncs, 2, 'отложенный запрос обслужен один раз');
  for (let k = 0; k < 50; k++) frame(ctx);
  assert.equal(ctx.host.desyncs, 2, 'новых состояний нет');
  assert.equal((ctx.hub.stats.types.state || 0) - before, 2);
  assert.equal(b.resyncs, 0);
  assertInSync(ctx, 'после спама desync');

  const got = [];
  b.on((e) => { if (e.type === 'chat') got.push(e.chat.text); });
  const errs = [];
  a.on((e) => { if (e.type === 'error') errs.push(e.error); });
  for (let k = 0; k < 20; k++) a.sendChat('спам ' + k);
  ctx.hub.flush();
  assert.equal(got.length, CHAT_BURST, 'в чат прошло не больше CHAT_BURST сообщений');
  assert.equal(errs.length, 1);
  for (let k = 0; k < 60; k++) frame(ctx);
  assert.ok(a.sendChat('снова можно'));
  ctx.hub.flush();
  assert.equal(got[got.length - 1], 'снова можно');
  assert.ok(ctx.host.sendChat('хост не ограничен'));
});

test('мусор и чанки от клиента не роняют хост и не копятся в памяти', () => {
  const ctx = setup({ clients: 1, bots: 1 });
  const [a] = ctx.clients;
  allSessions(ctx).forEach((s, k) => s.send(findSpawn(s, [40, 130][k], 60)));
  for (let k = 0; k < 20; k++) frame(ctx);
  const c1 = ctx.hub.nodes.get('C1');
  const part = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 200; i++) c1.send('H', { t: 'chunk', id: 'a' + (i % 7), i, of: 4096, data: part });
  const junk = [
    null, 0, 7, 'строка', [], [1, 2], true, {}, { t: 5 }, { t: 'нет такого' }, { t: 'intent' }, { t: 'intent', cmd: null },
    { t: 'intent', cmd: [1] }, { t: 'intent', cmd: { c: '__proto__' } }, { t: 'intent', cmd: { c: 'build', type: '__proto__', x: 'a', y: {} } },
    { t: 'intent', cmd: { c: 'attack', x: 1e308, y: -1e308, ratio: 'много' } }, { t: 'intent', cmd: { c: 'propose', to: 0, type: 'constructor' } },
    { t: 'chat', text: { a: 1 } }, { t: 'chat' }, { t: 'desync', n: 'x' }, { t: 'ready' }, { t: 'hello', v: NET_VERSION },
    { t: 'state', n: 0, state: {} }, { t: 'turn', n: 999, intents: 5 }, { t: 'chunk' }, { t: 'chunk', id: 'b', i: 0, of: 1, data: '{"t":"desync"}' },
  ];
  for (const m of junk) c1.send('H', m);
  ctx.hub.flush();
  for (const m of [undefined, null, 'x', 42, [], new Uint8Array(4)]) ctx.host.onNet('C1', m);
  assert.equal(ctx.host.chunks.held(), 0, 'хост не хранит чанки от клиентов');
  assert.equal(ctx.host.chunks.pending.size, 0);
  assert.ok(ctx.host.chunks.rejected >= 200);
  for (let k = 0; k < 30; k++) frame(ctx);
  assert.equal(ctx.host.errors, 0, 'симуляция хоста без исключений');
  assert.equal(a.ended, false);
  assert.ok(ctx.host.peers.has('C1'));
  assertInSync(ctx, 'после мусора');
});

test('лобби: мусор, чанки и спам от клиента ограничены', () => {
  let now = 1000;
  const hub = makeHub();
  const hl = new HostLobby(hub.host, 'Хост', { now: () => now });
  hl.set({ custom: CUSTOM });
  const cl = new ClientLobby(hub.client('C1'), 'Аня');
  hub.flush();
  assert.equal(hl.slots.length, 2);
  const c1 = hub.nodes.get('C1');
  for (let i = 0; i < 50; i++) c1.send('H', { t: 'chunk', id: 'z', i, of: 4096, data: 'x'.repeat(65536) });
  for (const m of [null, 3, 'x', [], { t: 1 }, { t: 'color', color: {} }, { t: 'name', name: ['a'] }, { t: 'hello' }]) c1.send('H', m);
  hub.flush();
  assert.equal(hl.chunks.held(), 0);
  assert.equal(hl.slots.length, 2);
  assert.equal(hl.slots[1].name, 'a');
  const sentBefore = hub.stats.types.custom || 0;
  for (let k = 0; k < 100; k++) c1.send('H', { t: 'hello', v: NET_VERSION, name: 'Аня' });
  hub.flush();
  const replies = (hub.stats.types.custom || 0) - sentBefore;
  assert.ok(replies > 0 && replies <= LOBBY_BURST, `ответов с картой на 100 hello: ${replies}`);
  now += 10;
  const chats = [];
  hl.onChat = (c) => chats.push(c);
  const errs = [];
  cl.onError = (e) => errs.push(e);
  for (let k = 0; k < 12; k++) cl.sendChat('привет ' + k);
  hub.flush();
  assert.equal(chats.length, LOBBY_CHAT_BURST);
  assert.equal(errs.length, 1);
  now += 10;
  cl.sendChat('ещё');
  cl.setColor('#123456');
  hub.flush();
  assert.equal(chats.length, LOBBY_CHAT_BURST + 1);
  assert.equal(hl.slots[1].color, '#123456');
  now += 10;
  for (let k = 0; k < 200; k++) c1.send('H', { t: 'name', name: 'Имя' + (k % 2) });
  c1.send('H', { t: 'bye' });
  hub.flush();
  assert.equal(hl.slots.length, 1, 'bye обрабатывается даже сверх лимита');
});

test('чанки: лимиты размера, числа сборок и времени жизни; RateLimit', () => {
  let now = 0;
  const r = new Reassembler({ maxBytes: 1000, ttl: 5000, now: () => now });
  assert.equal(r.accept('p', { t: 'chunk', id: 'big', i: 0, of: 3, data: 'x'.repeat(600) }), null);
  assert.equal(r.pending.size, 0, 'заявленный объём больше лимита — сборка не начинается');
  r.accept('p', { t: 'chunk', id: 'a', i: 0, of: 3, data: 'y'.repeat(400) });
  r.accept('p', { t: 'chunk', id: 'a', i: 1, of: 3, data: 'y'.repeat(400) });
  assert.equal(r.held('p'), 800);
  assert.equal(r.accept('p', { t: 'chunk', id: 'a', i: 2, of: 3, data: 'y'.repeat(400) }), null);
  assert.equal(r.held('p'), 0, 'сборка сверх лимита удалена');
  r.accept('p', { t: 'chunk', id: 'b', i: 0, of: 2, data: 'z'.repeat(450) });
  r.accept('p', { t: 'chunk', id: 'c', i: 0, of: 2, data: 'z'.repeat(450) });
  r.accept('p', { t: 'chunk', id: 'd', i: 0, of: 2, data: 'z'.repeat(450) });
  assert.equal(r.held('p'), 900, 'суммарный объём на пира ограничен');
  assert.deepEqual(r.accept('q', { t: 'chunk', id: 'b', i: 0, of: 1, data: '{"t":"ok"}' }), { t: 'ok' }, 'другой пир не страдает');
  assert.equal(r.accept('p', { t: 'chunk', id: 'x'.repeat(65), i: 0, of: 1, data: '{}' }), null);
  now += 6000;
  r.accept('q', { t: 'chunk', id: 'e', i: 0, of: 2, data: '{' });
  assert.equal(r.held('p'), 0, 'старые сборки удаляются по времени');
  assert.equal(r.held(), 1);
  r.drop('q');
  assert.equal(r.held(), 0);
  const parts = packMessage({ t: 'state', s: 'ж'.repeat(800) }, 300);
  assert.equal(parts.length, 3);
  let out = null;
  for (const m of parts) out = r.accept('p', JSON.parse(JSON.stringify(m))) || out;
  assert.equal(out && out.s.length, 800, 'обычное сообщение в пределах лимита собирается');
  const off = new Reassembler({ chunks: false });
  assert.equal(off.accept('p', { t: 'chunk', id: 'b', i: 0, of: 1, data: '{"t":"ok"}' }), null);
  assert.deepEqual(off.accept('p', { t: 'x' }), { t: 'x' });
  assert.equal(off.accept('p', [1]), null);
  assert.equal(off.held(), 0);
  assert.ok(MAX_ASSEMBLY >= 8 * 1024 * 1024);

  let t = 0;
  const rl = new RateLimit(2, 5, () => t);
  assert.ok(rl.take('a'));
  assert.ok(rl.take('a'));
  assert.equal(rl.take('a'), false);
  assert.ok(rl.firstMiss('a'));
  rl.take('a');
  assert.equal(rl.firstMiss('a'), false);
  assert.ok(rl.take('b'));
  t = 5;
  assert.ok(rl.take('a'), 'новое окно');
});

const require = createRequire(import.meta.url);
const ELECTRON_DIR = new URL('../electron/', import.meta.url).pathname;

function loadMain(file, fakes) {
  const stubs = [];
  for (const [name, exports] of Object.entries(fakes)) {
    const p = require.resolve(name, { paths: [ELECTRON_DIR] });
    require.cache[p] = { id: p, filename: p, loaded: true, exports, children: [], paths: [] };
    stubs.push(p);
  }
  const full = require.resolve(ELECTRON_DIR + file);
  delete require.cache[full];
  const mod = require(full);
  return { mod, restore() { for (const p of [...stubs, full]) delete require.cache[p]; } };
}

function fakeIpc() {
  const handlers = new Map();
  const listeners = new Map();
  return { handlers, listeners, ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => listeners.set(ch, fn) } };
}

async function waitFor(cond, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}

test('Steam (main): только участники лобби, состояние участника строкой и числом, сбои связи, список лобби', { timeout: 30000 }, async () => {
  const ipc = fakeIpc();
  const out = [];
  const sent = [];
  const accepted = [];
  const packets = [];
  const cbs = {};
  let sendResult = true;
  let pages = [];
  let created = null;
  const mkLobby = (id, data, members) => ({
    id, data: { ...data }, members: members.slice(), left: false,
    getMembers() { return this.members.map((m) => ({ steamId64: m, steamId32: '', accountId: 0 })); },
    getOwner() { return { steamId64: this.members[0], steamId32: '', accountId: 0 }; },
    getMemberCount() { return BigInt(this.members.length); },
    getMemberLimit() { return 12n; },
    getData(k) { return k in this.data ? this.data[k] : null; },
    setData(k, v) { this.data[k] = v; return true; },
    setJoinable() { return true; },
    leave() { this.left = true; },
    openInviteDialog() {},
  });
  const api = {
    callback: { register(id, fn) { cbs[id] = fn; return { disconnect() {} }; } },
    networking: {
      sendP2PPacket(id, type, buf) { sent.push([id, type, buf.toString('utf8')]); return sendResult; },
      isP2PPacketAvailable() { return packets.length ? packets[0].size : 0; },
      readP2PPacket() { return packets.shift(); },
      acceptP2PSession(id) { accepted.push(id); },
    },
    localplayer: { getSteamId: () => ({ steamId64: 100n, steamId32: '', accountId: 0 }), getName: () => 'Хост', setRichPresence() {} },
    matchmaking: {
      createLobby: async () => (created = mkLobby(555n, {}, [100n])),
      joinLobby: async (id) => mkLobby(id, { game: 'pixel-conquest' }, [900n, 100n]),
      getLobbies: async () => pages.shift() || [],
    },
    overlay: { activateInviteDialog() {} },
  };
  const env = process.env.STEAM_APP_ID;
  process.env.STEAM_APP_ID = '480';
  const { mod, restore } = loadMain('steam.cjs', { electron: { ipcMain: ipc.ipcMain }, 'steamworks.js': { init: () => api, electronEnableSteamOverlay() {} } });
  try {
    mod.attach({ isDestroyed: () => false, webContents: { send: (...a) => out.push(a) } });
    mod.init({ getPath: () => '/nowhere/app' });
    assert.deepEqual(Object.keys(cbs).map(Number).sort(), [5, 6, 7, 8]);
    const init = await ipc.handlers.get('steam:init')();
    assert.equal(init.ok, true);
    assert.equal(init.shared, true, 'общий AppID 480 распознан');
    const lob = await ipc.handlers.get('steam:createLobby')(null, 4, 'Комната Хоста');
    assert.equal(lob.ok, true);
    assert.equal(lob.lobbyId, '555');
    assert.deepEqual(created.data, { game: 'pixel-conquest', ver: String(NET_VERSION), name: 'Комната Хоста', host: 'Хост' });

    const pkt = (from, text) => ({ data: Buffer.from(text), size: Buffer.byteLength(text), steamId: { steamId64: from, steamId32: '', accountId: 0 } });
    const got = () => out.filter((a) => a[0] === 'steam:packet').map((a) => a[1] + ' ' + a[2]);
    const left = () => out.filter((a) => a[0] === 'steam:memberLeft').map((a) => a[1]);
    const fails = () => out.filter((a) => a[0] === 'steam:linkFail').map((a) => a[1]);

    cbs[6]({ remote: 200n });
    assert.deepEqual(accepted, [], 'P2P-сессия от не-участника не принята');
    packets.push(pkt(200n, '{"t":"hello"}'));
    mod.readPackets();
    assert.deepEqual(got(), [], 'пакет от не-участника отброшен');

    created.members.push(200n);
    cbs[5]({ lobby: 555n, user_changed: 200n, making_change: 200n, member_state_change: 'Entered' });
    assert.deepEqual(accepted, [200n], 'сессия принята, когда игрок вошёл в лобби');
    packets.push(pkt(200n, '{"t":"hello"}'), pkt(300n, '{"t":"chunk"}'));
    mod.readPackets();
    assert.deepEqual(got(), ['200 {"t":"hello"}']);
    cbs[6]({ remote: 300n });
    cbs[6]({ remote: 200n });
    assert.deepEqual(accepted, [200n, 200n]);

    created.members.push(400n);
    cbs[5]({ lobby: 555n, user_changed: 400n, making_change: 400n, member_state_change: 0 });
    cbs[5]({ lobby: 555n, user_changed: 400n, making_change: 400n, member_state_change: 1 });
    assert.deepEqual(left(), [], 'вход участника — строкой или числом — не считается уходом');
    created.members = created.members.filter((m) => m !== 200n);
    cbs[5]({ lobby: 555n, user_changed: 200n, making_change: 200n, member_state_change: 'Left' });
    created.members = created.members.filter((m) => m !== 400n);
    cbs[5]({ lobby: 555n, user_changed: 400n, making_change: 400n, member_state_change: 2 });
    cbs[5]({ lobby: 777n, user_changed: 100n, making_change: 100n, member_state_change: 'Left' });
    assert.deepEqual(left(), ['200', '400']);
    packets.push(pkt(200n, '{"t":"intent"}'));
    mod.readPackets();
    assert.equal(got().length, 1, 'после ухода пакеты игрока не принимаются');

    ipc.listeners.get('steam:send')(null, '200', '{"t":"turn"}');
    assert.deepEqual(sent[0], [200n, 2, '{"t":"turn"}']);
    assert.deepEqual(fails(), []);
    sendResult = false;
    ipc.listeners.get('steam:send')(null, '200', '{"t":"turn"}');
    ipc.listeners.get('steam:send')(null, '200', '{"t":"turn"}');
    cbs[7]({ remote: 900n, error: 4 });
    assert.deepEqual(fails(), ['200', '900'], 'о сбое связи сообщается, не чаще раза в секунду на игрока');

    const foreign = (k) => mkLobby(BigInt(1000 + k), { name: 'spacewar' }, [1n]);
    const ours = (id, name, ver = String(NET_VERSION)) => mkLobby(id, { game: 'pixel-conquest', name, host: 'Друг', ver }, [5n, 6n]);
    const page1 = [...Array.from({ length: 49 }, (_, k) => foreign(k)), ours(2001n, 'Комната')];
    const page2 = [ours(2002n, 'Старая', '1'), ...Array.from({ length: 48 }, (_, k) => foreign(k + 10)), ours(2001n, 'Комната')];
    pages = [page1, page2, page1, page2];
    const r = await ipc.handlers.get('steam:listLobbies')();
    assert.equal(r.ok, true);
    assert.equal(r.shared, true);
    assert.deepEqual(r.list.map((l) => l.id), ['2001', '2002'], 'лобби игры из нескольких запросов, совместимые первыми');
    assert.equal(r.list[0].name, 'Комната · Друг');
    assert.equal(r.list[0].members, 2);
    assert.equal(r.list[0].max, 12);
    assert.equal(r.scanned, 60);
    assert.equal(pages.length, 1, 'третий запрос без новых лобби — поиск остановлен');
    pages = [[ours(2003n, 'Одна')], [ours(2004n, 'Другая')]];
    const r2 = await ipc.handlers.get('steam:listLobbies')();
    assert.deepEqual(r2.list.map((l) => l.id), ['2003']);
    assert.equal(pages.length, 1, 'неполная страница — повторять запрос незачем');

    const join = await ipc.handlers.get('steam:joinLobby')(null, '888');
    assert.equal(join.hostId, '900');
    assert.equal(created.left, true, 'прежнее лобби покинуто');
    packets.push(pkt(900n, '{"t":"lobby"}'), pkt(200n, '{"t":"lobby"}'));
    mod.readPackets();
    assert.deepEqual(got().slice(1), ['900 {"t":"lobby"}']);
    ipc.listeners.get('steam:leave')();
    packets.push(pkt(900n, '{"t":"turn"}'));
    mod.readPackets();
    assert.equal(got().length, 2, 'без лобби пакеты не принимаются');
  } finally {
    mod.shutdown();
    restore();
    if (env === undefined) delete process.env.STEAM_APP_ID;
    else process.env.STEAM_APP_ID = env;
  }
});

test('LAN-сервер: слишком большое сообщение и флуд закрывают соединение', { timeout: 30000 }, async () => {
  const ipc = fakeIpc();
  const out = [];
  const { mod, restore } = loadMain('lan.cjs', { electron: { ipcMain: ipc.ipcMain } });
  const { WebSocket } = require('ws');
  mod.attach({ isDestroyed: () => false, webContents: { send: (...a) => out.push(a) } });
  let port = 0;
  let r = null;
  for (let k = 0; k < 8 && !(r && r.ok); k++) {
    port = 30000 + Math.floor(Math.random() * 20000);
    r = await ipc.handlers.get('lan:host')(null, port);
  }
  assert.ok(r && r.ok, 'сервер запущен');
  const open = () => new Promise((res, rej) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port);
    ws.once('open', () => res(ws));
    ws.once('error', rej);
  });
  const closed = (ws) => new Promise((res) => {
    const timer = setTimeout(() => res('открыто'), 5000);
    ws.once('close', (code) => { clearTimeout(timer); res(code); });
  });
  const from = (id) => out.filter((a) => a[0] === 'lan:message' && a[1] === id).length;
  try {
    const a = await open();
    a.send('{"t":"hello"}');
    assert.ok(await waitFor(() => from('p1') === 1), 'обычное сообщение доставлено');
    const aClosed = closed(a);
    a.send('x'.repeat(2 * 1024 * 1024));
    assert.equal(await aClosed, 1009, 'слишком большое сообщение закрывает соединение');
    assert.equal(from('p1'), 1);
    const b = await open();
    const bClosed = closed(b);
    for (let k = 0; k < 1500; k++) b.send('{"t":"chat","text":"x"}');
    assert.notEqual(await bClosed, 'открыто', 'флуд закрывает соединение');
    assert.ok(from('p2') <= 1000, `флуд обрезан: ${from('p2')}`);
    assert.ok(await waitFor(() => out.filter((x) => x[0] === 'lan:disconnect').length === 2), 'хост узнал об обоих отключениях');
  } finally {
    mod.stop();
    restore();
  }
});

test('Steam-транспорт: сбой связи с хостом — клиент запрашивает состояние; результат поиска лобби', { timeout: 30000 }, async () => {
  const sent = [];
  const cb = {};
  globalThis.window = {
    native: {
      steam: {
        send: (peer, data) => sent.push([peer, JSON.parse(data)]),
        onPacket: (f) => { cb.packet = f; },
        onMemberLeft: (f) => { cb.left = f; },
        onLinkFail: (f) => { cb.fail = f; },
        listLobbies: async () => ({ ok: true, list: [{ id: '1', name: 'A', members: 1, max: 12 }], scanned: 50, shared: true }),
        leave() {},
      },
    },
  };
  try {
    const t = new SteamTransport(false, '2', '9', 'L');
    const { map, state } = createMatch({ mapDesc: CUSTOM, seed: 5, players: [{ name: 'Хост' }, { name: 'Гость' }], settings: {} });
    const ses = new Session({ map, state, localPid: 1, mode: 'client', transport: t });
    assert.equal(sent[0][1].t, 'ready');
    cb.packet('7', JSON.stringify({ t: 'turn', n: 0, intents: [] }));
    assert.equal(ses.buffer.size, 0, 'ходы не от хоста игнорируются');
    cb.packet('9', JSON.stringify({ t: 'turn', n: 0, intents: [] }));
    ses.update(0.1);
    assert.equal(ses.n, 1);
    cb.fail('7');
    assert.equal(ses.lost, 0);
    cb.fail('9');
    assert.equal(ses.lost, 1);
    assert.equal(ses.awaitingState, true);
    assert.equal(sent[sent.length - 1][1].t, 'desync');
    const scan = await SteamTransport.scan();
    assert.deepEqual(scan, { list: [{ id: '1', name: 'A', members: 1, max: 12 }], scanned: 50, shared: true });
    assert.deepEqual(await SteamTransport.list(), scan.list);
    cb.left('9');
    assert.equal(ses.ended, true);
    t.close();
  } finally {
    delete globalThis.window;
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostLobby, ClientLobby, mergeSettings, defaultLobbySettings } from '../src/client/lobby.js';
import { Session, startOffline, loadOffline, cleanCmd, HASH_EVERY } from '../src/client/session.js';
import { packMessage, Reassembler, NET_VERSION } from '../src/client/net.js';
import { parseCustomMap, generateMap } from '../src/core/map.js';
import { hashState, serializeState } from '../src/core/state.js';

function makeHub() {
  const queue = [];
  const nodes = new Map();
  const stats = { msgs: 0, bytes: 0, types: {} };
  const mk = (selfId, isHost, hostId) => {
    const t = {
      kind: 'test', isHost, selfId, hostId, lobbyId: 'L1', peers: new Set(), closed: false,
      onMessage() {}, onPeerJoin() {}, onPeerLeave() {},
      send(peer, obj) {
        if (this.closed) return;
        const data = JSON.stringify(obj);
        stats.msgs++;
        stats.bytes += data.length;
        stats.types[obj.t] = (stats.types[obj.t] || 0) + 1;
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
  return { host, client, flush, drop, stats, queue };
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
  assert.ok(ctx.host.queue.length <= 32, 'ограничение команд за ход');
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

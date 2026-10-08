import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostLobby, ClientLobby } from '../src/client/lobby.js';

// Транспорт в памяти, имитирующий Steam/LAN (JSON-сериализация как в сети)
function pair() {
  const mk = (isHost, selfId, hostId) => ({
    isHost, selfId, hostId, kind: 'test', peers: new Set(), lobbyId: 'L1',
    onMessage() {}, onPeerJoin() {}, onPeerLeave() {},
    send(peer, obj) { const data = JSON.stringify(obj); queue.push(() => other(this).deliver(this.selfId, data)); },
    broadcast(obj) { for (const p of this.peers) this.send(p, obj); },
    deliver(from, data) { if (this.isHost) this.peers.add(from); this.onMessage(from, JSON.parse(data)); },
    close() {},
  });
  const queue = [];
  const host = mk(true, 'H', 'H');
  const client = mk(false, 'C', 'H');
  client.peers.add('H');
  const other = (t) => (t === host ? client : host);
  const flush = () => { while (queue.length) queue.shift()(); };
  return { host, client, flush };
}

test('лобби, старт и синхронизация команд клиента', () => {
  const { host, client, flush } = pair();
  const hl = new HostLobby(host, 'Хост');
  const cl = new ClientLobby(client, 'Друг');
  flush();
  assert.equal(hl.slots.length, 2);
  assert.equal(cl.view.slots[1].name, 'Друг');
  hl.addAI('easy');
  hl.set({ map: 'pangaea', seed: 77 });
  flush();
  let clientSession = null;
  cl.onStart = (s) => { clientSession = s; };
  const hostSession = hl.start();
  flush();
  clearInterval(cl.retry);
  assert.ok(clientSession);
  assert.equal(clientSession.localPid, 1);
  assert.equal(clientSession.map.provinces.length, hostSession.map.provinces.length);

  const home = clientSession.s.provs.findIndex((P) => P.o === 1);
  clientSession.command({ c: 'recruit', p: home, u: 'inf', n: 10 });
  flush();
  assert.equal(hostSession.s.provs[home].t.inf, 50);
  // Хост тикает и рассылает снимок
  hostSession.update(0.3);
  hostSession.broadcastSnapshot(false);
  flush();
  assert.equal(clientSession.s.provs[home].t.inf, 50);
  assert.ok(clientSession.s.time > 0);

  // Ошибочная команда возвращает ошибку клиенту
  const errors = [];
  clientSession.on((e) => { if (e.type === 'error') errors.push(e.error); });
  clientSession.command({ c: 'build', p: 0, k: 'fort' });
  flush();
  assert.equal(errors.length, 1);

  // Отключение клиента передаёт страну ИИ
  hostSession.onPeerLeave('C');
  assert.equal(hostSession.s.players[1].ai, 'normal');
});

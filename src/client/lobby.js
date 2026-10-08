import { generateMap, MAPS } from '../core/mapgen.js';
import { createState } from '../core/game.js';
import { PLAYER_COLORS } from '../core/config.js';
import { Session } from './session.js';

const MAX_SLOTS = 12;

export class HostLobby {
  constructor(transport, name) {
    this.transport = transport;
    this.slots = [{ peer: 'local', name, ai: null }];
    this.settings = { map: 'world', seed: (Math.random() * 1e9) | 0, victory: 0.7, custom: null };
    this.onChange = () => {};
    this.started = false;
    transport.onMessage = (peer, msg) => this.onMsg(peer, msg);
    transport.onPeerLeave = (peer) => {
      const i = this.slots.findIndex((s) => s.peer === peer);
      if (i > 0) { this.slots.splice(i, 1); this.sync(); }
    };
  }
  onMsg(peer, msg) {
    if (!msg || msg.t !== 'hello') return;
    if (this.slots.some((s) => s.peer === peer)) { this.sync(); return; }
    if (this.started || this.slots.length >= MAX_SLOTS) { this.transport.send(peer, { t: 'full' }); return; }
    this.slots.push({ peer, name: String(msg.name || 'Игрок').slice(0, 20), ai: null });
    this.sync();
  }
  addAI(difficulty = 'normal') {
    if (this.slots.length >= MAX_SLOTS) return;
    const n = this.slots.filter((s) => s.ai).length + 1;
    this.slots.push({ peer: null, name: `Бот ${n}`, ai: difficulty });
    this.sync();
  }
  remove(i) {
    if (i <= 0 || i >= this.slots.length) return;
    const [sl] = this.slots.splice(i, 1);
    if (sl.peer) this.transport.send(sl.peer, { t: 'kick' });
    this.sync();
  }
  set(patch) { Object.assign(this.settings, patch); this.sync(); }
  mapName() {
    return this.settings.custom ? this.settings.custom.name : (MAPS.find((m) => m.id === this.settings.map) || {}).name;
  }
  publicView() {
    return {
      t: 'lobby',
      slots: this.slots.map((s, i) => ({ name: s.name, ai: s.ai, host: i === 0, color: PLAYER_COLORS[i % PLAYER_COLORS.length] })),
      mapName: this.mapName(), seed: this.settings.seed, victory: this.settings.victory,
      lobbyId: this.transport.lobbyId || null,
    };
  }
  sync() {
    const view = this.publicView();
    this.transport.broadcast(view);
    this.onChange(view);
  }
  start() {
    this.started = true;
    const desc = this.settings.custom ? { ...this.settings.custom, seed: this.settings.seed } : { id: this.settings.map, seed: this.settings.seed };
    const map = generateMap(desc);
    const players = this.slots.map((s) => ({ name: s.name, ai: s.ai, netId: s.peer }));
    const state = createState(map, { seed: this.settings.seed, players, victoryShare: this.settings.victory });
    const peers = {};
    this.slots.forEach((s, i) => {
      if (i === 0 || s.ai || !s.peer) return;
      peers[s.peer] = i;
      this.transport.send(s.peer, { t: 'start', you: i, desc, state });
    });
    return new Session({ map, state, localPid: 0, mode: 'host', transport: this.transport, peers });
  }
  close() { this.transport.broadcast({ t: 'closed' }); setTimeout(() => this.transport.close(), 100); }
}

export class ClientLobby {
  constructor(transport, name) {
    this.transport = transport;
    this.name = name;
    this.view = null;
    this.onChange = () => {};
    this.onStart = () => {};
    this.onClosed = () => {};
    transport.onMessage = (peer, msg) => this.onMsg(msg);
    transport.onPeerLeave = () => this.onClosed('Соединение с хостом потеряно');
    this.hello();
    this.retry = setInterval(() => { if (!this.view) this.hello(); }, 2000);
  }
  hello() { this.transport.send(this.transport.hostId, { t: 'hello', name: this.name }); }
  onMsg(msg) {
    if (!msg) return;
    if (msg.t === 'lobby') { this.view = msg; this.onChange(msg); }
    else if (msg.t === 'start') {
      clearInterval(this.retry);
      const map = generateMap(msg.desc);
      const session = new Session({ map, state: msg.state, localPid: msg.you, mode: 'client', transport: this.transport });
      this.onStart(session);
    } else if (msg.t === 'full') { clearInterval(this.retry); this.onClosed('Лобби заполнено или игра уже началась'); }
    else if (msg.t === 'kick') { clearInterval(this.retry); this.onClosed('Хост исключил вас из лобби'); }
    else if (msg.t === 'closed') { clearInterval(this.retry); this.onClosed('Хост закрыл лобби'); }
  }
  close() { clearInterval(this.retry); this.transport.close(); }
}

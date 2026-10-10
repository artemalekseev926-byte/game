import { TICK_MS } from '../core/config.js';
import { Game } from '../core/game.js';
import { generateMap } from '../core/map.js';
import { createState, serializeState, deserializeState, hashState } from '../core/state.js';
import { Reassembler, RateLimit, sendLarge } from './net.js';

export const TURN_MS = TICK_MS;
export const HASH_EVERY = 50;
export const LAG_TURNS = 3;
export const OFFLINE_SPEEDS = [0, 1, 2, 3, 5];
export const NET_SPEEDS = [0, 1, 2];
export const READY_TIMEOUT = 30;
export const STATE_RETRY = 5;
export const STATE_GAP = 3;
export const GAP_WAIT = 1;
export const STALL_WAIT = 4;
export const READY_RETRY = 2;
export const PEER_INTENTS = 32;
export const PEER_QUEUE = 256;
export const CHAT_BURST = 5;
export const CHAT_WINDOW = 5;
const MAX_STEPS = 25;
const MAX_CATCHUP = 20;
const MAX_INTENTS = 256;
const MAX_CMD = 1024;
const MAX_QUEUE = 4096;
const MAX_BUFFER = 20000;
const CHAT_MAX = 200;
const CHAT_KEEP = 200;
const EPS = 1e-9;

const OK = Object.freeze({ ok: true });
const fail = (error) => ({ ok: false, error });

function plain(v) {
  try {
    const str = JSON.stringify(v);
    return str === undefined ? null : JSON.parse(str);
  } catch {
    return null;
  }
}

export function cleanCmd(cmd) {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return null;
  if (typeof cmd.c !== 'string' || !cmd.c || cmd.c.length > 24 || cmd.c[0] === '_') return null;
  let str;
  try { str = JSON.stringify(cmd); } catch { return null; }
  if (!str || str.length > MAX_CMD) return null;
  return JSON.parse(str);
}

export function matchDesc(mapDesc, seed) {
  const d = plain(mapDesc) || { id: 'random' };
  if (d.seed === undefined || d.seed === null) d.seed = Number(seed) >>> 0;
  return d;
}

export function createMatch({ mapDesc, seed, players, settings, map }) {
  const desc = matchDesc(mapDesc, seed);
  const m = map || generateMap(desc);
  const state = createState(m, { seed: Number(seed) >>> 0, players: plain(players) || [], settings: plain(settings) || {} });
  return { map: m, state };
}

export function startOffline(opts) {
  const { map, state } = createMatch(opts);
  return new Session({ map, state, localPid: opts.localPid || 0, mode: 'offline', speed: opts.speed || 1 });
}

export function loadOffline(data, map) {
  const src = typeof data === 'string' ? JSON.parse(data) : data;
  if (!src || typeof src !== 'object' || !src.state) throw new Error('Повреждённое сохранение');
  const raw = src.state;
  const desc = src.mapDesc || raw.mapDesc;
  if (!desc) throw new Error('В сохранении нет описания карты');
  const m = map || generateMap(desc);
  const state = deserializeState(raw, m);
  return new Session({ map: m, state, localPid: Number(src.localPid) || 0, mode: 'offline', turn: Number(src.n) || 0 });
}

export class Session {
  constructor(opts) {
    const {
      map, state, game = null, localPid = 0, mode = 'offline', transport = null, peers = null,
      speed = 1, turn = 0, hashEvery = HASH_EVERY, waitFor = null,
    } = opts;
    this.map = map;
    this.game = game || new Game(map, state);
    this.s = this.game.s;
    this.localPid = localPid;
    this.mode = mode;
    this.transport = transport;
    this.peers = new Map();
    if (peers instanceof Map) for (const [k, v] of peers) this.peers.set(k, v);
    else if (peers) for (const k of Object.keys(peers)) this.peers.set(k, peers[k]);
    this.speeds = mode === 'offline' ? OFFLINE_SPEEDS : mode === 'host' ? NET_SPEEDS : [];
    const sp = Number(speed) || 0;
    this.resumeSpeed = sp > 0 ? sp : 1;
    this.speed = sp > 0 ? sp : 0;
    this.n = turn;
    this.acc = 0;
    this.queue = [];
    this.buffer = new Map();
    this.listeners = [];
    this.chat = [];
    this.ended = false;
    this.closed = false;
    this.endReason = '';
    this.hashEvery = hashEvery;
    this.ready = new Set(mode === 'host' && waitFor ? waitFor : []);
    this.readyWait = 0;
    this.started = this.ready.size === 0;
    this.awaitingState = false;
    this.stateWait = 0;
    this.desyncs = 0;
    this.resyncs = 0;
    this.lastHash = null;
    this.errors = 0;
    this.lastError = null;
    this.clock = 0;
    this.idle = 0;
    this.gap = 0;
    this.readyRetry = 0;
    this.lost = 0;
    this.inbox = new Map();
    this.overflow = new Set();
    this.stateAt = new Map();
    this.stateWanted = new Set();
    this.chatLimit = new RateLimit(CHAT_BURST, CHAT_WINDOW, () => this.clock);
    this.chunks = new Reassembler({ chunks: mode === 'client' });
    if (transport) {
      transport.onMessage = (peer, msg) => this.onNet(peer, msg);
      transport.onPeerLeave = (peer) => this.onPeerLeave(peer);
      transport.onPeerJoin = () => {};
      transport.onTrouble = (peer) => this.onTrouble(peer);
      if (mode === 'client') transport.send(transport.hostId, { t: 'ready' });
    }
  }

  get isAuthority() { return this.mode !== 'client'; }
  get canControl() { return this.mode !== 'client'; }
  get paused() { return this.speed === 0; }
  get player() { return this.s.players[this.localPid] || null; }
  get waiting() {
    if (this.mode === 'host') return this.ready.size;
    if (this.mode === 'client') return this.awaitingState || (this.n === 0 && this.buffer.size === 0) ? 1 : 0;
    return 0;
  }
  get lag() { return this.mode === 'client' ? this.buffer.size : 0; }
  get backlog() {
    let n = 0;
    for (const list of this.inbox.values()) n += list.length;
    return n;
  }

  on(fn) {
    this.listeners.push(fn);
    return () => {
      const k = this.listeners.indexOf(fn);
      if (k >= 0) this.listeners.splice(k, 1);
    };
  }

  emit(ev) {
    for (const fn of this.listeners.slice()) {
      try { fn(ev); } catch (e) { if (typeof console !== 'undefined') console.error(e); }
    }
  }

  validate(cmd) {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.c !== 'string') return fail('Неверная команда');
    return this.game.validate(this.localPid, cmd);
  }

  send(cmd) {
    if (this.ended) return fail('Игра завершена');
    if (!cmd || typeof cmd !== 'object' || typeof cmd.c !== 'string') return fail('Неверная команда');
    if (cmd.c[0] === '_' && this.mode === 'client') return fail('Команда недоступна');
    const r = this.game.validate(this.localPid, cmd);
    if (!r.ok) return r;
    const c = plain(cmd);
    if (!c) return fail('Неверная команда');
    if (this.mode === 'client') {
      this.transport.send(this.transport.hostId, { t: 'intent', cmd: c });
      return OK;
    }
    if (this.queue.length >= MAX_QUEUE) return fail('Слишком много команд');
    this.queue.push({ pid: this.localPid, cmd: c });
    return OK;
  }

  setSpeed(v) {
    if (!this.canControl || this.ended) return false;
    const want = Number(v) || 0;
    if (want <= 0) return this.setPaused(true);
    const list = this.speeds.filter((x) => x > 0);
    let pick = list[0] || 1;
    for (const x of list) if (x <= want) pick = x;
    const was = this.speed;
    this.speed = pick;
    this.resumeSpeed = pick;
    if (this.mode === 'host') {
      this.broadcast({ t: 'speed', v: pick });
      if (was === 0) this.broadcast({ t: 'pause', on: false, v: pick });
    }
    if (was === 0) this.emit({ type: 'pause', on: false });
    this.emit({ type: 'speed', speed: pick });
    return true;
  }

  setPaused(on) {
    if (!this.canControl || this.ended) return false;
    on = !!on;
    if (on === this.paused) return true;
    if (on) {
      this.resumeSpeed = this.speed || this.resumeSpeed || 1;
      this.speed = 0;
    } else {
      this.speed = this.resumeSpeed || 1;
    }
    if (this.mode === 'host') this.broadcast({ t: 'pause', on, v: this.resumeSpeed });
    this.emit({ type: 'pause', on });
    this.emit({ type: 'speed', speed: this.speed });
    return true;
  }

  togglePause() { return this.setPaused(!this.paused); }

  stepTime() { return TURN_MS / 1000 / (this.speed || this.resumeSpeed || 1); }

  alpha() {
    const a = this.acc / this.stepTime();
    return a < 0 ? 0 : a > 1 ? 1 : a;
  }

  update(realDt) {
    if (this.ended) return;
    const dt = Number.isFinite(realDt) && realDt > 0 ? realDt : 0;
    this.clock += dt;
    if (this.mode === 'client') this.updateClient(dt);
    else {
      if (this.stateWanted.size) this.flushStates();
      this.updateAuthority(dt);
    }
  }

  updateAuthority(dt) {
    if (!this.started) {
      this.readyWait += dt;
      if (this.ready.size && this.readyWait < READY_TIMEOUT) return;
      this.ready.clear();
      this.started = true;
      this.emit({ type: 'ready' });
    }
    if (this.speed <= 0 || this.s.phase === 'over') return;
    const step = this.stepTime();
    this.acc += Math.min(dt, 0.5);
    let k = 0;
    while (this.acc + EPS >= step && k < MAX_STEPS) {
      this.acc -= step;
      this.step();
      k++;
      if (this.ended || this.s.phase === 'over') break;
    }
    if (this.acc < 0) this.acc = 0;
    if (this.acc > step) this.acc = step;
  }

  step() {
    const intents = this.queue.splice(0, MAX_INTENTS);
    if (this.inbox.size) this.drainInbox(intents);
    if (this.mode === 'host') {
      const msg = { t: 'turn', n: this.n, intents };
      if (this.hashEvery > 0 && this.n > 0 && this.n % this.hashEvery === 0) {
        msg.hash = hashState(this.s);
        this.lastHash = { n: this.n, hash: msg.hash };
      }
      for (const peer of this.peers.keys()) this.transport.send(peer, msg);
    }
    this.runTurn(intents);
  }

  drainInbox(intents) {
    for (const [peer, list] of this.inbox) {
      const k = Math.min(list.length, PEER_INTENTS, MAX_INTENTS - intents.length);
      for (let j = 0; j < k; j++) intents.push(list[j]);
      if (k > 0) list.splice(0, k);
      if (!list.length) {
        this.inbox.delete(peer);
        this.overflow.delete(peer);
      }
    }
  }

  runTurn(intents) {
    try {
      this.game.tick(intents);
    } catch (e) {
      this.errors++;
      this.lastError = e;
      this.emit({ type: 'error', error: 'Ошибка симуляции: ' + (e && e.message ? e.message : e) });
    }
    this.n++;
    this.emit({ type: 'events', events: this.game.events, n: this.n, tick: this.s.tick });
  }

  available(limit = 64) {
    let k = 0;
    while (k < limit && this.buffer.has(this.n + k)) k++;
    return k;
  }

  updateClient(dt) {
    this.idle += dt;
    if (this.awaitingState) {
      this.stateWait += dt;
      if (this.stateWait >= STATE_RETRY) {
        this.stateWait = 0;
        this.requestState();
      }
      return;
    }
    const step = this.stepTime();
    const avail = this.available();
    if (!avail) {
      this.acc = Math.min(this.acc + dt, step);
      this.watch(dt);
      return;
    }
    this.gap = 0;
    this.acc += Math.min(dt, 0.5);
    let budget = Math.floor((this.acc + EPS) / step);
    if (avail > LAG_TURNS) budget = Math.max(budget, avail - 1);
    budget = Math.min(budget, avail, MAX_CATCHUP);
    let done = 0;
    while (done < budget && !this.ended && !this.awaitingState) {
      if (!this.execBuffered()) break;
      done++;
    }
    this.acc -= done * step;
    if (this.acc < 0) this.acc = 0;
    if (this.acc > step) this.acc = step;
  }

  execBuffered() {
    const t = this.buffer.get(this.n);
    if (!t) return false;
    if (t.hash !== undefined && t.hash !== null) {
      const h = hashState(this.s);
      this.lastHash = { n: this.n, hash: h };
      if (h !== t.hash >>> 0) {
        this.onDesync(h);
        return false;
      }
    }
    this.buffer.delete(this.n);
    this.runTurn(Array.isArray(t.intents) ? t.intents : []);
    return true;
  }

  watch(dt) {
    if (this.buffer.size) {
      this.gap += dt;
      if (this.gap >= GAP_WAIT) this.resync('lost');
      return;
    }
    this.gap = 0;
    if (this.n === 0) {
      this.readyRetry += dt;
      if (this.readyRetry >= READY_RETRY && this.transport) {
        this.readyRetry = 0;
        this.transport.send(this.transport.hostId, { t: 'ready' });
      }
      return;
    }
    if (this.speed > 0 && this.s.phase !== 'over' && this.idle >= STALL_WAIT) this.resync('stall');
  }

  resync(reason) {
    if (this.mode !== 'client' || this.awaitingState || this.ended) return false;
    this.lost++;
    this.gap = 0;
    this.idle = 0;
    this.awaitingState = true;
    this.stateWait = 0;
    this.emit({ type: 'desync', n: this.n, hash: null, reason });
    this.requestState();
    return true;
  }

  onTrouble(peer) {
    if (this.ended || this.mode !== 'client' || !this.transport || peer !== this.transport.hostId) return;
    if (this.n > 0 || this.buffer.size) this.resync('link');
  }

  catchUp(max = 1e9) {
    let k = 0;
    while (k < max && !this.ended && !this.awaitingState && this.buffer.has(this.n)) {
      if (!this.execBuffered()) break;
      k++;
    }
    return k;
  }

  onDesync(hash) {
    this.desyncs++;
    this.awaitingState = true;
    this.stateWait = 0;
    this.emit({ type: 'desync', n: this.n, hash });
    this.requestState(hash);
  }

  requestState(hash) {
    if (this.transport && !this.ended) this.transport.send(this.transport.hostId, { t: 'desync', n: this.n, hash: hash === undefined ? null : hash });
  }

  sendState(peer) {
    const msg = { t: 'state', n: this.n, speed: this.speed, resume: this.resumeSpeed, state: serializeState(this.s) };
    return sendLarge(this.transport, peer, msg);
  }

  queueState(peer) {
    const last = this.stateAt.get(peer);
    if (last === undefined || this.clock - last >= STATE_GAP) this.pushState(peer);
    else this.stateWanted.add(peer);
  }

  pushState(peer) {
    this.stateWanted.delete(peer);
    if (!this.peers.has(peer)) return;
    this.stateAt.set(peer, this.clock);
    this.desyncs++;
    this.emit({ type: 'desync', pid: this.peers.get(peer), n: this.n });
    this.sendState(peer);
  }

  flushStates() {
    for (const peer of this.stateWanted) {
      if (this.clock - (this.stateAt.get(peer) || 0) >= STATE_GAP) this.pushState(peer);
    }
  }

  loadState(msg) {
    if (!Number.isInteger(msg.n) || !msg.state) return;
    let s;
    try {
      s = deserializeState(msg.state, this.map);
    } catch (e) {
      this.endWith('Не удалось синхронизировать игру: ' + (e && e.message ? e.message : e));
      return;
    }
    this.game = new Game(this.map, s);
    this.s = s;
    this.n = msg.n;
    for (const k of [...this.buffer.keys()]) if (k < this.n) this.buffer.delete(k);
    this.awaitingState = false;
    this.stateWait = 0;
    this.idle = 0;
    this.gap = 0;
    this.resyncs++;
    this.acc = 0;
    if (Number(msg.resume) > 0) this.resumeSpeed = Number(msg.resume);
    if (msg.speed !== undefined) this.speed = Number(msg.speed) > 0 ? Number(msg.speed) : 0;
    this.emit({ type: 'resync', n: this.n });
  }

  broadcast(msg) {
    if (!this.transport) return;
    for (const peer of this.peers.keys()) this.transport.send(peer, msg);
  }

  onNet(peer, raw) {
    if (this.closed) return;
    const msg = this.chunks.accept(peer, raw);
    if (!msg || typeof msg.t !== 'string') return;
    if (this.mode === 'host') this.onHostMsg(peer, msg);
    else if (this.mode === 'client') this.onClientMsg(peer, msg);
  }

  onHostMsg(peer, msg) {
    const pid = this.peers.get(peer);
    if (pid === undefined) {
      if (msg.t === 'hello') this.transport.send(peer, { t: 'reject', reason: 'Игра уже началась' });
      return;
    }
    switch (msg.t) {
      case 'intent':
        this.takeIntent(peer, pid, msg.cmd);
        return;
      case 'chat':
        if (this.chatLimit.take(peer)) this.postChat(pid, msg.text);
        else if (this.chatLimit.firstMiss(peer)) this.transport.send(peer, { t: 'err', error: 'Слишком много сообщений в чате — подождите несколько секунд' });
        return;
      case 'desync':
        this.queueState(peer);
        return;
      case 'ready':
        if (this.ready.delete(peer) && !this.ready.size && !this.started) {
          this.started = true;
          this.emit({ type: 'ready' });
        }
        return;
      case 'bye':
        this.onPeerLeave(peer);
        return;
      default:
    }
  }

  takeIntent(peer, pid, raw) {
    const cmd = cleanCmd(raw);
    if (!cmd) return false;
    let list = this.inbox.get(peer);
    if (!list) {
      list = [];
      this.inbox.set(peer, list);
    }
    if (list.length >= PEER_QUEUE) {
      if (!this.overflow.has(peer)) {
        this.overflow.add(peer);
        this.transport.send(peer, { t: 'err', error: 'Слишком много команд подряд — часть из них не выполнена' });
      }
      return false;
    }
    list.push({ pid, cmd });
    return true;
  }

  onClientMsg(peer, msg) {
    if (this.transport && peer !== this.transport.hostId) return;
    switch (msg.t) {
      case 'turn':
        if (!Number.isInteger(msg.n) || msg.n < this.n || this.buffer.has(msg.n)) return;
        if (this.buffer.size >= MAX_BUFFER) {
          this.resync('lost');
          return;
        }
        this.buffer.set(msg.n, msg);
        this.idle = 0;
        return;
      case 'state':
        this.loadState(msg);
        return;
      case 'speed':
        this.idle = 0;
        if (Number(msg.v) > 0) {
          this.resumeSpeed = Number(msg.v);
          if (this.speed > 0) this.speed = this.resumeSpeed;
          this.emit({ type: 'speed', speed: this.speed });
        }
        return;
      case 'pause': {
        this.idle = 0;
        const on = !!msg.on;
        if (Number(msg.v) > 0) this.resumeSpeed = Number(msg.v);
        if (on === this.paused) return;
        this.speed = on ? 0 : this.resumeSpeed || 1;
        this.emit({ type: 'pause', on });
        this.emit({ type: 'speed', speed: this.speed });
        return;
      }
      case 'chat':
        this.pushChat(msg);
        return;
      case 'closed':
        this.endWith('Хост завершил игру');
        return;
      case 'kick':
        this.endWith('Хост исключил вас из игры');
        return;
      case 'err':
        this.emit({ type: 'error', error: String(msg.error || '') });
        return;
      default:
    }
  }

  onPeerLeave(peer) {
    if (this.ended) return;
    if (this.mode === 'host') {
      const pid = this.peers.get(peer);
      if (pid === undefined) return;
      this.peers.delete(peer);
      this.forget(peer);
      if (this.ready.delete(peer) && !this.ready.size && !this.started) {
        this.started = true;
        this.emit({ type: 'ready' });
      }
      const p = this.s.players[pid];
      this.queue.push({ pid, cmd: { c: '_ai', pid, level: 'normal' } });
      this.emit({ type: 'peerLeft', pid, name: p ? p.name : '' });
    } else if (this.mode === 'client') {
      this.endWith('Соединение с хостом потеряно');
    }
  }

  forget(peer) {
    this.chunks.drop(peer);
    this.inbox.delete(peer);
    this.overflow.delete(peer);
    this.stateAt.delete(peer);
    this.stateWanted.delete(peer);
    this.chatLimit.drop(peer);
  }

  sendChat(text) {
    const t = String(text === undefined || text === null ? '' : text).trim().slice(0, CHAT_MAX);
    if (!t || this.ended) return false;
    if (this.mode === 'client') {
      this.transport.send(this.transport.hostId, { t: 'chat', text: t });
      return true;
    }
    this.postChat(this.localPid, t);
    return true;
  }

  postChat(pid, text) {
    const t = String(text === undefined || text === null ? '' : text).trim().slice(0, CHAT_MAX);
    if (!t) return;
    const p = this.s.players[pid];
    const c = { t: 'chat', from: pid, name: p ? p.name : 'Игрок', color: p ? p.color : '#ffffff', text: t };
    this.broadcast(c);
    this.pushChat(c);
  }

  pushChat(m) {
    const c = {
      from: Number.isInteger(m.from) ? m.from : -1,
      name: String(m.name || '').slice(0, 32),
      color: typeof m.color === 'string' ? m.color : '#ffffff',
      text: String(m.text || '').slice(0, CHAT_MAX),
      tick: this.s.tick,
    };
    this.chat.push(c);
    if (this.chat.length > CHAT_KEEP) this.chat.splice(0, this.chat.length - CHAT_KEEP);
    this.emit({ type: 'chat', chat: c });
  }

  hash() { return hashState(this.s); }

  snapshot() {
    return { version: this.s.version, mapDesc: plain(this.s.mapDesc), localPid: this.localPid, n: this.n, state: serializeState(this.s) };
  }

  endWith(reason) {
    if (this.ended) return;
    this.ended = true;
    this.endReason = reason;
    this.emit({ type: 'disconnected', reason });
  }

  close(delay = 100) {
    if (this.closed) return;
    this.closed = true;
    this.ended = true;
    const t = this.transport;
    if (!t) return;
    if (this.mode === 'host') this.broadcast({ t: 'closed' });
    else if (this.mode === 'client') t.send(t.hostId, { t: 'bye' });
    if (delay > 0 && typeof setTimeout === 'function') setTimeout(() => t.close(), delay);
    else t.close();
  }
}

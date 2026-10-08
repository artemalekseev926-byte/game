// Игровая сессия: офлайн, хост (авторитетная симуляция) или клиент (снимки от хоста).
import { TICK } from '../core/config.js';
import { Game } from '../core/game.js';
import { runAI } from '../core/ai.js';

const SNAP_INTERVAL = 200; // мс реального времени между снимками для клиентов
const FULL_EVERY = 25; // полный снимок каждые N отправок

const provKey = (P) => JSON.stringify([P.o, P.t, P.b, Math.round(P.pop), P.unrest > 0 ? 1 : 0, P.build && [P.build.k, Math.round(P.build.t), P.build.total], Math.ceil(P.cd)]);

export class Session {
  constructor({ map, state, localPid, mode, transport = null, peers = {} }) {
    this.map = map;
    this.mode = mode; // 'offline' | 'host' | 'client'
    this.localPid = localPid;
    this.transport = transport;
    this.peers = peers; // peerId -> pid (только у хоста)
    this.speed = 1;
    this.acc = 0;
    this.listeners = [];
    this.chat = [];
    this.lastSnapAt = 0;
    this.snapCount = 0;
    this.pendingFx = [];
    this.sentKeys = [];
    this.recvAt = performance.now();
    this.ended = false;
    if (mode === 'client') {
      this.s = state;
    } else {
      this.game = new Game(map, state);
      this.s = state;
    }
    if (transport) {
      transport.onMessage = (peer, msg) => this.onNet(peer, msg);
      transport.onPeerLeave = (peer) => this.onPeerLeave(peer);
    }
  }

  get isAuthority() { return this.mode !== 'client'; }
  on(fn) { this.listeners.push(fn); }
  emit(ev) { for (const fn of this.listeners) fn(ev); }

  update(realDt) {
    if (this.ended) return;
    if (this.isAuthority) {
      this.acc += Math.min(realDt, 0.5) * this.speed;
      let fx = [];
      while (this.acc >= TICK && this.s.winner === null) {
        this.acc -= TICK;
        this.game.tick();
        runAI(this.game, TICK);
        fx = fx.concat(this.game.fx);
      }
      if (this.s.winner !== null) this.acc = 0;
      if (fx.length) this.handleFx(fx);
      if (this.mode === 'host') {
        this.pendingFx.push(...fx);
        const now = performance.now();
        if (now - this.lastSnapAt >= SNAP_INTERVAL) {
          this.lastSnapAt = now;
          this.broadcastSnapshot(false);
        }
      }
    }
  }

  alpha() {
    if (this.s.winner !== null) return 0;
    if (this.isAuthority) return Math.min(this.acc, TICK);
    return Math.min(0.6, ((performance.now() - this.recvAt) / 1000) * this.speed);
  }

  handleFx(fx) {
    this.emit({ type: 'fx', fx });
  }

  command(cmd) {
    if (this.isAuthority) return this.game.command(this.localPid, cmd);
    this.transport.send(this.transport.hostId, { t: 'cmd', cmd });
    return { ok: true, pending: true };
  }

  setSpeed(v) {
    if (!this.isAuthority) return;
    this.speed = v;
    if (this.mode === 'host') this.broadcastSnapshot(false);
  }

  sendChat(text) {
    text = String(text).slice(0, 200);
    const name = this.s.players[this.localPid].name;
    if (this.mode === 'host') this.onChat({ from: this.localPid, name, text });
    else if (this.mode === 'client') this.transport.send(this.transport.hostId, { t: 'chat', text });
  }
  onChat(c) {
    if (this.mode === 'host') this.transport.broadcast({ t: 'chat', ...c });
    this.chat.push(c);
    this.emit({ type: 'chat', chat: c });
  }

  // ---------- Сеть ----------
  snapshot(full) {
    const provs = [];
    this.s.provs.forEach((P, i) => {
      const k = provKey(P);
      if (full || this.sentKeys[i] !== k) { provs.push([i, P]); this.sentKeys[i] = k; }
    });
    return {
      t: 'snap', full, speed: this.speed,
      time: this.s.time, tickN: this.s.tickN, winner: this.s.winner,
      players: this.s.players, armies: this.s.armies, shots: this.s.shots, provs,
      fx: this.pendingFx,
    };
  }
  broadcastSnapshot(full) {
    if (!this.transport) return;
    this.snapCount++;
    const snap = this.snapshot(full || this.snapCount % FULL_EVERY === 0);
    this.pendingFx = [];
    this.transport.broadcast(snap);
  }

  onNet(peer, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (this.mode === 'host') {
      const pid = this.peers[peer];
      if (pid === undefined) return;
      if (msg.t === 'cmd' && msg.cmd && typeof msg.cmd === 'object') {
        const res = this.game.command(pid, msg.cmd);
        if (!res.ok) this.transport.send(peer, { t: 'err', error: res.error });
      } else if (msg.t === 'chat') {
        this.onChat({ from: pid, name: this.s.players[pid].name, text: String(msg.text || '').slice(0, 200) });
      } else if (msg.t === 'resync') {
        this.transport.send(peer, this.snapshot(true));
      }
    } else if (this.mode === 'client') {
      if (msg.t === 'snap') this.applySnapshot(msg);
      else if (msg.t === 'err') this.emit({ type: 'error', error: msg.error });
      else if (msg.t === 'chat') { this.chat.push(msg); this.emit({ type: 'chat', chat: msg }); }
      else if (msg.t === 'closed') this.endWith('Хост завершил игру');
    }
  }

  applySnapshot(m) {
    const s = this.s;
    s.time = m.time; s.tickN = m.tickN; s.winner = m.winner;
    s.players = m.players; s.armies = m.armies; s.shots = m.shots;
    for (const [i, P] of m.provs) s.provs[i] = P;
    this.speed = m.speed;
    this.recvAt = performance.now();
    if (m.fx && m.fx.length) this.handleFx(m.fx);
  }

  onPeerLeave(peer) {
    if (this.mode === 'host') {
      const pid = this.peers[peer];
      if (pid === undefined) return;
      delete this.peers[peer];
      const pl = this.s.players[pid];
      pl.ai = 'normal';
      pl.netId = null;
      const ev = { k: 'msg', to: -1, text: `${pl.name} отключился — его страной управляет ИИ`, kind: 'info' };
      this.pendingFx.push(ev);
      this.emit({ type: 'fx', fx: [ev] });
    } else if (this.mode === 'client') {
      this.endWith('Соединение с хостом потеряно');
    }
  }

  endWith(reason) {
    if (this.ended) return;
    this.ended = true;
    this.emit({ type: 'disconnected', reason });
  }

  close() {
    this.ended = true;
    if (this.transport) {
      if (this.mode === 'host') this.transport.broadcast({ t: 'closed' });
      setTimeout(() => this.transport.close(), 100);
    }
  }
}

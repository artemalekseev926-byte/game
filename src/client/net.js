const native = () => (typeof window !== 'undefined' ? window.native : null);

export const hasNative = () => !!native();
export const DEFAULT_PORT = 27420;
export const NET_VERSION = 2;
export const CHUNK_SIZE = 192 * 1024;
const MAX_PARTS = 4096;
const MAX_PENDING = 4;

let chunkSeq = 0;

export function packMessage(obj, limit = CHUNK_SIZE) {
  const data = JSON.stringify(obj);
  if (data.length <= limit) return [obj];
  const id = (++chunkSeq).toString(36) + '.' + data.length.toString(36);
  const of = Math.ceil(data.length / limit);
  const out = [];
  for (let i = 0; i < of; i++) out.push({ t: 'chunk', id, i, of, data: data.slice(i * limit, (i + 1) * limit) });
  return out;
}

export function sendLarge(transport, peer, obj, limit) {
  const parts = packMessage(obj, limit || transport.chunkSize || CHUNK_SIZE);
  for (const m of parts) transport.send(peer, m);
  return parts.length;
}

export class Reassembler {
  constructor() {
    this.pending = new Map();
  }

  accept(peer, msg) {
    if (!msg || typeof msg !== 'object') return null;
    if (msg.t !== 'chunk') return msg;
    const { id, i, of, data } = msg;
    if (typeof id !== 'string' || typeof data !== 'string' || !Number.isInteger(i) || !Number.isInteger(of) || of < 1 || of > MAX_PARTS || i < 0 || i >= of) return null;
    const key = peer + '|' + id;
    let e = this.pending.get(key);
    if (!e) {
      e = { peer, of, got: 0, parts: new Array(of) };
      this.pending.set(key, e);
      this.trim(peer, key);
    }
    if (e.of !== of || e.parts[i] !== undefined) return null;
    e.parts[i] = data;
    e.got++;
    if (e.got < of) return null;
    this.pending.delete(key);
    try { return JSON.parse(e.parts.join('')); } catch { return null; }
  }

  trim(peer, keep) {
    const mine = [];
    for (const [k, e] of this.pending) if (e.peer === peer && k !== keep) mine.push(k);
    while (mine.length >= MAX_PENDING) this.pending.delete(mine.shift());
  }

  drop(peer) {
    for (const [k, e] of this.pending) if (e.peer === peer) this.pending.delete(k);
  }
}

class BaseTransport {
  constructor() {
    this.peers = new Set();
    this.chunkSize = CHUNK_SIZE;
    this.onMessage = () => {};
    this.onPeerJoin = () => {};
    this.onPeerLeave = () => {};
  }
  broadcast(obj) { for (const p of this.peers) this.send(p, obj); }
  parse(data) {
    try { return JSON.parse(data); } catch { return null; }
  }
}

export class SteamTransport extends BaseTransport {
  static async init() {
    const n = native();
    if (!n || !n.steam) return { ok: false, error: 'Steam доступен только в версии для ПК (Electron)' };
    return n.steam.init();
  }
  static async list() {
    const r = await native().steam.listLobbies();
    if (!r.ok) throw new Error(r.error);
    return r.list;
  }
  static async host(maxPlayers, name) {
    const r = await native().steam.createLobby(maxPlayers, name);
    if (!r.ok) throw new Error(r.error);
    return new SteamTransport(true, r.selfId, r.selfId, r.lobbyId);
  }
  static async join(lobbyId) {
    const r = await native().steam.joinLobby(String(lobbyId));
    if (!r.ok) throw new Error(r.error);
    return new SteamTransport(false, r.selfId, r.hostId, r.lobbyId);
  }
  constructor(isHost, selfId, hostId, lobbyId) {
    super();
    this.kind = 'steam';
    this.isHost = isHost;
    this.selfId = selfId;
    this.hostId = hostId;
    this.lobbyId = lobbyId;
    this.closed = false;
    if (!isHost) this.peers.add(hostId);
    const n = native();
    n.steam.onPacket((from, data) => {
      if (this.closed) return;
      const msg = this.parse(data);
      if (!msg) return;
      if (!this.isHost && from !== this.hostId) return;
      if (this.isHost && !this.peers.has(from)) { this.peers.add(from); this.onPeerJoin(from); }
      this.onMessage(from, msg);
    });
    n.steam.onMemberLeft((id) => {
      if (this.closed) return;
      if (this.peers.has(id)) { this.peers.delete(id); this.onPeerLeave(id); }
    });
  }
  send(peer, obj) { if (!this.closed) native().steam.send(peer, JSON.stringify(obj)); }
  invite() { native().steam.invite(); }
  close() {
    if (this.closed) return;
    this.closed = true;
    native().steam.leave();
  }
}

export class LanHostTransport extends BaseTransport {
  static async host(port = DEFAULT_PORT) {
    const n = native();
    if (!n || !n.lan) throw new Error('Хостинг по сети доступен только в версии для ПК');
    const r = await n.lan.host(port);
    if (!r.ok) throw new Error(r.error);
    return new LanHostTransport(r);
  }
  constructor(info) {
    super();
    this.kind = 'lan';
    this.isHost = true;
    this.selfId = 'host';
    this.hostId = 'host';
    this.ips = info.ips;
    this.port = info.port;
    this.chunkSize = 4 * 1024 * 1024;
    this.closed = false;
    const n = native();
    n.lan.onConnect((id) => { if (!this.closed) { this.peers.add(id); this.onPeerJoin(id); } });
    n.lan.onDisconnect((id) => { if (!this.closed && this.peers.delete(id)) this.onPeerLeave(id); });
    n.lan.onMessage((id, data) => {
      if (this.closed) return;
      const m = this.parse(data);
      if (m) this.onMessage(id, m);
    });
  }
  send(peer, obj) { if (!this.closed) native().lan.send(peer, JSON.stringify(obj)); }
  close() {
    if (this.closed) return;
    this.closed = true;
    native().lan.stop();
  }
}

export class LanClientTransport extends BaseTransport {
  static connect(address) {
    let addr = String(address || '').trim();
    if (!addr) return Promise.reject(new Error('Введите адрес хоста'));
    if (!/:\d+$/.test(addr)) addr += ':' + DEFAULT_PORT;
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket('ws://' + addr); } catch { reject(new Error('Неверный адрес: ' + addr)); return; }
      const timer = setTimeout(() => { ws.close(); reject(new Error('Хост не отвечает')); }, 6000);
      ws.onopen = () => { clearTimeout(timer); resolve(new LanClientTransport(ws)); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('Не удалось подключиться к ' + addr)); };
    });
  }
  constructor(ws) {
    super();
    this.kind = 'lan';
    this.isHost = false;
    this.ws = ws;
    this.selfId = 'me';
    this.hostId = 'host';
    this.chunkSize = 4 * 1024 * 1024;
    this.peers.add('host');
    ws.onerror = null;
    ws.onmessage = (e) => { const m = this.parse(e.data); if (m) this.onMessage('host', m); };
    ws.onclose = () => { if (this.peers.delete('host')) this.onPeerLeave('host'); };
  }
  send(_peer, obj) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  close() {
    this.ws.onclose = null;
    this.ws.onmessage = null;
    this.peers.delete('host');
    this.ws.close();
  }
}

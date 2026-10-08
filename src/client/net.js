// Транспорты для мультиплеера: Steam P2P (через steamworks.js в Electron) и LAN/IP (WebSocket).
// Интерфейс: isHost, selfId, hostId, send(peer, obj), broadcast(obj), onMessage, onPeerJoin, onPeerLeave, close().
const native = () => (typeof window !== 'undefined' ? window.native : null);

export const hasNative = () => !!native();
export const DEFAULT_PORT = 27420;

class BaseTransport {
  constructor() {
    this.peers = new Set();
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
  static async host(maxPlayers) {
    const r = await native().steam.createLobby(maxPlayers);
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
    if (!isHost) this.peers.add(hostId);
    const n = native();
    n.steam.onPacket((from, data) => {
      const msg = this.parse(data);
      if (!msg) return;
      if (this.isHost && !this.peers.has(from)) { this.peers.add(from); this.onPeerJoin(from); }
      if (!this.isHost && from !== this.hostId) return;
      this.onMessage(from, msg);
    });
    n.steam.onMemberLeft((id) => {
      if (this.peers.has(id)) { this.peers.delete(id); this.onPeerLeave(id); }
    });
  }
  send(peer, obj) { native().steam.send(peer, JSON.stringify(obj)); }
  invite() { native().steam.invite(); }
  close() { native().steam.leave(); }
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
    const n = native();
    n.lan.onConnect((id) => { this.peers.add(id); this.onPeerJoin(id); });
    n.lan.onDisconnect((id) => { if (this.peers.delete(id)) this.onPeerLeave(id); });
    n.lan.onMessage((id, data) => { const m = this.parse(data); if (m) this.onMessage(id, m); });
  }
  send(peer, obj) { native().lan.send(peer, JSON.stringify(obj)); }
  close() { native().lan.stop(); }
}

export class LanClientTransport extends BaseTransport {
  static connect(address) {
    let addr = address.trim();
    if (!addr.includes(':')) addr += ':' + DEFAULT_PORT;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://' + addr);
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
    this.peers.add('host');
    ws.onmessage = (e) => { const m = this.parse(e.data); if (m) this.onMessage('host', m); };
    ws.onclose = () => this.onPeerLeave('host');
  }
  send(_peer, obj) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  close() { this.ws.onclose = null; this.ws.close(); }
}

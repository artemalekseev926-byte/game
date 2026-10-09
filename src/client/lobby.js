import { MAPS, parseCustomMap } from '../core/map.js';
import { PLAYER_COLORS, DEFAULT_SETTINGS, DIFFICULTY } from '../core/config.js';
import { normalizeSettings } from '../core/state.js';
import { Session, createMatch } from './session.js';
import { NET_VERSION, Reassembler, sendLarge } from './net.js';

export const MAX_SLOTS = 12;
const HEX = /^#[0-9a-fA-F]{6}$/;
const CHAT_MAX = 200;

export const randomSeed = () => Math.floor(Math.random() * 2147483647) >>> 0;

export function cleanName(v, def = 'Игрок') {
  const s = String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20);
  return s || def;
}

export const isColor = (c) => typeof c === 'string' && HEX.test(c);

export function defaultLobbySettings() {
  return {
    map: 'world',
    custom: null,
    seed: randomSeed(),
    victory: { ...DEFAULT_SETTINGS.victory },
    spawnSeconds: DEFAULT_SETTINGS.spawnSeconds,
    difficulty: DEFAULT_SETTINGS.difficulty,
  };
}

function customOf(v) {
  if (!v) return null;
  const d = v.id === 'custom' && Array.isArray(v.rows) ? v : parseCustomMap(v);
  const out = { id: 'custom', name: String(d.name || 'Своя карта').slice(0, 40), rows: d.rows.slice() };
  if (Number.isFinite(Number(d.scale)) && Number(d.scale) >= 1) out.scale = Math.min(16, Math.floor(Number(d.scale)));
  return out;
}

export function mergeSettings(cur, patch) {
  const next = { ...cur, victory: { ...cur.victory } };
  if (!patch || typeof patch !== 'object') return next;
  if (patch.map !== undefined && patch.map !== 'custom' && MAPS.some((m) => m.id === patch.map)) {
    next.map = patch.map;
    next.custom = null;
  }
  if (patch.custom !== undefined) {
    next.custom = customOf(patch.custom);
    if (next.custom) next.map = 'custom';
    else if (next.map === 'custom') next.map = MAPS[0].id;
  }
  if (patch.seed !== undefined && Number.isFinite(Number(patch.seed))) next.seed = Math.floor(Math.abs(Number(patch.seed))) >>> 0;
  const merged = normalizeSettings({
    victory: { ...next.victory, ...(patch.victory && typeof patch.victory === 'object' ? patch.victory : {}) },
    spawnSeconds: patch.spawnSeconds !== undefined ? patch.spawnSeconds : next.spawnSeconds,
    difficulty: patch.difficulty !== undefined ? patch.difficulty : next.difficulty,
  });
  next.victory = merged.victory;
  next.spawnSeconds = merged.spawnSeconds;
  next.difficulty = merged.difficulty;
  return next;
}

export function mapLimit(settings) {
  if (settings.custom) return MAX_SLOTS;
  const m = MAPS.find((x) => x.id === settings.map);
  return Math.min(MAX_SLOTS, m && m.maxPlayers ? m.maxPlayers : MAX_SLOTS);
}

export function lobbyMapDesc(settings) {
  return settings.custom ? { ...settings.custom, seed: settings.seed } : { id: settings.map, seed: settings.seed };
}

export function gameSettings(settings) {
  return normalizeSettings({ victory: settings.victory, spawnSeconds: settings.spawnSeconds, difficulty: settings.difficulty });
}

export class HostLobby {
  constructor(transport, name, opts = {}) {
    this.transport = transport;
    this.uid = 1;
    this.slots = [{ id: this.uid++, peer: null, name: cleanName(name), ai: null, color: isColor(opts.color) ? opts.color : PLAYER_COLORS[0] }];
    this.settings = mergeSettings(defaultLobbySettings(), opts.settings);
    this.customRev = this.settings.custom ? 1 : 0;
    this.chat = [];
    this.started = false;
    this.closed = false;
    this.onChange = () => {};
    this.onChat = () => {};
    this.chunks = new Reassembler();
    transport.onMessage = (peer, msg) => this.onMsg(peer, msg);
    transport.onPeerLeave = (peer) => this.onLeave(peer);
    transport.onPeerJoin = () => {};
  }

  get maxPlayers() { return mapLimit(this.settings); }

  mapName() {
    if (this.settings.custom) return this.settings.custom.name;
    const m = MAPS.find((x) => x.id === this.settings.map);
    return m ? m.name : this.settings.map;
  }

  mapDesc() { return lobbyMapDesc(this.settings); }

  freeColor() {
    const used = new Set(this.slots.map((s) => s.color.toLowerCase()));
    for (const c of PLAYER_COLORS) if (!used.has(c.toLowerCase())) return c;
    return PLAYER_COLORS[this.slots.length % PLAYER_COLORS.length];
  }

  colorTaken(color, except) {
    const c = color.toLowerCase();
    return this.slots.some((s, i) => i !== except && s.color.toLowerCase() === c);
  }

  slotOf(peer) { return this.slots.findIndex((s) => s.peer !== null && s.peer === peer); }

  canStart() {
    if (this.started) return 'Игра уже началась';
    if (this.slots.length < 2) return 'Нужно минимум 2 участника — добавьте бота или дождитесь друга';
    if (this.slots.length > this.maxPlayers) return `На этой карте не больше ${this.maxPlayers} участников`;
    return null;
  }

  publicView(you = 0) {
    const s = this.settings;
    return {
      t: 'lobby',
      v: NET_VERSION,
      you,
      slots: this.slots.map((sl, i) => ({ id: sl.id, name: sl.name, ai: sl.ai, color: sl.color, host: i === 0, human: !sl.ai })),
      settings: {
        map: s.map,
        mapName: this.mapName(),
        custom: s.custom ? { name: s.custom.name, rev: this.customRev, w: s.custom.rows[0].length, h: s.custom.rows.length } : null,
        seed: s.seed,
        victory: { ...s.victory },
        spawnSeconds: s.spawnSeconds,
        difficulty: s.difficulty,
      },
      maxPlayers: this.maxPlayers,
      canStart: this.canStart(),
      lobbyId: this.transport.lobbyId || null,
      kind: this.transport.kind || null,
    };
  }

  sync() {
    if (this.closed) return null;
    this.slots.forEach((sl, i) => { if (sl.peer !== null) this.transport.send(sl.peer, this.publicView(i)); });
    const view = this.publicView(0);
    this.onChange(view);
    return view;
  }

  sendCustom(peer) {
    if (!this.settings.custom) return;
    sendLarge(this.transport, peer, { t: 'custom', rev: this.customRev, desc: this.settings.custom });
  }

  onMsg(peer, raw) {
    if (this.closed || this.started) return;
    const msg = this.chunks.accept(peer, raw);
    if (!msg || typeof msg.t !== 'string') return;
    if (msg.t === 'hello') { this.onHello(peer, msg); return; }
    const i = this.slotOf(peer);
    if (i < 0) return;
    if (msg.t === 'color') {
      if (!this.setColor(i, msg.color)) this.transport.send(peer, { t: 'err', error: 'Этот цвет уже занят' });
    } else if (msg.t === 'name') {
      this.slots[i].name = cleanName(msg.name, this.slots[i].name);
      this.sync();
    } else if (msg.t === 'chat') {
      this.postChat(i, msg.text);
    } else if (msg.t === 'bye') {
      this.onLeave(peer);
    }
  }

  onHello(peer, msg) {
    const known = this.slotOf(peer);
    if (known >= 0) {
      this.sendCustom(peer);
      this.transport.send(peer, this.publicView(known));
      return;
    }
    if (msg.v !== NET_VERSION) { this.transport.send(peer, { t: 'reject', reason: 'У хоста другая версия игры' }); return; }
    if (this.slots.length >= Math.min(MAX_SLOTS, this.maxPlayers)) { this.transport.send(peer, { t: 'reject', reason: 'Лобби заполнено' }); return; }
    const color = isColor(msg.color) && !this.colorTaken(msg.color, -1) ? msg.color : this.freeColor();
    this.slots.push({ id: this.uid++, peer, name: cleanName(msg.name), ai: null, color });
    this.sendCustom(peer);
    this.sync();
  }

  onLeave(peer) {
    if (this.started) return;
    const i = this.slotOf(peer);
    this.chunks.drop(peer);
    if (i > 0) {
      this.slots.splice(i, 1);
      this.sync();
    }
  }

  addAI(level) {
    if (this.started || this.slots.length >= Math.min(MAX_SLOTS, this.maxPlayers)) return -1;
    const lvl = DIFFICULTY[level] ? level : this.settings.difficulty;
    const used = new Set(this.slots.map((s) => s.name));
    let k = 1;
    while (used.has(`Бот ${k}`)) k++;
    this.slots.push({ id: this.uid++, peer: null, name: `Бот ${k}`, ai: lvl, color: this.freeColor() });
    this.sync();
    return this.slots.length - 1;
  }

  setAI(i, level) {
    const sl = this.slots[i];
    if (!sl || !sl.ai || !DIFFICULTY[level]) return false;
    sl.ai = level;
    this.sync();
    return true;
  }

  setColor(i, color) {
    const sl = this.slots[i];
    if (!sl || !isColor(color) || this.colorTaken(color, i)) return false;
    sl.color = color;
    this.sync();
    return true;
  }

  rename(i, name) {
    const sl = this.slots[i];
    if (!sl || (sl.peer !== null && i !== 0)) return false;
    sl.name = cleanName(name, sl.name);
    this.sync();
    return true;
  }

  remove(i) {
    if (this.started || i <= 0 || i >= this.slots.length) return false;
    const [sl] = this.slots.splice(i, 1);
    if (sl.peer !== null) this.transport.send(sl.peer, { t: 'kick' });
    this.sync();
    return true;
  }

  set(patch) {
    if (this.started) return this.publicView(0);
    const prev = this.settings.custom;
    this.settings = mergeSettings(this.settings, patch);
    if (this.settings.custom && this.settings.custom !== prev) {
      this.customRev++;
      for (const sl of this.slots) if (sl.peer !== null) this.sendCustom(sl.peer);
    }
    return this.sync();
  }

  postChat(i, text) {
    const t = String(text === undefined || text === null ? '' : text).trim().slice(0, CHAT_MAX);
    const sl = this.slots[i];
    if (!t || !sl) return;
    const c = { t: 'chat', from: i, name: sl.name, color: sl.color, text: t };
    for (const s of this.slots) if (s.peer !== null) this.transport.send(s.peer, c);
    this.chat.push(c);
    this.onChat(c);
  }

  sendChat(text) { this.postChat(0, text); }

  start(opts = {}) {
    const err = this.canStart();
    if (err) throw new Error(err);
    this.started = true;
    const mapDesc = this.mapDesc();
    const seed = this.settings.seed;
    const settings = gameSettings(this.settings);
    const players = this.slots.map((sl) => ({ name: sl.name, color: sl.color, ai: sl.ai, netId: sl.peer }));
    const peers = new Map();
    this.slots.forEach((sl, i) => { if (sl.peer !== null) peers.set(sl.peer, i); });
    for (const [peer, you] of peers) sendLarge(this.transport, peer, { t: 'start', v: NET_VERSION, you, mapDesc, seed, players, settings, speed: 1 });
    const { map, state } = createMatch({ mapDesc, seed, players, settings, map: opts.map });
    return new Session({ map, state, localPid: 0, mode: 'host', transport: this.transport, peers, waitFor: [...peers.keys()], hashEvery: opts.hashEvery });
  }

  close(delay = 100) {
    if (this.closed) return;
    this.closed = true;
    if (!this.started) this.transport.broadcast({ t: 'closed' });
    const t = this.transport;
    if (delay > 0 && typeof setTimeout === 'function') setTimeout(() => t.close(), delay);
    else t.close();
  }
}

export class ClientLobby {
  constructor(transport, name, opts = {}) {
    this.transport = transport;
    this.name = cleanName(name);
    this.color = isColor(opts.color) ? opts.color : null;
    this.view = null;
    this.custom = null;
    this.session = null;
    this.chat = [];
    this.started = false;
    this.closed = false;
    this.onChange = () => {};
    this.onStart = () => {};
    this.onClosed = () => {};
    this.onChat = () => {};
    this.onError = () => {};
    this.onCustom = () => {};
    this.chunks = new Reassembler();
    transport.onMessage = (peer, msg) => this.onMsg(peer, msg);
    transport.onPeerLeave = () => this.fail('Соединение с хостом потеряно');
    transport.onPeerJoin = () => {};
    this.hello();
    this.retry = null;
    if (typeof setInterval === 'function') {
      this.retry = setInterval(() => { if (!this.view && !this.closed && !this.started) this.hello(); }, opts.retryMs || 2000);
      if (this.retry && typeof this.retry.unref === 'function') this.retry.unref();
    }
  }

  get you() { return this.view ? this.view.you : -1; }

  get customDesc() {
    const c = this.view && this.view.settings.custom;
    return c && this.custom && this.custom.rev === c.rev ? this.custom.desc : null;
  }

  hello() {
    const m = { t: 'hello', v: NET_VERSION, name: this.name };
    if (this.color) m.color = this.color;
    this.transport.send(this.transport.hostId, m);
  }

  stopRetry() {
    if (this.retry !== null) clearInterval(this.retry);
    this.retry = null;
  }

  onMsg(peer, raw) {
    if (this.closed || this.started) return;
    if (peer !== this.transport.hostId) return;
    const msg = this.chunks.accept(peer, raw);
    if (!msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'lobby':
        this.stopRetry();
        this.view = msg;
        this.onChange(msg);
        return;
      case 'custom':
        if (msg.desc && Array.isArray(msg.desc.rows)) {
          this.custom = { rev: msg.rev, desc: msg.desc };
          this.onCustom(msg.desc);
        }
        return;
      case 'start':
        this.begin(msg);
        return;
      case 'chat': {
        const c = { from: Number(msg.from), name: String(msg.name || ''), color: String(msg.color || '#ffffff'), text: String(msg.text || '').slice(0, CHAT_MAX) };
        this.chat.push(c);
        this.onChat(c);
        return;
      }
      case 'err':
        this.onError(String(msg.error || ''));
        return;
      case 'full':
        this.fail('Лобби заполнено или игра уже началась');
        return;
      case 'reject':
        this.fail(String(msg.reason || 'Хост отклонил подключение'));
        return;
      case 'kick':
        this.fail('Хост исключил вас из лобби');
        return;
      case 'closed':
        this.fail('Хост закрыл лобби');
        return;
      default:
    }
  }

  begin(msg) {
    this.stopRetry();
    if (msg.v !== undefined && msg.v !== NET_VERSION) {
      this.fail('У хоста другая версия игры');
      return;
    }
    let session;
    try {
      const { map, state } = createMatch(msg);
      this.started = true;
      session = new Session({ map, state, localPid: Number(msg.you), mode: 'client', transport: this.transport, speed: Number(msg.speed) || 1 });
    } catch (e) {
      this.started = false;
      this.transport.send(this.transport.hostId, { t: 'bye' });
      this.fail('Не удалось начать игру: ' + (e && e.message ? e.message : e));
      return;
    }
    this.session = session;
    this.onStart(session);
  }

  setColor(color) {
    if (!isColor(color)) return false;
    this.color = color;
    this.transport.send(this.transport.hostId, { t: 'color', color });
    return true;
  }

  setName(name) {
    this.name = cleanName(name, this.name);
    this.transport.send(this.transport.hostId, { t: 'name', name: this.name });
  }

  sendChat(text) {
    const t = String(text === undefined || text === null ? '' : text).trim().slice(0, CHAT_MAX);
    if (!t) return false;
    this.transport.send(this.transport.hostId, { t: 'chat', text: t });
    return true;
  }

  fail(reason) {
    if (this.closed || this.started) return;
    this.closed = true;
    this.stopRetry();
    this.onClosed(reason);
  }

  close() {
    this.stopRetry();
    if (this.started) return;
    if (!this.closed) this.transport.send(this.transport.hostId, { t: 'bye' });
    this.closed = true;
    this.transport.close();
  }
}

import {
  VERSION, PLAYER_COLORS, ECON, RESEARCH_KEYS, DEFAULT_SETTINGS, VICTORY, DIFFICULTY, BUILDING_KEYS, STRIKE_KEYS,
} from './config.js';
import { makeRelation, isProposal } from './diplomacy.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const clampNum = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

export function normalizeSettings(src) {
  const d = DEFAULT_SETTINGS;
  const s = src && typeof src === 'object' ? src : {};
  const v = s.victory && typeof s.victory === 'object' ? s.victory : {};
  return {
    victory: {
      territory: v.territory === undefined ? d.victory.territory : !!v.territory,
      territoryPct: Math.round(clampNum(v.territoryPct, VICTORY.minTerritoryPct, VICTORY.maxTerritoryPct, d.victory.territoryPct)),
      economy: v.economy === undefined ? d.victory.economy : !!v.economy,
      economyMinutes: Math.round(clampNum(v.economyMinutes, VICTORY.minEconMinutes, VICTORY.maxEconMinutes, d.victory.economyMinutes)),
    },
    spawnSeconds: Math.round(clampNum(s.spawnSeconds, 0, 120, d.spawnSeconds)),
    difficulty: DIFFICULTY[s.difficulty] ? s.difficulty : d.difficulty,
  };
}

export function aiLevel(v, fallback) {
  if (!v) return null;
  if (typeof v === 'string' && DIFFICULTY[v]) return v;
  return DIFFICULTY[fallback] ? fallback : 'normal';
}

export function createPlayer(i, src, settings) {
  const p = src || {};
  const research = {};
  for (const k of RESEARCH_KEYS) research[k] = 0;
  return {
    id: i,
    name: String(p.name || `Игрок ${i + 1}`).slice(0, 32),
    color: typeof p.color === 'string' && p.color ? p.color : PLAYER_COLORS[i % PLAYER_COLORS.length],
    ai: aiLevel(p.ai, settings.difficulty),
    alive: true,
    spawned: false,
    netId: p.netId === undefined ? null : p.netId,
    gold: ECON.startGold,
    troops: ECON.startTroops,
    maxTroops: ECON.troopsBase,
    tiles: 0,
    research,
    researching: null,
    composition: { inf: 1, tank: 0, art: 0 },
    income: 0,
    upkeep: 0,
    incBase: 0,
    eventIncome: 0,
    eventAcc: 0,
    stats: { tilesCaptured: 0, tilesLost: 0, kills: 0, shipsSunk: 0, nukes: 0, peakTiles: 0, goldEarned: 0 },
    traitorUntil: 0,
    capital: -1,
    eliminatedAt: -1,
    aiState: {},
  };
}

export function createState(map, opts = {}) {
  const N = map.W * map.H;
  const seed = Number(opts.seed) >>> 0;
  const settings = normalizeSettings(opts.settings);
  const players = (opts.players || []).map((p, i) => createPlayer(i, p, settings));
  return {
    version: VERSION,
    tick: 0,
    rngState: Math.imul(seed ^ 0x9e3779b9, 2654435761) >>> 0,
    mapDesc: clone(map.desc),
    settings,
    phase: 'spawn',
    winner: -1,
    winReason: '',
    owner: new Uint16Array(N),
    fallout: new Uint16Array(N),
    players,
    buildings: [],
    rails: [],
    attacks: [],
    units: [],
    projectiles: [],
    relations: {},
    requests: [],
    nextId: 1,
    econLeader: -1,
    econLeadTicks: 0,
  };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64LUT = (() => {
  const t = new Uint8Array(128);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  t[45] = 62; t[95] = 63;
  return t;
})();

export function bytesToB64(bytes) {
  const n = bytes.length;
  const parts = [];
  let chunk = '';
  for (let i = 0; i < n; i += 3) {
    const a = bytes[i], b = i + 1 < n ? bytes[i + 1] : 0, c = i + 2 < n ? bytes[i + 2] : 0;
    const v = (a << 16) | (b << 8) | c;
    chunk += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + (i + 1 < n ? B64[(v >> 6) & 63] : '=') + (i + 2 < n ? B64[v & 63] : '=');
    if (chunk.length >= 8192) { parts.push(chunk); chunk = ''; }
  }
  parts.push(chunk);
  return parts.join('');
}

export function b64ToBytes(str) {
  let len = str.length;
  while (len && str.charCodeAt(len - 1) === 61) len--;
  const out = new Uint8Array((len * 3) >> 2);
  let o = 0, buf = 0, bits = 0;
  for (let i = 0; i < len; i++) {
    buf = ((buf << 6) | B64LUT[str.charCodeAt(i) & 127]) & 0xffffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 255; }
  }
  return out;
}

class ByteWriter {
  constructor(cap = 1024) { this.buf = new Uint8Array(cap); this.n = 0; }
  byte(v) {
    if (this.n >= this.buf.length) {
      const nb = new Uint8Array(this.buf.length * 2);
      nb.set(this.buf);
      this.buf = nb;
    }
    this.buf[this.n++] = v;
  }
  varint(v) {
    while (v >= 128) { this.byte((v & 127) | 128); v = Math.floor(v / 128); }
    this.byte(v);
  }
  bytes() { return this.buf.subarray(0, this.n); }
}

const TYPED = {
  u8: Uint8Array, u16: Uint16Array, u32: Uint32Array, i32: Int32Array, i16: Int16Array, i8: Int8Array,
};

function typeTag(arr) {
  for (const k of Object.keys(TYPED)) if (arr instanceof TYPED[k]) return k;
  return null;
}

const zig = (v) => (v < 0 ? -2 * v - 1 : 2 * v);
const unzig = (v) => (v % 2 ? -(v + 1) / 2 : v / 2);

export function rleEncode(arr) {
  const t = typeTag(arr);
  if (!t) throw new Error('Неподдерживаемый тип массива');
  const signed = t[0] === 'i';
  const w = new ByteWriter(Math.max(1024, arr.length >> 6));
  const n = arr.length;
  let i = 0;
  while (i < n) {
    const v = arr[i];
    let j = i + 1;
    while (j < n && arr[j] === v) j++;
    w.varint(signed ? zig(v) : v);
    w.varint(j - i);
    i = j;
  }
  return { rle: bytesToB64(w.bytes()), n, t };
}

export function rleDecode(obj) {
  const Ctor = TYPED[obj.t] || Uint16Array;
  const out = new Ctor(obj.n);
  const bytes = b64ToBytes(obj.rle);
  const signed = (obj.t || 'u16')[0] === 'i';
  let p = 0, o = 0;
  const read = () => {
    let v = 0, mul = 1, b;
    do {
      b = bytes[p++];
      v += (b & 127) * mul;
      mul *= 128;
    } while (b & 128 && p < bytes.length);
    return v;
  };
  while (p < bytes.length && o < obj.n) {
    const raw = read();
    const cnt = read();
    const v = signed ? unzig(raw) : raw;
    const end = Math.min(obj.n, o + cnt);
    if (v !== 0) out.fill(v, o, end);
    o = end;
  }
  return out;
}

const isRle = (v) => v && typeof v === 'object' && typeof v.rle === 'string' && Number.isInteger(v.n);

export function serializeState(state) {
  const out = {};
  for (const k of Object.keys(state)) {
    const v = state[k];
    if (ArrayBuffer.isView(v)) out[k] = rleEncode(v);
    else if (v !== undefined) out[k] = clone(v);
  }
  return out;
}

export function deserializeState(obj, map) {
  const src = typeof obj === 'string' ? JSON.parse(obj) : obj;
  if (!src || typeof src !== 'object') throw new Error('Повреждённое сохранение');
  const s = {};
  for (const k of Object.keys(src)) {
    const v = src[k];
    s[k] = isRle(v) ? rleDecode(v) : clone(v);
  }
  if (map) {
    const N = map.W * map.H;
    if (!(s.owner instanceof Uint16Array) || s.owner.length !== N) throw new Error('Сохранение не подходит к карте');
    if (!(s.fallout instanceof Uint16Array) || s.fallout.length !== N) s.fallout = new Uint16Array(N);
  }
  for (const key of ['buildings', 'rails', 'attacks', 'units', 'projectiles', 'requests', 'players']) if (!Array.isArray(s[key])) s[key] = [];
  s.relations = normalizeRelations(s.relations, s.players.length);
  s.requests = s.requests.filter((r) => r && typeof r === 'object' && isProposal(r.type));
  s.settings = normalizeSettings(s.settings);
  return s;
}

const REL_KEY = /^(\d+):(\d+)$/;

export function normalizeRelations(src, n) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const key of Object.keys(src)) {
    const m = REL_KEY.exec(key);
    if (!m) continue;
    const a = Number(m[1]), b = Number(m[2]);
    if (a >= b || b >= n) continue;
    const r = makeRelation(src[key]);
    if (r.type !== 'none' || r.trade || r.embargo) out[key] = r;
  }
  return out;
}

const FNV = 16777619;
const BTYPE = Object.fromEntries(BUILDING_KEYS.map((k, i) => [k, i + 1]));
const UTYPE = { warship: 1, transport: 2, trade: 3, train: 4, truck: 5 };
const PHASE = { spawn: 1, play: 2, over: 3 };
const RTYPE = { none: 1, pact: 2, alliance: 3 };
const PTYPE = { alliance: 1, pact: 2, trade: 3 };
const RKEY = Object.fromEntries(RESEARCH_KEYS.map((k, i) => [k, i + 1]));
const SKIND = Object.fromEntries([...STRIKE_KEYS, 'warhead'].map((k, i) => [k, i + 1]));
const AILVL = { easy: 1, normal: 2, hard: 3 };

export function hashState(s) {
  let h = 0x811c9dc5;
  const mix = (v) => { h = Math.imul(h ^ (v | 0), FNV); };
  const num = (v, m = 1) => mix(Number.isFinite(v) ? Math.floor(v * m) : -7);
  const int = (v) => mix(Number.isFinite(v) ? v : -7);
  mix(s.tick);
  mix(s.rngState);
  mix(PHASE[s.phase] || 0);
  mix(s.winner);
  mix(s.nextId);
  int(s.econLeader);
  int(s.econLeadTicks);
  const own = s.owner, fo = s.fallout;
  for (let i = 0; i < own.length; i++) h = Math.imul(h ^ (own[i] | (fo[i] << 16)), FNV);
  for (const p of s.players) {
    mix(p.alive ? 1 : 0);
    mix(p.spawned ? 1 : 0);
    mix(AILVL[p.ai] || 0);
    num(p.troops);
    num(p.gold, 16);
    mix(p.tiles);
    num(p.maxTroops);
    num(p.income, 64);
    num(p.upkeep, 64);
    num(p.eventIncome, 64);
    int(p.traitorUntil);
    int(p.capital);
    int(p.eliminatedAt);
    for (const k of RESEARCH_KEYS) mix(p.research[k]);
    const r = p.researching;
    if (r) { mix(RKEY[r.key] || -1); int(r.progress); int(r.total); } else mix(-2);
    const c = p.composition;
    if (c) { num(c.tank, 1e6); num(c.art, 1e6); }
    const a = p.aiState;
    if (a && typeof a === 'object' && a.v) {
      mix(a.rng); int(a.turn); int(a.war); int(a.warAt); int(a.nukeAt); int(a.boatAt); int(a.dipAt); int(a.atkAt);
    }
  }
  const keys = Object.keys(s.relations).sort();
  mix(keys.length);
  for (const key of keys) {
    const r = s.relations[key];
    const k = key.indexOf(':');
    mix(Number(key.slice(0, k)));
    mix(Number(key.slice(k + 1)));
    mix(RTYPE[r.type] || 9);
    int(r.until);
    mix(r.trade ? 1 : 0);
    mix(r.emb);
  }
  mix(s.requests.length);
  for (const r of s.requests) { mix(r.id); mix(r.from); mix(r.to); mix(PTYPE[r.type] || 9); int(r.expires); int(r.at); }
  for (const b of s.buildings) {
    mix(b.id); mix(b.owner); mix(BTYPE[b.type] || 0); mix(b.x); mix(b.y); mix(b.level); mix(b.build); mix(b.cd | 0);
    mix(b.up | 0); mix(b.stock | 0); mix(b.veh | 0); mix(b.direct | 0);
  }
  for (const r of s.rails) { mix(r.id); mix(r.owner); mix(r.a); mix(r.b); }
  for (const a of s.attacks) {
    mix(a.id); mix(a.attacker); mix(a.target); num(a.troops); mix(a.landing); mix(a.local ? 1 : 0); int(a.scan);
    const F = a.front;
    mix(F.length);
    for (let k = 0; k < F.length; k++) mix(F[k]);
  }
  for (const u of s.units) {
    mix(u.id); mix(u.owner); mix(UTYPE[u.type] || 0); num(u.x, 8); num(u.y, 8); num(u.hp); int(u.pi);
    num(u.cargo); num(u.troops); int(u.chase); mix(u.order | 0); mix(u.path ? u.path.length : -1);
  }
  for (const p of s.projectiles) {
    mix(p.id); mix(p.owner); mix(SKIND[p.type] || 0); num(p.x, 8); num(p.y, 8); num(p.tx, 8); num(p.ty, 8); mix(p.t); mix(p.dur);
  }
  return h >>> 0;
}

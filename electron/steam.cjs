const { ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const LOBBY_PUBLIC = 2;
const GAME_KEY = 'pixel-conquest';
const NET_VERSION = '2';
const SHARED_APP_ID = 480;
const SEND_RELIABLE = 2;
const CB = { LobbyChatUpdate: 5, P2PSessionRequest: 6, P2PSessionConnectFail: 7, GameLobbyJoinRequested: 8 };
const ENTERED = new Set(['Entered', 0]);
const LEFT = new Set(['Left', 'Disconnected', 'Kicked', 'Banned']);
const LIST_ROUNDS = 3;
const LIST_PAGE = 50;
const MEMBERS_REFRESH_MS = 1000;
const SESSION_WAIT_MS = 30000;
const FAIL_NOTICE_MS = 1000;
const PACKETS_PER_POLL = 200;

let steamworks = null;
let client = null;
let appId = 0;
let initError = 'Steam не инициализирован';
let lobby = null;
let win = null;
let poll = null;
let pendingJoin = null;
let members = new Set();
let membersAt = 0;
const waitingSessions = new Map();
const failedAt = new Map();

function loadModule() {
  if (steamworks) return steamworks;
  try {
    steamworks = require('steamworks.js');
  } catch (e) {
    initError = 'Модуль steamworks.js недоступен: ' + e.message;
  }
  return steamworks;
}

function readAppId(app) {
  if (process.env.STEAM_APP_ID) return Number(process.env.STEAM_APP_ID);
  const candidates = [
    path.join(path.dirname(app.getPath('exe')), 'steam_appid.txt'),
    path.join(__dirname, '..', 'steam_appid.txt'),
    path.join(process.cwd(), 'steam_appid.txt'),
  ];
  for (const f of candidates) {
    try {
      const id = Number(fs.readFileSync(f, 'utf8').trim());
      if (id > 0) return id;
    } catch { }
  }
  return SHARED_APP_ID;
}

function prepareOverlay() {
  const sw = loadModule();
  if (!sw) return;
  try { sw.electronEnableSteamOverlay(); } catch { }
}

const idOf = (v) => String(v === undefined || v === null ? '' : v);

function refreshMembers() {
  const next = new Set();
  if (lobby) {
    try {
      for (const m of lobby.getMembers()) next.add(idOf(m.steamId64));
    } catch { }
  }
  members = next;
  membersAt = Date.now();
  return members;
}

function isMember(id) {
  if (!lobby) return false;
  if (members.has(id)) return true;
  if (Date.now() - membersAt < MEMBERS_REFRESH_MS) return false;
  return refreshMembers().has(id);
}

function memberLeft(state, id) {
  if (ENTERED.has(state)) return false;
  if (LEFT.has(state)) return true;
  return !members.has(id);
}

function acceptSession(id) {
  waitingSessions.delete(id);
  try { client.networking.acceptP2PSession(BigInt(id)); } catch { }
}

function acceptWaiting() {
  const now = Date.now();
  for (const [id, at] of waitingSessions) {
    if (members.has(id)) acceptSession(id);
    else if (now - at > SESSION_WAIT_MS) waitingSessions.delete(id);
  }
}

function linkFailed(id) {
  const now = Date.now();
  if (now - (failedAt.get(id) || 0) < FAIL_NOTICE_MS) return;
  failedAt.set(id, now);
  send('steam:linkFail', id);
}

function onSessionRequest(e) {
  const id = idOf(e.remote);
  if (isMember(id)) acceptSession(id);
  else if (lobby) waitingSessions.set(id, Date.now());
}

function onChatUpdate(e) {
  if (!lobby || idOf(e.lobby) !== idOf(lobby.id)) return;
  refreshMembers();
  const id = idOf(e.user_changed);
  if (memberLeft(e.member_state_change, id)) {
    waitingSessions.delete(id);
    send('steam:memberLeft', id);
  }
  acceptWaiting();
}

function init(app) {
  const argv = process.argv;
  const i = argv.indexOf('+connect_lobby');
  if (i >= 0 && argv[i + 1]) pendingJoin = argv[i + 1];

  const sw = loadModule();
  if (!sw) return;
  try {
    appId = readAppId(app);
    client = sw.init(appId);
  } catch (e) {
    client = null;
    initError = 'Steam не запущен или игра не принадлежит аккаунту (' + e.message + ')';
    return;
  }
  const cb = client.callback;
  cb.register(CB.P2PSessionRequest, onSessionRequest);
  cb.register(CB.P2PSessionConnectFail, (e) => linkFailed(idOf(e.remote)));
  cb.register(CB.LobbyChatUpdate, onChatUpdate);
  cb.register(CB.GameLobbyJoinRequested, (e) => {
    send('steam:joinRequested', idOf(e.lobby_steam_id));
  });
  poll = setInterval(readPackets, 10);
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function readPackets() {
  if (!client) return;
  try {
    for (let n = 0; n < PACKETS_PER_POLL; n++) {
      const size = client.networking.isP2PPacketAvailable();
      if (!size) break;
      const pkt = client.networking.readP2PPacket(size);
      const from = idOf(pkt.steamId.steamId64);
      if (!isMember(from)) continue;
      send('steam:packet', from, pkt.data.toString('utf8'));
    }
  } catch (e) {
    console.error('steam read error', e);
  }
}

function selfId() { return idOf(client.localplayer.getSteamId().steamId64); }

function setPresence(lobbyId) {
  try {
    client.localplayer.setRichPresence('connect', lobbyId ? `+connect_lobby ${lobbyId}` : null);
    client.localplayer.setRichPresence('status', lobbyId ? 'В лобби Pixel Conquest' : null);
  } catch { }
}

function enter(next) {
  lobby = next;
  waitingSessions.clear();
  failedAt.clear();
  refreshMembers();
}

function leave() {
  if (lobby) {
    try { lobby.leave(); } catch { }
    lobby = null;
  }
  members = new Set();
  waitingSessions.clear();
  failedAt.clear();
  if (client) setPresence(null);
}

function attach(window) {
  win = window;
}

function describe(l) {
  const name = l.getData('name') || 'Лобби';
  const host = l.getData('host') || '';
  return {
    id: idOf(l.id),
    name: host && host !== name ? `${name} · ${host}` : name,
    host,
    members: Number(l.getMemberCount()),
    max: Number(l.getMemberLimit() || 12),
    ver: l.getData('ver') || '',
  };
}

async function findLobbies() {
  const found = new Map();
  const seen = new Set();
  for (let round = 0; round < LIST_ROUNDS; round++) {
    const page = await client.matchmaking.getLobbies();
    let fresh = 0;
    for (const l of page) {
      const id = idOf(l.id);
      if (!seen.has(id)) {
        seen.add(id);
        fresh++;
      }
      if (found.has(id)) continue;
      let key = null;
      try { key = l.getData('game'); } catch { }
      if (key === GAME_KEY) found.set(id, describe(l));
    }
    if (page.length < LIST_PAGE || !fresh) break;
  }
  const list = [...found.values()].sort((a, b) => (b.ver === NET_VERSION) - (a.ver === NET_VERSION) || b.members - a.members);
  return { list, scanned: seen.size };
}

ipcMain.handle('steam:init', () => {
  if (!client) return { ok: false, error: initError };
  return { ok: true, name: client.localplayer.getName(), steamId: selfId(), appId, shared: appId === SHARED_APP_ID };
});

ipcMain.handle('steam:createLobby', async (_e, max, name) => {
  if (!client) return { ok: false, error: initError };
  try {
    leave();
    const next = await client.matchmaking.createLobby(LOBBY_PUBLIC, Math.max(2, Math.min(12, Number(max) || 12)));
    const persona = String(client.localplayer.getName() || '').slice(0, 32);
    const data = { game: GAME_KEY, ver: NET_VERSION, name: String(name || persona || 'Лобби').slice(0, 32), host: persona };
    for (const k of Object.keys(data)) next.setData(k, data[k]);
    next.setJoinable(true);
    enter(next);
    const id = idOf(next.id);
    setPresence(id);
    return { ok: true, lobbyId: id, selfId: selfId() };
  } catch (e) {
    return { ok: false, error: 'Не удалось создать лобби: ' + e.message };
  }
});

ipcMain.handle('steam:joinLobby', async (_e, id) => {
  if (!client) return { ok: false, error: initError };
  try {
    leave();
    const next = await client.matchmaking.joinLobby(BigInt(String(id).trim()));
    enter(next);
    const host = idOf(next.getOwner().steamId64);
    setPresence(idOf(next.id));
    return { ok: true, lobbyId: idOf(next.id), selfId: selfId(), hostId: host };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('steam:listLobbies', async () => {
  if (!client) return { ok: false, error: initError };
  try {
    const { list, scanned } = await findLobbies();
    return { ok: true, list, scanned, shared: appId === SHARED_APP_ID };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('steam:pendingJoin', () => {
  const id = pendingJoin;
  pendingJoin = null;
  return id;
});

ipcMain.on('steam:invite', () => {
  if (lobby) {
    try { lobby.openInviteDialog(); } catch { client.overlay.activateInviteDialog(lobby.id); }
  }
});

ipcMain.on('steam:leave', () => leave());

ipcMain.on('steam:send', (_e, peer, data) => {
  if (!client) return;
  const id = idOf(peer);
  let sent = false;
  try {
    sent = client.networking.sendP2PPacket(BigInt(id), SEND_RELIABLE, Buffer.from(String(data), 'utf8')) !== false;
  } catch (e) {
    console.error('steam send error', e.message);
  }
  if (!sent) linkFailed(id);
});

function shutdown() {
  clearInterval(poll);
  poll = null;
  leave();
}

module.exports = { prepareOverlay, init, attach, shutdown, readPackets };

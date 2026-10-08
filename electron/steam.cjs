const { ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const LOBBY_PUBLIC = 2;
const GAME_KEY = 'pixel-conquest';
const SEND_RELIABLE = 2;
const CB = { LobbyChatUpdate: 5, P2PSessionRequest: 6, GameLobbyJoinRequested: 8 };
const MEMBER_ENTERED = 0;

let steamworks = null;
let client = null;
let initError = 'Steam не инициализирован';
let lobby = null;
let win = null;
let poll = null;
let pendingJoin = null;

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
  return 480;
}

function prepareOverlay() {
  const sw = loadModule();
  if (!sw) return;
  try { sw.electronEnableSteamOverlay(); } catch { }
}

function init(app) {
  const argv = process.argv;
  const i = argv.indexOf('+connect_lobby');
  if (i >= 0 && argv[i + 1]) pendingJoin = argv[i + 1];

  const sw = loadModule();
  if (!sw) return;
  try {
    client = sw.init(readAppId(app));
  } catch (e) {
    client = null;
    initError = 'Steam не запущен или игра не принадлежит аккаунту (' + e.message + ')';
    return;
  }
  const cb = client.callback;
  cb.register(CB.P2PSessionRequest, (e) => {
    try { client.networking.acceptP2PSession(e.remote); } catch { }
  });
  cb.register(CB.LobbyChatUpdate, (e) => {
    if (!lobby || e.lobby !== lobby.id) return;
    if (e.member_state_change !== MEMBER_ENTERED) send('steam:memberLeft', e.user_changed.toString());
  });
  cb.register(CB.GameLobbyJoinRequested, (e) => {
    send('steam:joinRequested', e.lobby_steam_id.toString());
  });
  poll = setInterval(readPackets, 10);
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function readPackets() {
  if (!client) return;
  try {
    for (let n = 0; n < 200; n++) {
      const size = client.networking.isP2PPacketAvailable();
      if (!size) break;
      const pkt = client.networking.readP2PPacket(size);
      send('steam:packet', pkt.steamId.steamId64.toString(), pkt.data.toString('utf8'));
    }
  } catch (e) {
    console.error('steam read error', e);
  }
}

function selfId() { return client.localplayer.getSteamId().steamId64.toString(); }

function setPresence(lobbyId) {
  try {
    client.localplayer.setRichPresence('connect', lobbyId ? `+connect_lobby ${lobbyId}` : null);
    client.localplayer.setRichPresence('status', lobbyId ? 'В лобби Pixel Conquest' : null);
  } catch { }
}

function leave() {
  if (lobby) {
    try { lobby.leave(); } catch { }
    lobby = null;
  }
  if (client) setPresence(null);
}

function attach(window) {
  win = window;
}

ipcMain.handle('steam:init', () => {
  if (!client) return { ok: false, error: initError };
  return { ok: true, name: client.localplayer.getName(), steamId: selfId() };
});

ipcMain.handle('steam:createLobby', async (_e, max, name) => {
  if (!client) return { ok: false, error: initError };
  try {
    leave();
    lobby = await client.matchmaking.createLobby(LOBBY_PUBLIC, Math.max(2, Math.min(12, Number(max) || 12)));
    lobby.setData('game', GAME_KEY);
    lobby.setData('name', String(name || client.localplayer.getName()).slice(0, 32));
    lobby.setJoinable(true);
    const id = lobby.id.toString();
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
    lobby = await client.matchmaking.joinLobby(BigInt(String(id).trim()));
    const host = lobby.getOwner().steamId64.toString();
    setPresence(lobby.id.toString());
    return { ok: true, lobbyId: lobby.id.toString(), selfId: selfId(), hostId: host };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('steam:listLobbies', async () => {
  if (!client) return { ok: false, error: initError };
  try {
    const all = await client.matchmaking.getLobbies();
    const list = all.filter((l) => l.getData('game') === GAME_KEY).map((l) => ({
      id: l.id.toString(),
      name: l.getData('name') || 'Лобби',
      members: Number(l.getMemberCount()),
      max: Number(l.getMemberLimit() || 12),
    }));
    return { ok: true, list };
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
  try {
    client.networking.sendP2PPacket(BigInt(peer), SEND_RELIABLE, Buffer.from(data, 'utf8'));
  } catch (e) {
    console.error('steam send error', e.message);
  }
});

function shutdown() {
  clearInterval(poll);
  leave();
}

module.exports = { prepareOverlay, init, attach, shutdown };

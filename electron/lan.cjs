const { ipcMain } = require('electron');
const os = require('node:os');
const { WebSocketServer } = require('ws');

const MAX_MESSAGE = 1024 * 1024;
const FLOOD_WINDOW_MS = 1000;
const FLOOD_LIMIT = 1000;

let wss = null;
let win = null;
let nextId = 1;
const sockets = new Map();

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function localIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out.length ? out : ['127.0.0.1'];
}

function stop() {
  if (!wss) return;
  for (const ws of sockets.values()) ws.close();
  sockets.clear();
  wss.close();
  wss = null;
}

ipcMain.handle('lan:host', (_e, port) => new Promise((resolve) => {
  stop();
  port = Number(port) || 27420;
  const server = new WebSocketServer({ port, maxPayload: MAX_MESSAGE });
  server.once('listening', () => {
    wss = server;
    resolve({ ok: true, port, ips: localIps() });
  });
  server.once('error', (e) => resolve({ ok: false, error: `Не удалось открыть порт ${port}: ${e.message}` }));
  server.on('connection', (ws) => {
    const id = 'p' + nextId++;
    sockets.set(id, ws);
    let windowStart = Date.now();
    let count = 0;
    send('lan:connect', id);
    ws.on('message', (data) => {
      const now = Date.now();
      if (now - windowStart >= FLOOD_WINDOW_MS) {
        windowStart = now;
        count = 0;
      }
      if (++count > FLOOD_LIMIT) {
        ws.terminate();
        return;
      }
      send('lan:message', id, data.toString('utf8'));
    });
    ws.on('close', () => { sockets.delete(id); send('lan:disconnect', id); });
    ws.on('error', () => ws.close());
  });
}));

ipcMain.on('lan:send', (_e, id, data) => {
  const ws = sockets.get(id);
  if (ws && ws.readyState === 1) ws.send(data);
});
ipcMain.on('lan:stop', () => stop());

module.exports = { attach: (w) => { win = w; }, stop };

const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const steam = require('./steam.cjs');
const lan = require('./lan.cjs');

steam.prepareOverlay();

let win = null;

function customMapsDir() {
  const dirs = [path.join(path.dirname(app.getPath('exe')), 'maps'), path.join(__dirname, '..', 'maps'), path.join(app.getPath('userData'), 'maps')];
  return dirs.filter((d, i) => dirs.indexOf(d) === i && fs.existsSync(d));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0b0e13',
    title: 'Pixel Conquest',
    icon: path.join(__dirname, '..', 'web', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'web', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  steam.attach(win);
  lan.attach(win);
  win.on('closed', () => { win = null; });
}

ipcMain.on('app:quit', () => app.quit());
ipcMain.on('app:fullscreen', () => { if (win) win.setFullScreen(!win.isFullScreen()); });
ipcMain.handle('app:customMaps', () => {
  const out = [];
  for (const dir of customMapsDir()) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const full = path.join(dir, f);
        if (fs.statSync(full).size > 2_000_000) continue;
        out.push({ name: f, content: fs.readFileSync(full, 'utf8') });
      } catch { }
    }
  }
  return out;
});

app.whenReady().then(() => {
  steam.init(app);
  createWindow();
});
app.on('window-all-closed', () => {
  lan.stop();
  steam.shutdown();
  app.quit();
});

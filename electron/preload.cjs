const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel, cb) => {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, (_e, ...args) => cb(...args));
};

contextBridge.exposeInMainWorld('native', {
  quit: () => ipcRenderer.send('app:quit'),
  toggleFullscreen: () => ipcRenderer.send('app:fullscreen'),
  readCustomMaps: () => ipcRenderer.invoke('app:customMaps'),
  steam: {
    init: () => ipcRenderer.invoke('steam:init'),
    createLobby: (max, name) => ipcRenderer.invoke('steam:createLobby', max, name),
    listLobbies: () => ipcRenderer.invoke('steam:listLobbies'),
    joinLobby: (id) => ipcRenderer.invoke('steam:joinLobby', id),
    pendingJoin: () => ipcRenderer.invoke('steam:pendingJoin'),
    invite: () => ipcRenderer.send('steam:invite'),
    leave: () => ipcRenderer.send('steam:leave'),
    send: (peer, data) => ipcRenderer.send('steam:send', peer, data),
    onPacket: (cb) => listen('steam:packet', cb),
    onMemberLeft: (cb) => listen('steam:memberLeft', cb),
    onLinkFail: (cb) => listen('steam:linkFail', cb),
    onJoinRequested: (cb) => listen('steam:joinRequested', cb),
  },
  lan: {
    host: (port) => ipcRenderer.invoke('lan:host', port),
    stop: () => ipcRenderer.send('lan:stop'),
    send: (id, data) => ipcRenderer.send('lan:send', id, data),
    onConnect: (cb) => listen('lan:connect', cb),
    onDisconnect: (cb) => listen('lan:disconnect', cb),
    onMessage: (cb) => listen('lan:message', cb),
  },
});

// Точка входа: меню, настройки, одиночная игра, мультиплеер, сохранения, игровой цикл.
import { VERSION, PLAYER_COLORS } from '../core/config.js';
import { MAPS, generateMap, parseCustomMap } from '../core/mapgen.js';
import { createState, Game } from '../core/game.js';
import { Renderer } from './render.js';
import { Hud } from './hud.js';
import { Session } from './session.js';
import { HostLobby, ClientLobby } from './lobby.js';
import { SteamTransport, LanHostTransport, LanClientTransport, hasNative, DEFAULT_PORT } from './net.js';
import { setVolume, play } from './audio.js';
import { THEMES, hexToRgb, mix } from './theme.js';
import mapKrest from '../../maps/krest.json';
import mapShahmaty from '../../maps/shahmaty.json';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
const SAVE_SLOTS = ['auto', '1', '2', '3'];

class App {
  constructor() {
    this.GameClass = Game;
    this.settings = Object.assign({ theme: 'dark', volume: 50, ui: 1, name: 'Командир', edgeScroll: false }, store.get('pc_settings', {}));
    this.customMaps = [parseCustomMap(mapKrest), parseCustomMap(mapShahmaty)];
    for (const m of store.get('pc_custom_maps', [])) if (!this.customMaps.some((c) => c.name === m.name)) this.customMaps.push(m);
    this.sp = { map: 'world', custom: null, seed: (Math.random() * 1e9) | 0 };
    this.session = null;
    this.lobby = null;
    this.renderer = new Renderer($('map'));
    this.applySettings();
    this.bindMenus();
    this.menuBackground();
    $('ver').textContent = VERSION;
    document.querySelectorAll('.native-only').forEach((el) => { el.hidden = !hasNative(); });
    if (!hasNative()) $('btn-quit').hidden = true;
    this.bindSteamInvites();
    this.loadNativeMaps();
  }

  // ---------- Настройки и тема ----------
  saveSettings() { store.set('pc_settings', this.settings); }
  applySettings() {
    document.documentElement.dataset.theme = this.settings.theme;
    document.documentElement.style.setProperty('--ui', this.settings.ui);
    this.renderer.setTheme(this.settings.theme);
    setVolume(this.settings.volume / 100);
    $('set-theme').value = this.settings.theme;
    $('set-vol').value = this.settings.volume;
    $('set-vol-v').textContent = this.settings.volume + '%';
    $('set-ui').value = String(this.settings.ui);
    $('set-edge').checked = !!this.settings.edgeScroll;
    $('sp-name').value = this.settings.name;
    $('mp-name').value = this.settings.name;
    this.bgDirty = true;
  }
  toggleTheme() {
    this.settings.theme = this.settings.theme === 'dark' ? 'light' : 'dark';
    this.saveSettings();
    this.applySettings();
    if (this.previewDesc) this.drawPreview();
  }

  // ---------- Навигация ----------
  show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === 'screen-' + id));
    this.screen = id;
    if (id === 'setup') this.renderMapList();
    if (id === 'mp') this.checkSteam();
  }
  anyModalOpen() { return [...document.querySelectorAll('.modal')].some((m) => !m.hidden); }
  closeModals() { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); }
  openModal(id) { $('modal-' + id).hidden = false; }
  showMessage(title, text, onClose) {
    $('msg-title').textContent = title;
    $('msg-text').textContent = text;
    $('modal-msg').hidden = false;
    this.onMsgClose = onClose || null;
  }
  openPause() {
    this.openModal('pause');
    if (this.session && this.session.mode === 'offline' && this.session.speed) { this.pausedSpeed = this.session.speed; this.session.setSpeed(0); this.hud.updateSpeedButtons(); }
  }

  bindMenus() {
    document.addEventListener('click', (e) => {
      const go = e.target.closest('[data-go]');
      if (go) { play('click'); this.show(go.dataset.go); }
      const m = e.target.closest('[data-modal]');
      if (m) { play('click'); this.openModal(m.dataset.modal); }
      const c = e.target.closest('[data-close]');
      if (c) {
        play('click');
        const modal = c.closest('.modal');
        modal.hidden = true;
        if (modal.id === 'modal-pause' && this.pausedSpeed && this.session) { this.session.setSpeed(this.pausedSpeed); this.pausedSpeed = 0; this.hud.updateSpeedButtons(); }
        if (modal.id === 'modal-msg' && this.onMsgClose) { const f = this.onMsgClose; this.onMsgClose = null; f(); }
      }
    });
    $('theme-link').onclick = (e) => { e.preventDefault(); this.toggleTheme(); };
    $('btn-quit').onclick = () => window.native && window.native.quit();

    // Настройки
    $('set-theme').onchange = (e) => { this.settings.theme = e.target.value; this.saveSettings(); this.applySettings(); };
    $('set-vol').oninput = (e) => { this.settings.volume = Number(e.target.value); this.saveSettings(); this.applySettings(); };
    $('set-vol').onchange = () => play('click');
    $('set-ui').onchange = (e) => { this.settings.ui = Number(e.target.value); this.saveSettings(); this.applySettings(); };
    $('set-edge').onchange = (e) => { this.settings.edgeScroll = e.target.checked; this.saveSettings(); };
    $('set-fs').onchange = () => window.native && window.native.toggleFullscreen();
    window.addEventListener('keydown', (e) => { if (e.key === 'F11' && window.native) { e.preventDefault(); window.native.toggleFullscreen(); } });
    for (const id of ['sp-name', 'mp-name']) $(id).onchange = (e) => { this.settings.name = e.target.value.trim().slice(0, 20) || 'Командир'; this.saveSettings(); this.applySettings(); };

    // Одиночная игра
    $('sp-bots').oninput = (e) => { $('sp-bots-v').textContent = e.target.value; };
    $('sp-vic').oninput = (e) => { $('sp-vic-v').textContent = e.target.value + '%'; };
    $('sp-seed').value = this.sp.seed;
    $('sp-seed').onchange = (e) => { this.sp.seed = Number(e.target.value) | 0; this.selectMap(this.sp.map, this.sp.custom); };
    $('sp-reseed').onclick = () => { this.sp.seed = (Math.random() * 1e9) | 0; $('sp-seed').value = this.sp.seed; this.selectMap(this.sp.map, this.sp.custom); };
    $('sp-start').onclick = () => this.startSingle();
    $('custom-map-file').onchange = (e) => this.importCustomMap(e.target.files[0]);

    // Пауза / сохранения
    $('btn-exit').onclick = () => { this.closeModals(); this.exitGame(); };
    $('btn-save').onclick = () => this.openSaves('save');
    $('btn-load-game').onclick = () => this.openSaves('load');
    $('btn-load-menu').onclick = () => this.openSaves('load');
    $('save-slots').onclick = (e) => this.onSaveSlot(e);
    $('end-continue').onclick = () => { $('modal-end').hidden = true; };
    $('end-menu').onclick = () => { $('modal-end').hidden = true; this.exitGame(); };

    // Мультиплеер
    $('steam-host').onclick = () => this.hostSteam();
    $('steam-join').onclick = () => this.joinSteam($('steam-lobby-id').value.trim());
    $('lan-host').onclick = () => this.hostLan();
    $('lan-join').onclick = () => this.joinLan();
    $('lobby-leave').onclick = () => this.leaveLobby();
    $('lobby-start').onclick = () => this.startLobby();
    $('lobby-add-ai').onclick = () => this.lobby && this.lobby.addAI($('lobby-ai-diff').value);
    $('lobby-invite').onclick = () => this.lobby && this.lobby.transport.invite && this.lobby.transport.invite();
    $('lobby-map').onchange = (e) => {
      const v = e.target.value;
      if (v.startsWith('custom:')) this.lobby.set({ custom: this.customMaps[Number(v.slice(7))] });
      else this.lobby.set({ map: v, custom: null });
    };
    $('lobby-seed').onchange = (e) => this.lobby.set({ seed: Number(e.target.value) | 0 });
    $('lobby-reseed').onclick = () => { const seed = (Math.random() * 1e9) | 0; $('lobby-seed').value = seed; this.lobby.set({ seed }); };
    $('lobby-vic').oninput = (e) => { $('lobby-vic-v').textContent = e.target.value + '%'; this.lobby.set({ victory: Number(e.target.value) / 100 }); };
    $('lobby-slots').onclick = (e) => {
      const b = e.target.closest('[data-kick]');
      if (b && this.lobby instanceof HostLobby) this.lobby.remove(Number(b.dataset.kick));
    };
  }

  // ---------- Фон меню: пиксельная карта мира с «живыми» державами ----------
  menuBackground() {
    const cv = $('menu-bg');
    const map = generateMap({ id: 'world', seed: 7 });
    const owners = new Int8Array(map.provinces.length).fill(-1);
    for (let i = 0; i < 9; i++) owners[(i * 37) % map.provinces.length] = i;
    let t = 0;
    const tick = () => {
      if (this.screen !== 'menu' && this.screen !== undefined) { this.bgDirty = true; requestAnimationFrame(tick); return; }
      t++;
      if (t % 20 === 0 || this.bgDirty) {
        // Державы понемногу расширяются
        for (let k = 0; k < 3; k++) {
          const i = (Math.random() * owners.length) | 0;
          if (owners[i] < 0) continue;
          const n = map.provinces[i].adj[(Math.random() * map.provinces[i].adj.length) | 0];
          if (n !== undefined) owners[n] = owners[i];
        }
        if (owners.filter((o) => o < 0).length < 10) { owners.fill(-1); for (let i = 0; i < 9; i++) owners[(Math.random() * owners.length) | 0] = i; }
        this.drawMini(cv, map, (p) => owners[p], 3);
        this.bgDirty = false;
      }
      requestAnimationFrame(tick);
    };
    this.screen = 'menu';
    tick();
  }

  drawMini(cv, map, ownerOf, scale) {
    const th = THEMES[this.settings.theme];
    cv.width = map.W * scale; cv.height = map.H * scale;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(map.W, map.H);
    const cols = PLAYER_COLORS.map(hexToRgb);
    for (let i = 0; i < map.W * map.H; i++) {
      const p = map.prov[i];
      let c;
      if (p < 0) c = ((i % map.W) + ((i / map.W) | 0)) % 2 ? th.water : th.water2;
      else {
        const o = ownerOf(p);
        c = o >= 0 ? cols[o % cols.length] : mix([150, 170, 110], th.neutralMix, th.neutralAmt);
        const x = i % map.W, y = (i / map.W) | 0;
        if ((x > 0 && map.prov[i - 1] !== p && map.prov[i - 1] >= 0) || (y > 0 && map.prov[i - map.W] !== p && map.prov[i - map.W] >= 0)) c = c.map((v) => v * 0.75);
      }
      img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = 255;
    }
    const tmp = document.createElement('canvas');
    tmp.width = map.W; tmp.height = map.H;
    tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, cv.width, cv.height);
  }

  // ---------- Выбор карты ----------
  renderMapList() {
    $('map-list').innerHTML = MAPS.map((m) => `<button class="btn small ${this.sp.map === m.id && !this.sp.custom ? 'on' : ''}" data-map="${m.id}">${m.name}</button>`).join('');
    $('custom-maps').innerHTML = this.customMaps.map((m, i) => `<button class="btn small ${this.sp.custom === m ? 'on' : ''}" data-cmap="${i}">★ ${esc(m.name)}</button>`).join('');
    $('map-list').onclick = (e) => { const b = e.target.closest('[data-map]'); if (b) { play('click'); this.selectMap(b.dataset.map, null); } };
    $('custom-maps').onclick = (e) => { const b = e.target.closest('[data-cmap]'); if (b) { play('click'); this.selectMap('custom', this.customMaps[Number(b.dataset.cmap)]); } };
    if (!this.previewDesc) this.selectMap(this.sp.map, this.sp.custom);
  }
  selectMap(id, custom) {
    this.sp.map = id; this.sp.custom = custom;
    this.previewDesc = custom ? { ...custom, seed: this.sp.seed } : { id, seed: this.sp.seed };
    this.renderMapListButtons();
    this.drawPreview();
  }
  renderMapListButtons() {
    document.querySelectorAll('#map-list [data-map]').forEach((b) => b.classList.toggle('on', !this.sp.custom && b.dataset.map === this.sp.map));
    document.querySelectorAll('#custom-maps [data-cmap]').forEach((b) => b.classList.toggle('on', this.sp.custom === this.customMaps[Number(b.dataset.cmap)]));
  }
  drawPreview() {
    const map = generateMap(this.previewDesc);
    this.previewMap = map;
    const scale = Math.max(1, Math.floor(720 / map.W));
    this.drawMini($('map-preview'), map, () => -1, scale);
    const info = MAPS.find((m) => m.id === this.sp.map);
    $('map-desc').textContent = `${this.sp.custom ? this.sp.custom.name : info.name}: ${this.sp.custom ? 'пользовательская карта' : info.desc} Провинций: ${map.provinces.length}.`;
  }
  async importCustomMap(file) {
    if (!file) return;
    try {
      const desc = parseCustomMap(await file.text());
      this.customMaps = this.customMaps.filter((m) => m.name !== desc.name).concat(desc);
      const userMaps = store.get('pc_custom_maps', []).filter((m) => m.name !== desc.name).concat(desc);
      if (!store.set('pc_custom_maps', userMaps)) throw new Error('Не удалось сохранить карту (слишком большая)');
      this.renderMapList();
      this.selectMap('custom', desc);
    } catch (e) {
      this.showMessage('Ошибка карты', e.message);
    }
    $('custom-map-file').value = '';
  }
  async loadNativeMaps() {
    if (!window.native || !window.native.readCustomMaps) return;
    try {
      const files = await window.native.readCustomMaps();
      for (const f of files) {
        try {
          const desc = parseCustomMap(f.content);
          if (!this.customMaps.some((m) => m.name === desc.name)) this.customMaps.push(desc);
        } catch (e) { console.warn('Карта пропущена', f.name, e.message); }
      }
    } catch (e) { console.warn(e); }
  }

  // ---------- Одиночная игра ----------
  startSingle() {
    play('click');
    const bots = Number($('sp-bots').value);
    const diff = $('sp-diff').value;
    const diffs = ['easy', 'normal', 'hard'];
    const players = [{ name: this.settings.name, ai: null }];
    for (let i = 0; i < bots; i++) players.push({ name: BOT_NAMES[i % BOT_NAMES.length], ai: diff === 'mixed' ? diffs[i % 3] : diff });
    const desc = this.sp.custom ? { ...this.sp.custom, seed: this.sp.seed } : { id: this.sp.map, seed: this.sp.seed };
    const map = generateMap(desc);
    const state = createState(map, { seed: this.sp.seed, players, victoryShare: Number($('sp-vic').value) / 100 });
    this.enterGame(new Session({ map, state, localPid: 0, mode: 'offline' }));
    // новый seed для следующей партии
    this.sp.seed = (Math.random() * 1e9) | 0;
    $('sp-seed').value = this.sp.seed;
    this.previewDesc = null;
  }

  // ---------- Игровой цикл ----------
  enterGame(session) {
    this.session = session;
    this.lobby = null;
    this.show('game');
    this.renderer.setMap(session.map);
    this.renderer.selected = -1;
    this.renderer.targetMode = null;
    this.renderer.particles = [];
    this.renderer.fit();
    this.hud = new Hud(this, session, this.renderer);
    const home = session.s.provs.findIndex((P) => P.o === session.localPid);
    if (home >= 0) { this.renderer.focus(home, Math.max(this.renderer.cam.z * 2, 8)); this.renderer.selected = home; }
    this.autosaveT = 60;
    let last = performance.now();
    const loop = (now) => {
      if (this.session !== session) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      session.update(dt);
      this.renderer.draw(session, dt);
      this.hud.update(dt);
      if (session.mode === 'offline' && session.s.winner === null) {
        this.autosaveT -= dt * (session.speed ? 1 : 0);
        if (this.autosaveT <= 0) { this.autosaveT = 60; this.saveTo('auto'); }
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  exitGame() {
    if (this.hud) this.hud.destroy();
    if (this.session) this.session.close();
    this.session = null;
    this.hud = null;
    this.closeModals();
    this.show('menu');
  }

  // ---------- Сохранения ----------
  openSaves(mode) {
    this.saveMode = mode;
    $('load-title').textContent = mode === 'save' ? 'Сохранить игру' : 'Загрузить игру';
    $('save-slots').innerHTML = SAVE_SLOTS.map((k) => {
      const meta = store.get('pc_save_meta_' + k, null);
      const label = k === 'auto' ? 'Автосохранение' : 'Слот ' + k;
      const info = meta ? `${esc(meta.map)} · ${new Date(meta.date).toLocaleString('ru-RU')}` : 'пусто';
      const can = mode === 'save' ? k !== 'auto' : !!meta;
      return `<li><span class="name">${label}<br><span class="tag">${info}</span></span><button class="btn small" data-slot="${k}" ${can ? '' : 'disabled'}>${mode === 'save' ? 'Сохранить' : 'Загрузить'}</button></li>`;
    }).join('');
    this.openModal('load');
  }
  onSaveSlot(e) {
    const b = e.target.closest('[data-slot]');
    if (!b) return;
    play('click');
    if (this.saveMode === 'save') {
      if (this.saveTo(b.dataset.slot)) this.openSaves('save');
    } else this.loadFrom(b.dataset.slot);
  }
  saveTo(slot) {
    if (!this.session || this.session.mode !== 'offline') return false;
    const ok = store.set('pc_save_' + slot, { state: this.session.s, desc: this.session.map.desc })
      && store.set('pc_save_meta_' + slot, { date: Date.now(), map: this.session.map.name });
    if (!ok && slot !== 'auto') this.showMessage('Ошибка', 'Не удалось сохранить игру');
    return ok;
  }
  loadFrom(slot) {
    const data = store.get('pc_save_' + slot, null);
    if (!data) return;
    try {
      const map = generateMap(data.desc);
      if (map.provinces.length !== data.state.provs.length) throw new Error('Сохранение не соответствует карте');
      if (this.session) { this.hud.destroy(); this.session.close(); this.session = null; }
      this.closeModals();
      const pid = data.state.players.findIndex((p) => !p.ai);
      this.enterGame(new Session({ map, state: data.state, localPid: Math.max(0, pid), mode: 'offline' }));
    } catch (e) {
      this.showMessage('Ошибка загрузки', e.message);
    }
  }

  // ---------- Мультиплеер ----------
  async checkSteam() {
    const st = $('steam-status');
    const r = await SteamTransport.init();
    this.steamOk = r.ok;
    st.textContent = r.ok ? `Steam подключён: ${r.name}` : r.error || 'Steam недоступен';
    $('steam-host').disabled = !r.ok;
    $('steam-join').disabled = !r.ok;
    $('lan-host').disabled = !hasNative();
  }
  bindSteamInvites() {
    if (!window.native || !window.native.steam) return;
    window.native.steam.onJoinRequested((lobbyId) => this.joinSteam(lobbyId));
    window.native.steam.pendingJoin().then((id) => { if (id) this.joinSteam(id); });
  }
  playerName() { return ($('mp-name').value.trim() || this.settings.name).slice(0, 20); }

  async hostSteam() {
    try {
      const t = await SteamTransport.host(12);
      this.openLobby(new HostLobby(t, this.playerName()), true);
    } catch (e) { this.showMessage('Steam', e.message); }
  }
  async joinSteam(lobbyId) {
    if (!lobbyId) return;
    if (this.session) { this.showMessage('Steam', 'Сначала завершите текущую партию'); return; }
    try {
      const init = await SteamTransport.init();
      if (!init.ok) throw new Error(init.error);
      if (this.lobby) this.leaveLobby();
      const t = await SteamTransport.join(lobbyId);
      this.openLobby(new ClientLobby(t, this.playerName()), false);
    } catch (e) { this.showMessage('Steam', 'Не удалось войти в лобби: ' + e.message); }
  }
  async hostLan() {
    try {
      const t = await LanHostTransport.host(Number($('lan-port').value) || DEFAULT_PORT);
      this.openLobby(new HostLobby(t, this.playerName()), true);
    } catch (e) { this.showMessage('Сеть', e.message); }
  }
  async joinLan() {
    try {
      const t = await LanClientTransport.connect($('lan-addr').value);
      this.openLobby(new ClientLobby(t, this.playerName()), false);
    } catch (e) { this.showMessage('Сеть', e.message); }
  }

  openLobby(lobby, isHost) {
    this.lobby = lobby;
    this.show('lobby');
    document.querySelectorAll('#screen-lobby .host-only').forEach((el) => { el.hidden = !isHost; });
    $('lobby-invite').hidden = lobby.transport.kind !== 'steam';
    const t = lobby.transport;
    let info = '';
    if (t.kind === 'steam') info = `ID лобби: <b>${esc(t.lobbyId)}</b><br>Пригласите друзей через Steam или передайте им ID.`;
    else if (isHost) info = `Адрес для подключения:<br>${t.ips.map((ip) => `<b>${esc(ip)}:${t.port}</b>`).join('<br>')}`;
    else info = 'Подключено к хосту.';
    $('lobby-connect').innerHTML = info;
    if (isHost) {
      $('lobby-map').innerHTML = MAPS.map((m) => `<option value="${m.id}">${m.name}</option>`).join('') +
        this.customMaps.map((m, i) => `<option value="custom:${i}">★ ${esc(m.name)}</option>`).join('');
      $('lobby-seed').value = lobby.settings.seed;
      lobby.onChange = (v) => this.renderLobby(v, true);
      lobby.sync();
    } else {
      $('lobby-info').textContent = 'Ожидание данных от хоста...';
      $('lobby-slots').innerHTML = '';
      lobby.onChange = (v) => this.renderLobby(v, false);
      lobby.onStart = (session) => this.enterGame(session);
      lobby.onClosed = (reason) => { this.lobby = null; this.show('mp'); this.showMessage('Лобби', reason); };
    }
  }
  renderLobby(v, isHost) {
    $('lobby-slots').innerHTML = v.slots.map((s, i) => `<li><span class="dot" style="background:${s.color}"></span><span class="name">${esc(s.name)}</span><span class="tag">${s.host ? 'Хост' : s.ai ? 'Бот · ' + ({ easy: 'лёгкий', normal: 'норм.', hard: 'сложный' })[s.ai] : 'Игрок'}</span>${isHost && i > 0 ? `<button class="btn tiny danger" data-kick="${i}">✕</button>` : ''}</li>`).join('');
    $('lobby-info').innerHTML = `Карта: <b>${esc(v.mapName)}</b> · seed ${v.seed} · победа ${Math.round(v.victory * 100)}%`;
    if (isHost) $('lobby-start').disabled = v.slots.length < 2;
  }
  leaveLobby() {
    if (this.lobby) this.lobby.close();
    this.lobby = null;
    this.show('mp');
  }
  startLobby() {
    if (!(this.lobby instanceof HostLobby)) return;
    play('click');
    this.enterGame(this.lobby.start());
  }
}

const BOT_NAMES = ['Северная Империя', 'Южный Союз', 'Восточная Орда', 'Западная Лига', 'Пиксельная Республика', 'Красный Блок', 'Синий Альянс', 'Железный Пакт', 'Островное Королевство', 'Пустынный Халифат', 'Ледяной Каганат'];

window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});

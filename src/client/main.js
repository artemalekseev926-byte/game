import {
  VERSION, PLAYER_COLORS, DEFAULT_SETTINGS, BUILDINGS, BUILDING_KEYS, STRIKES, STRIKE_KEYS, RESEARCH, RESEARCH_KEYS,
} from '../core/config.js';
import { generateMap, parseCustomMap } from '../core/map.js';
import { Renderer } from './render.js';
import { Hud, $, esc, tpl, setRangeFill, fmtClock, fmtPct } from './hud.js';
import { Menus, MapPreviews, descKey, startPreviewWorker } from './menus.js';
import { startOffline, loadOffline } from './session.js';
import { hasNative, DEFAULT_PORT } from './net.js';
import { setVolume, play, unlock } from './audio.js';
import mapKrest from '../../maps/krest.json';
import mapShahmaty from '../../maps/shahmaty.json';

const SCRIPT_URL = typeof document !== 'undefined' && document.currentScript ? document.currentScript.src : '';
const SETTINGS_KEY = 'pc2_settings';
const MAPS_KEY = 'pc2_custom_maps';
const SAVE_KEY = 'pc2_save_';
const META_KEY = 'pc2_save_meta_';
const SLOTS = ['auto', '1', '2', '3'];
const AUTOSAVE_SEC = 60;
const NO_BACKDROP_CLOSE = { end: true, msg: true, confirm: true };
const UI_MIN = 0.6;

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
      return true;
    } catch {
      return false;
    }
  },
  del(k) {
    try { localStorage.removeItem(k); } catch { return; }
  },
};

function defaults() {
  return {
    theme: 'dark', volume: 50, ui: 1, edgeScroll: false, name: 'Командир', color: PLAYER_COLORS[0],
    bots: 5, difficulty: 'normal', map: 'world', victory: { ...DEFAULT_SETTINGS.victory },
    ratio: 0.3, boardCollapsed: false, lanPort: DEFAULT_PORT, lanAddr: '',
  };
}

function loadSettings() {
  const d = defaults();
  const s = Object.assign(d, store.get(SETTINGS_KEY, {}));
  if (s.theme !== 'light') s.theme = 'dark';
  s.volume = Math.max(0, Math.min(100, Number(s.volume) || 0));
  if (![0.85, 1, 1.15, 1.3].includes(Number(s.ui))) s.ui = 1;
  s.ui = Number(s.ui);
  s.victory = { ...DEFAULT_SETTINGS.victory, ...(s.victory || {}) };
  s.bots = Math.max(1, Math.min(11, Number(s.bots) || 5));
  if (!['easy', 'normal', 'hard', 'mixed'].includes(s.difficulty)) s.difficulty = 'normal';
  if (!PLAYER_COLORS.includes(s.color)) s.color = PLAYER_COLORS[0];
  return s;
}

const isTyping = (el) => !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
  || (el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit', 'file'].includes(el.type)));

const nextPaint = () => new Promise((resolve) => {
  let done = false;
  const fin = () => {
    if (done) return;
    done = true;
    resolve();
  };
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(fin, 0)));
  setTimeout(fin, 200);
});

class App {
  constructor() {
    this.settings = loadSettings();
    this.screen = 'menu';
    this.session = null;
    this.hud = null;
    this.mapCache = [];
    this.pausedByMenu = false;
    this.msgClose = null;
    this.saveTimer = 0;
    this.autosaveT = AUTOSAVE_SEC;
    this.lastFrame = 0;
    this.fs = false;
    this.renderer = new Renderer($('map'));
    this.renderer.setTheme(this.settings.theme);
    this.previews = new MapPreviews(SCRIPT_URL);
    this.customMaps = [];
    for (const [src, name] of [[mapKrest, 'krest'], [mapShahmaty, 'shahmaty']]) {
      try {
        this.customMaps.push({ ...parseCustomMap(src), builtin: name });
      } catch (e) {
        console.warn('Карта пропущена', name, e.message);
      }
    }
    for (const m of store.get(MAPS_KEY, [])) {
      try {
        this.addCustomMap(parseCustomMap(m), false);
      } catch {
        continue;
      }
    }
    this.menus = new Menus(this);
    this.lobbyView = this.menus.lobby;
    this.multiplayer = this.menus.mp;
    $('ver').textContent = VERSION;
    document.querySelectorAll('.native-only').forEach((el) => { el.hidden = !hasNative(); });
    this.fillHelp();
    this.bindGlobal();
    this.bindSettings();
    this.bindPause();
    this.applySettings();
    this.show('menu');
    this.loadNativeMaps();
    this.bindSteamInvites();
    setInterval(() => this.background(), 250);
    setTimeout(() => this.menus.warmup(), 1200);
  }

  saveSettings() {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    store.set(SETTINGS_KEY, this.settings);
  }

  saveSettingsSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveSettings(), 400);
  }

  unlockAudio() { unlock(); }

  applySettings() {
    const s = this.settings;
    document.documentElement.dataset.theme = s.theme;
    this.applyUi();
    setVolume(s.volume / 100);
    const th = document.querySelector(`#set-theme input[value="${s.theme}"]`);
    if (th) th.checked = true;
    const ui = document.querySelector(`#set-ui input[value="${s.ui}"]`);
    if (ui) ui.checked = true;
    $('set-vol').value = s.volume;
    setRangeFill($('set-vol'));
    $('set-vol-v').textContent = s.volume + '%';
    $('set-edge').checked = !!s.edgeScroll;
    $('set-fs').checked = this.fs;
  }

  applyUi() {
    const want = Number(this.settings.ui) || 1;
    const root = document.documentElement;
    const set = (v) => root.style.setProperty('--ui', String(Math.round(v * 1000) / 1000));
    let ui = want;
    set(ui);
    if (this.screen === 'game') {
      for (let k = 0; k < 5; k++) {
        const over = this.hudOverflow();
        if (over <= 1.002 || ui <= UI_MIN) break;
        ui = Math.max(UI_MIN, ui / Math.min(over, 1.5) - 0.005);
        set(ui);
      }
    }
    this.uiScale = ui;
    if (this.hud) this.hud.updateDockHeight();
  }

  checkUi() {
    if (this.screen === 'game' && this.hudOverflow() > 1.002) this.applyUi();
  }

  hudOverflow() {
    const W = window.innerWidth, H = window.innerHeight;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 15;
    let over = 1;
    const dock = $('hud-bottom');
    const row = dock && !dock.hidden ? dock.querySelector('.tools-row') : null;
    if (row && row.scrollWidth > 0) {
      const cs = getComputedStyle(dock);
      const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 2;
      over = Math.max(over, (row.scrollWidth + pad) / Math.max(1, W - rem));
    }
    const stats = document.querySelector('#hud-top .hud-stats'), right = document.querySelector('#hud-top .hud-right');
    if (stats && right) {
      const gap = parseFloat(getComputedStyle(stats).columnGap) || 0;
      let sum = 0, n = 0;
      for (const c of stats.children) {
        if (c.hidden || c.offsetParent === null) continue;
        sum += c.scrollWidth;
        n++;
      }
      const top = $('hud-top');
      const ts = getComputedStyle(top);
      const need = sum + gap * Math.max(0, n - 1) + right.offsetWidth + parseFloat(ts.paddingLeft) + parseFloat(ts.paddingRight) + (parseFloat(ts.columnGap) || 0);
      over = Math.max(over, need / Math.max(1, W));
    }
    const topH = $('hud-top').offsetHeight, dockH = dock && !dock.hidden ? dock.offsetHeight : 0;
    over = Math.max(over, (topH + dockH) / Math.max(1, H * 0.46));
    return over;
  }

  fillHelp() {
    const li = (name, text) => `<li><b>${esc(name)}</b> — ${esc(text)}</li>`;
    const b = $('help-buildings');
    if (b) b.innerHTML = BUILDING_KEYS.map((k) => li(`${BUILDINGS[k].short} (${BUILDINGS[k].hotkey})`, BUILDINGS[k].desc)).join('');
    const st = $('help-strikes');
    if (st) st.innerHTML = STRIKE_KEYS.filter((k) => k !== 'mega').map((k) => li(STRIKES[k].name, STRIKES[k].desc || '')).join('');
    const mg = $('help-mega');
    if (mg && STRIKES.mega && STRIKES.mega.desc) mg.innerHTML = `<b>Опустошает всю карту врагов.</b> ${esc(STRIKES.mega.desc)}.`;
    const r = $('help-research');
    if (r) r.textContent = RESEARCH_KEYS.map((k, i) => (i ? RESEARCH[k].name.toLowerCase() : RESEARCH[k].name)).join(', ');
  }

  setTheme(name) {
    const t = name === 'light' ? 'light' : 'dark';
    if (t === this.settings.theme) return;
    this.settings.theme = t;
    this.saveSettings();
    this.applySettings();
    this.renderer.setTheme(t);
    this.menus.onTheme();
  }

  toggleTheme() {
    this.setTheme(this.settings.theme === 'dark' ? 'light' : 'dark');
    play('toggle');
  }

  toggleFullscreen() {
    if (window.native && window.native.toggleFullscreen) {
      window.native.toggleFullscreen();
      this.fs = !this.fs;
    } else if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      this.fs = false;
    } else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
      this.fs = true;
    }
    $('set-fs').checked = this.fs;
  }

  show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === 'screen-' + id));
    this.screen = id;
    this.menus.onShow(id);
  }

  modal(name) { return $('modal-' + name); }

  anyModal() {
    for (const m of document.querySelectorAll('.modal')) if (!m.hidden) return true;
    return false;
  }

  topModal() {
    let top = null;
    for (const m of document.querySelectorAll('.modal')) if (!m.hidden) top = m;
    return top;
  }

  openModal(name) {
    const m = this.modal(name);
    if (!m) return;
    if (name === 'settings') this.applySettings();
    m.hidden = false;
    if (this.hud) {
      this.hud.closeCtx();
      $('tip').hidden = true;
    }
  }

  closeModal(name) {
    const m = this.modal(name);
    if (!m || m.hidden) return;
    m.hidden = true;
    if (name === 'pause') this.resumeFromPause();
    if (name === 'confirm') $('confirm-ok').onclick = null;
    if (name === 'msg' && this.msgClose) {
      const f = this.msgClose;
      this.msgClose = null;
      f();
    }
  }

  closeModals() {
    for (const m of document.querySelectorAll('.modal')) m.hidden = true;
    this.pausedByMenu = false;
    this.msgClose = null;
  }

  showMessage(title, text, onClose) {
    $('msg-title').textContent = title;
    $('msg-text').textContent = text;
    this.msgClose = onClose || null;
    this.openModal('msg');
  }

  confirm(title, text, okText, fn) {
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    const ok = $('confirm-ok');
    ok.textContent = okText || 'Подтвердить';
    ok.onclick = () => {
      this.closeModal('confirm');
      play('click');
      fn();
    };
    this.openModal('confirm');
  }

  showLoading(text) {
    $('loading-text').textContent = text || 'Загрузка…';
    $('loading').hidden = false;
    return nextPaint();
  }

  hideLoading() { $('loading').hidden = true; }

  bindGlobal() {
    document.addEventListener('click', (e) => {
      const go = e.target.closest('[data-go]');
      if (go) {
        play('click');
        this.show(go.dataset.go);
        return;
      }
      const mo = e.target.closest('[data-modal]');
      if (mo) {
        play('click');
        this.openModal(mo.dataset.modal);
        return;
      }
      const c = e.target.closest('[data-close]');
      if (c) {
        play('click');
        const m = c.closest('.modal');
        if (m) this.closeModal(m.id.slice(6));
        return;
      }
      if (e.target.classList && e.target.classList.contains('modal')) {
        const name = e.target.id.slice(6);
        if (!NO_BACKDROP_CLOSE[name]) this.closeModal(name);
      }
    });
    document.addEventListener('pointerdown', () => unlock(), { once: true });
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('resize', () => this.applyUi());
    window.addEventListener('beforeunload', () => {
      const s = this.session;
      if (s && s.mode === 'offline' && s.s.phase === 'play') this.saveTo('auto', s, true);
    });
    $('theme-link').onclick = () => this.toggleTheme();
    $('btn-quit').onclick = () => { if (window.native) window.native.quit(); };
    $('btn-load-menu').onclick = () => { play('click'); this.openSaves('load'); };
    $('save-slots').onclick = (e) => this.onSaveSlot(e);
    $('end-continue').onclick = () => { play('click'); this.closeModal('end'); };
    $('end-menu').onclick = () => { play('click'); this.exitGame(); };
  }

  bindSettings() {
    $('set-theme').onchange = (e) => {
      if (e.target.name === 'set-theme') this.setTheme(e.target.value);
    };
    $('set-vol').oninput = (e) => {
      this.settings.volume = Number(e.target.value);
      setRangeFill(e.target);
      $('set-vol-v').textContent = this.settings.volume + '%';
      setVolume(this.settings.volume / 100);
      this.saveSettingsSoon();
    };
    $('set-vol').onchange = () => play('click');
    $('set-ui').onchange = (e) => {
      if (e.target.name !== 'set-ui') return;
      this.settings.ui = Number(e.target.value);
      this.saveSettings();
      this.applyUi();
      if (this.hud) setTimeout(() => this.applyUi(), 60);
    };
    $('set-edge').onchange = (e) => {
      this.settings.edgeScroll = e.target.checked;
      this.saveSettings();
    };
    $('set-fs').onchange = () => this.toggleFullscreen();
  }

  bindPause() {
    $('btn-save').onclick = () => { play('click'); this.openSaves('save'); };
    $('btn-load-game').onclick = () => { play('click'); this.openSaves('load'); };
    $('btn-surrender').onclick = () => {
      const s = this.session;
      if (!s || s.s.phase === 'over') return;
      const me = s.s.players[s.localPid];
      if (!me || !me.alive) {
        this.showMessage('Сдаться', 'Ваша страна уже выбыла из игры.');
        return;
      }
      this.confirm('Сдаться?', 'Вся ваша территория станет ничьей, здания и флот будут потеряны. Вы сможете наблюдать за игрой до конца.', 'Сдаться', () => {
        if (!this.session) return;
        const r = this.session.send({ c: 'surrender' });
        if (!r.ok) {
          this.showMessage('Сдаться', r.error);
          return;
        }
        if (this.hud) this.hud.surrendered = true;
        this.closeModal('pause');
      });
    };
    $('btn-exit').onclick = () => {
      play('click');
      const s = this.session;
      if (s && s.mode !== 'offline' && s.s.phase !== 'over' && !s.ended) {
        this.confirm('Покинуть игру?', s.mode === 'host'
          ? 'Вы хост: игра закончится для всех игроков.'
          : 'Вашей страной будет управлять компьютер. Вернуться в эту партию будет нельзя.', 'Выйти', () => this.exitGame());
        return;
      }
      this.exitGame();
    };
  }

  openPause() {
    if (!this.session) return;
    const m = this.modal('pause');
    if (!m.hidden) {
      this.closeModal('pause');
      return;
    }
    play('click');
    this.openModal('pause');
    const s = this.session;
    if (s.mode === 'offline' && !s.paused && s.s.phase !== 'over') {
      s.setPaused(true);
      this.pausedByMenu = true;
      if (this.hud) this.hud.updateSpeed();
    }
  }

  resumeFromPause() {
    if (this.pausedByMenu && this.session && this.session.paused) {
      this.session.setPaused(false);
      if (this.hud) this.hud.updateSpeed();
    }
    this.pausedByMenu = false;
  }

  onKeyDown(e) {
    if (e.key === 'F11') {
      e.preventDefault();
      this.toggleFullscreen();
      return;
    }
    if (isTyping(e.target)) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    const top = this.topModal();
    if (top) {
      const name = top.id.slice(6);
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeModal(name);
      } else if (name === 'countries' && e.code === 'Tab') {
        e.preventDefault();
        this.closeModal(name);
      } else if (name === 'research' && e.code === 'KeyR') {
        this.closeModal(name);
      } else if (name === 'confirm' && e.key === 'Enter') {
        e.preventDefault();
        $('confirm-ok').click();
      } else if (name === 'msg' && e.key === 'Enter') {
        e.preventDefault();
        this.closeModal(name);
      }
      return;
    }
    if (this.screen === 'game' && this.hud) {
      if (e.target && e.target.type === 'range') e.target.blur();
      this.hud.onKeyDown(e);
      return;
    }
    if (e.key === 'Escape' && (this.screen === 'setup' || this.screen === 'mp')) {
      play('click');
      this.show('menu');
    }
  }

  addCustomMap(desc, persist) {
    const d = { id: 'custom', name: desc.name, rows: desc.rows.slice(), ...(desc.scale ? { scale: desc.scale } : {}), seed: 0 };
    const k = this.customMaps.findIndex((m) => m.name === d.name);
    if (k >= 0 && this.customMaps[k].builtin) d.name += ' (2)';
    const j = this.customMaps.findIndex((m) => m.name === d.name);
    if (j >= 0) this.customMaps[j] = d;
    else this.customMaps.push(d);
    if (persist) {
      const list = this.customMaps.filter((m) => !m.builtin && !m.native).map((m) => ({ name: m.name, rows: m.rows, ...(m.scale ? { scale: m.scale } : {}) }));
      if (!store.set(MAPS_KEY, list)) throw new Error('Не удалось сохранить карту: недостаточно места в хранилище');
    }
    return d;
  }

  async loadNativeMaps() {
    if (!window.native || !window.native.readCustomMaps) return;
    try {
      const files = await window.native.readCustomMaps();
      let added = 0;
      for (const f of files) {
        try {
          const d = parseCustomMap(f.content);
          if (this.customMaps.some((m) => m.name === d.name)) continue;
          this.customMaps.push({ id: 'custom', name: d.name, rows: d.rows, ...(d.scale ? { scale: d.scale } : {}), seed: 0, native: true });
          added++;
        } catch (e) {
          console.warn('Карта пропущена', f.name, e.message);
        }
      }
      if (added && this.screen === 'setup') this.menus.setup.renderGrid();
    } catch (e) {
      console.warn(e);
    }
  }

  bindSteamInvites() {
    const st = window.native && window.native.steam;
    if (!st) return;
    st.onJoinRequested((id) => this.multiplayer.joinSteam(id));
    st.pendingJoin().then((id) => { if (id) this.multiplayer.joinSteam(id); }).catch(() => {});
  }

  getMap(desc) {
    const key = descKey(desc);
    const k = this.mapCache.findIndex((m) => m.key === key);
    if (k >= 0) {
      const [hit] = this.mapCache.splice(k, 1);
      this.mapCache.push(hit);
      return hit.map;
    }
    const map = generateMap(desc);
    this.mapCache.push({ key, map });
    while (this.mapCache.length > 2) this.mapCache.shift();
    return map;
  }

  async startSingle(cfg) {
    await this.showLoading('Генерация карты…');
    try {
      const map = this.getMap(cfg.desc);
      const session = startOffline({ mapDesc: cfg.desc, seed: cfg.seed, players: cfg.players, settings: cfg.settings, map });
      this.enterGame(session);
    } catch (e) {
      console.error(e);
      this.hideLoading();
      this.showMessage('Не удалось начать игру', (e && e.message) || String(e));
    }
  }

  enterGame(session) {
    if (this.hud) this.hud.destroy();
    this.hud = null;
    if (this.session && this.session !== session) this.session.close();
    this.closeModals();
    this.session = session;
    this.lobbyView.lobby = null;
    this.show('game');
    const r = this.renderer;
    r.setTheme(this.settings.theme);
    r.setMap(session.map);
    this.hud = new Hud(this, session, r);
    this.applyUi();
    r.fit(this.hud.safeInsets());
    this.hideLoading();
    if (session.s.phase !== 'spawn') {
      const me = session.s.players[session.localPid];
      if (me && me.capital >= 0) {
        const W = session.map.W;
        r.focus((me.capital % W) + 0.5, Math.floor(me.capital / W) + 0.5, 5, true);
      } else this.hud.focusHome(4);
    }
    this.autosaveT = AUTOSAVE_SEC;
    this.lastFrame = performance.now();
    const loop = (now) => {
      if (this.session !== session) return;
      this.frame(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  frame(now) {
    const dt = Math.min(0.25, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    const s = this.session;
    try {
      s.update(dt);
    } catch (e) {
      console.error(e);
    }
    if (this.session !== s) return;
    this.renderer.draw(s, dt);
    if (this.hud) this.hud.update(dt);
    if (s.mode === 'offline' && s.s.phase === 'play' && !s.paused) {
      this.autosaveT -= dt;
      if (this.autosaveT <= 0) {
        this.autosaveT = AUTOSAVE_SEC;
        this.saveTo('auto', s, true);
      }
    }
  }

  background() {
    const s = this.session;
    if (!s || !document.hidden || s.mode === 'offline') return;
    const now = performance.now();
    const dt = Math.min(0.5, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    try {
      s.update(dt);
    } catch (e) {
      console.error(e);
    }
  }

  exitGame() {
    const s = this.session;
    if (this.hud) this.hud.destroy();
    this.hud = null;
    this.session = null;
    if (s) {
      if (s.mode === 'offline' && s.s.phase === 'play') this.saveTo('auto', s, true);
      s.close();
    }
    this.closeModals();
    this.hideLoading();
    this.show('menu');
  }

  onDisconnected(reason) {
    if (!this.session) return;
    this.showMessage('Игра прервана', reason || 'Соединение потеряно', () => this.exitGame());
  }

  saveMeta(slot) { return store.get(META_KEY + slot, null); }

  saveTo(slot, ses = this.session, quiet = false) {
    if (!ses || ses.mode !== 'offline') return false;
    let data;
    try {
      data = JSON.stringify(ses.snapshot());
    } catch (e) {
      if (!quiet) this.showMessage('Не удалось сохранить', e.message);
      return false;
    }
    const s = ses.s, me = s.players[ses.localPid];
    const meta = {
      date: Date.now(), map: ses.map.name, time: Math.floor(s.tick / 10), name: me ? me.name : '', color: me ? me.color : '',
      pct: me && ses.map.landCount ? (me.tiles * 100) / ses.map.landCount : 0, players: s.players.length, size: data.length,
    };
    const write = () => store.set(SAVE_KEY + slot, data) && store.set(META_KEY + slot, meta);
    let ok = write();
    if (!ok && slot !== 'auto') {
      store.del(SAVE_KEY + 'auto');
      store.del(META_KEY + 'auto');
      ok = write();
    }
    if (!ok) {
      store.del(SAVE_KEY + slot);
      store.del(META_KEY + slot);
      if (!quiet) this.showMessage('Не удалось сохранить', 'Недостаточно места в хранилище браузера. Освободите другой слот сохранения.');
    }
    return ok;
  }

  openSaves(mode) {
    this.saveMode = mode;
    $('load-title').textContent = mode === 'save' ? 'Сохранить игру' : 'Загрузить игру';
    this.renderSaves();
    this.openModal('load');
  }

  renderSaves() {
    const mode = this.saveMode;
    const ul = $('save-slots');
    ul.innerHTML = '';
    for (const k of SLOTS) {
      const meta = this.saveMeta(k);
      const li = tpl('tpl-save-slot');
      li.classList.toggle('empty-slot', !meta);
      li.querySelector('.save-name').textContent = k === 'auto' ? 'Автосохранение' : `Слот ${k}`;
      const info = meta
        ? `${meta.map} · ${fmtClock(meta.time)} · ${meta.name ? esc(meta.name) + ' ' + fmtPct(meta.pct || 0) + ' · ' : ''}${new Date(meta.date).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
        : k === 'auto' ? 'Пусто — сохраняется само каждую минуту' : 'Пусто';
      li.querySelector('.save-meta').innerHTML = info;
      const b = li.querySelector('.btn');
      b.dataset.slot = k;
      const can = mode === 'save' ? k !== 'auto' && !!this.session && this.session.mode === 'offline' : !!meta;
      b.textContent = mode === 'save' ? (meta ? 'Перезаписать' : 'Сохранить') : 'Загрузить';
      b.disabled = !can;
      b.classList.toggle('primary', can);
      if (mode === 'save' && k === 'auto') b.title = 'Автосохранение нельзя перезаписать вручную';
      ul.appendChild(li);
    }
  }

  onSaveSlot(e) {
    const b = e.target.closest('[data-slot]');
    if (!b || b.disabled) return;
    const slot = b.dataset.slot;
    if (this.saveMode === 'save') {
      if (this.saveTo(slot)) {
        play('build');
        this.renderSaves();
        if (this.hud) this.hud.toast('Игра сохранена', 'ok');
      }
    } else {
      play('click');
      this.loadFrom(slot);
    }
  }

  async loadFrom(slot) {
    let raw;
    try {
      raw = localStorage.getItem(SAVE_KEY + slot);
    } catch {
      raw = null;
    }
    if (!raw) {
      this.showMessage('Ошибка загрузки', 'Сохранение не найдено');
      return;
    }
    await this.showLoading('Загрузка сохранения…');
    try {
      const data = JSON.parse(raw);
      const desc = data.mapDesc || (data.state && data.state.mapDesc);
      const map = desc ? this.getMap(desc) : undefined;
      const session = loadOffline(data, map);
      this.enterGame(session);
      if (this.hud) this.hud.toast('Игра загружена', 'ok');
    } catch (e) {
      console.error(e);
      this.hideLoading();
      this.showMessage('Ошибка загрузки', (e && e.message) || String(e));
    }
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const boot = () => {
    try {
      window.app = new App();
    } catch (e) {
      console.error(e);
      document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;inset:auto 1rem 1rem 1rem;z-index:99;padding:1rem;background:#300;color:#fff;white-space:pre-wrap">${esc(e && e.stack ? e.stack : String(e))}</pre>`);
    }
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
  else boot();
} else if (typeof self !== 'undefined' && typeof importScripts === 'function') {
  startPreviewWorker();
}

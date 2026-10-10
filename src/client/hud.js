import {
  BUILDINGS, BUILDING_KEYS, RESEARCH, RESEARCH_KEYS, STRIKES, SHIPS, TERRAIN, TICKS_PER_SEC, WIN_REASONS, TRADE,
  ECON, SAM, DIPLO, RAIL_TYPES, researchCost, researchTicks, siloReload, airbaseReload, interceptChance,
} from '../core/config.js';
import { buildCost, upgradeCost, demolishRefund, factoryOutlook } from '../core/buildings.js';
import { shipCost, portShips, portShipCap, countUnits, warshipDamage, buildShipError, clearWater } from '../core/units.js';
import { strikeTarget, strikeRange, strikeCost, megasUsed } from '../core/strikes.js';
import { proposeError, embargoBy } from '../core/diplomacy.js';
import { spawnTicks } from '../core/territory.js';
import { NAV_SCALE, NAV_SEARCH, nearestOceanTile } from '../core/nav.js';
import { fmtNum } from './render.js';
import { play } from './audio.js';

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const icon = (name, cls = '') => `<svg class="ic${cls ? ' ' + cls : ''}"><use href="#i-${name}"/></svg>`;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const safeColor = (c) => (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#888888');

export function fmtInt(n) {
  const v = Math.round(Number(n) || 0);
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return v < 0 ? '−' + s : s;
}

export const fmtPct = (v, d = 1) => (Number(v) || 0).toFixed(d).replace('.', ',') + '%';

export const fmtShare = (v) => fmtPct(v, v > 0 && v < 1 ? 2 : 1);

export function fmtClock(sec) {
  const t = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

export function fmtSec(sec) {
  const t = Math.max(0, Math.ceil(Number(sec) || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

export function plural(n, forms) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

export function tpl(id) { return $(id).content.firstElementChild.cloneNode(true); }

export function setRangeFill(el) {
  const min = Number(el.min) || 0, max = Number(el.max) || 100, v = Number(el.value);
  el.style.setProperty('--p', (max > min ? ((v - min) / (max - min)) * 100 : 0) + '%');
}

export function setText(el, v) {
  const t = String(v);
  if (el && el.textContent !== t) el.textContent = t;
}

export function setHTML(el, v) {
  if (el && el.dataset.h !== v) {
    el.innerHTML = v;
    el.dataset.h = v;
  }
}

function toggle(el, cls, on) {
  if (el && el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on);
}

function show(el, on) {
  if (el && el.hidden === !!on) el.hidden = !on;
}

function labelNode(btn) {
  for (const n of btn.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return n;
  const t = document.createTextNode('');
  btn.appendChild(t);
  return t;
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
const RESEARCH_ICONS = { econ: 'econ', logistics: 'rail', inf: 'troops', armor: 'tank', art: 'art', fort: 'fort', naval: 'ship', drone: 'drone', missile: 'cruise', aa: 'sam', nuclear: 'atom' };
const UNIT_NAMES = { warship: 'Военный корабль', transport: 'Десантный корабль', trade: 'Торговое судно', train: 'Поезд', truck: 'Грузовик' };
const UNIT_ICONS = { warship: 'ship', transport: 'boat', trade: 'trade', train: 'rail', truck: 'factory' };
const DIP_TYPES = { alliance: 'Союз', pact: 'Пакт', trade: 'Торговля' };
const DIP_TEXT = {
  alliance: 'Предлагает союз: вы не сможете нападать друг на друга.',
  pact: 'Предлагает пакт о ненападении на 10 минут.',
  trade: 'Предлагает торговый договор: +50% к доходу от торговли. Пакт о ненападении, если он есть, сохранится.',
};
const PROPOSE_TITLE = { alliance: 'Предложить союз', pact: 'Предложить пакт о ненападении на 10 минут', trade: 'Предложить торговый договор: +50% к торговле, пакт сохранится' };
const STRIKE_SHORT = { drone: 'Дрон', kamikaze: 'Камикадзе', cruise: 'Крылатая ракета', atom: 'Атомная бомба', hbomb: 'Водородная бомба', mega: 'Мегабомба' };
const SRC_NEED = { airbase: 'Постройте аэродром БПЛА (клавиша 6)', silo: 'Постройте ракетную шахту (клавиша 7)' };
const SRC_NAME = { airbase: 'аэродром БПЛА', silo: 'ракетная шахта' };
const PANEL_STRIKES = { silo: ['cruise', 'atom', 'hbomb', 'mega'], airbase: ['drone', 'kamikaze'] };
const RATIO_STEP = 5;
const ECON_MARKS = [0.5, 0.75, 0.9];
const FLEET_GAP = 4;
const FLEET_RINGS = 9;
const SHIP_FORMS = ['корабль', 'корабля', 'кораблей'];
const PENDING_TICKS = 40;

export function breakLabel(rel) {
  if (!rel) return 'Разорвать договор';
  if (rel.type === 'alliance') return 'Разорвать союз';
  if (rel.type === 'pact') return rel.trade ? 'Разорвать пакт и торговлю' : 'Разорвать пакт';
  return rel.trade ? 'Разорвать торговлю' : 'Разорвать договор';
}

export function econGoalText(leader, isMe, leadSec, needSec) {
  if (leader < 0) return { text: `цель ${fmtSec(needSec)}`, done: false };
  return { text: `${fmtSec(leadSec)} / ${fmtSec(needSec)}`, done: isMe };
}

export function econMarkStage(progress) {
  let k = 0;
  while (k < ECON_MARKS.length && progress >= ECON_MARKS[k]) k++;
  return k;
}

export function fleetSlots(map, x, y, n, gap = FLEET_GAP) {
  const W = map.W, H = map.H, ocean = map.nav.ocean, wb = map.waterBody;
  const c0 = nearestOceanTile(map, x, y, NAV_SCALE * NAV_SEARCH);
  if (c0 < 0 || n <= 0) return [];
  const body = wb[c0];
  const ix = Math.floor(x), iy = Math.floor(y);
  const exact = ix >= 0 && iy >= 0 && ix < W && iy < H && ocean[iy * W + ix] && wb[iy * W + ix] === body;
  const cx = exact ? x : (c0 % W) + 0.5, cy = exact ? y : Math.floor(c0 / W) + 0.5;
  const pts = [];
  for (let b = -FLEET_RINGS; b <= FLEET_RINGS; b++) {
    for (let a = -FLEET_RINGS; a <= FLEET_RINGS; a++) {
      if (Math.abs(a + b) > FLEET_RINGS) continue;
      const px = cx + gap * (a + b / 2), py = cy + gap * b * 0.8660254;
      pts.push([(px - cx) ** 2 + (py - cy) ** 2, Math.atan2(py - cy, px - cx), px, py]);
    }
  }
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const out = [];
  const used = new Set();
  for (const [, , px, py] of pts) {
    if (out.length >= n) break;
    const tx = Math.floor(px), ty = Math.floor(py);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
    const i = ty * W + tx;
    if (used.has(i) || !ocean[i] || wb[i] !== body) continue;
    if (out.length && !clearWater(map, cx, cy, px, py)) continue;
    used.add(i);
    out.push([px, py]);
  }
  return out;
}

export function fleetOrders(game, pid, ids, x, y) {
  const ships = [];
  for (const id of ids) {
    const u = game.unitById(id);
    if (u && u.owner === pid && u.type === 'warship' && u.hp > 0 && !ships.includes(u)) ships.push(u);
  }
  const cmds = [], failed = [], points = [];
  if (!ships.length) return { cmds, failed, points };
  const slots = ships.length > 1 ? fleetSlots(game.map, x, y, ships.length) : [];
  const assign = new Map();
  if (slots.length) {
    let mx = 0, my = 0;
    for (const u of ships) { mx += u.x; my += u.y; }
    mx /= ships.length;
    my /= ships.length;
    const [sx0, sy0] = slots[0];
    const pairs = [];
    ships.forEach((u, k) => slots.forEach(([px, py], j) => {
      pairs.push([((u.x - mx) - (px - sx0)) ** 2 + ((u.y - my) - (py - sy0)) ** 2, k, j]);
    }));
    pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    const takenS = new Set();
    for (const [, k, j] of pairs) {
      if (assign.has(k) || takenS.has(j)) continue;
      assign.set(k, slots[j]);
      takenS.add(j);
    }
  }
  ships.forEach((u, k) => {
    const tries = assign.has(k) ? [assign.get(k), [x, y]] : [[x, y]];
    for (const [px, py] of tries) {
      const cmd = { c: 'moveShip', id: u.id, x: px, y: py };
      if (game.validate(pid, cmd).ok) {
        cmds.push(cmd);
        points.push([px, py]);
        return;
      }
    }
    failed.push(u.id);
  });
  return { cmds, failed, points };
}

const pips = (n, max) => `<span class="pips">${Array.from({ length: max }, (_, k) => `<i${k < n ? ' class="on"' : ''}></i>`).join('')}</span>`;
const kv = (rows) => `<div class="kv">${rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('')}</div>`;
const pbar = (label, value, pct, cls = '') => `<div class="pbar-block"><div class="pbar-label"><span>${label}</span><b>${value}</b></div><div class="pbar${cls ? ' ' + cls : ''}"><span style="width:${clamp(pct, 0, 100).toFixed(1)}%"></span></div></div>`;
const btn = (act, label, extra = {}) => {
  const attrs = Object.entries(extra.data || {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
  const cls = ['btn', 'sm', extra.cls || '', extra.full ? 'full' : ''].filter(Boolean).join(' ');
  const cost = extra.cost !== undefined ? `<span class="cost">${extra.cost}</span>` : '';
  return `<button class="${cls}" data-act="${act}"${attrs}${extra.disabled ? ' disabled' : ''}${extra.title ? ` title="${esc(extra.title)}"` : ''}>${extra.icon ? icon(extra.icon) : ''}<span class="lbl">${label}</span>${cost}</button>`;
};

export class Hud {
  constructor(app, session, renderer) {
    this.app = app;
    this.session = session;
    this.r = renderer;
    this.pid = session.localPid;
    this.canvas = renderer.canvas;
    this.ratio = clamp(Number(app.settings.ratio) || 0.3, 0.01, 1);
    this.listeners = [];
    this.mouse = { cx: -1, cy: -1, inside: false, inWin: false, down: -1, ox: 0, oy: 0, lx: 0, ly: 0, drag: false, box: false, boxAdd: false };
    this.econMark = { leader: -2, stage: 0 };
    this.sentProps = new Map();
    this.camKey = '';
    this.noteAt = 0;
    this.feedKey = '';
    this.keyPan = { l: 0, r: 0, u: 0, d: 0 };
    this.cards = new Map();
    this.rows = new Map();
    this.sort = { key: 'terr', dir: -1 };
    this.focusPid = -1;
    this.ctx = null;
    this.hoverIndex = -1;
    this.tipAt = 0;
    this.tipDirty = true;
    this.hintKey = '';
    this.endShown = false;
    this.deadShown = false;
    this.endWait = 0;
    this.lastMsg = { text: '', at: 0, el: null, n: 1 };
    this.boatCache = { key: '', v: null };
    this.timers = { top: 0, dock: 0, panel: 0, board: 0, cards: 0, modal: 0, tip: 0, ui: 1 };
    this.r.mode = null;
    this.r.selection = null;
    this.r.box = null;
    this.r.hoverTile = -1;
    this.r.keys.x = 0;
    this.r.keys.y = 0;
    this.initDom();
    this.bind();
    this.unsub = session.on((ev) => this.onSession(ev));
    this.update(0);
  }

  get game() { return this.session.game; }

  get s() { return this.session.s; }

  get me() { return this.session.s.players[this.pid]; }

  listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.listeners.push([target, type, fn, opts]);
  }

  destroy() {
    for (const [t, type, fn, opts] of this.listeners) t.removeEventListener(type, fn, opts);
    this.listeners = [];
    if (this.unsub) this.unsub();
    this.unsub = null;
    this.r.mode = null;
    this.r.selection = null;
    this.r.box = null;
    this.r.hoverTile = -1;
    this.r.keys.x = 0;
    this.r.keys.y = 0;
    this.canvas.style.cursor = '';
    $('tip').hidden = true;
    $('ctx-menu').hidden = true;
    $('diplo-stack').innerHTML = '';
    $('toasts').innerHTML = '';
    this.cards.clear();
  }

  initDom() {
    const s = this.s, me = this.me, offline = this.session.mode === 'offline';
    $('chat-form').hidden = offline;
    $('chat-input').value = '';
    document.querySelectorAll('.offline-only').forEach((el) => { el.hidden = !offline; });
    $('log').innerHTML = '';
    $('toasts').innerHTML = '';
    $('diplo-stack').innerHTML = '';
    $('panel').hidden = true;
    $('hint').hidden = true;
    $('ctx-menu').hidden = true;
    $('tip').hidden = true;
    $('hud-bottom').hidden = !me || !me.alive;
    $('spawn-overlay').hidden = s.phase !== 'spawn';
    $('countries-badge').hidden = true;
    $('board').classList.toggle('collapsed', !!this.app.settings.boardCollapsed);
    $('btn-aa').classList.toggle('on', !!this.r.showAA);
    $('r-name').textContent = me ? me.name : '';
    $('r-color').style.background = me ? safeColor(me.color) : '';
    for (const b of $('speed-ctrl').querySelectorAll('[data-speed]')) b.hidden = !this.session.speeds.includes(Number(b.dataset.speed));
    $('speed-ctrl').hidden = !this.session.speeds.length;
    $('research-list').innerHTML = '';
    $('countries-body').innerHTML = '';
    this.initTitles();
    this.setRatio(this.ratio, true);
    this.updateSpeed();
    this.updateDockHeight();
  }

  initTitles() {
    for (const type of BUILDING_KEYS) {
      const def = BUILDINGS[type], el = $('tool-' + type);
      if (!el) continue;
      const req = def.req ? ` Нужно исследование «${RESEARCH[def.req[0]].name}» ${ROMAN[def.req[1]] || def.req[1]}.` : '';
      el.title = `${def.name}: ${def.desc}.${req} Клавиша ${def.hotkey}`;
    }
    for (const kind of Object.keys(STRIKES)) {
      const def = STRIKES[kind], el = $('tool-' + kind);
      if (!el) continue;
      const desc = def.desc ? def.desc.replace(/\.$/, '') + '.' : '';
      el.title = `${def.name}: ${desc} Запуск: ${SRC_NAME[def.src]}, исследование «${RESEARCH[def.req[0]].name}» ${ROMAN[def.req[1]] || def.req[1]}`;
    }
    $('tool-rail').title = 'Железная дорога между фабрикой, портом или жилым кварталом: поезд идёт вдвое быстрее грузовика и удваивает поток товаров с фабрики в порт. Клавиша 8';
    $('btn-warship').title = 'Военный корабль: строится в выбранном или ближайшем порту. F — выбрать весь флот';
  }

  bind() {
    const c = this.canvas;
    this.listen(c, 'mousedown', (e) => this.onMouseDown(e));
    this.listen(window, 'mousemove', (e) => this.onMouseMove(e));
    this.listen(window, 'mouseup', (e) => this.onMouseUp(e));
    this.listen(c, 'wheel', (e) => this.onWheel(e), { passive: false });
    this.listen(c, 'contextmenu', (e) => { e.preventDefault(); this.onRightClick(e); });
    this.listen(c, 'dblclick', (e) => this.onDoubleClick(e));
    this.listen(c, 'mouseleave', () => {
      this.mouse.inside = false;
      this.r.hoverTile = -1;
      this.hoverIndex = -1;
      $('tip').hidden = true;
    });
    this.listen(document.documentElement, 'mouseleave', () => { this.mouse.inWin = false; });
    this.listen(window, 'keyup', (e) => this.onKeyUp(e));
    this.listen(window, 'blur', () => this.releaseKeys());
    this.listen(window, 'resize', () => this.updateDockHeight());
    this.listen(document, 'mousedown', (e) => {
      if (this.ctx && !e.target.closest('#ctx-menu')) this.closeCtx();
    }, true);

    $('speed-ctrl').onclick = (e) => {
      const b = e.target.closest('[data-speed]');
      if (b) this.setSpeed(Number(b.dataset.speed));
    };
    $('btn-countries').onclick = () => this.openCountries();
    $('btn-research').onclick = () => this.openResearch();
    $('r-research').onclick = () => this.openResearch();
    $('btn-aa').onclick = () => this.toggleAA();
    $('btn-theme').onclick = () => this.app.toggleTheme();
    $('btn-menu').onclick = () => this.app.openPause();
    $('board-more').onclick = () => this.openCountries();
    $('board-toggle').onclick = () => {
      const on = !$('board').classList.contains('collapsed');
      $('board').classList.toggle('collapsed', on);
      this.app.settings.boardCollapsed = on;
      this.app.saveSettings();
      this.feedKey = '';
      play('toggle');
    };
    $('board-list').onclick = (e) => {
      const li = e.target.closest('[data-pid]');
      if (li) this.focusPlayer(Number(li.dataset.pid));
    };
    $('me-chip').onclick = () => this.focusHome();
    $('panel-close').onclick = () => this.clearSelection();
    $('panel-body').onclick = (e) => this.onPanelAction(e);
    $('diplo-stack').onclick = (e) => this.onCardAction(e);
    $('hint-cancel').onclick = () => this.cancelHint();
    $('atk-ratio').oninput = (e) => this.setRatio(Number(e.target.value) / 100);
    $('atk-dec').onclick = () => this.stepRatio(-RATIO_STEP);
    $('atk-inc').onclick = () => this.stepRatio(RATIO_STEP);
    $('build-bar').onclick = (e) => {
      const b = e.target.closest('[data-build]');
      if (b) this.onBuildTool(b.dataset.build);
    };
    $('strike-bar').onclick = (e) => {
      const b = e.target.closest('[data-strike]');
      if (b) this.onStrikeTool(b.dataset.strike);
    };
    $('btn-boat').onclick = () => this.toggleBoat();
    $('btn-warship').onclick = () => this.buildWarship();
    $('ctx-menu').onclick = (e) => {
      const b = e.target.closest('[data-act]');
      if (b && !b.disabled) this.onCtxAction(b.dataset.act);
    };
    $('ctx-menu').oncontextmenu = (e) => e.preventDefault();
    $('chat-form').onsubmit = (e) => {
      e.preventDefault();
      const inp = $('chat-input');
      const text = inp.value.trim();
      if (text) this.session.sendChat(text);
      inp.value = '';
      inp.blur();
    };
    $('research-list').onclick = (e) => {
      const b = e.target.closest('[data-research]');
      if (b && !b.disabled) this.startResearch(b.dataset.research);
    };
    $('countries-table').onclick = (e) => this.onCountriesClick(e);
  }

  onSession(ev) {
    switch (ev.type) {
      case 'events':
        this.r.addEvents(ev.events);
        this.onEvents(ev.events);
        break;
      case 'chat':
        this.logChat(ev.chat);
        break;
      case 'disconnected':
        this.app.onDisconnected(ev.reason);
        break;
      case 'desync':
        if (this.session.mode === 'client') this.toast('Рассинхронизация — загружаем состояние с хоста…', 'info');
        break;
      case 'resync':
        this.toast('Синхронизация восстановлена', 'ok');
        break;
      case 'pause':
      case 'speed':
        this.updateSpeed();
        break;
      case 'peerLeft':
        this.log(`${ev.name || 'Игрок'} отключился — страной управляет компьютер`, 'warn');
        break;
      case 'ready':
        this.toast('Все игроки загрузились', 'ok');
        break;
      case 'error':
        if (typeof console !== 'undefined') console.error(ev.error);
        this.toast(ev.error || 'Ошибка');
        break;
      default:
        break;
    }
  }

  visible(x, y) {
    const [px, py] = this.r.tileToScreen(x, y);
    return px >= 0 && py >= 0 && px <= this.r.viewW && py <= this.r.viewH;
  }

  onEvents(events) {
    const me = this.pid;
    for (const e of events) {
      if (!e) continue;
      switch (e.k) {
        case 'msg':
          if (e.to === me || e.to === -1) this.log(e.text, e.kind || 'info');
          break;
        case 'capture':
          if (e.pid === me) play('capture');
          else if (e.from === me) play('lost');
          break;
        case 'built':
          if (e.pid === me) play('built');
          break;
        case 'destroyed':
          if (e.owner === me || e.by === me || this.visible(e.x, e.y)) play('smallboom');
          break;
        case 'launch':
          if (e.kind === 'mega') play('mega');
          else if (e.pid === me) play(e.kind === 'drone' || e.kind === 'kamikaze' ? 'drone' : 'launch');
          else if (this.visible(e.x, e.y)) play('launch');
          break;
        case 'impact':
          if ((e.kind === 'drone' || e.kind === 'kamikaze' || e.kind === 'cruise') && (e.owner === me || this.visible(e.x, e.y))) play('smallboom');
          break;
        case 'nuke':
          play('nuke');
          break;
        case 'intercept':
          if (e.by === me || e.owner === me || this.visible(e.x, e.y)) play('intercept');
          break;
        case 'shipSunk':
          if (e.owner === me || e.by === me || this.visible(e.x, e.y)) play('splash');
          break;
        case 'ship':
          if (e.pid === me) play(e.type === 'transport' ? 'boat' : 'ship');
          break;
        case 'trade':
          if (e.from === me || e.to === me) play('trade');
          break;
        case 'cargo':
          if (e.pid === me) play('cash');
          break;
        case 'research':
          if (e.pid === me) play('research');
          break;
        case 'request':
          if (e.req && e.req.to === me) {
            play('proposal');
            this.timers.cards = 0;
          }
          break;
        case 'eliminated':
          if (e.pid === me) play('eliminated');
          break;
        case 'victory': {
          const g = this.game;
          const won = e.pid === me || (e.pid >= 0 && this.me && this.me.alive && g.isAllied(me, e.pid));
          play(won ? 'victory' : 'defeat');
          break;
        }
        case 'phase':
          if (e.phase === 'play') {
            play('spawn');
            this.focusHome(5);
          }
          break;
        default:
          break;
      }
    }
    this.tipDirty = true;
  }

  log(text, kind = 'info', html = false) {
    const now = performance.now();
    const L = this.lastMsg;
    if (!html && L.el && L.el.isConnected && L.text === text && now - L.at < 5000) {
      L.n++;
      L.at = now;
      L.el.querySelector('.log-text').textContent = `${text} ×${L.n}`;
      return;
    }
    const el = tpl('tpl-log-item');
    el.classList.add(kind === 'danger' || kind === 'good' || kind === 'warn' || kind === 'chat' ? kind : 'info');
    el.querySelector('.log-time').textContent = fmtClock(this.s.tick / TICKS_PER_SEC);
    const t = el.querySelector('.log-text');
    if (html) t.innerHTML = text;
    else t.textContent = text;
    const log = $('log');
    log.appendChild(el);
    while (log.children.length > 7) log.firstElementChild.remove();
    setTimeout(() => el.remove(), 12000);
    this.lastMsg = { text: html ? '' : text, at: now, el, n: 1 };
    this.fitFeed();
    if (kind === 'danger') play('alert');
  }

  feedTop() {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 15;
    const board = $('board');
    if (board && board.offsetParent !== null) {
      const r = board.getBoundingClientRect();
      if (r.height > 0) return r.bottom + rem * 0.6;
    }
    return $('hud-top').getBoundingClientRect().bottom + rem * 0.6;
  }

  fitFeed() {
    const feed = $('feed'), log = $('log');
    if (!feed || feed.offsetParent === null) return;
    const avail = Math.max(0, feed.getBoundingClientRect().bottom - this.feedTop());
    feed.style.maxHeight = Math.floor(avail) + 'px';
    const chat = $('chat-form');
    const extra = chat.hidden ? 0 : chat.offsetHeight + 6;
    while (log.children.length > 1 && log.offsetHeight + extra > avail) log.firstElementChild.remove();
  }

  logChat(c) {
    this.log(`<b style="color:${safeColor(c.color)}">${esc(c.name)}:</b> ${esc(c.text)}`, 'chat', true);
    if (c.from !== this.pid) play('chat');
  }

  toast(text, kind = '') {
    const el = tpl('tpl-toast');
    if (kind) el.classList.add(kind);
    if (kind === 'info' || kind === 'ok') el.querySelector('use').setAttribute('href', kind === 'ok' ? '#i-check' : '#i-info');
    el.querySelector('.toast-text').textContent = text;
    const box = $('toasts');
    for (const old of box.children) {
      if (old.querySelector('.toast-text').textContent === text) old.remove();
    }
    box.appendChild(el);
    while (box.children.length > 4) box.firstElementChild.remove();
    setTimeout(() => el.remove(), 3200);
    if (!kind) play('error');
  }

  send(cmd) {
    const r = this.session.send(cmd);
    if (!r.ok) {
      this.toast(r.error || 'Команда отклонена');
      return false;
    }
    this.timers.panel = 0.05;
    this.timers.dock = 0.05;
    this.tipDirty = true;
    this.queuedNote();
    return true;
  }

  queuedNote() {
    const ses = this.session;
    if (!this.s || this.s.phase === 'over') return;
    const held = ses.paused || ses.waiting > 0;
    if (!held) return;
    const now = performance.now();
    if (now - this.noteAt < 2500) return;
    this.noteAt = now;
    this.toast(ses.paused ? 'Игра на паузе: команда выполнится, когда игра продолжится' : 'Команда выполнится, когда все игроки загрузятся', 'info');
  }

  markProposal(to, type) {
    this.sentProps.set(to + ':' + type, this.s.tick);
  }

  proposalPending(to, type) {
    const s = this.s, me = this.pid;
    if (s.requests.some((r) => r.from === me && r.to === to && r.type === type)) {
      this.sentProps.delete(to + ':' + type);
      return true;
    }
    const at = this.sentProps.get(to + ':' + type);
    if (at === undefined) return false;
    if (s.tick - at <= PENDING_TICKS) return true;
    this.sentProps.delete(to + ':' + type);
    return false;
  }

  propose(to, type) {
    if (!this.send({ c: 'propose', to, type })) return false;
    this.markProposal(to, type);
    play('click');
    return true;
  }

  update(dt) {
    if (!this.session.s) return;
    const T = this.timers;
    this.applyPan();
    this.updateSpawn();
    if ((T.top -= dt) <= 0) { T.top = 0.12; this.updateTop(); }
    if ((T.dock -= dt) <= 0) { T.dock = 0.2; this.updateDock(); }
    if ((T.panel -= dt) <= 0) { T.panel = 0.25; this.updatePanel(); }
    if ((T.board -= dt) <= 0) { T.board = 0.5; this.updateBoard(); }
    if ((T.cards -= dt) <= 0) { T.cards = 0.2; this.updateCards(); }
    if ((T.modal -= dt) <= 0) { T.modal = 0.4; this.updateModals(); }
    if ((T.ui -= dt) <= 0) { T.ui = 2.5; if (this.app.checkUi) this.app.checkUi(); }
    this.trackCamera();
    T.tip -= dt;
    if (T.tip <= 0 || (this.tipDirty && performance.now() - this.tipAt > 50)) {
      T.tip = 0.25;
      this.updateTip();
    }
    this.updateHint();
    this.checkEnd(dt);
  }

  trackCamera() {
    const c = this.r.cam;
    const key = c.x.toFixed(3) + ',' + c.y.toFixed(3) + ',' + c.z.toFixed(4) + ',' + this.r.viewW + ',' + this.r.viewH;
    if (key === this.camKey) return;
    this.camKey = key;
    if (!this.mouse.inside) return;
    if (this.mouse.box) this.updateBox();
    this.updateHover();
  }

  applyPan() {
    const k = this.keyPan;
    let x = k.r - k.l, y = k.d - k.u;
    const m = this.mouse;
    if (this.app.settings.edgeScroll && m.inWin && m.down < 0 && !this.app.anyModal()) {
      const e = 6, W = window.innerWidth, H = window.innerHeight;
      if (m.cx <= e) x = -1;
      else if (m.cx >= W - 1 - e) x = 1;
      if (m.cy <= e) y = -1;
      else if (m.cy >= H - 1 - e) y = 1;
    }
    this.r.keys.x = Math.sign(x);
    this.r.keys.y = Math.sign(y);
  }

  updateDockHeight() {
    const dock = $('hud-bottom');
    const h = dock.hidden ? 0 : dock.offsetHeight;
    if (h > 0 || dock.hidden) $('screen-game').style.setProperty('--dock-h', h + 'px');
    this.fitFeed();
  }

  safeInsets() {
    const rect = (id) => {
      const el = $(id);
      if (!el || el.hidden || el.offsetParent === null) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? r : null;
    };
    const top = rect('hud-top'), dock = rect('hud-bottom'), board = rect('board');
    const pad = 8;
    return {
      t: top ? top.bottom + pad : 0,
      b: dock ? window.innerHeight - dock.top + pad : 0,
      l: board ? board.right + pad : 0,
      r: 0,
      bh: board ? board.bottom + pad : 0,
    };
  }

  updateSpawn() {
    const s = this.s, ov = $('spawn-overlay');
    if (s.phase !== 'spawn') {
      show(ov, false);
      return;
    }
    show(ov, true);
    const total = spawnTicks(s);
    const left = Math.max(0, total - s.tick - this.session.alpha());
    setText($('spawn-time'), Math.ceil(left / TICKS_PER_SEC));
    $('spawn-bar').style.width = (total > 0 ? (left / total) * 100 : 0).toFixed(1) + '%';
    const me = this.me;
    setText(ov.querySelector('.spawn-text b'), me && me.spawned ? 'Место старта выбрано' : 'Выберите место старта');
  }

  updateSpeed() {
    const sp = this.session.paused ? 0 : this.session.speed;
    for (const b of $('speed-ctrl').querySelectorAll('[data-speed]')) toggle(b, 'on', Number(b.dataset.speed) === sp);
  }

  updateTop() {
    const g = this.game, s = g.s, me = this.me;
    if (!me) return;
    setText($('r-gold'), me.gold < 1e6 ? fmtInt(Math.floor(me.gold)) : fmtNum(me.gold));
    const net = me.income - me.upkeep;
    const inc = $('r-income');
    setText(inc, (net >= 0 ? '+' : '−') + fmtNum(Math.abs(net)) + '/с');
    toggle(inc, 'pos', net >= 0);
    toggle(inc, 'neg', net < 0);
    setText($('r-troops'), fmtNum(me.troops));
    setText($('r-maxtroops'), fmtNum(me.maxTroops));
    const c = me.composition || { inf: 1, tank: 0, art: 0 };
    const ti = Math.round(c.tank * 100), ai = Math.round(c.art * 100), ii = 100 - ti - ai;
    $('r-comp-inf').style.width = ii + '%';
    $('r-comp-tank').style.width = ti + '%';
    $('r-comp-art').style.width = ai + '%';
    setText($('r-comp-inf-v'), ii);
    setText($('r-comp-tank-v'), ti);
    setText($('r-comp-art-v'), ai);
    const land = g.map.landCount || 1;
    const pct = (me.tiles * 100) / land;
    setText($('r-terr'), fmtShare(pct));
    const alive = s.players.filter((p) => p.alive);
    const rank = me.alive ? alive.filter((p) => p.tiles > me.tiles).length + 1 : 0;
    setText($('r-rank'), me.alive && s.phase !== 'spawn' ? `#${rank} из ${alive.length}` : '');
    this.updateGoals(g, s, me, alive, land);
    const rs = me.researching;
    if (rs) {
      const lvl = me.research[rs.key] + 1;
      setText($('r-rs'), `${RESEARCH[rs.key].name} ${ROMAN[lvl] || lvl}`);
      $('r-rs-bar').style.width = clamp((rs.progress / rs.total) * 100, 0, 100).toFixed(1) + '%';
      setText($('r-rs-time'), fmtSec((rs.total - rs.progress) / TICKS_PER_SEC));
    } else {
      setText($('r-rs'), 'Нет');
      $('r-rs-bar').style.width = '0%';
      setText($('r-rs-time'), '');
    }
    setText($('game-time'), fmtClock(s.tick / TICKS_PER_SEC));
  }

  updateGoals(g, s, me, alive, land) {
    const v = s.settings.victory;
    show($('g-terr'), v.territory);
    if (v.territory) {
      const goal = v.territoryPct;
      const my = (me.tiles * 100) / land;
      $('g-terr-bar').style.width = clamp((my / goal) * 100, 0, 100).toFixed(1) + '%';
      let best = null;
      for (const p of alive) if (p.id !== me.id && p.tiles > 0 && (!best || p.tiles > best.tiles)) best = p;
      const lead = $('g-terr-lead');
      show(lead, !!best);
      if (best) {
        const bp = (best.tiles * 100) / land;
        lead.style.left = clamp((bp / goal) * 100, 0, 100).toFixed(1) + '%';
        lead.style.background = safeColor(best.color);
        lead.title = `${best.name}: ${fmtPct(bp)}`;
      }
      setText($('g-terr-v'), `${my < 10 ? my.toFixed(1).replace('.', ',') : Math.floor(my)} / ${goal}%`);
      toggle($('g-terr'), 'done', my >= goal);
    }
    show($('g-econ'), v.economy);
    if (v.economy) {
      const need = v.economyMinutes * 60 * TICKS_PER_SEC;
      const L = s.econLeader, t = L >= 0 ? s.econLeadTicks : 0;
      const lp = L >= 0 ? s.players[L] : null;
      const bar = $('g-econ-bar');
      bar.style.width = clamp((t / need) * 100, 0, 100).toFixed(1) + '%';
      bar.style.background = lp ? safeColor(lp.color) : '';
      const view = econGoalText(lp ? L : -1, L === me.id, t / TICKS_PER_SEC, need / TICKS_PER_SEC);
      setText($('g-econ-t'), view.text);
      const dot = $('g-econ-dot');
      show(dot, !!lp);
      if (lp) dot.style.background = safeColor(lp.color);
      toggle($('g-econ'), 'done', view.done);
      toggle($('g-econ'), 'rival', !!lp && L !== me.id);
      const left = fmtSec((need - t) / TICKS_PER_SEC);
      $('g-econ').title = !lp
        ? `Экономическое лидерство: нужен самый большой чистый доход с отрывом от второго места не меньше 15%, без перерыва ${fmtSec(need / TICKS_PER_SEC)}. Сейчас лидера нет`
        : `Лидер по доходу: ${L === me.id ? 'вы' : lp.name}. Держит лидерство ${fmtSec(t / TICKS_PER_SEC)} из ${fmtSec(need / TICKS_PER_SEC)}, до победы ${left}`;
      this.econWarn(L, lp, t / need, left);
    }
    show($('g-surv'), !v.territory && !v.economy);
    setText($('g-surv-v'), `Осталось стран: ${alive.length}`);
  }

  econWarn(L, lp, progress, left) {
    const M = this.econMark;
    if (L !== M.leader) {
      M.leader = L;
      M.stage = 0;
    }
    if (!lp || !this.me || this.s.phase !== 'play') return;
    const k = econMarkStage(progress);
    if (k <= M.stage) return;
    M.stage = k;
    if (L === this.pid) this.log(`Экономическое лидерство за вами: до победы ${left}`, 'good');
    else if (this.game.isAllied(this.pid, L)) this.log(`Союзник ${lp.name} близок к экономической победе: осталось ${left}`, 'info');
    else this.log(`${lp.name} близок к экономической победе: осталось ${left}. Обгоните его по доходу`, k >= ECON_MARKS.length ? 'danger' : 'warn');
  }

  updateBoard() {
    const s = this.s, me = this.pid, land = this.game.map.landCount || 1;
    const alive = s.players.filter((p) => p.alive).sort((a, b) => b.tiles - a.tiles || a.id - b.id);
    const list = alive.slice(0, 8).map((p) => [alive.indexOf(p) + 1, p]);
    const mine = s.players[me];
    if (mine && !list.some(([, p]) => p.id === me)) list.push([mine.alive ? alive.indexOf(mine) + 1 : 0, mine]);
    const ol = $('board-list');
    while (ol.children.length < list.length) ol.appendChild(tpl('tpl-board-row'));
    while (ol.children.length > list.length) ol.lastElementChild.remove();
    list.forEach(([rank, p], k) => {
      const li = ol.children[k];
      li.dataset.pid = p.id;
      toggle(li, 'me', p.id === me);
      toggle(li, 'dead', !p.alive);
      setText(li.querySelector('.rank'), rank || '—');
      li.querySelector('.dot').style.background = safeColor(p.color);
      setText(li.querySelector('.nm'), p.name);
      setText(li.querySelector('.pct'), fmtShare((p.tiles * 100) / land));
      li.title = `${p.name}: ${fmtNum(p.troops)} войск`;
    });
    const key = `${ol.children.length}|${$('board').classList.contains('collapsed')}|${window.innerHeight}|${$('log').children.length}`;
    if (key !== this.feedKey) {
      this.feedKey = key;
      this.fitFeed();
    }
  }

  updateCards() {
    const s = this.s, me = this.pid;
    const reqs = s.requests.filter((r) => r.to === me);
    const ids = new Set(reqs.map((r) => r.id));
    for (const [id, el] of this.cards) {
      if (!ids.has(id)) {
        el.remove();
        this.cards.delete(id);
      }
    }
    const stack = $('diplo-stack');
    for (const r of reqs) {
      let el = this.cards.get(r.id);
      const from = s.players[r.from];
      if (!el) {
        el = tpl('tpl-diplo-card');
        el.classList.add(r.type);
        el.dataset.req = r.id;
        el.querySelector('.dot').style.background = safeColor(from ? from.color : '');
        el.querySelector('.dcard-from').textContent = from ? from.name : '?';
        el.querySelector('.dcard-type').textContent = DIP_TYPES[r.type] || r.type;
        el.querySelector('.dcard-text').textContent = (DIP_TEXT[r.type] || '') + (from && from.traitorUntil > s.tick ? ' Внимание: эта страна — предатель.' : '');
        el.querySelector('.dcard-accept').dataset.accept = r.id;
        el.querySelector('.dcard-decline').dataset.decline = r.id;
        stack.appendChild(el);
        this.cards.set(r.id, el);
      }
      const left = clamp(((r.expires - s.tick) / DIPLO.requestTicks) * 100, 0, 100);
      el.querySelector('.dcard-timer > span').style.width = left.toFixed(1) + '%';
    }
    const badge = $('countries-badge');
    show(badge, reqs.length > 0);
    setText(badge, reqs.length);
  }

  onCardAction(e) {
    const a = e.target.closest('[data-accept]'), d = e.target.closest('[data-decline]');
    const id = a ? Number(a.dataset.accept) : d ? Number(d.dataset.decline) : NaN;
    if (!Number.isFinite(id)) return;
    if (this.send({ c: 'respond', id, accept: !!a })) {
      play(a ? 'select' : 'click');
      const el = this.cards.get(id);
      if (el) el.remove();
      this.cards.delete(id);
    }
  }

  updateHint() {
    const m = this.r.mode, s = this.s, ses = this.session;
    let ic = '', text = '', cancel = true;
    if (m) {
      if (m.kind === 'build') {
        const cost = buildCost(this.game, this.pid, m.type);
        ic = m.type;
        text = `Строительство: ${BUILDINGS[m.type].name} · ${fmtInt(cost)} — клик по своей территории, Shift — несколько`;
      } else if (m.kind === 'rail') {
        ic = 'rail';
        text = m.from ? 'Ж/д: выберите второе здание — фабрику, порт или дом' : 'Ж/д: выберите первое здание — фабрику, порт или дом';
      } else if (m.kind === 'strike') {
        ic = m.strike;
        const def = STRIKES[m.strike];
        text = m.strike === 'mega'
          ? 'Мегабомба: укажите точку распада — боеголовки поразят всех врагов'
          : def.point ? `${def.name}: выберите вражеское здание` : `${def.name}: выберите цель на вражеской территории`;
      } else if (m.kind === 'boat') {
        ic = 'boat';
        text = 'Высадка: кликните по чужой или ничьей земле за морем, Shift — несколько';
      }
    } else if (ses.waiting > 0) {
      ic = 'hourglass';
      text = ses.mode === 'host' ? `Ожидание загрузки игроков: ${ses.waiting}` : 'Ожидание хоста…';
      cancel = false;
    } else if (ses.paused && s.phase !== 'over') {
      ic = 'pause';
      text = ses.canControl ? 'Пауза — нажмите Пробел, чтобы продолжить' : 'Хост поставил игру на паузу';
      cancel = false;
    } else if (this.mouse.box && this.r.box) {
      const n = this.r.box.n || 0;
      ic = 'ship';
      text = n ? `В рамке ${n} ${plural(n, SHIP_FORMS)} — отпустите кнопку, чтобы выбрать` : 'Выделите рамкой свои военные корабли';
      cancel = false;
    } else if (this.r.selection && this.r.selection.kind === 'ship') {
      const n = this.shipSel().length;
      if (n > 1) {
        ic = 'ship';
        text = `Выбрано: ${n} ${plural(n, SHIP_FORMS)} · ПКМ по воде — курс строем · Ctrl+клик — добавить или убрать`;
      } else if (n === 1) {
        ic = 'ship';
        text = 'Корабль выбран: ПКМ по воде — курс · Shift+рамка или F — выбрать несколько';
      }
    }
    const key = ic + '|' + text + '|' + cancel;
    if (key === this.hintKey) return;
    this.hintKey = key;
    const h = $('hint');
    if (!text) {
      h.hidden = true;
      return;
    }
    $('hint-icon').innerHTML = icon(ic);
    $('hint-text').textContent = text;
    $('hint-cancel').hidden = !cancel;
    h.hidden = false;
  }

  cancelHint() {
    if (this.r.mode) this.setMode(null);
    else this.clearSelection();
  }

  setMode(m) {
    this.r.mode = m;
    this.tipDirty = true;
    this.timers.dock = 0;
    this.hintKey = '';
    if (m) {
      this.closeCtx();
      play('toggle');
    }
    this.updateDock();
    this.updateHover();
  }

  modeIs(kind, sub) {
    const m = this.r.mode;
    if (!m || m.kind !== kind) return false;
    if (sub === undefined) return true;
    return kind === 'build' ? m.type === sub : kind === 'strike' ? m.strike === sub : true;
  }

  needPlay() {
    if (this.s.phase === 'play') return true;
    this.toast(this.s.phase === 'spawn' ? 'Сначала выберите место старта и дождитесь начала игры' : 'Игра окончена');
    return false;
  }

  updateDock() {
    const g = this.game, me = this.me, pid = this.pid;
    if (!me) return;
    const nws = countUnits(g, pid, 'warship');
    const cws = $('cnt-warships');
    show(cws, nws > 0);
    setText(cws, nws);
    setText($('atk-troops'), fmtNum(Math.floor(me.troops * this.ratio)));
    for (const type of BUILDING_KEYS) {
      const el = $('tool-' + type);
      const def = BUILDINGS[type];
      const cost = buildCost(g, pid, type);
      setText($('cost-' + type), fmtInt(cost));
      const locked = !!def.req && me.research[def.req[0]] < def.req[1];
      toggle(el, 'locked', locked);
      toggle(el, 'poor', !locked && me.gold < cost);
      toggle(el, 'on', this.modeIs('build', type));
    }
    toggle($('tool-rail'), 'on', this.modeIs('rail'));
    for (const kind of Object.keys(STRIKES)) {
      const el = $('tool-' + kind);
      const def = STRIKES[kind];
      const resOk = me.research[def.req[0]] >= def.req[1];
      const src = g.buildingsOf(pid, def.src).filter((b) => g.buildingActive(b));
      const ready = src.filter((b) => !(b.cd > 0));
      const cost = strikeCost(g, pid, kind);
      setText($('cost-' + kind), fmtInt(cost));
      const spent = !!def.perGame && megasUsed(me) >= def.perGame;
      toggle(el, 'locked', !resOk || !src.length || spent);
      toggle(el, 'poor', resOk && src.length > 0 && !spent && me.gold < cost);
      toggle(el, 'on', this.modeIs('strike', kind));
      const cnt = $('cnt-' + kind);
      show(cnt, resOk && src.length > 0);
      setText(cnt, ready.length);
      const cool = resOk && src.length > 0 && !ready.length;
      toggle(el, 'cooldown', cool);
      if (cool) {
        let best = 0;
        for (const b of src) {
          const tot = b.type === 'silo' ? siloReload(b.level) : airbaseReload(b.level);
          best = Math.max(best, 1 - b.cd / tot);
        }
        el.style.setProperty('--cd', (clamp(best, 0, 1) * 100).toFixed(0) + '%');
      }
    }
    setText($('cnt-boats'), `${countUnits(g, pid, 'transport')} / ${SHIPS.transport.maxActive}`);
    toggle($('btn-boat'), 'on', this.modeIs('boat'));
    const ports = g.buildingsOf(pid, 'port').filter((b) => g.buildingActive(b));
    const sc = shipCost(g, pid);
    setText($('cost-warship'), fmtInt(sc));
    toggle($('btn-warship'), 'locked', !ports.length);
    toggle($('btn-warship'), 'poor', ports.length > 0 && me.gold < sc);
  }

  setRatio(v, silent = false) {
    this.ratio = clamp(Math.round(clamp(Number(v) || 0.01, 0.01, 1) * 100) / 100, 0.01, 1);
    const el = $('atk-ratio');
    const pv = Math.round(this.ratio * 100);
    if (Number(el.value) !== pv) el.value = pv;
    setRangeFill(el);
    setText($('atk-ratio-v'), pv + '%');
    const me = this.me;
    if (me) setText($('atk-troops'), fmtNum(Math.floor(me.troops * this.ratio)));
    if (!silent) {
      this.app.settings.ratio = this.ratio;
      this.app.saveSettingsSoon();
      this.tipDirty = true;
    }
  }

  stepRatio(d) {
    const cur = Math.round(this.ratio * 100);
    let next;
    if (Math.abs(d) >= RATIO_STEP && cur % RATIO_STEP) next = d > 0 ? Math.ceil(cur / RATIO_STEP) * RATIO_STEP : Math.floor(cur / RATIO_STEP) * RATIO_STEP;
    else next = cur + d;
    this.setRatio(clamp(next, 1, 100) / 100);
  }

  setSpeed(v) {
    if (!this.session.canControl) return;
    if (v <= 0) this.session.setPaused(true);
    else this.session.setSpeed(v);
    play('click');
    this.updateSpeed();
  }

  stepSpeed(dir) {
    const ses = this.session;
    if (!ses.canControl) return;
    const list = ses.speeds.filter((x) => x > 0);
    if (!list.length) return;
    if (ses.paused) {
      if (dir > 0) ses.setPaused(false);
    } else {
      const k = list.indexOf(ses.speed);
      const n = k + dir;
      if (n < 0) ses.setPaused(true);
      else ses.setSpeed(list[Math.min(list.length - 1, n)]);
    }
    play('click');
    this.updateSpeed();
  }

  togglePause() {
    if (!this.session.canControl || this.s.phase === 'over') return;
    this.session.togglePause();
    play('click');
    this.updateSpeed();
  }

  toggleAA() {
    this.r.showAA = !this.r.showAA;
    $('btn-aa').classList.toggle('on', this.r.showAA);
    play('toggle');
  }

  onBuildTool(type) {
    if (type === 'rail') {
      this.toggleRail();
      return;
    }
    if (!BUILDINGS[type]) return;
    if (this.modeIs('build', type)) {
      this.setMode(null);
      return;
    }
    if (!this.needPlay()) return;
    const def = BUILDINGS[type], me = this.me;
    if (def.req && me.research[def.req[0]] < def.req[1]) {
      if (this.r.mode) this.setMode(null);
      this.toast(`Нужно исследование «${RESEARCH[def.req[0]].name}» ${def.req[1]} ур.`);
      return;
    }
    this.setMode({ kind: 'build', type });
  }

  toggleRail() {
    if (this.modeIs('rail')) {
      this.setMode(null);
      return;
    }
    if (!this.needPlay()) return;
    const sel = this.r.selection;
    const b = sel && sel.kind === 'building' ? this.game.buildingById(sel.id) : null;
    const from = b && b.owner === this.pid && RAIL_TYPES[b.type] && this.game.buildingActive(b) ? b.id : null;
    this.setMode({ kind: 'rail', from });
  }

  toggleBoat() {
    if (this.modeIs('boat')) {
      this.setMode(null);
      return;
    }
    if (!this.needPlay()) return;
    this.setMode({ kind: 'boat' });
  }

  viewCenter() {
    return this.r.screenToTile(this.r.viewW / 2, this.r.viewH / 2);
  }

  strikeLock(kind) {
    const def = STRIKES[kind], me = this.me, g = this.game;
    if (me.research[def.req[0]] < def.req[1]) return `Нужно исследование «${RESEARCH[def.req[0]].name}» ${def.req[1]} ур.`;
    if (!g.buildingsOf(this.pid, def.src).some((b) => g.buildingActive(b))) return SRC_NEED[def.src];
    if (def.perGame && megasUsed(me) >= def.perGame) return 'Мегабомба уже применена: она одна на партию';
    return null;
  }

  onStrikeTool(kind) {
    if (!STRIKES[kind]) return;
    if (this.modeIs('strike', kind)) {
      this.setMode(null);
      return;
    }
    if (!this.needPlay()) return;
    const lock = this.strikeLock(kind);
    if (lock) {
      if (this.r.mode) this.setMode(null);
      this.toast(lock);
      return;
    }
    const [cx, cy] = this.viewCenter();
    const src = this.bestSource(kind, cx, cy);
    this.setMode({ kind: 'strike', strike: kind, from: src ? src.id : null });
  }

  bestSource(kind, x, y) {
    const def = STRIKES[kind], g = this.game;
    if (!def) return null;
    const list = g.buildingsOf(this.pid, def.src).filter((b) => g.buildingActive(b));
    if (!list.length) return null;
    const range = strikeRange(g, this.pid, kind);
    let best = null, bs = Infinity;
    for (const b of list) {
      const dx = b.x + 0.5 - x, dy = b.y + 0.5 - y;
      const d2 = dx * dx + dy * dy;
      const inRange = !Number.isFinite(range) || d2 <= range * range;
      const score = (b.cd > 0 ? 1e12 + b.cd * 1e6 : 0) + (inRange ? 0 : 1e11) + d2;
      if (score < bs || (score === bs && b.id < best.id)) {
        bs = score;
        best = b;
      }
    }
    return best;
  }

  buildWarship() {
    if (!this.needPlay()) return;
    const g = this.game, pid = this.pid;
    const sel = this.r.selection;
    let port = sel && sel.kind === 'building' ? g.buildingById(sel.id) : null;
    if (!port || port.type !== 'port' || port.owner !== pid) port = null;
    if (!port) {
      const ports = g.buildingsOf(pid, 'port').filter((b) => g.buildingActive(b));
      if (!ports.length) {
        this.toast('Нужен готовый порт (клавиша 3)');
        return;
      }
      const [cx, cy] = this.viewCenter();
      let bd = Infinity;
      for (const b of ports) {
        const d = (b.x - cx) ** 2 + (b.y - cy) ** 2 + (buildShipError(g, pid, b.id) ? 1e12 : 0);
        if (d < bd) {
          bd = d;
          port = b;
        }
      }
    }
    this.send({ c: 'buildShip', port: port.id });
  }

  focusHome(zoom) {
    const me = this.me, g = this.game;
    if (!me) return;
    let t = me.capital;
    if (!(t >= 0) || g.tileOwner(t) !== this.pid) t = this.playerAnchor(this.pid);
    if (t < 0) {
      if (zoom === undefined) this.toast('У вас нет территории', 'info');
      return;
    }
    const W = g.W;
    this.r.focus((t % W) + 0.5, Math.floor(t / W) + 0.5, zoom || Math.max(this.r.zoom, 4));
  }

  playerAnchor(pid) {
    const g = this.game, p = g.s.players[pid];
    if (!p) return -1;
    if (p.capital >= 0 && g.tileOwner(p.capital) === pid) return p.capital;
    const list = g.borderList(pid);
    if (!list.length) return -1;
    const W = g.W;
    let sx = 0, sy = 0, n = 0;
    const step = Math.max(1, Math.floor(list.length / 400));
    for (let k = 0; k < list.length; k += step) {
      sx += list[k] % W;
      sy += Math.floor(list[k] / W);
      n++;
    }
    sx /= n;
    sy /= n;
    let best = list[0], bd = Infinity;
    for (let k = 0; k < list.length; k += step) {
      const d = (list[k] % W - sx) ** 2 + (Math.floor(list[k] / W) - sy) ** 2;
      if (d < bd) {
        bd = d;
        best = list[k];
      }
    }
    return best;
  }

  focusPlayer(pid) {
    const t = this.playerAnchor(pid);
    if (t < 0) {
      this.toast('У этой страны нет территории', 'info');
      return;
    }
    const W = this.game.W;
    this.r.focus((t % W) + 0.5, Math.floor(t / W) + 0.5, Math.max(this.r.zoom, 3));
    play('click');
  }

  pickUnit(sx, sy, ownWarship) {
    const s = this.s, r = this.r, dpr = r.dpr, z = r.cam.z;
    const rad = Math.max(11 * dpr, 2.4 * z);
    let best = null, bd = rad * rad;
    for (const u of s.units) {
      if (u.type === 'train' || u.type === 'truck') continue;
      if (ownWarship && (u.owner !== this.pid || u.type !== 'warship')) continue;
      const [ux, uy] = r.unitPos(u);
      const d = (r.sx(ux) - sx) ** 2 + (r.sy(uy) - sy) ** 2;
      if (d <= bd) {
        bd = d;
        best = u;
      }
    }
    return best;
  }

  pickBuilding(sx, sy, filter) {
    const s = this.s, r = this.r, g = this.game, me = this.pid;
    const rad = Math.max(9 * r.dpr, r.markerRadius() + 4 * r.dpr);
    let best = null, bd = rad * rad;
    for (const b of s.buildings) {
      if (filter === 'own' && b.owner !== me) continue;
      if (filter === 'enemy' && (b.owner === me || !g.isHostile(me, b.owner))) continue;
      const d = (r.sx(b.x + 0.5) - sx) ** 2 + (r.sy(b.y + 0.5) - sy) ** 2;
      if (d <= bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  }

  select(kind, id) {
    this.r.selection = { kind, id };
    this.timers.panel = 0;
    this.hintKey = '';
    play('select');
  }

  clearSelection() {
    if (!this.r.selection) return;
    this.r.selection = null;
    $('panel').hidden = true;
    this.hintKey = '';
    this.updateHover();
  }

  shipSel() {
    const sel = this.r.selection;
    if (!sel || sel.kind !== 'ship' || !this.s) return [];
    const g = this.game, out = [];
    for (const id of sel.ids || [sel.id]) {
      const u = g.unitById(id);
      if (u && u.owner === this.pid && u.type === 'warship' && u.hp > 0) out.push(u);
    }
    return out;
  }

  selectShips(ids, quiet = false) {
    const list = [...new Set(ids)];
    if (!list.length) {
      this.clearSelection();
      return;
    }
    this.r.selection = { kind: 'ship', id: list[0], ids: list };
    this.timers.panel = 0;
    this.hintKey = '';
    this.tipDirty = true;
    if (!quiet) play('select');
  }

  toggleShip(u) {
    const ids = this.shipSel().map((v) => v.id);
    const k = ids.indexOf(u.id);
    if (k >= 0) ids.splice(k, 1);
    else ids.push(u.id);
    if (ids.length) this.selectShips(ids);
    else this.clearSelection();
  }

  ownWarships(onScreen = false) {
    const out = [];
    for (const u of this.s.units) {
      if (u.owner !== this.pid || u.type !== 'warship' || u.hp <= 0) continue;
      if (onScreen) {
        const [x, y] = this.r.unitPos(u);
        if (!this.visible(x, y)) continue;
      }
      out.push(u);
    }
    return out;
  }

  selectFleet() {
    if (this.s.phase !== 'play') return;
    const all = this.ownWarships();
    if (!all.length) {
      this.toast('У вас нет военных кораблей: постройте их в порту', 'info');
      return;
    }
    if (this.r.mode) this.setMode(null);
    const cur = new Set(this.shipSel().map((u) => u.id));
    if (cur.size === all.length && all.every((u) => cur.has(u.id))) {
      this.focusShips(all);
      return;
    }
    this.selectShips(all.map((u) => u.id));
  }

  focusShips(list) {
    if (!list.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const u of list) {
      const [x, y] = this.r.unitPos(u);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    const span = Math.max(x1 - x0, y1 - y0, 1);
    const fit = Math.min(this.r.viewW, this.r.viewH) / this.r.dpr / (span + 24);
    this.r.focus((x0 + x1) / 2, (y0 + y1) / 2, clamp(fit, 1.5, Math.max(this.r.zoom, 6)));
    play('click');
  }

  shipsInBox(b) {
    if (!b) return [];
    const pad = 4 * this.r.dpr, out = [];
    for (const u of this.ownWarships()) {
      const [x, y] = this.r.unitPos(u);
      const sx = this.r.sx(x), sy = this.r.sy(y);
      if (sx >= b.x0 - pad && sx <= b.x1 + pad && sy >= b.y0 - pad && sy <= b.y1 + pad) out.push(u);
    }
    return out;
  }

  updateBox() {
    const m = this.mouse, r = this.r;
    const [ax, ay] = r.canvasPoint(m.ox, m.oy), [bx, by] = r.canvasPoint(m.cx, m.cy);
    const b = { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by), n: 0 };
    b.n = this.shipsInBox(b).length;
    r.box = b;
  }

  finishBox() {
    const list = this.shipsInBox(this.r.box);
    const add = this.mouse.boxAdd;
    this.r.box = null;
    this.hintKey = '';
    if (!list.length) {
      this.toast('В рамке нет ваших военных кораблей', 'info');
      return;
    }
    const ids = list.map((u) => u.id);
    this.selectShips(add ? this.shipSel().map((u) => u.id).concat(ids) : ids);
  }

  orderFleet(ships, x, y) {
    const plan = fleetOrders(this.game, this.pid, ships.map((u) => u.id), x, y);
    let ok = 0;
    for (const cmd of plan.cmds) if (this.session.send(cmd).ok) ok++;
    const n = ships.length, bad = plan.failed.length;
    if (ok) {
      play('click');
      if (typeof this.r.markOrders === 'function') this.r.markOrders(plan.points);
      this.queuedNote();
    }
    if (bad) {
      if (!ok) this.toast(n > 1 ? 'Корабли туда не доплывут' : 'Корабль туда не доплывёт');
      else this.toast(`${bad} из ${n} ${plural(n, SHIP_FORMS)} не доплывут: они в другом море`, 'info');
    }
    this.timers.panel = 0.05;
    this.tipDirty = true;
  }

  onDoubleClick(e) {
    if (this.r.mode || !this.s || this.s.phase !== 'play') return;
    const [sx, sy] = this.r.canvasPoint(e.clientX, e.clientY);
    const u = this.pickUnit(sx, sy, true);
    if (!u) return;
    const ids = this.ownWarships(true).map((v) => v.id);
    if (!ids.includes(u.id)) ids.push(u.id);
    const add = e.ctrlKey || e.metaKey || e.shiftKey;
    this.selectShips(add ? this.shipSel().map((v) => v.id).concat(ids) : ids);
  }

  onMouseDown(e) {
    this.app.unlockAudio();
    if (e.button === 0 || e.button === 1) {
      const m = this.mouse;
      m.down = e.button;
      m.ox = m.lx = e.clientX;
      m.oy = m.ly = e.clientY;
      m.drag = false;
      m.box = e.button === 0 && e.shiftKey && !this.r.mode && !!this.s && this.s.phase === 'play';
      m.boxAdd = e.ctrlKey || e.metaKey;
      if (e.button === 1) e.preventDefault();
    }
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) document.activeElement.blur();
  }

  onMouseMove(e) {
    const m = this.mouse;
    m.cx = e.clientX;
    m.cy = e.clientY;
    m.inWin = true;
    m.inside = e.target === this.canvas;
    if (m.down >= 0) {
      if (!m.drag && Math.hypot(e.clientX - m.ox, e.clientY - m.oy) > 5) {
        m.drag = true;
        if (!m.box) this.canvas.style.cursor = 'grabbing';
        $('tip').hidden = true;
      }
      if (m.drag) {
        if (m.box) this.updateBox();
        else this.r.pan((e.clientX - m.lx) * this.r.dpr, (e.clientY - m.ly) * this.r.dpr);
      }
      m.lx = e.clientX;
      m.ly = e.clientY;
    }
    this.updateHover();
  }

  onMouseUp(e) {
    const m = this.mouse;
    if (m.down < 0) return;
    const was = m.down, drag = m.drag, box = m.box;
    m.down = -1;
    m.drag = false;
    this.canvas.style.cursor = '';
    if (box && drag) {
      this.finishBox();
      m.box = false;
    } else {
      m.box = false;
      this.r.box = null;
      if (was === 0 && e.button === 0 && !drag && e.target === this.canvas) this.onLeftClick(e);
    }
    this.updateHover();
  }

  onWheel(e) {
    e.preventDefault();
    let d = e.deltaY || e.deltaX;
    if (e.deltaMode === 1) d *= 16;
    else if (e.deltaMode === 2) d *= 400;
    if (!d) return;
    if (e.shiftKey) {
      this.stepRatio(d > 0 ? -2 : 2);
      return;
    }
    const [sx, sy] = this.r.canvasPoint(e.clientX, e.clientY);
    this.r.zoomAt(sx, sy, Math.exp(-clamp(d, -240, 240) * 0.0018));
  }

  updateHover() {
    const r = this.r, m = this.mouse;
    if (!m.inside || !r.map) {
      r.hoverTile = -1;
      this.hoverIndex = -1;
      return;
    }
    const [sx, sy] = r.canvasPoint(m.cx, m.cy);
    let i = r.tileAtScreen(sx, sy);
    const mode = r.mode, W = r.map.W;
    let cursor = '';
    if (mode && (mode.kind === 'rail' || (mode.kind === 'strike' && STRIKES[mode.strike] && STRIKES[mode.strike].point))) {
      const b = this.pickBuilding(sx, sy, mode.kind === 'rail' ? 'own' : 'enemy');
      if (b) i = b.y * W + b.x;
    }
    if (mode && mode.kind === 'strike' && !mode.fixed && i >= 0) {
      const src = this.bestSource(mode.strike, (i % W) + 0.5, Math.floor(i / W) + 0.5);
      if (src && src.id !== mode.from) mode.from = src.id;
    }
    if (!mode && m.down < 0 && this.s.phase === 'play' && (this.pickUnit(sx, sy, true) || this.pickBuilding(sx, sy, 'own'))) cursor = 'pointer';
    if (m.drag) cursor = m.box ? 'crosshair' : 'grabbing';
    if (this.canvas.style.cursor !== cursor) this.canvas.style.cursor = cursor;
    if (i !== this.hoverIndex) this.tipDirty = true;
    else if (!$('tip').hidden) this.placeTip();
    r.hoverTile = i;
    this.hoverIndex = i;
  }

  tileXY(i) {
    const W = this.game.W;
    return [i % W, Math.floor(i / W)];
  }

  onLeftClick(e) {
    const r = this.r, g = this.game, s = g.s, me = this.pid;
    const [sx, sy] = r.canvasPoint(e.clientX, e.clientY);
    this.mouse.inside = true;
    this.updateHover();
    const i = this.hoverIndex;
    if (i < 0) return;
    const [x, y] = this.tileXY(i);
    const shift = e.shiftKey;
    if (s.phase === 'spawn') {
      if (this.send({ c: 'spawn', x, y })) play('select');
      return;
    }
    if (s.phase !== 'play') return;
    const mode = r.mode;
    if (mode) {
      this.onModeClick(mode, sx, sy, i, x, y, shift);
      return;
    }
    const multi = e.ctrlKey || e.metaKey || e.shiftKey;
    const u = this.pickUnit(sx, sy, true);
    if (u) {
      if (multi && this.shipSel().length) this.toggleShip(u);
      else this.selectShips([u.id]);
      return;
    }
    if (multi && this.shipSel().length) return;
    const b = this.pickBuilding(sx, sy, 'own');
    if (b) {
      this.select('building', b.id);
      return;
    }
    if (!g.isLandTile(i)) {
      this.clearSelection();
      return;
    }
    if (g.tileOwner(i) === me) {
      this.clearSelection();
      return;
    }
    this.sendAttack(x, y, true);
  }

  onModeClick(mode, sx, sy, i, x, y, shift) {
    switch (mode.kind) {
      case 'build':
        if (this.send({ c: 'build', type: mode.type, x, y })) {
          play('build');
          if (!shift) this.setMode(null);
        }
        break;
      case 'boat':
        if (this.send({ c: 'boat', x, y, ratio: this.ratio }) && !shift) this.setMode(null);
        break;
      case 'rail':
        this.onRailClick(mode, sx, sy, i, shift);
        break;
      case 'strike': {
        const kind = mode.strike;
        let from = mode.from;
        if (!mode.fixed) {
          const src = this.bestSource(kind, x + 0.5, y + 0.5);
          if (src) from = src.id;
        }
        const cmd = { c: 'strike', kind, from, x, y };
        if (kind === 'mega') {
          const v = this.session.validate(cmd);
          if (!v.ok) {
            this.toast(v.error);
            return;
          }
          this.app.confirm('Мегабомба «Судный день»', `Запустить мегабомбу за ${fmtInt(strikeCost(this.game, this.pid, 'mega'))} золота? Она одна на партию. Сотни боеголовок выжгут почти всю территорию всех враждебных стран; ваша земля, союзники и партнёры по пакту не пострадают.`, 'Запустить', () => {
            if (this.send(cmd)) this.setMode(null);
          });
          return;
        }
        if (this.send(cmd) && !shift) this.setMode(null);
        break;
      }
      default:
        break;
    }
  }

  onRailClick(mode, sx, sy, i, shift) {
    const g = this.game, me = this.pid;
    const b = this.pickBuilding(sx, sy, 'own') || g.buildingAt(i);
    if (!b || b.owner !== me) {
      this.toast('Выберите своё здание: фабрику, порт или жилой квартал');
      return;
    }
    if (!RAIL_TYPES[b.type]) {
      this.toast('Ж/д соединяет только фабрики, порты и жилые кварталы');
      return;
    }
    if (!mode.from || !g.buildingById(mode.from)) {
      if (!g.buildingActive(b)) {
        this.toast('Здание ещё строится');
        return;
      }
      this.setMode({ kind: 'rail', from: b.id });
      return;
    }
    if (b.id === mode.from) {
      this.setMode({ kind: 'rail', from: null });
      return;
    }
    if (this.send({ c: 'rail', a: mode.from, b: b.id })) {
      play('build');
      this.setMode(shift ? { kind: 'rail', from: b.id } : null);
    }
  }

  sendAttack(x, y, allowBoat) {
    const g = this.game, me = this.pid, i = g.tileAt(x, y);
    const cmd = { c: 'attack', x, y, ratio: this.ratio };
    const v = g.validate(me, cmd);
    if (v.ok) {
      if (this.session.send(cmd).ok) play('attack');
      return true;
    }
    if (allowBoat && g.isLandTile(i) && g.tileOwner(i) !== me && !g.bordersByLand(me, i)) {
      return this.send({ c: 'boat', x, y, ratio: this.ratio });
    }
    this.toast(v.error);
    return false;
  }

  onRightClick(e) {
    this.app.unlockAudio();
    this.closeCtx();
    const r = this.r, g = this.game, s = g.s;
    if (r.mode) {
      this.setMode(null);
      return;
    }
    const [sx, sy] = r.canvasPoint(e.clientX, e.clientY);
    const i = r.tileAtScreen(sx, sy);
    if (i < 0 || s.phase !== 'play') return;
    const [x, y] = this.tileXY(i);
    const ships = this.shipSel();
    if (ships.length && !g.isLandTile(i)) {
      const [wx, wy] = r.screenToTile(sx, sy);
      this.orderFleet(ships, wx, wy);
      return;
    }
    if (!g.isLandTile(i)) return;
    const o = g.tileOwner(i);
    if (o === this.pid) return;
    this.openCtx(e.clientX, e.clientY, i, x, y, o);
  }

  shortErr(err) {
    if (!err) return '';
    if (err.startsWith('Нет общей границы')) return 'нет границы';
    if (err.startsWith('Недостаточно войск')) return 'мало войск';
    if (err.startsWith('Нужно ') && err.endsWith(' золота')) return 'мало золота';
    if (err.startsWith('Не больше')) return 'нет кораблей';
    if (err.startsWith('Перезарядка')) return err.replace('Перезарядка: ', '⟳ ');
    if (err.length > 22) return 'недоступно';
    return err.toLowerCase();
  }

  openCtx(cx, cy, i, x, y, o) {
    const g = this.game, s = g.s, me = this.pid;
    const p = o >= 0 ? s.players[o] : null;
    this.ctx = { pid: o, x, y, i };
    $('ctx-dot').style.background = p ? safeColor(p.color) : 'var(--muted)';
    $('ctx-title').textContent = p ? p.name : 'Ничья земля';
    $('ctx-sub').textContent = p ? this.relText(o) : TERRAIN[g.map.terrain[i]].name;
    const troops = fmtNum(Math.floor(this.me.troops * this.ratio));
    const va = g.validate(me, { c: 'attack', x, y, ratio: this.ratio });
    const vb = g.validate(me, { c: 'boat', x, y, ratio: this.ratio });
    const atk = $('ctx-attack'), boat = $('ctx-boat');
    atk.disabled = !va.ok;
    atk.title = va.ok ? '' : va.error;
    setText($('ctx-attack-hint'), va.ok ? troops : this.shortErr(va.error));
    boat.disabled = !vb.ok;
    boat.title = vb.ok ? '' : vb.error;
    setText($('ctx-boat-hint'), vb.ok ? troops : this.shortErr(vb.error));
    const target = strikeTarget(g, me, x, y, 2);
    for (const kind of ['kamikaze', 'cruise']) {
      const b = $('ctx-' + kind);
      const def = STRIKES[kind];
      const resOk = this.me.research[def.req[0]] >= def.req[1];
      b.hidden = !target || !resOk;
      if (b.hidden) continue;
      const src = this.bestSource(kind, target.x + 0.5, target.y + 0.5);
      const v = src ? g.validate(me, { c: 'strike', kind, from: src.id, x: target.x, y: target.y }) : { ok: false, error: SRC_NEED[def.src] };
      b.disabled = !v.ok;
      b.title = v.ok ? `${BUILDINGS[target.type].name}: ${fmtInt(def.cost)} золота` : v.error;
      setText($('ctx-' + kind + '-hint'), v.ok ? fmtInt(def.cost) : this.shortErr(v.error));
    }
    const rel = p ? g.relation(me, o) : null;
    const type = rel ? rel.type : 'none';
    for (const t of ['alliance', 'pact', 'trade']) {
      const b = $('ctx-' + t);
      const hide = !p || type === 'alliance' || (t === 'pact' && type === 'pact') || (t === 'trade' && !!rel.trade);
      b.hidden = hide;
      if (hide) continue;
      const pending = this.proposalPending(o, t);
      const err = pending ? 'Предложение отправлено, ждём ответа' : proposeError(g, me, o, t);
      b.disabled = !!err;
      b.title = err || PROPOSE_TITLE[t];
      setText($('ctx-' + t + '-hint'), pending ? 'отправлено' : '');
    }
    const br = $('ctx-break');
    br.hidden = !p || (type === 'none' && !(rel && rel.trade));
    if (!br.hidden) labelNode(br).textContent = breakLabel(rel);
    const em = $('ctx-embargo');
    em.hidden = !p;
    if (p) {
      const on = embargoBy(g, me, o);
      $('ctx-embargo-text').textContent = on ? 'Снять эмбарго' : 'Объявить эмбарго';
      em.classList.toggle('on', on);
    }
    $('ctx-summary').hidden = !p;
    const menu = $('ctx-menu');
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.hidden = false;
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(6, Math.min(cx + 4, window.innerWidth - w - 6)) + 'px';
    menu.style.top = Math.max(6, Math.min(cy + 4, window.innerHeight - h - 6)) + 'px';
    $('tip').hidden = true;
    play('click');
  }

  closeCtx() {
    if (!this.ctx) return;
    this.ctx = null;
    $('ctx-menu').hidden = true;
  }

  onCtxAction(act) {
    const c = this.ctx;
    this.closeCtx();
    if (!c) return;
    const g = this.game, me = this.pid;
    switch (act) {
      case 'attack':
        this.sendAttack(c.x, c.y, false);
        break;
      case 'boat':
        this.send({ c: 'boat', x: c.x, y: c.y, ratio: this.ratio });
        break;
      case 'kamikaze':
      case 'cruise': {
        const t = strikeTarget(g, me, c.x, c.y, 2);
        if (!t) {
          this.toast('Здание уже уничтожено');
          return;
        }
        const src = this.bestSource(act, t.x + 0.5, t.y + 0.5);
        if (!src) {
          this.toast(SRC_NEED[STRIKES[act].src]);
          return;
        }
        this.send({ c: 'strike', kind: act, from: src.id, x: t.x, y: t.y });
        break;
      }
      case 'alliance':
      case 'pact':
      case 'trade':
        this.propose(c.pid, act);
        break;
      case 'break':
        this.breakWith(c.pid);
        break;
      case 'embargo':
        if (this.send({ c: 'embargo', with: c.pid, on: !embargoBy(g, me, c.pid) })) play('click');
        break;
      case 'summary':
        this.openCountries(c.pid);
        break;
      default:
        break;
    }
  }

  breakWith(q) {
    const g = this.game, me = this.pid, s = g.s;
    const rel = g.relation(me, q);
    const p = s.players[q];
    const traitor = rel.type === 'alliance' || (rel.type === 'pact' && rel.until > s.tick);
    const doIt = () => { if (this.send({ c: 'break', with: q })) play('click'); };
    if (!traitor) {
      doIt();
      return;
    }
    const what = rel.type === 'alliance' ? 'Союз' : rel.trade ? 'Пакт о ненападении и торговый договор' : 'Пакт о ненападении';
    this.app.confirm('Разорвать договор?', `${what} с «${p ? p.name : '?'}» ${rel.type === 'pact' && rel.trade ? 'будут разорваны' : 'будет разорван'}. Вы станете предателем, и другие страны долго не будут вам доверять.`, 'Разорвать', doIt);
  }

  relText(q) {
    const g = this.game, s = g.s, me = this.pid;
    const p = s.players[q];
    if (!p) return '';
    if (q === me) return 'Это вы';
    if (!p.alive) return 'Выбыл';
    const rel = g.relation(me, q);
    const parts = [];
    if (rel.type === 'alliance') parts.push('Союз');
    else {
      if (rel.type === 'pact') parts.push(`Пакт · ${fmtSec((rel.until - s.tick) / TICKS_PER_SEC)}`);
      if (rel.trade) parts.push(rel.type === 'pact' ? 'торговля' : 'Торговый договор');
      if (!parts.length) parts.push(this.atWar(me, q) ? 'Война' : 'Нет договора');
    }
    if (rel.embargo) parts.push('эмбарго');
    if (p.traitorUntil > s.tick) parts.push('предатель');
    return parts.join(' · ');
  }

  atWar(a, b) {
    for (const x of this.s.attacks) if ((x.attacker === a && x.target === b) || (x.attacker === b && x.target === a)) return true;
    return false;
  }

  updateTip() {
    this.tipDirty = false;
    this.tipAt = performance.now();
    const tip = $('tip');
    if (!this.mouse.inside || this.mouse.drag || this.ctx || this.app.anyModal() || this.hoverIndex < 0) {
      tip.hidden = true;
      return;
    }
    let html = '';
    try {
      html = this.tipHTML();
    } catch (err) {
      html = '';
    }
    if (!html) {
      tip.hidden = true;
      return;
    }
    setHTML(tip, html);
    tip.hidden = false;
    this.placeTip();
  }

  placeTip() {
    const tip = $('tip'), m = this.mouse;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = m.cx + 18, y = m.cy + 20;
    if (x + w > window.innerWidth - 6) x = m.cx - w - 14;
    if (y + h > window.innerHeight - 6) y = m.cy - h - 14;
    tip.style.left = Math.max(6, x) + 'px';
    tip.style.top = Math.max(6, y) + 'px';
  }

  tipHTML() {
    const g = this.game, s = g.s, me = this.pid, r = this.r;
    const i = this.hoverIndex;
    const [x, y] = this.tileXY(i);
    const t = g.map.terrain[i];
    const land = t >= 2;
    const o = land ? g.tileOwner(i) : -1;
    const p = o >= 0 ? s.players[o] : null;
    const rows = [];
    let head, act = '';
    const [sx, sy] = r.canvasPoint(this.mouse.cx, this.mouse.cy);
    const unit = !r.mode && s.phase === 'play' ? this.pickUnit(sx, sy, false) : null;
    if (unit) {
      const up = s.players[unit.owner];
      head = `<div class="tip-head"><span class="dot" style="background:${safeColor(up && up.color)}"></span>${UNIT_NAMES[unit.type] || unit.type}</div>`;
      rows.push(['Владелец', unit.owner === me ? 'Вы' : esc(up ? up.name : '?')]);
      if (unit.maxHp > 1) rows.push(['Прочность', `${fmtInt(unit.hp)} / ${fmtInt(unit.maxHp)}`]);
      if (unit.type === 'transport') rows.push(['Десант', fmtNum(unit.troops)]);
      if (unit.type === 'trade') rows.push(['Груз', fmtInt(unit.cargo)]);
      if (unit.owner === me && unit.type === 'warship') {
        const picked = this.shipSel().some((u) => u.id === unit.id);
        act = this.tipAct('ok', 'target', picked ? 'Выбран · Ctrl+клик — убрать из выбора' : 'ЛКМ — выбрать · Ctrl+клик — добавить к выбору');
      }
      return head + this.tipRows(rows) + act;
    }
    if (land) {
      head = `<div class="tip-head"><span class="dot" style="background:${p ? safeColor(p.color) : 'var(--muted)'}"></span>${p ? esc(p.name) + (o === me ? ' (вы)' : '') : 'Ничья земля'}</div>`;
      rows.push(['Местность', TERRAIN[t].name]);
      if (p && o !== me) {
        rows.push(['Войска', fmtNum(p.troops)]);
        rows.push(['Отношения', esc(this.relText(o))]);
      }
      if (s.fallout[i]) rows.push(['Радиация', fmtSec(s.fallout[i] / TICKS_PER_SEC)]);
      const b = g.buildingAt(i) || this.pickBuilding(sx, sy);
      if (b) rows.push(['Здание', `${BUILDINGS[b.type].name} ${ROMAN[b.level] || b.level}`]);
    } else {
      const lake = g.map.waterBody[i] >= 0 && !g.map.oceanBodies.has(g.map.waterBody[i]);
      head = `<div class="tip-head">${lake ? 'Озеро' : TERRAIN[t].name}</div>`;
    }
    act = this.tipAction(i, x, y, land, o, sx, sy);
    if (!land && !act) return '';
    return head + this.tipRows(rows) + act;
  }

  tipRows(rows) {
    return rows.map(([k, v]) => `<div class="tip-row"><span>${k}</span><b>${v}</b></div>`).join('');
  }

  tipAct(cls, ic, text) {
    return `<div class="tip-act ${cls}">${icon(ic)}<span>${esc(text)}</span></div>`;
  }

  tipAction(i, x, y, land, o, sx, sy) {
    const g = this.game, s = g.s, me = this.pid, m = this.r.mode;
    const val = (cmd) => g.validate(me, cmd);
    const troops = fmtNum(Math.floor(this.me.troops * this.ratio));
    if (s.phase === 'spawn') {
      const v = val({ c: 'spawn', x, y });
      return v.ok ? this.tipAct('ok', 'pin', 'ЛКМ — начать здесь') : this.tipAct('bad', 'alert', v.error);
    }
    if (s.phase !== 'play') return '';
    if (m) {
      if (m.kind === 'build') {
        const v = val({ c: 'build', type: m.type, x, y });
        const ex = g.buildingAt(i);
        const up = ex && ex.owner === me && ex.type === m.type;
        const cost = up ? upgradeCost(g, ex) : buildCost(g, me, m.type);
        return v.ok ? this.tipAct('build', m.type, `ЛКМ — ${up ? 'улучшить' : 'построить'} · ${fmtInt(cost)}`) : this.tipAct('bad', 'alert', v.error);
      }
      if (m.kind === 'strike') {
        const v = m.from ? val({ c: 'strike', kind: m.strike, from: m.from, x, y }) : { ok: false, error: SRC_NEED[STRIKES[m.strike].src] };
        return v.ok ? this.tipAct('strike', m.strike, `ЛКМ — ${STRIKE_SHORT[m.strike]} · ${fmtInt(strikeCost(g, me, m.strike))}`) : this.tipAct('bad', 'alert', v.error);
      }
      if (m.kind === 'boat') {
        const v = this.boatValid(x, y);
        return v.ok ? this.tipAct('boat', 'boat', `ЛКМ — высадка · ${troops} войск`) : this.tipAct('bad', 'alert', v.error);
      }
      if (m.kind === 'rail') {
        const b = g.buildingAt(i);
        if (!m.from) return b && b.owner === me && RAIL_TYPES[b.type] ? this.tipAct('ok', 'rail', 'ЛКМ — начать дорогу отсюда') : this.tipAct('bad', 'rail', 'Выберите фабрику, порт или дом');
        if (!b || b.id === m.from) return this.tipAct('bad', 'rail', 'Выберите второе здание');
        const v = val({ c: 'rail', a: m.from, b: b.id });
        if (!v.ok) return this.tipAct('bad', 'alert', v.error);
        const A = g.buildingById(m.from);
        const len = Math.hypot(A.x - b.x, A.y - b.y);
        return this.tipAct('build', 'rail', `ЛКМ — проложить · ${fmtInt(Math.round(ECON.railCostPerTile * len))}`);
      }
      return '';
    }
    if (!land) {
      const n = this.shipSel().length;
      if (n > 1) return this.tipAct('ok', 'ship', `ПКМ — курс строем · ${n} ${plural(n, SHIP_FORMS)}`);
      if (n === 1) return this.tipAct('ok', 'ship', 'ПКМ — плыть сюда');
      return '';
    }
    if (o === me) {
      const b = this.pickBuilding(sx, sy, 'own');
      return b ? this.tipAct('ok', b.type, 'ЛКМ — выбрать здание') : '';
    }
    const va = val({ c: 'attack', x, y, ratio: this.ratio });
    if (va.ok) return this.tipAct('attack', 'sword', o < 0 ? `ЛКМ — захват ничьей земли · ${troops} войск` : `ЛКМ — атака · ${troops} войск`);
    if (!g.bordersByLand(me, i)) {
      const vb = this.boatValid(x, y);
      return vb.ok ? this.tipAct('boat', 'boat', `ЛКМ — высадка · ${troops} войск`) : this.tipAct('bad', 'alert', vb.error);
    }
    return this.tipAct('bad', 'alert', va.error);
  }

  boatValid(x, y) {
    const key = `${x},${y},${Math.floor(this.s.tick / 5)},${this.ratio}`;
    if (this.boatCache.key === key) return this.boatCache.v;
    const v = this.game.validate(this.pid, { c: 'boat', x, y, ratio: this.ratio });
    this.boatCache = { key, v };
    return v;
  }

  updatePanel() {
    const sel = this.r.selection, panel = $('panel');
    if (!sel) {
      show(panel, false);
      return;
    }
    const g = this.game;
    let d;
    if (sel.kind === 'ship') {
      const ships = this.shipSel();
      if (!ships.length) {
        this.r.selection = null;
        show(panel, false);
        this.hintKey = '';
        return;
      }
      if (ships.length !== (sel.ids || [sel.id]).length) {
        sel.ids = ships.map((u) => u.id);
        sel.id = sel.ids[0];
        this.hintKey = '';
      }
      d = ships.length > 1 ? this.fleetPanel(ships) : this.unitPanel(ships[0]);
    } else {
      const obj = sel.kind === 'building' ? g.buildingById(sel.id) : g.unitById(sel.id);
      if (!obj) {
        this.r.selection = null;
        show(panel, false);
        this.hintKey = '';
        return;
      }
      d = sel.kind === 'building' ? this.buildingPanel(obj) : this.unitPanel(obj);
    }
    setHTML($('panel-icon'), icon(d.icon));
    setText($('panel-title'), d.title);
    setHTML($('panel-sub'), d.sub);
    setHTML($('panel-body'), d.body);
    show(panel, true);
  }

  buildingPanel(b) {
    const g = this.game, s = g.s, me = this.pid, def = BUILDINGS[b.type], owner = s.players[b.owner];
    const mine = b.owner === me;
    const lvl = b.level;
    let body = '';
    if (b.build > 0) {
      const tot = b.total || 1;
      body += pbar(b.up ? `Улучшение до ур. ${lvl + 1}` : 'Строительство', fmtSec(b.build / TICKS_PER_SEC), (1 - b.build / tot) * 100, 'blue');
    }
    const rows = [['Владелец', mine ? 'Вы' : esc(owner ? owner.name : '?')], ['Уровень', `${lvl} из ${def.max}`]];
    switch (b.type) {
      case 'house':
        rows.push(['Максимум войск', '+' + fmtInt(ECON.houseTroops * lvl)]);
        rows.push(['Доход', `+${fmtInt(ECON.houseIncome * lvl)}/с`]);
        break;
      case 'factory': {
        const f = factoryOutlook(g, b);
        if (f.type === 'direct') {
          rows.push(['Доставка', 'нет доступного порта']);
          rows.push(['Доход', `+${fmtInt(f.perSec)}/с напрямую`]);
        } else {
          rows.push(['Доставка', f.type === 'train' ? 'поездом по ж/д' : 'грузовиком']);
          rows.push(['Груз за рейс', fmtInt(f.cargo) + ' золота']);
          rows.push(['Рейс', `${Math.round(f.len)} кл. · раз в ${Math.round(f.cycle / TICKS_PER_SEC)} с`]);
          rows.push(['Поток в порт', `+${fmtInt(f.perMin)}/мин`]);
          if (f.railPerMin > 0.5) rows.push(['С ж/д', `+${fmtInt(f.perMin + f.railPerMin)}/мин`]);
        }
        break;
      }
      case 'port':
        rows.push(['Склад товаров', `${b.stock || 0} / ${TRADE.maxStock}`]);
        rows.push(['Торговое судно', `каждые ${Math.round(TRADE.interval(lvl) / TICKS_PER_SEC)} с`]);
        rows.push(['Военные корабли', `${portShips(g, b)} / ${portShipCap(b)}`]);
        break;
      case 'fort':
        rows.push(['Радиус', `${ECON.fortRadius} кл.`]);
        rows.push(['Оборона', '×' + (ECON.fortBonus * (1 + ECON.fortLevelBonus * (lvl - 1))).toFixed(2).replace('.', ',')]);
        break;
      case 'sam': {
        const aa = owner ? owner.research.aa : 0;
        rows.push(['Радиус', `${SAM.radius(lvl)} кл.`]);
        rows.push(['Перезарядка', `${(SAM.reload(lvl) / TICKS_PER_SEC).toFixed(1).replace('.', ',')} с`]);
        rows.push(['Перехват ракеты', fmtPct(interceptChance('cruise', aa) * 100, 0)]);
        rows.push(['Содержание', `${(BUILDINGS.sam.upkeep * lvl).toFixed(1).replace('.', ',')}/с`]);
        break;
      }
      case 'airbase':
      case 'silo': {
        const tot = b.type === 'silo' ? siloReload(lvl) : airbaseReload(lvl);
        rows.push(['Перезарядка', `${Math.round(tot / TICKS_PER_SEC)} с`]);
        rows.push(['Содержание', `${fmtInt(def.upkeep)}/с`]);
        if (b.build === 0 && b.cd > 0) body = pbar('Перезарядка', fmtSec(b.cd / TICKS_PER_SEC), (1 - b.cd / tot) * 100, 'warn') + body;
        break;
      }
      default:
        break;
    }
    body += kv(rows);
    if (mine && this.s.phase === 'play') {
      const acts = [];
      if (lvl < def.max) {
        const err = b.build > 0 ? (b.up ? 'Здание уже улучшается' : 'Здание ещё строится') : null;
        acts.push(btn('upgrade', 'Улучшить', { icon: 'upgrade', cost: fmtInt(upgradeCost(g, b)), disabled: !!err, title: err || `Улучшить до ур. ${lvl + 1}` }));
      } else acts.push(btn('noop', 'Макс. уровень', { icon: 'check', disabled: true }));
      acts.push(btn('demolish', 'Снести', { icon: 'trash', cls: 'danger', cost: '+' + fmtInt(demolishRefund(b)), title: 'Снести здание и вернуть 25% затрат' }));
      if (b.type === 'port') {
        const err = buildShipError(g, me, b.id);
        acts.push(btn('ship', 'Военный корабль', { icon: 'ship', full: true, cost: fmtInt(shipCost(g, me)), disabled: !!err && !/золота$/.test(err), title: err || 'Спустить на воду военный корабль' }));
      }
      if (RAIL_TYPES[b.type]) acts.push(btn('rail', 'Проложить ж/д отсюда', { icon: 'rail', full: true, disabled: !g.buildingActive(b), title: 'Соединить с другим зданием железной дорогой' }));
      if (b.type === 'factory') {
        const f = factoryOutlook(g, b);
        if (f.type === 'truck' && f.railPerMin > 0.5 && f.port) {
          const v = g.validate(me, { c: 'rail', a: b.id, b: f.port.id });
          if (v.ok || /золота$/.test(v.error || '')) {
            acts.push(btn('rail-port', 'Ж/д до порта', {
              icon: 'rail', full: true, data: { port: f.port.id }, cost: fmtInt(Math.round(ECON.railCostPerTile * Math.hypot(f.port.x - b.x, f.port.y - b.y))),
              title: `Проложить железную дорогу до порта: поток товаров вырастет до +${fmtInt(f.perMin + f.railPerMin)}/мин`,
            }));
          }
        }
      }
      body += `<div class="sec-title">Действия</div><div class="panel-actions">${acts.join('')}</div>`;
      if (PANEL_STRIKES[b.type]) {
        const strikes = [];
        for (const kind of PANEL_STRIKES[b.type]) {
          const sd = STRIKES[kind];
          const resOk = this.me.research[sd.req[0]] >= sd.req[1];
          const spent = !!sd.perGame && megasUsed(this.me) >= sd.perGame;
          strikes.push(btn('strike', sd.name.replace(/ «.*»$/, ''), {
            icon: kind, cost: fmtInt(strikeCost(g, me, kind)), data: { kind }, full: true, disabled: !resOk || !g.buildingActive(b) || spent,
            title: spent ? 'Мегабомба уже применена: она одна на партию' : resOk ? `${sd.name}: ${sd.desc || ''}` : `Нужно исследование «${RESEARCH[sd.req[0]].name}» ${sd.req[1]} ур.`,
            cls: kind === 'mega' ? 'danger' : '',
          }));
        }
        body += `<div class="sec-title">Удары</div><div class="panel-actions">${strikes.join('')}</div>`;
      }
      if (b.type === 'port') body += '<p class="note">Порт сам отправляет торговые суда в порты других стран.</p>';
      if (b.type === 'factory') body += '<p class="note">Новый груз фабрика отправляет, когда предыдущий доставлен. Поезд по ж/д идёт вдвое быстрее грузовика и удваивает поток товаров.</p>';
    } else if (!mine) {
      body += '<p class="note">Чужое здание: ПКМ по нему — удар камикадзе или крылатой ракетой.</p>';
    }
    return {
      icon: b.type,
      title: def.name,
      sub: `${pips(lvl, def.max)} <span>Ур. ${lvl}</span>`,
      body,
    };
  }

  unitPanel(u) {
    const g = this.game, s = g.s, me = this.pid, owner = s.players[u.owner];
    const mine = u.owner === me;
    let body = '';
    if (u.maxHp > 1) {
      const k = u.hp / u.maxHp;
      body += pbar('Прочность', `${fmtInt(u.hp)} / ${fmtInt(u.maxHp)}`, k * 100, k < 0.35 ? 'danger' : 'hp');
    }
    const rows = [['Владелец', mine ? 'Вы' : esc(owner ? owner.name : '?')]];
    if (u.type === 'warship') {
      rows.push(['Урон за залп', fmtInt(warshipDamage(owner ? owner.research.naval : 0))]);
      rows.push(['Дальность', `${SHIPS.warship.range} кл.`]);
      rows.push(['Состояние', u.order ? 'Идёт по курсу' : u.chase >= 0 ? 'Преследует цель' : 'Ожидает приказа']);
    } else if (u.type === 'transport') {
      rows.push(['Десант', fmtInt(u.troops)]);
      const tp = s.players[u.tp];
      rows.push(['Цель', tp ? esc(tp.name) : 'Ничья земля']);
    } else if (u.type === 'trade') {
      rows.push(['Груз', fmtInt(u.cargo) + ' золота']);
      const to = s.players[u.toOwner];
      rows.push(['Направление', to ? esc(to.name) : '?']);
    }
    body += kv(rows);
    if (mine && u.type === 'warship') {
      const total = this.ownWarships().length;
      if (total > 1) body += `<div class="panel-actions">${btn('fleet-all', `Весь флот · ${total}`, { icon: 'ship', full: true, title: 'Выбрать все свои военные корабли (F)' })}</div>`;
      body += '<p class="note">ПКМ по воде — задать курс. Корабль сам атакует враждебные суда поблизости. Ctrl+клик по другим кораблям, Shift+рамка или F — выбрать несколько.</p>';
    }
    return {
      icon: UNIT_ICONS[u.type] || 'ship',
      title: UNIT_NAMES[u.type] || u.type,
      sub: `<span>${mine ? 'Ваш флот' : esc(owner ? owner.name : '')}</span>`,
      body,
    };
  }

  fleetPanel(ships) {
    const me = this.me, n = ships.length;
    let hp = 0, max = 0, moving = 0, chasing = 0;
    for (const u of ships) {
      hp += u.hp;
      max += u.maxHp;
      if (u.order) moving++;
      else if (u.chase >= 0) chasing++;
    }
    const k = max > 0 ? hp / max : 0;
    let body = pbar('Прочность флота', `${fmtInt(hp)} / ${fmtInt(max)}`, k * 100, k < 0.35 ? 'danger' : 'hp');
    body += kv([
      ['Выбрано', `${n} из ${this.ownWarships().length}`],
      ['Урон за залп', fmtInt(warshipDamage(me ? me.research.naval : 0) * n)],
      ['Идут по курсу', moving],
      ['Преследуют цель', chasing],
      ['Ожидают приказа', n - moving - chasing],
    ]);
    body += `<div class="panel-actions">${btn('fleet-all', 'Весь флот', { icon: 'ship', title: 'Выбрать все свои военные корабли (F)' })}${btn('fleet-show', 'Показать', { icon: 'target', title: 'Показать выбранные корабли на карте' })}</div>`;
    body += '<p class="note">ПКМ по воде — курс строем для всех выбранных. Ctrl+клик по кораблю — добавить или убрать, Shift+перетаскивание — рамка, двойной клик по кораблю — все корабли на экране, F — весь флот.</p>';
    return {
      icon: 'ship',
      title: 'Флот',
      sub: `<span>${n} ${plural(n, SHIP_FORMS)} выбрано</span>`,
      body,
    };
  }

  onPanelAction(e) {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const g = this.game, sel = this.r.selection;
    if (b.dataset.act === 'fleet-all') {
      this.selectFleet();
      return;
    }
    if (b.dataset.act === 'fleet-show') {
      this.focusShips(this.shipSel());
      return;
    }
    const bd = sel && sel.kind === 'building' ? g.buildingById(sel.id) : null;
    if (!bd) return;
    switch (b.dataset.act) {
      case 'rail-port':
        if (this.send({ c: 'rail', a: bd.id, b: Number(b.dataset.port) })) play('build');
        break;
      case 'upgrade':
        if (this.send({ c: 'upgrade', id: bd.id })) play('build');
        break;
      case 'demolish':
        this.app.confirm('Снести здание?', `${BUILDINGS[bd.type].name} (ур. ${bd.level}) будет снесено. Вернётся ${fmtInt(demolishRefund(bd))} золота.`, 'Снести', () => {
          if (this.send({ c: 'demolish', id: bd.id })) {
            play('smallboom');
            this.clearSelection();
          }
        });
        break;
      case 'ship':
        this.send({ c: 'buildShip', port: bd.id });
        break;
      case 'rail':
        this.setMode({ kind: 'rail', from: bd.id });
        break;
      case 'strike': {
        const kind = b.dataset.kind;
        if (!STRIKES[kind]) return;
        this.setMode({ kind: 'strike', strike: kind, from: bd.id, fixed: true });
        break;
      }
      default:
        return;
    }
    this.timers.panel = 0.05;
  }

  onKeyDown(e) {
    const code = e.code, rep = e.repeat;
    if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') e.preventDefault();
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const pan = { KeyW: 'u', ArrowUp: 'u', KeyS: 'd', ArrowDown: 'd', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' }[code];
    if (pan) {
      this.keyPan[pan] = 1;
      e.preventDefault();
      return true;
    }
    if (code === 'KeyQ') { this.stepRatio(e.shiftKey ? -1 : -RATIO_STEP); return true; }
    if (code === 'KeyE') { this.stepRatio(e.shiftKey ? 1 : RATIO_STEP); return true; }
    if (rep) return code === 'Tab' || code === 'Space';
    const dm = /^(?:Digit|Numpad)([1-8])$/.exec(code);
    if (dm) {
      const n = Number(dm[1]);
      this.onBuildTool(n <= 7 ? BUILDING_KEYS[n - 1] : 'rail');
      return true;
    }
    switch (code) {
      case 'Escape': this.onEscape(); return true;
      case 'Tab': e.preventDefault(); this.openCountries(); return true;
      case 'KeyR': this.openResearch(); return true;
      case 'KeyV': this.toggleAA(); return true;
      case 'KeyT': this.app.toggleTheme(); return true;
      case 'KeyB': this.toggleBoat(); return true;
      case 'KeyF': this.selectFleet(); return true;
      case 'Space': e.preventDefault(); this.togglePause(); return true;
      case 'Minus':
      case 'NumpadSubtract': this.stepSpeed(-1); return true;
      case 'Equal':
      case 'NumpadAdd': this.stepSpeed(1); return true;
      case 'Home': e.preventDefault(); this.focusHome(); return true;
      case 'Enter':
      case 'NumpadEnter':
        e.preventDefault();
        if (this.session.mode !== 'offline') $('chat-input').focus();
        return true;
      default:
        return false;
    }
  }

  onKeyUp(e) {
    const pan = { KeyW: 'u', ArrowUp: 'u', KeyS: 'd', ArrowDown: 'd', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' }[e.code];
    if (pan) this.keyPan[pan] = 0;
  }

  releaseKeys() {
    this.keyPan = { l: 0, r: 0, u: 0, d: 0 };
    this.r.keys.x = 0;
    this.r.keys.y = 0;
    this.mouse.down = -1;
    this.mouse.drag = false;
    this.mouse.box = false;
    this.r.box = null;
  }

  onEscape() {
    if (this.ctx) this.closeCtx();
    else if (this.r.mode) this.setMode(null);
    else if (this.r.selection) this.clearSelection();
    else this.app.openPause();
  }

  updateModals() {
    if (!$('modal-research').hidden) this.renderResearch();
    if (!$('modal-countries').hidden) this.renderCountries(false);
  }

  openResearch() {
    if (!$('modal-research').hidden) {
      this.app.closeModal('research');
      return;
    }
    this.renderResearch();
    this.app.openModal('research');
    this.closeCtx();
  }

  startResearch(key) {
    if (this.send({ c: 'research', key })) {
      play('select');
      this.pendingResearch = key;
      setTimeout(() => this.renderResearch(), 250);
    }
  }

  renderResearch() {
    const me = this.me, list = $('research-list');
    if (!me) return;
    if (list.children.length !== RESEARCH_KEYS.length) {
      list.innerHTML = '';
      for (const key of RESEARCH_KEYS) {
        const card = tpl('tpl-research-card');
        card.dataset.key = key;
        card.querySelector('.rcard-ic use').setAttribute('href', '#i-' + RESEARCH_ICONS[key]);
        card.querySelector('h4').textContent = RESEARCH[key].name;
        card.querySelector('.rcard-desc').textContent = RESEARCH[key].desc;
        card.querySelector('.rcard-btn').dataset.research = key;
        list.appendChild(card);
      }
    }
    const rs = me.researching;
    for (const card of list.children) {
      const key = card.dataset.key, def = RESEARCH[key];
      const lvl = me.research[key];
      const maxed = lvl >= def.max;
      const active = !!rs && rs.key === key;
      const locked = !!def.req && me.research[def.req[0]] < def.req[1];
      const cost = maxed ? 0 : researchCost(key, lvl);
      const poor = !maxed && !active && me.gold < cost;
      toggle(card, 'active', active);
      toggle(card, 'maxed', maxed);
      toggle(card, 'locked', locked && !maxed);
      toggle(card, 'poor', poor && !locked);
      setHTML(card.querySelector('.pips'), Array.from({ length: def.max }, (_, k) => `<i${k < lvl ? ' class="on"' : ''}></i>`).join(''));
      setText(card.querySelector('.rc-cost b'), maxed ? '' : fmtInt(cost));
      setText(card.querySelector('.rc-dur b'), maxed ? '' : fmtSec(researchTicks(lvl) / TICKS_PER_SEC));
      setText(card.querySelector('.rcard-req'), locked && !maxed ? `Требуется: ${RESEARCH[def.req[0]].name} ${ROMAN[def.req[1]]}` : '');
      card.querySelector('.rcard-bar > span').style.width = active ? clamp((rs.progress / rs.total) * 100, 0, 100).toFixed(1) + '%' : '0%';
      const b = card.querySelector('.rcard-btn');
      const label = active ? 'Изучается…' : maxed ? 'Изучено полностью' : `Исследовать ${ROMAN[lvl + 1] || lvl + 1}`;
      setText(b, label);
      const dis = active || maxed || locked || !!rs || this.s.phase === 'over' || !me.alive;
      if (b.disabled !== dis) b.disabled = dis;
      b.title = rs && !active ? 'Сначала дождитесь окончания текущего исследования' : '';
      toggle(b, 'primary', !dis && !poor);
    }
    const cur = $('research-current');
    toggle(cur, 'active', !!rs);
    if (rs) {
      const lvl = me.research[rs.key] + 1;
      setText($('research-cur-name'), `${RESEARCH[rs.key].name} ${ROMAN[lvl] || lvl}`);
      setText($('research-cur-time'), 'осталось ' + fmtSec((rs.total - rs.progress) / TICKS_PER_SEC));
      $('research-cur-bar').style.width = clamp((rs.progress / rs.total) * 100, 0, 100).toFixed(1) + '%';
    } else {
      setText($('research-cur-name'), 'Ничего — выберите технологию');
      setText($('research-cur-time'), '');
      $('research-cur-bar').style.width = '0%';
    }
  }

  openCountries(focus = -1) {
    const modal = $('modal-countries');
    if (!modal.hidden && focus < 0) {
      this.app.closeModal('countries');
      return;
    }
    this.focusPid = focus;
    this.renderCountries(true);
    this.app.openModal('countries');
    this.closeCtx();
    if (focus >= 0) {
      const tr = this.rows.get(focus);
      if (tr) requestAnimationFrame(() => tr.scrollIntoView({ block: 'center' }));
    }
  }

  onCountriesClick(e) {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const key = th.dataset.sort;
      if (this.sort.key === key) this.sort.dir = -this.sort.dir;
      else this.sort = { key, dir: key === 'name' ? 1 : -1 };
      play('click');
      this.renderCountries(false);
      return;
    }
    const d = e.target.closest('button.dip');
    if (d) {
      if (d.disabled) return;
      const q = Number(d.dataset.pid), act = d.dataset.dip;
      const g = this.game;
      if (act === 'break') this.breakWith(q);
      else if (act === 'embargo') {
        if (this.send({ c: 'embargo', with: q, on: !embargoBy(g, this.pid, q) })) play('click');
      } else this.propose(q, act);
      this.renderCountries(false);
      setTimeout(() => { if (!$('modal-countries').hidden) this.renderCountries(false); }, 150);
      return;
    }
    const tr = e.target.closest('tr[data-pid]');
    if (tr && !e.target.closest('.dip-actions')) {
      this.app.closeModal('countries');
      this.focusPlayer(Number(tr.dataset.pid));
    }
  }

  renderCountries(rebuild) {
    const g = this.game, s = g.s, me = this.pid;
    const stats = g.countryStats();
    const body = $('countries-body');
    if (rebuild || this.rows.size !== stats.length || !body.children.length) {
      body.innerHTML = '';
      this.rows.clear();
      for (const st of stats) {
        const tr = tpl('tpl-country-row');
        tr.dataset.pid = st.id;
        for (const b of tr.querySelectorAll('.dip')) b.dataset.pid = st.id;
        this.rows.set(st.id, tr);
        body.appendChild(tr);
      }
    }
    for (const st of stats) this.fillCountryRow(this.rows.get(st.id), st, g, s, me);
    const key = this.sort.key, dir = this.sort.dir;
    const val = (st) => {
      switch (key) {
        case 'name': return st.name.toLowerCase();
        case 'terr': return st.tiles;
        case 'income': return st.income - st.upkeep;
        case 'ships': return st.warship;
        default: return st[key] || 0;
      }
    };
    const order = stats.slice().sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      const va = val(a), vb = val(b);
      const c = typeof va === 'string' ? va.localeCompare(vb, 'ru') : va - vb;
      return c * dir || a.id - b.id;
    });
    const rows = order.map((st) => this.rows.get(st.id));
    if (rows.some((tr, k) => body.children[k] !== tr)) for (const tr of rows) body.appendChild(tr);
    for (const th of $('countries-table').querySelectorAll('th[data-sort]')) {
      const on = th.dataset.sort === key;
      toggle(th, 'sorted', on);
      toggle(th, 'asc', on && dir > 0);
      toggle(th, 'desc', on && dir < 0);
    }
    const alive = stats.filter((x) => x.alive).length, dead = stats.length - alive;
    setText($('countries-sub'), `${alive} ${plural(alive, ['страна', 'страны', 'стран'])} в игре` + (dead ? ` · ${dead} ${plural(dead, ['выбыла', 'выбыли', 'выбыли'])}` : ''));
  }

  fillCountryRow(tr, st, g, s, me) {
    const self = st.id === me;
    toggle(tr, 'me', self);
    toggle(tr, 'dead', !st.alive);
    toggle(tr, 'focus', st.id === this.focusPid);
    tr.querySelector('.cname .dot').style.background = safeColor(st.color);
    setText(tr.querySelector('.cname b'), st.name);
    const tag = tr.querySelector('.cname .tag');
    let tt = '', tc = '';
    if (self) { tt = 'Вы'; tc = 'you'; } else if (!st.alive) { tt = 'Выбыл'; tc = 'dead'; } else if (st.traitor) { tt = 'Предатель'; tc = 'traitor'; } else if (st.ai) { tt = 'Бот'; tc = 'bot'; }
    setText(tag, tt);
    tag.className = 'tag' + (tc ? ' ' + tc : '');
    setText(tr.querySelector('.c-terr'), fmtShare(st.pct));
    setText(tr.querySelector('.c-troops'), fmtNum(st.troops));
    setText(tr.querySelector('.c-gold'), fmtNum(st.gold));
    const net = st.income - st.upkeep;
    const inc = tr.querySelector('.c-income');
    setText(inc, (net >= 0 ? '+' : '−') + fmtNum(Math.abs(net)));
    toggle(inc, 'pos', net > 0);
    toggle(inc, 'neg', net < 0);
    for (const [cls, v] of [['c-factory', st.factory], ['c-house', st.house], ['c-port', st.port], ['c-sam', st.sam], ['c-silo', st.silo], ['c-ships', st.warship]]) {
      const td = tr.querySelector('.' + cls);
      setText(td, v);
      toggle(td, 'zero', !v);
    }
    setHTML(tr.querySelector('.c-rel'), this.relHTML(st, g, s, me));
    const acts = tr.querySelector('.dip-actions');
    const showActs = !self && st.alive && this.me && this.me.alive;
    show(acts, showActs);
    if (!showActs) return;
    const rel = g.relation(me, st.id);
    for (const b of acts.querySelectorAll('.dip')) {
      const t = b.dataset.dip;
      if (t === 'alliance' || t === 'pact' || t === 'trade') {
        const hide = rel.type === 'alliance' || (t === 'pact' && rel.type === 'pact') || (t === 'trade' && !!rel.trade);
        show(b, !hide);
        if (hide) continue;
        const pending = this.proposalPending(st.id, t);
        const err = proposeError(g, me, st.id, t);
        toggle(b, 'pending', pending);
        b.disabled = pending || !!err;
        b.title = pending ? 'Предложение отправлено, ждём ответа' : err || PROPOSE_TITLE[t];
      } else if (t === 'break') {
        show(b, rel.type !== 'none' || !!rel.trade);
        b.title = breakLabel(rel);
      } else if (t === 'embargo') {
        const on = embargoBy(g, me, st.id);
        toggle(b, 'on', on);
        b.title = on ? 'Снять эмбарго' : 'Эмбарго: запретить торговлю';
      }
    }
  }

  relHTML(st, g, s, me) {
    if (st.id === me) return '<span class="rel self">Это вы</span>';
    if (!st.alive) return '<span class="rel dead">Выбыл</span>';
    const rel = g.relation(me, st.id);
    const out = [];
    if (rel.type === 'alliance') out.push('<span class="rel alliance">Союз</span>');
    else {
      if (rel.type === 'pact') out.push(`<span class="rel pact">Пакт · ${fmtSec((rel.until - s.tick) / TICKS_PER_SEC)}</span>`);
      if (rel.trade) out.push('<span class="rel trade">Торговля</span>');
      if (!out.length) out.push(this.atWar(me, st.id) ? '<span class="rel war">Война</span>' : '<span class="rel none">Нет договора</span>');
    }
    if (rel.embargo) out.push(`<span class="rel embargo">${embargoBy(g, me, st.id) ? 'Ваше эмбарго' : 'Эмбарго'}</span>`);
    if (st.traitor) out.push('<span class="rel traitor">Предатель</span>');
    return out.join('');
  }

  checkEnd(dt) {
    const s = this.s, me = this.me;
    if (s.phase === 'over') {
      if (this.endShown) return;
      this.endWait += dt;
      if (this.endWait < 1.2) return;
      this.endShown = true;
      this.setMode(null);
      this.showEnd(false);
      return;
    }
    if (me && !me.alive && !this.deadShown && s.phase === 'play') {
      this.deadShown = true;
      this.setMode(null);
      this.clearSelection();
      $('hud-bottom').hidden = true;
      this.updateDockHeight();
      this.showEnd(true);
    }
  }

  showEnd(dead) {
    const g = this.game, s = g.s, me = this.pid, P = s.players;
    const win = s.winner;
    const mine = P[me];
    const ally = win >= 0 && win !== me && mine && mine.alive && g.isAllied(me, win);
    const won = !dead && (win === me || ally);
    toggle($('end-hero'), 'lose', !won);
    $('end-icon').innerHTML = icon(won ? 'trophy' : dead ? 'flag' : win < 0 ? 'globe' : 'flag');
    $('end-title').textContent = dead ? 'Вы выбыли' : win < 0 ? 'Игра окончена' : won ? (ally ? 'Победа коалиции!' : 'Победа!') : 'Поражение';
    let reason = '';
    if (dead) reason = mine && mine.stats && s.tick && this.surrendered ? 'Вы сдались' : 'Ваша страна потеряла всю территорию';
    else reason = WIN_REASONS[s.winReason] || '';
    $('end-reason').textContent = reason;
    const wp = win >= 0 ? P[win] : null;
    $('end-winner').innerHTML = wp && !dead ? `<span class="dot" style="background:${safeColor(wp.color)}"></span>${esc(wp.name)}${win === me ? ' (вы)' : ''}` : '';
    const time = fmtClock(s.tick / TICKS_PER_SEC);
    $('end-text').textContent = dead
      ? `Партия продолжается без вас (время ${time}). Можно наблюдать за картой или выйти в главное меню.`
      : won ? `Партия длилась ${time}. Отличная работа, командир!` : `Партия длилась ${time}.`;
    $('end-stats').innerHTML = this.statsTable();
    $('end-continue').lastChild.textContent = dead ? 'Наблюдать' : 'Смотреть карту';
    this.app.closeModals();
    this.app.openModal('end');
    if (dead && !won) play('defeat');
  }

  statsTable() {
    const g = this.game, s = g.s, me = this.pid, land = g.map.landCount || 1;
    const order = s.players.slice().sort((a, b) => {
      if (a.id === s.winner) return -1;
      if (b.id === s.winner) return 1;
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (!a.alive) return (b.eliminatedAt || 0) - (a.eliminatedAt || 0);
      return b.tiles - a.tiles;
    });
    const cols = [
      ['Земля', 'Доля суши сейчас'], ['Пик', 'Наибольшая доля суши за партию'], ['Клетки', 'Захвачено клеток'],
      ['Убито', 'Уничтожено вражеских войск'], ['Суда', 'Потоплено судов'], ['Ядерн.', 'Ядерные удары'], ['Золото', 'Заработано золота'],
    ];
    const head = `<thead><tr><th>Страна</th>${cols.map(([t, h]) => `<th class="num" title="${h}">${t}</th>`).join('')}</tr></thead>`;
    const rows = order.map((p) => {
      const st = p.stats || {};
      const cls = [p.id === me ? 'me' : '', p.alive ? '' : 'dead'].filter(Boolean).join(' ');
      return `<tr${cls ? ` class="${cls}"` : ''}><td class="cname"><span class="dot" style="background:${safeColor(p.color)}"></span>${esc(p.name)}</td>`
        + `<td class="num">${fmtShare((p.tiles * 100) / land)}</td><td class="num">${fmtShare(((st.peakTiles || p.tiles) * 100) / land)}</td>`
        + `<td class="num">${fmtInt(st.tilesCaptured || 0)}</td><td class="num">${fmtNum(st.kills || 0)}</td><td class="num">${fmtInt(st.shipsSunk || 0)}</td>`
        + `<td class="num">${fmtInt(st.nukes || 0)}</td><td class="num">${fmtNum(st.goldEarned || 0)}</td></tr>`;
    }).join('');
    return head + '<tbody>' + rows + '</tbody>';
  }
}

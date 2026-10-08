// Игровой интерфейс: верхняя панель, панель провинции, исследования, журнал, ввод.
import { UNITS, UNIT_KEYS, BUILDINGS, BUILDING_KEYS, RESEARCH, RESEARCH_KEYS, researchCost, researchTime, TERRAIN, DRONES, MISSILE, droneRange, missileRange } from '../core/config.js';
import { troopCount, popCap } from '../core/game.js';
import { spriteURL } from './sprites.js';
import { fmtNum } from './render.js';
import { play } from './audio.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pips = (n, max) => '■'.repeat(n) + '□'.repeat(Math.max(0, max - n));
const fmtTime = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export class Hud {
  constructor(app, session, renderer) {
    this.app = app;
    this.session = session;
    this.r = renderer;
    this.frac = 0.5;
    this.panelT = 0;
    this.boardT = 0;
    this.lastPanel = '';
    this.endShown = false;
    this.deadShown = false;
    this.keys = new Set();
    this.listeners = [];
    this.mouse = { x: 0, y: 0, down: false, drag: false, sx: 0, sy: 0, cx: 0, cy: 0 };

    document.querySelectorAll('#screen-game img[data-sprite]').forEach((img) => { img.src = spriteURL(img.dataset.sprite, '#fff', 3); });
    $('chat-form').hidden = session.mode === 'offline';
    $('speed-ctrl').style.display = session.isAuthority ? '' : 'none';
    document.querySelectorAll('.offline-only').forEach((el) => { el.hidden = session.mode !== 'offline'; });
    $('log').innerHTML = '';
    $('panel').hidden = true;
    $('hint').hidden = true;
    $('r-color').style.background = this.me.color;

    session.on((ev) => this.onSession(ev));
    this.bindInput();
    this.updateSpeedButtons();
  }

  get s() { return this.session.s; }
  get me() { return this.s.players[this.session.localPid]; }
  get pid() { return this.session.localPid; }

  listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.listeners.push([target, type, fn, opts]);
  }
  destroy() {
    for (const [t, type, fn, opts] of this.listeners) t.removeEventListener(type, fn, opts);
    this.listeners = [];
    $('modal-research').hidden = true;
    $('modal-end').hidden = true;
  }

  // ---------- События сессии ----------
  onSession(ev) {
    if (ev.type === 'fx') {
      this.r.addFx(ev.fx);
      for (const e of ev.fx) this.onFx(e);
    } else if (ev.type === 'error') {
      this.toast(ev.error);
    } else if (ev.type === 'chat') {
      this.log(`${ev.chat.name}: ${ev.chat.text}`, 'chat');
      play('click');
    } else if (ev.type === 'disconnected') {
      this.app.showMessage('Игра прервана', ev.reason, () => this.app.exitGame());
    }
  }

  onFx(e) {
    const me = this.pid;
    switch (e.k) {
      case 'msg':
        if (e.to === me || e.to === -1) {
          this.log(e.text, e.kind);
          if (e.kind === 'danger') play('alert');
        }
        break;
      case 'capture':
        if (e.o === me) play('capture');
        else if (e.from === me) play('lost');
        else if (this.visible(e.p)) play('battle');
        break;
      case 'repelled':
      case 'battle':
        if (this.visible(e.p)) play('battle');
        break;
      case 'boom': play(e.big ? 'boom' : 'smallboom'); break;
      case 'intercept': play('intercept'); break;
      case 'launch': if (e.o === me) play(e.kind === 'missile' ? 'launch' : 'drone'); break;
      case 'research': if (e.o === me) { play('research'); if (!$('modal-research').hidden) this.renderResearch(); } break;
      case 'built': if (this.s.provs[e.p].o === me) play('build'); break;
      case 'eliminated': if (e.o === me) play('defeat'); break;
      case 'victory': play(e.o === me ? 'victory' : 'defeat'); break;
      default: break;
    }
  }

  visible(p) {
    const P = this.r.map.provinces[p];
    const x = this.r.sx(P.cx), y = this.r.sy(P.cy);
    return x > 0 && y > 0 && x < this.r.canvas.width && y < this.r.canvas.height;
  }

  log(text, kind = 'info') {
    const el = document.createElement('div');
    el.className = kind;
    el.textContent = text;
    const log = $('log');
    log.appendChild(el);
    while (log.children.length > 7) log.firstChild.remove();
    setTimeout(() => el.remove(), 12000);
  }
  toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 3000);
    play('error');
  }

  cmd(c) {
    const res = this.session.command(c);
    if (!res.ok) { this.toast(res.error); return false; }
    this.lastPanel = '';
    return true;
  }

  // ---------- Покадровое обновление ----------
  update(dt) {
    const s = this.s, me = this.me;
    // Прокрутка клавишами / у края экрана
    const pan = (600 / this.r.cam.z) * dt;
    if (this.keys.has('arrowleft') || this.keys.has('a')) this.r.cam.x -= pan;
    if (this.keys.has('arrowright') || this.keys.has('d')) this.r.cam.x += pan;
    if (this.keys.has('arrowup') || this.keys.has('w')) this.r.cam.y -= pan;
    if (this.keys.has('arrowdown') || this.keys.has('s')) this.r.cam.y += pan;
    if (this.app.settings.edgeScroll && this.mouse.inside) {
      const m = 12, W = window.innerWidth, H = window.innerHeight;
      if (this.mouse.cx < m) this.r.cam.x -= pan;
      if (this.mouse.cx > W - m) this.r.cam.x += pan;
      if (this.mouse.cy < m) this.r.cam.y -= pan;
      if (this.mouse.cy > H - m) this.r.cam.y += pan;
    }
    this.r.clampCam();

    const net = me.income - me.upkeep;
    setText('r-money', fmtNum(me.money));
    const rate = $('r-money-rate');
    setText('r-money-rate', (net >= 0 ? '+' : '') + net.toFixed(1));
    rate.className = net >= 0 ? 'pos' : 'neg';
    setText('r-mp', fmtNum(me.mp));
    setText('r-mp-rate', '+' + me.mpRate.toFixed(1));
    $('r-mp-rate').className = 'pos';
    let owned = 0;
    for (const P of s.provs) if (P.o === this.pid) owned++;
    setText('r-provs', String(owned));
    setText('r-goal', '/' + Math.ceil(s.provs.length * s.victoryShare));
    if (me.rs) {
      setText('r-rs', RESEARCH[me.rs.k].name.slice(0, 12));
      $('r-rs-bar').style.width = Math.min(100, ((me.rs.t + this.session.alpha()) / me.rs.total) * 100) + '%';
    } else {
      setText('r-rs', 'нет');
      $('r-rs-bar').style.width = '0%';
    }
    setText('game-time', fmtTime(s.time));

    this.boardT -= dt;
    if (this.boardT <= 0) { this.boardT = 0.5; this.renderBoard(); }
    this.panelT -= dt;
    if (this.panelT <= 0) { this.panelT = 0.2; this.renderPanel(); }
    if (!$('modal-research').hidden && Math.floor(s.time * 2) !== this._rsT) { this._rsT = Math.floor(s.time * 2); this.renderResearch(); }

    if (s.winner !== null && !this.endShown) { this.endShown = true; this.showEnd(); }
    else if (!me.alive && !this.deadShown && s.winner === null) { this.deadShown = true; this.showEnd(true); }
  }

  renderBoard() {
    const s = this.s;
    const counts = s.players.map(() => 0);
    for (const P of s.provs) if (P.o >= 0) counts[P.o]++;
    const order = s.players.map((p, i) => i).sort((a, b) => counts[b] - counts[a]);
    $('board').innerHTML = '<h3 style="margin:0 0 .4em">Державы</h3>' + order.map((i) => {
      const p = s.players[i];
      return `<div class="pl ${p.alive ? '' : 'dead'} ${i === this.pid ? 'me' : ''}" title="${p.ai ? 'ИИ' : 'Игрок'}"><span class="dot" style="background:${p.color}"></span><span class="nm">${esc(p.name)}</span><b>${counts[i]}</b></div>`;
    }).join('');
  }

  // ---------- Панель провинции ----------
  renderPanel() {
    const sel = this.r.selected;
    const panel = $('panel');
    if (sel < 0) { panel.hidden = true; this.lastPanel = ''; return; }
    const html = this.panelHTML(sel);
    if (html !== this.lastPanel) {
      const scroll = panel.scrollTop;
      panel.innerHTML = html;
      panel.scrollTop = scroll;
      this.lastPanel = html;
    }
    panel.hidden = false;
  }

  panelHTML(i) {
    const s = this.s, P = s.provs[i], mp = this.r.map.provinces[i], me = this.me;
    const own = P.o === this.pid;
    const owner = P.o >= 0 ? s.players[P.o] : null;
    const color = owner ? owner.color : '#888';
    const game = this.session.game || this.helper();
    let h = `<div class="p-head"><span class="dot" style="background:${color}"></span><h2>Провинция ${i + 1}</h2><span class="p-close" data-act="close">✕</span></div>`;
    h += `<div class="kv"><span>Владелец</span><span>${owner ? esc(owner.name) : 'Нейтральная'}</span>`;
    h += `<span>Рельеф</span><span>${TERRAIN[mp.terrain].name} (×${TERRAIN[mp.terrain].def})</span>`;
    h += `<span>Население</span><span>${fmtNum(P.pop)} / ${fmtNum(popCap(mp, P))}</span>`;
    h += `<span>Оборона</span><span>${fmtNum(game.defensePower(i))}</span>`;
    if (mp.sea.length) h += `<span>Морские пути</span><span>${mp.sea.length}</span>`;
    if (P.unrest > 0) h += `<span>Беспорядки</span><span class="warn">${Math.ceil(P.unrest)} с</span>`;
    h += '</div>';
    h += '<div class="troops">' + UNIT_KEYS.map((k) => `<div title="${UNITS[k].name}"><img src="${spriteURL(k, color, 3)}">${fmtNum(P.t[k])}</div>`).join('') + '</div>';

    if (!own) {
      const blds = BUILDING_KEYS.filter((k) => P.b[k] > 0).map((k) => `${BUILDINGS[k].name} ${P.b[k]}`).join(', ');
      h += `<div class="kv"><span>Постройки</span><span>${blds || '—'}</span></div>`;
      h += '<p class="muted small">Выберите свою провинцию и нажмите ПКМ по этой, чтобы атаковать. Ракеты и БПЛА — из панели своей провинции.</p>';
      return h;
    }

    // Отправка войск
    h += '<div class="section"><h3>Армия</h3><div class="frac">' + [0.25, 0.5, 0.75, 1].map((f) =>
      `<button class="btn tiny ${this.frac === f ? 'on' : ''}" data-act="frac" data-v="${f}">${f * 100}%</button>`).join('') + '</div>';
    h += `<div class="actions"><button class="btn" data-act="mode-move" ${troopCount(P.t) ? '' : 'disabled'}>Отправить войска</button></div>`;
    h += '<p class="muted small">или ПКМ по цели на карте</p>';
    // Найм
    h += '<h3>Набор</h3>';
    for (const k of UNIT_KEYS) {
      const U = UNITS[k];
      const ok = !U.needs || P.b[U.needs] > 0;
      const max = Math.floor(Math.min(me.money / U.cost, me.mp / U.mp));
      const dis = (n) => (!ok || max < n ? 'disabled' : '');
      h += `<div class="unit-row" title="Атака ${U.atk}, оборона ${U.def}, содержание ${U.upkeep}$/с${U.needs ? '. Нужна фабрика' : ''}"><img src="${spriteURL(k, color, 2)}"><span>${U.short} ${U.cost}$</span>`;
      h += `<button class="btn" data-act="recruit" data-u="${k}" data-n="1" ${dis(1)}>+1</button>`;
      h += `<button class="btn" data-act="recruit" data-u="${k}" data-n="10" ${dis(10)}>+10</button>`;
      h += `<button class="btn" data-act="recruit" data-u="${k}" data-n="50" ${dis(50)}>+50</button>`;
      h += `<button class="btn" data-act="recruit" data-u="${k}" data-n="max" ${dis(1)}>MAX</button></div>`;
      if (!ok) h += '<div class="warn">Танки и артиллерия — только в провинции с фабрикой</div>';
    }
    h += '</div>';

    // Удары
    if (P.b.airbase > 0 || P.b.silo > 0) {
      h += '<div class="section"><h3>Удары</h3>';
      if (P.cd > 0) h += `<p class="warn">Перезарядка: ${Math.ceil(P.cd)} с</p>`;
      h += '<div class="actions">';
      if (P.b.airbase > 0) {
        for (const [k, D] of Object.entries(DRONES)) {
          const lock = me.research.drone < D.lvl;
          h += `<button class="btn" data-act="mode-drone" data-d="${k}" ${lock || P.cd > 0 || me.money < D.cost ? 'disabled' : ''} title="${lock ? 'Нужно исследование БПЛА ур. ' + D.lvl : 'Радиус ' + droneRange(P.b.airbase, me.research.drone)}">${D.name} ${D.cost}$</button>`;
        }
      }
      if (P.b.silo > 0) {
        const r = missileRange(me.research.missile);
        h += `<button class="btn danger" data-act="mode-missile" ${P.cd > 0 || me.money < MISSILE.cost ? 'disabled' : ''} title="Радиус ${r > 9000 ? 'глобальный' : r}">Ракета ${MISSILE.cost}$</button>`;
      }
      h += '</div></div>';
    }

    // Постройки
    h += '<div class="section"><h3>Постройки</h3>';
    for (const k of BUILDING_KEYS) {
      const B = BUILDINGS[k];
      const lvl = P.b[k];
      const building = P.build && P.build.k === k;
      h += `<div class="bld" title="${B.desc}"><img src="${spriteURL(k, color, 3)}"><div>${B.name}<br><span class="pips">${pips(lvl, B.max)}</span>`;
      if (building) h += `<div class="progress"><span style="width:${Math.min(100, (P.build.t / P.build.total) * 100)}%"></span></div>`;
      h += '</div>';
      if (building) h += '<button class="btn" data-act="cancel">Отмена</button>';
      else if (lvl >= B.max) h += '<span class="lv">МАКС</span>';
      else {
        const err = game.canBuild(this.pid, i, k);
        const cost = game.buildCost(this.pid, k, lvl + 1);
        const locked = B.req && me.research[B.req[0]] < B.req[1];
        h += `<button class="btn" data-act="build" data-k="${k}" ${err ? 'disabled' : ''} title="${err ? esc(err) : ''}">${locked ? 'ИССЛ.' : lvl ? '↑' : '+'} ${cost}$</button>`;
      }
      h += '</div>';
    }
    h += '</div>';
    return h;
  }

  // Клиенту нужны функции расчёта без авторитетной симуляции
  helper() {
    if (!this._helper || this._helper.s !== this.s) {
      const G = this.app.GameClass;
      this._helper = new G(this.r.map, this.s);
    }
    return this._helper;
  }

  onPanelAction(el) {
    const act = el.dataset.act, sel = this.r.selected;
    play('click');
    if (act === 'close') { this.select(-1); return; }
    if (act === 'frac') { this.frac = Number(el.dataset.v); this.lastPanel = ''; return; }
    if (act === 'recruit') {
      let n = el.dataset.n;
      if (n === 'max') n = 10000;
      if (this.cmd({ c: 'recruit', p: sel, u: el.dataset.u, n: Number(n) })) play('recruit');
      return;
    }
    if (act === 'build') { this.cmd({ c: 'build', p: sel, k: el.dataset.k }); return; }
    if (act === 'cancel') { this.cmd({ c: 'cancelBuild', p: sel }); return; }
    if (act === 'mode-move') return this.setMode({ kind: 'move', from: sel });
    if (act === 'mode-drone') return this.setMode({ kind: 'drone', from: sel, d: el.dataset.d });
    if (act === 'mode-missile') return this.setMode({ kind: 'missile', from: sel });
  }

  setMode(m) {
    this.r.targetMode = m;
    const hint = $('hint');
    if (!m) { hint.hidden = true; return; }
    const txt = { move: 'Выберите цель для войск', drone: `Цель для «${m.d && DRONES[m.d].name}»`, missile: 'Цель для ракетного удара' }[m.kind];
    hint.textContent = txt + ' — ЛКМ. Esc — отмена';
    hint.hidden = false;
  }

  select(p) {
    this.r.selected = p;
    this.lastPanel = '';
    this.panelT = 0;
  }

  order(target) {
    const from = this.r.selected;
    if (from < 0 || target < 0 || from === target) return;
    if (this.s.provs[from].o !== this.pid) { this.toast('Сначала выберите свою провинцию'); return; }
    if (this.cmd({ c: 'move', from, to: target, frac: this.frac })) play('move');
  }

  clickTarget(p) {
    const m = this.r.targetMode;
    if (!m || p < 0) return;
    let ok = false;
    if (m.kind === 'move') { this.r.selected = m.from; this.order(p); ok = true; }
    else if (m.kind === 'drone') ok = this.cmd({ c: 'drone', from: m.from, to: p, d: m.d });
    else if (m.kind === 'missile') ok = this.cmd({ c: 'missile', from: m.from, to: p });
    if (ok) this.setMode(null);
  }

  // ---------- Исследования ----------
  openResearch() {
    $('modal-research').hidden = false;
    this.renderResearch();
  }
  renderResearch() {
    const me = this.me;
    $('research-list').innerHTML = RESEARCH_KEYS.map((k) => {
      const R = RESEARCH[k], lvl = me.research[k];
      const active = me.rs && me.rs.k === k;
      const maxed = lvl >= R.max;
      const cost = researchCost(k, lvl);
      let btn;
      if (active) btn = `<div class="progress"><span style="width:${(me.rs.t / me.rs.total) * 100}%"></span></div>`;
      else if (maxed) btn = '<span class="muted">Изучено</span>';
      else btn = `<button class="btn small" data-rs="${k}" ${me.rs || me.money < cost ? 'disabled' : ''}>Изучить: ${cost}$ · ${researchTime(lvl)}с</button>`;
      return `<div class="rcard ${active ? 'active' : ''}"><h4>${R.name}</h4><span class="pips">${pips(lvl, R.max)}</span><span class="muted">${R.desc}</span>${btn}</div>`;
    }).join('');
  }

  // ---------- Конец игры ----------
  showEnd(dead = false) {
    const s = this.s;
    const won = s.winner === this.pid;
    $('end-title').textContent = dead ? 'Ваша держава пала' : won ? 'ПОБЕДА!' : 'Поражение';
    $('end-text').textContent = dead ? 'Можно продолжить наблюдение за картой.' : `Победитель: ${s.players[s.winner].name} · время ${fmtTime(s.time)}`;
    const counts = s.players.map(() => 0);
    for (const P of s.provs) if (P.o >= 0) counts[P.o]++;
    $('end-stats').innerHTML = '<tr><th>Держава</th><th>Пров.</th><th>Захв.</th><th>Уничтож.</th></tr>' +
      s.players.map((p, i) => `<tr><td><span class="dot" style="background:${p.color}"></span> ${esc(p.name)}</td><td>${counts[i]}</td><td>${p.stats.captured}</td><td>${fmtNum(p.stats.kills)}</td></tr>`).join('');
    $('modal-end').hidden = false;
  }

  updateSpeedButtons() {
    document.querySelectorAll('#speed-ctrl .btn').forEach((b) => b.classList.toggle('on', Number(b.dataset.speed) === this.session.speed));
  }

  // ---------- Ввод ----------
  bindInput() {
    const cv = this.r.canvas;
    const dpr = () => window.devicePixelRatio || 1;
    const pos = (e) => { const rc = cv.getBoundingClientRect(); return [(e.clientX - rc.left) * dpr(), (e.clientY - rc.top) * dpr()]; };

    this.listen(cv, 'pointerdown', (e) => {
      const [x, y] = pos(e);
      if (e.button === 2) { // ПКМ: приказ
        const p = this.r.provAt(x, y);
        if (this.r.targetMode) { this.setMode(null); return; }
        this.order(p);
        return;
      }
      if (e.button !== 0 && e.button !== 1) return;
      this.mouse.down = true; this.mouse.drag = e.button === 1;
      this.mouse.sx = x; this.mouse.sy = y; this.mouse.camX = this.r.cam.x; this.mouse.camY = this.r.cam.y;
      cv.setPointerCapture(e.pointerId);
    });
    this.listen(cv, 'pointermove', (e) => {
      const [x, y] = pos(e);
      this.mouse.x = x; this.mouse.y = y; this.mouse.cx = e.clientX; this.mouse.cy = e.clientY; this.mouse.inside = true;
      if (this.mouse.down) {
        if (!this.mouse.drag && Math.hypot(x - this.mouse.sx, y - this.mouse.sy) > 6 * dpr()) this.mouse.drag = true;
        if (this.mouse.drag) {
          this.r.cam.x = this.mouse.camX - (x - this.mouse.sx) / this.r.cam.z;
          this.r.cam.y = this.mouse.camY - (y - this.mouse.sy) / this.r.cam.z;
          this.r.clampCam();
        }
      }
      const p = this.r.provAt(x, y);
      this.r.hover = p;
      this.showTip(p, e.clientX, e.clientY);
    });
    this.listen(cv, 'pointerleave', () => { this.mouse.inside = false; this.r.hover = -1; $('tip').hidden = true; });
    this.listen(cv, 'pointerup', (e) => {
      if (!this.mouse.down) return;
      this.mouse.down = false;
      if (this.mouse.drag) return;
      const [x, y] = pos(e);
      const p = this.r.provAt(x, y);
      if (this.r.targetMode) { this.clickTarget(p); return; }
      this.select(p);
      if (p >= 0) play('click');
    });
    this.listen(cv, 'contextmenu', (e) => e.preventDefault());
    this.listen(cv, 'wheel', (e) => {
      e.preventDefault();
      const [x, y] = pos(e);
      this.r.zoomAt(x, y, e.deltaY < 0 ? 1 : -1);
    }, { passive: false });

    this.listen($('panel'), 'pointerdown', (e) => {
      const el = e.target.closest('[data-act]');
      if (el && !el.disabled) { e.preventDefault(); this.onPanelAction(el); }
    });
    this.listen($('research-list'), 'pointerdown', (e) => {
      const el = e.target.closest('[data-rs]');
      if (el && !el.disabled) { play('click'); if (this.cmd({ c: 'research', k: el.dataset.rs })) setTimeout(() => this.renderResearch(), 50); }
    });
    this.listen($('r-research'), 'click', () => this.openResearch());
    this.listen($('speed-ctrl'), 'click', (e) => {
      const b = e.target.closest('[data-speed]');
      if (b) { this.session.setSpeed(Number(b.dataset.speed)); this.updateSpeedButtons(); play('click'); }
    });
    this.listen($('btn-aa'), 'click', () => { this.r.showAA = !this.r.showAA; $('btn-aa').classList.toggle('on', this.r.showAA); });
    this.listen($('btn-theme'), 'click', () => this.app.toggleTheme());
    this.listen($('btn-menu'), 'click', () => this.app.openPause());
    this.listen($('chat-form'), 'submit', (e) => {
      e.preventDefault();
      const v = $('chat-input').value.trim();
      if (v) this.session.sendChat(v);
      $('chat-input').value = '';
      $('chat-input').blur();
    });

    this.listen(window, 'keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      if (this.app.anyModalOpen()) {
        if (e.key === 'Escape') this.app.closeModals();
        return;
      }
      const k = e.key.toLowerCase();
      this.keys.add(k);
      if (k === 'escape') {
        if (this.r.targetMode) this.setMode(null);
        else if (this.r.selected >= 0) this.select(-1);
        else this.app.openPause();
      } else if (k === ' ') { e.preventDefault(); this.session.setSpeed(this.session.speed ? 0 : 1); this.updateSpeedButtons(); }
      else if (k === '1' || k === '2' || k === '3') { this.session.setSpeed(Number(k)); this.updateSpeedButtons(); }
      else if (k === 'r') this.openResearch();
      else if (k === 'v') $('btn-aa').click();
      else if (k === 't') this.app.toggleTheme();
      else if (k === 'z') this.frac = 0.25;
      else if (k === 'x') this.frac = 0.5;
      else if (k === 'c') this.frac = 0.75;
      else if (k === 'b') this.frac = 1;
      else if (k === 'enter' && this.session.mode !== 'offline') { e.preventDefault(); $('chat-input').focus(); }
      else if (k === 'home') this.focusHome();
      if ('zxcb'.includes(k)) this.lastPanel = '';
    });
    this.listen(window, 'keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    this.listen(window, 'blur', () => this.keys.clear());
  }

  focusHome() {
    const i = this.s.provs.findIndex((P) => P.o === this.pid);
    if (i >= 0) this.r.focus(i);
  }

  showTip(p, cx, cy) {
    const tip = $('tip');
    if (p < 0 || this.mouse.drag) { tip.hidden = true; return; }
    const P = this.s.provs[p], mp = this.r.map.provinces[p];
    const owner = P.o >= 0 ? this.s.players[P.o] : null;
    const game = this.session.game || this.helper();
    let h = `<b style="color:${owner ? owner.color : 'inherit'}">${owner ? esc(owner.name) : 'Нейтральная'}</b><br>`;
    h += `${TERRAIN[mp.terrain].name} · нас. ${fmtNum(P.pop)}<br>Войска: ${fmtNum(troopCount(P.t))} · оборона ${fmtNum(game.defensePower(p))}`;
    const sel = this.r.selected;
    if (sel >= 0 && sel !== p && this.s.provs[sel].o === this.pid && P.o !== this.pid) {
      const S = this.s.provs[sel];
      const send = { inf: Math.floor(S.t.inf * this.frac), tank: Math.floor(S.t.tank * this.frac), art: Math.floor(S.t.art * this.frac) };
      const att = game.attackPower(this.pid, send), def = game.defensePower(p, this.pid, send);
      const odds = att / Math.max(1, def);
      h += `<br>Атака ${Math.round(this.frac * 100)}%: <b style="color:${odds > 1 ? 'var(--good)' : 'var(--danger)'}">${fmtNum(att)} vs ${fmtNum(def)}</b>`;
    }
    tip.innerHTML = h;
    tip.hidden = false;
    tip.style.left = Math.min(window.innerWidth - 270, cx + 16) + 'px';
    tip.style.top = Math.min(window.innerHeight - 90, cy + 16) + 'px';
  }
}

function setText(id, v) {
  const el = $(id);
  if (el.textContent !== v) el.textContent = v;
}

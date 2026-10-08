// Пиксельный рендер карты, войск, БПЛА, ракет и эффектов.
import { THEMES, hexToRgb, mix, shade, lighten, rgbStr } from './theme.js';
import { TERRAIN, aaRadius, droneRange, missileRange } from '../core/config.js';
import { troopCount } from '../core/game.js';
import { sprite } from './sprites.js';

const SUB = 4; // субпикселей текстуры на клетку
const MASKS = {
  plain: ['....', '..l.', '....', 'l...'],
  forest: ['.d..', 'ddd.', '.d..', '....'],
  hills: ['....', '.l..', 'lld.', '....'],
  desert: ['..l.', '....', 'l...', '...l'],
  snow: ['l...', '..l.', '....', '...l'],
};
const FONT = '"Press Start 2P", monospace';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = { x: 0, y: 0, z: 6 };
    this.tex = document.createElement('canvas');
    this.texSig = '';
    this.themeName = 'dark';
    this.particles = [];
    this.tracers = [];
    this.flashes = new Map();
    this.trails = new Map();
    this.hover = -1;
    this.selected = -1;
    this.targetMode = null; // { kind, from }
    this.showAA = false;
    this.time = 0;
  }

  setMap(map) {
    this.map = map;
    this._tiles = null;
    this.tex.width = map.W * SUB;
    this.tex.height = map.H * SUB;
    this.texSig = '';
    // Контуры провинций (отрезки по краям клеток) для выделения
    this.edges = map.provinces.map(() => []);
    const { W, H, prov } = map;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = prov[y * W + x];
      if (p < 0) continue;
      const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= W || yy >= H ? -1 : prov[yy * W + xx]);
      if (at(x, y - 1) !== p) this.edges[p].push([x, y, x + 1, y]);
      if (at(x, y + 1) !== p) this.edges[p].push([x, y + 1, x + 1, y + 1]);
      if (at(x - 1, y) !== p) this.edges[p].push([x, y, x, y + 1]);
      if (at(x + 1, y) !== p) this.edges[p].push([x + 1, y, x + 1, y + 1]);
    }
  }

  setTheme(name) { this.themeName = name; this.texSig = ''; }
  get theme() { return THEMES[this.themeName]; }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  fit() {
    this.resize();
    const { W, H } = this.map;
    this.cam.z = Math.max(2, Math.floor(Math.min(this.canvas.width / W, this.canvas.height / H)));
    this.cam.x = W / 2 - this.canvas.width / this.cam.z / 2;
    this.cam.y = H / 2 - this.canvas.height / this.cam.z / 2;
  }
  focus(pIdx, z) {
    const P = this.map.provinces[pIdx];
    if (z) this.cam.z = z;
    this.cam.x = P.cx + 0.5 - this.canvas.width / this.cam.z / 2;
    this.cam.y = P.cy + 0.5 - this.canvas.height / this.cam.z / 2;
    this.clampCam();
  }
  zoomAt(sx, sy, dir) {
    const levels = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32];
    let i = levels.findIndex((l) => l >= this.cam.z);
    if (i < 0) i = levels.length - 1;
    i = Math.max(0, Math.min(levels.length - 1, i + dir));
    const wx = this.cam.x + sx / this.cam.z, wy = this.cam.y + sy / this.cam.z;
    this.cam.z = levels[i];
    this.cam.x = wx - sx / this.cam.z;
    this.cam.y = wy - sy / this.cam.z;
    this.clampCam();
  }
  clampCam() {
    const vw = this.canvas.width / this.cam.z, vh = this.canvas.height / this.cam.z;
    const { W, H } = this.map;
    // Запас по краям, чтобы окраины карты можно было вывести из-под панелей
    const mx = Math.min(vw * 0.35, W * 0.5), my = Math.min(vh * 0.25, H * 0.5);
    this.cam.x = vw > W + mx ? (W - vw) / 2 : Math.max(-mx, Math.min(W - vw + mx, this.cam.x));
    this.cam.y = vh > H + my ? (H - vh) / 2 : Math.max(-my, Math.min(H - vh + my, this.cam.y));
  }
  screenToTile(sx, sy) { return [this.cam.x + sx / this.cam.z, this.cam.y + sy / this.cam.z]; }
  provAt(sx, sy) {
    const [tx, ty] = this.screenToTile(sx, sy);
    const x = Math.floor(tx), y = Math.floor(ty);
    if (x < 0 || y < 0 || x >= this.map.W || y >= this.map.H) return -1;
    return this.map.prov[y * this.map.W + x];
  }
  sx(tx) { return (tx - this.cam.x) * this.cam.z; }
  sy(ty) { return (ty - this.cam.y) * this.cam.z; }

  // ---------- Текстура территории ----------
  rebuildTexture(state) {
    const sig = this.themeName + state.provs.map((P) => P.o).join(',');
    if (sig === this.texSig) return;
    this.texSig = sig;
    const { W, H, prov, land, provinces } = this.map;
    const th = this.theme;
    const tw = W * SUB;
    const ctx = this.tex.getContext('2d');
    const img = ctx.createImageData(tw, H * SUB);
    const d = img.data;
    const colors = state.players.map((p) => hexToRgb(p.color));
    const terr = Object.fromEntries(Object.entries(TERRAIN).map(([k, v]) => [k, hexToRgb(v.color)]));
    const ownerAt = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return -2;
      const p = prov[y * W + x];
      return p < 0 ? -2 : state.provs[p].o;
    };
    const provAt = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : prov[y * W + x]);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const t = y * W + x;
        const p = prov[t];
        if (p < 0 || !land[t]) {
          // Вода с пиксельными волнами
          let coast = false;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (provAt(x + dx, y + dy) >= 0) coast = true;
          for (let j = 0; j < SUB; j++) for (let i = 0; i < SUB; i++) {
            const X = x * SUB + i, Y = y * SUB + j;
            let c = ((X >> 2) + (Y >> 2)) % 2 ? th.water : th.water2;
            if (coast) c = th.shallow;
            if ((X * 7 + Y * 13 + ((Y >> 3) * 5)) % 37 === 0) c = th.wave;
            const o = (Y * tw + X) * 4;
            d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
          }
          continue;
        }
        const P = state.provs[p], mp = provinces[p];
        const owner = P.o;
        const tcol = terr[mp.terrain];
        let base = owner >= 0 ? mix(colors[owner], tcol, 0.22) : mix(tcol, th.neutralMix, th.neutralAmt);
        const mask = MASKS[mp.terrain];
        const oL = ownerAt(x - 1, y), oR = ownerAt(x + 1, y), oU = ownerAt(x, y - 1), oD = ownerAt(x, y + 1);
        const pL = provAt(x - 1, y), pR = provAt(x + 1, y), pU = provAt(x, y - 1), pD = provAt(x, y + 1);
        for (let j = 0; j < SUB; j++) for (let i = 0; i < SUB; i++) {
          let c = base;
          const m = mask[(j + (x & 1) * 2) % 4][(i + (y & 1)) % 4];
          if (m === 'l') c = lighten(c, 0.12);
          else if (m === 'd') c = shade(c, 0.82);
          // Границы стран: тёмная линия + светлая кромка внутри
          const edgeCountry = (i === 0 && oL !== owner && oL !== -2) || (i === SUB - 1 && oR !== owner && oR !== -2) ||
            (j === 0 && oU !== owner && oU !== -2) || (j === SUB - 1 && oD !== owner && oD !== -2);
          const coastEdge = (i === 0 && pL < 0) || (i === SUB - 1 && pR < 0) || (j === 0 && pU < 0) || (j === SUB - 1 && pD < 0);
          const innerCountry = owner >= 0 && ((i === 1 && oL !== owner) || (i === SUB - 2 && oR !== owner) || (j === 1 && oU !== owner) || (j === SUB - 2 && oD !== owner));
          const edgeProv = (i === 0 && pL !== p && pL >= 0) || (j === 0 && pU !== p && pU >= 0);
          if (edgeCountry) c = owner >= 0 ? shade(colors[owner], th.countryBorder) : shade(base, 0.55);
          else if (coastEdge) c = shade(base, 0.7);
          else if (innerCountry) c = lighten(owner >= 0 ? colors[owner] : base, 0.25);
          else if (edgeProv) c = shade(base, th.provBorder);
          const X = x * SUB + i, Y = y * SUB + j, o = (Y * tw + X) * 4;
          d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // ---------- События -> эффекты ----------
  addFx(events) {
    for (const e of events) {
      if (e.k === 'boom') this.explode(e.x, e.y, e.big ? 26 : 12, e.big);
      else if (e.k === 'intercept') this.explode(e.x, e.y, 8, false, true);
      else if (e.k === 'battle') this.sparks(e.x + 0.5, e.y + 0.5);
      else if (e.k === 'capture') this.flashes.set(e.p, { t: 0.8, o: e.o });
      else if (e.k === 'aafire') {
        const P = this.map.provinces[e.p];
        this.tracers.push({ x1: P.cx + 0.5, y1: P.cy + 0.5, x2: e.x, y2: e.y, t: 0.25 });
      }
    }
  }
  explode(x, y, n, big, blue) {
    const cols = blue ? ['#ffffff', '#9ad7ff', '#4aa3e0'] : ['#ffffff', '#ffe066', '#ff9f1c', '#e63b2e', '#5a5a5a'];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = (big ? 3 : 1.6) * (0.3 + Math.random());
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, life: 0.5 + Math.random() * (big ? 1.0 : 0.5), c: cols[i % cols.length], s: big ? 2 : 1 });
    }
    this.particles.push({ ring: true, x, y, t: 0, life: big ? 0.7 : 0.35, r: big ? 6 : 2.5 });
  }
  sparks(x, y) {
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      this.particles.push({ x, y, vx: Math.cos(a) * 1.2, vy: Math.sin(a) * 1.2 - 0.5, t: 0, life: 0.4, c: i % 2 ? '#fff6a0' : '#ff7a3a', s: 1 });
    }
  }

  // ---------- Кадр ----------
  draw(session, dt) {
    this.time += dt;
    this.resize();
    const ctx = this.ctx, s = session.s, map = this.map, th = this.theme, z = this.cam.z;
    this.rebuildTexture(s);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.tex, Math.round(this.sx(0)), Math.round(this.sy(0)), map.W * z, map.H * z);

    const me = session.localPid;
    const alpha = session.alpha();

    // Вспышки захвата
    for (const [p, f] of this.flashes) {
      f.t -= dt;
      if (f.t <= 0) { this.flashes.delete(p); continue; }
      ctx.globalAlpha = Math.min(0.6, f.t);
      ctx.fillStyle = '#ffffff';
      for (const t of this.provTiles(p)) ctx.fillRect(this.sx(t % map.W), this.sy((t / map.W) | 0), z, z);
      ctx.globalAlpha = 1;
    }

    // Морские пути выбранной провинции
    if (this.selected >= 0) {
      const P = map.provinces[this.selected];
      ctx.strokeStyle = th.lane;
      ctx.lineWidth = Math.max(1, z / 4);
      ctx.setLineDash([z / 2, z / 2]);
      for (const n of P.sea) {
        const Q = map.provinces[n];
        ctx.beginPath();
        ctx.moveTo(this.sx(P.cx + 0.5), this.sy(P.cy + 0.5));
        ctx.lineTo(this.sx(Q.cx + 0.5), this.sy(Q.cy + 0.5));
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // Радиусы ПВО
    if (this.showAA || this.targetMode) {
      s.provs.forEach((P, i) => {
        if (P.o < 0 || P.b.aa < 1) return;
        const mp = map.provinces[i];
        ctx.strokeStyle = P.o === me ? 'rgba(90,200,255,0.6)' : 'rgba(255,80,80,0.6)';
        ctx.lineWidth = Math.max(1, z / 6);
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(this.sx(mp.cx + 0.5), this.sy(mp.cy + 0.5), aaRadius(P.b.aa) * z, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      });
    }
    // Радиус удара в режиме прицеливания
    if (this.targetMode && this.targetMode.from >= 0) {
      const from = this.targetMode.from, mp = map.provinces[from], P = s.provs[from], pl = s.players[me];
      const r = this.targetMode.kind === 'missile' ? missileRange(pl.research.missile) : droneRange(P.b.airbase, pl.research.drone);
      if (r < 9000) {
        ctx.strokeStyle = this.targetMode.kind === 'missile' ? '#ff5a3a' : '#ffd23a';
        ctx.lineWidth = Math.max(1, z / 4);
        ctx.beginPath();
        ctx.arc(this.sx(mp.cx + 0.5), this.sy(mp.cy + 0.5), r * z, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Выделение и наведение
    this.outline(this.hover, th.hover, Math.max(1, z / 6));
    if (this.selected >= 0) {
      const pulse = 0.6 + 0.4 * Math.sin(this.time * 6);
      ctx.globalAlpha = pulse;
      this.outline(this.selected, th.select, Math.max(2, z / 3));
      ctx.globalAlpha = 1;
    }

    // Подписи провинций: войска, постройки, стройка
    const labelScale = Math.max(1, Math.round(z / 6));
    const fontPx = 8 * labelScale;
    ctx.font = `${fontPx}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const vw = this.canvas.width, vh = this.canvas.height;
    s.provs.forEach((P, i) => {
      const mp = map.provinces[i];
      const x = this.sx(mp.cx + 0.5), y = this.sy(mp.cy + 0.5);
      if (x < -60 || y < -40 || x > vw + 60 || y > vh + 40) return;
      if (z * Math.sqrt(mp.size) < 26 && i !== this.selected) return;
      const n = troopCount(P.t);
      const txt = fmtNum(n);
      const w = ctx.measureText(txt).width + 6 * labelScale;
      const h = fontPx + 5 * labelScale;
      ctx.fillStyle = th.labelBg;
      ctx.fillRect(Math.round(x - w / 2), Math.round(y - h / 2), Math.round(w), h);
      ctx.fillStyle = P.o >= 0 ? s.players[P.o].color : '#888';
      ctx.fillRect(Math.round(x - w / 2), Math.round(y + h / 2 - labelScale), Math.round(w), labelScale);
      ctx.fillStyle = th.label;
      ctx.fillText(txt, Math.round(x), Math.round(y + labelScale * 0.5));
      // Иконки построек
      if (z >= 8) {
        const icons = [];
        for (const k of ['fort', 'factory', 'house', 'aa', 'airbase', 'silo']) if (P.b[k] > 0) icons.push(k);
        const sc = labelScale;
        let ix = Math.round(x - (icons.length * 9 * sc) / 2);
        const iy = Math.round(y + h / 2 + 2 * sc);
        for (const k of icons) {
          ctx.drawImage(sprite(k, P.o >= 0 ? s.players[P.o].color : '#999'), ix, iy, 8 * sc, 8 * sc);
          ix += 9 * sc;
        }
        if (P.build) {
          const bw = 24 * sc;
          ctx.fillStyle = '#111';
          ctx.fillRect(Math.round(x - bw / 2), Math.round(y - h / 2 - 4 * sc), bw, 3 * sc);
          ctx.fillStyle = '#f2c23a';
          ctx.fillRect(Math.round(x - bw / 2), Math.round(y - h / 2 - 4 * sc), Math.round(bw * Math.min(1, (P.build.t + alpha) / P.build.total)), 3 * sc);
        }
      }
    });

    // Армии в пути
    for (const A of s.armies) {
      const a = map.provinces[A.path[A.i]], b = map.provinces[A.path[A.i + 1]];
      if (!a || !b) continue;
      const sea = !a.neighbors.includes(b.id);
      const len = Math.max(1, Math.hypot(a.cx - b.cx, a.cy - b.cy));
      const p = Math.min(1, A.p + (A.spd * (sea ? 0.6 : 1) * alpha) / len);
      const x = this.sx(a.cx + 0.5 + (b.cx - a.cx) * p), y = this.sy(a.cy + 0.5 + (b.cy - a.cy) * p);
      const col = s.players[A.o].color;
      // Линия маршрута
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = Math.max(1, z / 6);
      ctx.setLineDash([z / 3, z / 3]);
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let k = A.i + 1; k < A.path.length; k++) {
        const q = map.provinces[A.path[k]];
        ctx.lineTo(this.sx(q.cx + 0.5), this.sy(q.cy + 0.5));
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      const kind = A.t.tank >= A.t.inf / 4 && A.t.tank > 0 ? 'tank' : A.t.art > A.t.inf / 3 ? 'art' : 'inf';
      const spr = sprite(kind, col);
      const sc = Math.max(1, Math.round(z / 5));
      const bob = sea ? Math.round(Math.sin(this.time * 4 + A.id) * sc) : 0;
      ctx.drawImage(spr, Math.round(x - (spr.width * sc) / 2), Math.round(y - spr.height * sc + bob), spr.width * sc, spr.height * sc);
      if (z >= 4) {
        ctx.font = `${8 * Math.max(1, Math.round(sc / 1.5))}px ${FONT}`;
        ctx.fillStyle = th.labelBg;
        const txt = fmtNum(troopCount(A.t));
        const w = ctx.measureText(txt).width + 4;
        ctx.fillRect(Math.round(x - w / 2), Math.round(y + 2), Math.round(w), 10 * Math.max(1, Math.round(sc / 1.5)));
        ctx.fillStyle = col;
        ctx.fillText(txt, Math.round(x), Math.round(y + 2 + 5 * Math.max(1, Math.round(sc / 1.5))));
      }
    }

    // БПЛА и ракеты
    const live = new Set();
    for (const S of s.shots) {
      live.add(S.id);
      const dx = S.tx - S.x, dy = S.ty - S.y, d = Math.hypot(dx, dy);
      const adv = Math.min(d, S.sp * alpha);
      const x = S.x + (d > 0 ? (dx / d) * adv : 0), y = S.y + (d > 0 ? (dy / d) * adv : 0);
      let ox = 0, oy = 0;
      if (S.kind === 'missile') {
        const total = Math.hypot(S.tx - S.sx, S.ty - S.sy) || 1;
        const prog = 1 - (d - adv) / total;
        oy = -Math.sin(Math.PI * Math.max(0, Math.min(1, prog))) * Math.min(14, total * 0.25);
      }
      const px = this.sx(x), py = this.sy(y + oy);
      let tr = this.trails.get(S.id);
      if (!tr) { tr = []; this.trails.set(S.id, tr); }
      tr.push([x, y + oy]);
      if (tr.length > (S.kind === 'missile' ? 26 : 10)) tr.shift();
      const ps = Math.max(1, Math.round(z / 5));
      tr.forEach(([tx, ty], k) => {
        ctx.globalAlpha = (k / tr.length) * 0.6;
        ctx.fillStyle = S.kind === 'missile' ? '#bbbbbb' : s.players[S.o].color;
        ctx.fillRect(Math.round(this.sx(tx)) - ps / 2, Math.round(this.sy(ty)) - ps / 2, ps, ps);
      });
      ctx.globalAlpha = 1;
      const spr = sprite(S.kind === 'missile' ? 'missile' : 'drone', s.players[S.o].color);
      const sc = Math.max(1, Math.round(z / 4));
      ctx.drawImage(spr, Math.round(px - (spr.width * sc) / 2), Math.round(py - (spr.height * sc) / 2), spr.width * sc, spr.height * sc);
      if (S.kind === 'missile' && Math.floor(this.time * 10) % 2) {
        ctx.fillStyle = '#ffb02e';
        ctx.fillRect(Math.round(px - sc), Math.round(py + 2 * sc), sc * 2, sc * 2);
      }
    }
    for (const id of this.trails.keys()) if (!live.has(id)) this.trails.delete(id);

    // Трассеры ПВО
    for (const T of this.tracers) {
      T.t -= dt;
      ctx.strokeStyle = Math.floor(this.time * 20) % 2 ? '#fff6a0' : '#ff5a3a';
      ctx.lineWidth = Math.max(1, z / 5);
      ctx.beginPath();
      ctx.moveTo(this.sx(T.x1), this.sy(T.y1));
      ctx.lineTo(this.sx(T.x2), this.sy(T.y2));
      ctx.stroke();
    }
    this.tracers = this.tracers.filter((T) => T.t > 0);

    // Частицы
    for (const p of this.particles) {
      p.t += dt;
      const k = p.t / p.life;
      if (p.ring) {
        ctx.strokeStyle = `rgba(255,220,120,${1 - k})`;
        ctx.lineWidth = Math.max(1, z / 3);
        ctx.beginPath();
        ctx.arc(this.sx(p.x), this.sy(p.y), p.r * k * z + 1, 0, Math.PI * 2);
        ctx.stroke();
        continue;
      }
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 1.5 * dt;
      ctx.globalAlpha = Math.max(0, 1 - k);
      ctx.fillStyle = p.c;
      const ps = Math.max(1, Math.round((z / 4) * p.s));
      ctx.fillRect(Math.round(this.sx(p.x)), Math.round(this.sy(p.y)), ps, ps);
    }
    ctx.globalAlpha = 1;
    this.particles = this.particles.filter((p) => p.t < p.life);
  }

  provTiles(p) {
    if (!this._tiles) {
      this._tiles = this.map.provinces.map(() => []);
      this.map.prov.forEach((v, t) => { if (v >= 0) this._tiles[v].push(t); });
    }
    return this._tiles[p];
  }

  outline(p, color, width) {
    if (p < 0 || !this.edges) return;
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of this.edges[p]) {
      ctx.moveTo(Math.round(this.sx(x1)), Math.round(this.sy(y1)));
      ctx.lineTo(Math.round(this.sx(x2)), Math.round(this.sy(y2)));
    }
    ctx.stroke();
  }
}

export function fmtNum(n) {
  n = Math.floor(n);
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'K';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

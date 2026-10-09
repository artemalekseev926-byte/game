const circ = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;

export const ICONS = {
  house: { s: ['M3 11l9-7 9 7', 'M5.5 9.5V20h13V9.5', 'M10 20v-5.5h4V20'] },
  factory: { s: ['M2 20.5h20', 'M3 20.5V11l5 3v-3l5 3v-3l5 3V4h3v16.5', 'M7 17.5h2M11.5 17.5h2M16 17.5h2'] },
  port: { s: [circ(12, 5, 2), 'M12 7v14', 'M8.5 10.5h7', 'M4.5 13.5a7.5 7.5 0 0 0 15 0'] },
  fort: { s: ['M4 21V7.5h3V10h3V7.5h4V10h3V7.5h3V21z', 'M10 21v-4a2 2 0 0 1 4 0v4'] },
  sam: { s: ['M12 3l8 3v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6z', 'M12 16V8.5', 'M9 11.5l3-3 3 3'] },
  airbase: { s: ['M12 2.5c.9 0 1.4.9 1.4 2.2V9l7.1 4.3v2.2l-7.1-2.3v4.4l2.3 1.8v1.6L12 20.1l-3.7.9v-1.6l2.3-1.8v-4.4l-7.1 2.3v-2.2L10.6 9V4.7c0-1.3.5-2.2 1.4-2.2z'] },
  silo: { s: ['M12 2c2 2 3 4.6 3 8v7H9v-7c0-3.4 1-6 3-8z', 'M9 12.5l-3 3V19h3', 'M15 12.5l3 3V19h-3', 'M10.5 21h3'] },
  rail: { s: ['M8.5 3L5 21', 'M15.5 3L19 21', 'M7.6 7.5h8.8M6.8 11.5h10.4M6 15.5h12M5.2 19.5h13.6'] },
  drone: {
    s: ['M9 10.5a1.5 1.5 0 0 1 1.5-1.5h3a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 9 13.5z',
      'M9 9L6.8 6.8M15 9l2.2-2.2M9 15l-2.2 2.2M15 15l2.2 2.2',
      circ(5.2, 5.2, 2.4), circ(18.8, 5.2, 2.4), circ(5.2, 18.8, 2.4), circ(18.8, 18.8, 2.4)],
  },
  kamikaze: { s: ['M13.5 13.5L3 8.8l3.3-2.5L8.8 3z', 'M6.3 6.3l3.6 3.6', circ(18, 18, 1.6), 'M18 13.5V15M22.5 18H21M18 22.5V21M14.8 21.2l1-1M21.2 14.8l-1 1'] },
  cruise: { s: ['M14.5 4.6l5.4-1.5-1.5 5.4-8.6 8.6-3.9-3.9z', 'M6.2 13.4L3.5 14.5l6 6 1.1-2.7', 'M4 20l2.2-2.2'] },
  atom: {
    f: ['M13.6 14.77L16.5 19.79A9 9 0 0 1 7.5 19.79L10.4 14.77A3.2 3.2 0 0 0 13.6 14.77Z',
      'M8.8 12L3 12A9 9 0 0 1 7.5 4.21L10.4 9.23A3.2 3.2 0 0 0 8.8 12Z',
      'M13.6 9.23L16.5 4.21A9 9 0 0 1 21 12L15.2 12A3.2 3.2 0 0 0 13.6 9.23Z', circ(12, 12, 1.7)],
  },
  hbomb: { s: [circ(10.5, 14, 7), 'M15.5 9l2.2-2.2', 'M18.5 3v1.6M22 7h-1.6M21 4l-1.1 1.1', 'M8 11.5v5M13 11.5v5M8 14h5'] },
  mega: { s: ['M12 3a8 8 0 0 0-8 8c0 2.6 1.2 4.4 3 5.6V20h10v-3.4c1.8-1.2 3-3 3-5.6a8 8 0 0 0-8-8z', 'M10 20v-2.2M14 20v-2.2'], f: [circ(9, 11.5, 1.7), circ(15, 11.5, 1.7)] },
  warship: { s: ['M2 15.5h20l-3 4.5H5z', 'M5.5 15.5V12.5h9.5l2 3', 'M8.5 12.5V9h4v3.5', 'M10.5 9V5', 'M12.5 10.5h5'] },
  transport: { s: ['M2 14h13.5l-2 5H4z', 'M4.5 14v-3h7.5v3', 'M16.5 9h5.5', 'M19.5 6.5L22 9l-2.5 2.5'] },
  trade: { s: ['M2 15h20l-3 5H5z', 'M5 10h4v5H5z', 'M10 10h4v5h-4z', 'M10 6h4v4h-4z', 'M17.5 15V7.5'] },
  train: { s: ['M6 4h12a2 2 0 0 1 2 2v9a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a2 2 0 0 1 2-2z', 'M4 11h16', 'M8 18l-2 3M16 18l2 3', circ(8.5, 14.5, 0.6), circ(15.5, 14.5, 0.6)] },
  truck: { s: ['M2 6h11v10H2z', 'M13 9h4l4 4v3h-8z', circ(6, 17.5, 1.8), circ(17, 17.5, 1.8)] },
  gold: { s: [circ(12, 12, 8.5), 'M14.6 9.3c-.5-.9-1.5-1.4-2.6-1.4-1.6 0-2.7.8-2.7 2s1 1.7 2.7 2.1 2.8.9 2.8 2.1-1.2 2-2.8 2c-1.2 0-2.2-.5-2.7-1.4', 'M12 6.2v1.7M12 16.1v1.7'] },
  troops: { s: [circ(12, 7, 3.5), 'M5 20.5c0-3.9 3.1-7 7-7s7 3.1 7 7'] },
  target: { s: [circ(12, 12, 8), circ(12, 12, 3), 'M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4'] },
  radiation: { f: ['M13.6 14.77L16.5 19.79A9 9 0 0 1 7.5 19.79L10.4 14.77A3.2 3.2 0 0 0 13.6 14.77Z', 'M8.8 12L3 12A9 9 0 0 1 7.5 4.21L10.4 9.23A3.2 3.2 0 0 0 8.8 12Z', 'M13.6 9.23L16.5 4.21A9 9 0 0 1 21 12L15.2 12A3.2 3.2 0 0 0 13.6 9.23Z', circ(12, 12, 1.7)] },
};

export const ICON_NAMES = Object.keys(ICONS);
export const BUILDING_ICONS = ['house', 'factory', 'port', 'fort', 'sam', 'airbase', 'silo'];
export const STRIKE_ICONS = ['drone', 'kamikaze', 'cruise', 'atom', 'hbomb', 'mega'];

const hasDom = () => typeof document !== 'undefined';
const pathCache = new Map();

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined' && !hasDom()) return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function iconPaths(name) {
  let p = pathCache.get(name);
  if (p) return p;
  const def = ICONS[name];
  if (!def || typeof Path2D === 'undefined') return null;
  p = { s: (def.s || []).map((d) => new Path2D(d)), f: (def.f || []).map((d) => new Path2D(d)) };
  pathCache.set(name, p);
  return p;
}

export function drawIcon(ctx, name, cx, cy, size, color = '#ffffff', lw = 2) {
  const p = iconPaths(name);
  if (!p) return;
  const k = size / 24;
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(k, k);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of p.s) ctx.stroke(s);
  for (const f of p.f) ctx.fill(f);
  ctx.restore();
}

const iconCanvasCache = new Map();

export function iconCanvas(name, color = '#ffffff', px = 24, lw = 2) {
  const key = name + '|' + color + '|' + px + '|' + lw;
  let c = iconCanvasCache.get(key);
  if (c) return c;
  c = makeCanvas(px, px);
  drawIcon(c.getContext('2d'), name, px / 2, px / 2, px, color, lw);
  iconCanvasCache.set(key, c);
  return c;
}

const urlCache = new Map();

export function iconURL(name, color = '#ffffff', px = 48, lw = 2) {
  const key = name + '|' + color + '|' + px + '|' + lw;
  let u = urlCache.get(key);
  if (u) return u;
  if (!hasDom()) return '';
  const c = makeCanvas(px, px);
  drawIcon(c.getContext('2d'), name, px / 2, px / 2, px, color, lw);
  u = c.toDataURL('image/png');
  urlCache.set(key, u);
  return u;
}

export function iconSVG(name, opts = {}) {
  const def = ICONS[name];
  if (!def) return '';
  const size = opts.size || 24;
  const color = opts.color || 'currentColor';
  const lw = opts.lw || 2;
  const cls = opts.cls ? ` class="${opts.cls}"` : '';
  const s = (def.s || []).map((d) => `<path d="${d}"/>`).join('');
  const f = (def.f || []).map((d) => `<path d="${d}" fill="${color}" stroke="none"/>`).join('');
  return `<svg${cls} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${lw}" stroke-linecap="round" stroke-linejoin="round">${s}${f}</svg>`;
}

const hexRgb = (hex) => {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [160, 160, 160];
};
const css = (c, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
const shadeC = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const mixC = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function drawMarker(ctx, type, cx, cy, r, color, opts = {}) {
  const c = Array.isArray(color) ? color : hexRgb(color);
  const light = lum(c) > 0.78;
  const body = light ? shadeC(c, 0.8) : c;
  const ring = opts.ring || 'rgba(6,9,15,0.88)';
  ctx.save();
  if (opts.alpha !== undefined) ctx.globalAlpha *= opts.alpha;
  if (opts.shadow !== false) {
    ctx.fillStyle = opts.shadow || 'rgba(0,0,0,0.38)';
    ctx.beginPath();
    ctx.arc(cx, cy + Math.max(1, r * 0.12), r + 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = ring;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  const ri = r - Math.max(1.2, r * 0.14);
  const g = ctx.createRadialGradient(cx - ri * 0.35, cy - ri * 0.45, ri * 0.1, cx, cy, ri);
  g.addColorStop(0, css(mixC(body, [255, 255, 255], 0.28)));
  g.addColorStop(1, css(shadeC(body, 0.82)));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, ri, 0, Math.PI * 2);
  ctx.fill();
  if (opts.icon !== false && r >= 5) {
    const ic = light ? '#141920' : opts.iconColor || '#ffffff';
    drawIcon(ctx, type, cx, cy, ri * 1.42, ic, r < 9 ? 2.8 : 2.3);
  }
  const lvl = opts.level | 0;
  if (lvl >= 2 && r >= 7) {
    const br = Math.max(4.5, r * 0.44);
    const bx = cx + r * 0.74, by = cy - r * 0.74;
    ctx.fillStyle = opts.badge || '#0d121b';
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = css(body);
    ctx.lineWidth = Math.max(1, br * 0.22);
    ctx.stroke();
    ctx.fillStyle = opts.badgeText || '#ffffff';
    ctx.font = `800 ${Math.round(br * 1.25)}px Inter, "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(lvl), bx, by + br * 0.06);
  }
  ctx.restore();
}

const markerCache = new Map();

export function markerCanvas(type, color, r, opts = {}) {
  const lvl = opts.level | 0;
  const key = type + '|' + color + '|' + r + '|' + lvl + '|' + (opts.ring || '') + '|' + (opts.badge || '') + '|' + (opts.icon === false ? 0 : 1);
  let m = markerCache.get(key);
  if (m) return m;
  const pad = Math.ceil(r * 0.9 + 3);
  const size = Math.ceil(r * 2 + pad * 2);
  const c = makeCanvas(size, size);
  drawMarker(c.getContext('2d'), type, size / 2, size / 2, r, color, opts);
  m = { c, off: size / 2 };
  if (markerCache.size > 600) markerCache.clear();
  markerCache.set(key, m);
  return m;
}

function hullPath(ctx, L, w, bow, stern) {
  const h = L / 2;
  ctx.beginPath();
  ctx.moveTo(h, 0);
  ctx.quadraticCurveTo(h - L * bow * 0.35, -w / 2, h - L * bow, -w / 2);
  ctx.lineTo(-h + L * stern, -w / 2);
  ctx.quadraticCurveTo(-h, -w / 2, -h, -w * 0.3);
  ctx.lineTo(-h, w * 0.3);
  ctx.quadraticCurveTo(-h, w / 2, -h + L * stern, w / 2);
  ctx.lineTo(h - L * bow, w / 2);
  ctx.quadraticCurveTo(h - L * bow * 0.35, w / 2, h, 0);
  ctx.closePath();
}

function rrect(ctx, x, y, w, h, r) {
  const q = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + q, y);
  ctx.lineTo(x + w - q, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + q);
  ctx.lineTo(x + w, y + h - q);
  ctx.quadraticCurveTo(x + w, y + h, x + w - q, y + h);
  ctx.lineTo(x + q, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - q);
  ctx.lineTo(x, y + q);
  ctx.quadraticCurveTo(x, y, x + q, y);
  ctx.closePath();
}

export const UNIT_ASPECT = { warship: 0.27, transport: 0.36, trade: 0.3, train: 0.3, truck: 0.42 };

export function drawUnitShape(ctx, type, L, color, opts = {}) {
  const c = Array.isArray(color) ? color : hexRgb(color);
  const hull = opts.hull || [70, 79, 90];
  const deck = opts.deck || [140, 150, 162];
  const line = opts.line || 'rgba(5,8,12,0.85)';
  const lw = Math.max(0.8, L * 0.035);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (type === 'warship') {
    const w = L * 0.27;
    hullPath(ctx, L, w, 0.3, 0.06);
    ctx.fillStyle = css(hull);
    ctx.fill();
    ctx.strokeStyle = line;
    ctx.lineWidth = lw;
    ctx.stroke();
    hullPath(ctx, L * 0.86, w * 0.62, 0.28, 0.06);
    ctx.fillStyle = css(deck);
    ctx.fill();
    ctx.fillStyle = css(c);
    rrect(ctx, -L * 0.2, -w * 0.24, L * 0.3, w * 0.48, w * 0.12);
    ctx.fill();
    ctx.strokeStyle = line;
    ctx.lineWidth = lw * 0.8;
    ctx.stroke();
    ctx.fillStyle = css(shadeC(hull, 0.75));
    for (const tx of [L * 0.24, -L * 0.33]) {
      ctx.beginPath();
      ctx.arc(tx, 0, w * 0.17, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = css(shadeC(hull, 0.6));
      ctx.lineWidth = w * 0.09;
      ctx.beginPath();
      const dir = tx > 0 ? 1 : -1;
      ctx.moveTo(tx, 0);
      ctx.lineTo(tx + dir * w * 0.42, 0);
      ctx.stroke();
    }
  } else if (type === 'transport') {
    const w = L * 0.36;
    hullPath(ctx, L, w, 0.22, 0.08);
    ctx.fillStyle = css(c);
    ctx.fill();
    ctx.strokeStyle = line;
    ctx.lineWidth = lw;
    ctx.stroke();
    ctx.fillStyle = css(mixC(c, [255, 255, 255], 0.55));
    rrect(ctx, -L * 0.36, -w * 0.3, L * 0.56, w * 0.6, w * 0.12);
    ctx.fill();
    ctx.fillStyle = css(shadeC(c, 0.55));
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      ctx.arc(-L * 0.25 + k * L * 0.17, 0, w * 0.11, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (type === 'trade') {
    const w = L * 0.3;
    hullPath(ctx, L, w, 0.22, 0.05);
    ctx.fillStyle = css(mixC(c, [40, 40, 44], 0.35));
    ctx.fill();
    ctx.strokeStyle = line;
    ctx.lineWidth = lw;
    ctx.stroke();
    const box = [[232, 136, 46], [70, 140, 220], [214, 64, 56], [80, 176, 96]];
    const bw = L * 0.13;
    for (let k = 0; k < 4; k++) {
      ctx.fillStyle = css(box[(k + (opts.seed | 0)) % 4]);
      rrect(ctx, -L * 0.18 + k * (bw + L * 0.015) - bw * 0.5, -w * 0.32, bw, w * 0.64, bw * 0.12);
      ctx.fill();
    }
    ctx.fillStyle = '#f2f4f7';
    rrect(ctx, -L * 0.44, -w * 0.3, L * 0.12, w * 0.6, L * 0.02);
    ctx.fill();
  } else if (type === 'train') {
    const w = L * 0.26;
    const seg = L * 0.31, gap = L * 0.035;
    for (let k = 2; k >= 0; k--) {
      const x0 = L / 2 - (k + 1) * seg - k * gap;
      ctx.fillStyle = k === 0 ? css(c) : css(mixC(c, [200, 204, 210], 0.62));
      rrect(ctx, x0, -w / 2, seg, w, w * (k === 0 ? 0.45 : 0.18));
      ctx.fill();
      ctx.strokeStyle = line;
      ctx.lineWidth = lw;
      ctx.stroke();
    }
    ctx.fillStyle = '#fff7c8';
    ctx.beginPath();
    ctx.arc(L / 2 - seg * 0.1, 0, w * 0.16, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === 'truck') {
    const w = L * 0.42;
    ctx.fillStyle = css(mixC(c, [220, 222, 226], 0.6));
    rrect(ctx, -L / 2, -w / 2, L * 0.64, w, w * 0.12);
    ctx.fill();
    ctx.strokeStyle = line;
    ctx.lineWidth = lw;
    ctx.stroke();
    ctx.fillStyle = css(c);
    rrect(ctx, L * 0.18, -w * 0.44, L * 0.32, w * 0.88, w * 0.25);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

const unitCache = new Map();

export function unitCanvas(type, color, L, opts = {}) {
  const key = type + '|' + color + '|' + L + '|' + (opts.seed | 0) + '|' + (opts.hull || '') + '|' + (opts.deck || '');
  let u = unitCache.get(key);
  if (u) return u;
  const w = Math.ceil(L * 1.1 + 4);
  const h = Math.ceil(L * 0.6 + 4);
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  if (type === 'warship' || type === 'transport' || type === 'trade') {
    const sh = makeCanvas(w, h);
    const sx = sh.getContext('2d');
    sx.translate(w / 2 + L * 0.03, h / 2 + L * 0.05);
    drawUnitShape(sx, type, L, color, opts);
    sx.setTransform(1, 0, 0, 1, 0, 0);
    sx.globalCompositeOperation = 'source-in';
    sx.fillStyle = 'rgba(0,0,0,0.38)';
    sx.fillRect(0, 0, w, h);
    ctx.drawImage(sh, 0, 0);
  }
  ctx.translate(w / 2, h / 2);
  drawUnitShape(ctx, type, L, color, opts);
  u = { c, ox: w / 2, oy: h / 2 };
  if (unitCache.size > 800) unitCache.clear();
  unitCache.set(key, u);
  return u;
}

export function clearIconCaches() {
  iconCanvasCache.clear();
  markerCache.clear();
  unitCache.clear();
}

// Генерирует примеры пользовательских карт в формате JSON (папка maps/).
// Формат: { "name": "...", "rows": ["..##..", ...], "area": 30, "seaRange": 7 }
// '#' — суша, '.' — вода. area — средний размер провинции, seaRange — длина морских путей.
import { writeFileSync } from 'node:fs';

function make(name, file, W, H, fn, extra = {}) {
  const rows = [];
  for (let y = 0; y < H; y++) {
    let r = '';
    for (let x = 0; x < W; x++) r += fn(x, y) ? '#' : '.';
    rows.push(r);
  }
  writeFileSync(new URL(`../maps/${file}`, import.meta.url), JSON.stringify({ name, ...extra, rows }, null, 1));
}

const wob = (x, y) => Math.sin(x * 0.31) * 1.6 + Math.cos(y * 0.27) * 1.6 + Math.sin((x + y) * 0.13) * 2;

// Крест: четыре полуострова вокруг центральной крепости
make('Великий Крест', 'krest.json', 160, 110, (x, y) => {
  const dx = Math.abs(x - 80), dy = Math.abs(y - 55), w = wob(x, y);
  const arm = (dx < 15 + w && dy < 48) || (dy < 13 + w && dx < 72);
  const core = Math.hypot(x - 80, y - 55) < 24 + w;
  const isles = [[30, 22], [130, 22], [30, 88], [130, 88]].some(([cx, cy]) => Math.hypot(x - cx, y - cy) < 12 + w);
  return arm || core || isles;
}, { area: 30, seaRange: 7 });

// Шахматная доска: квадратные острова, разделённые проливами
make('Шахматные острова', 'shahmaty.json', 168, 112, (x, y) => {
  const cx = Math.floor(x / 28), cy = Math.floor(y / 28);
  const lx = x % 28, ly = y % 28, w = wob(x, y) * 0.6;
  if ((cx + cy) % 2) return lx > 6 + w && lx < 22 - w && ly > 6 + w && ly < 22 - w;
  return lx > 2 + w && lx < 26 - w && ly > 2 + w && ly < 26 - w;
}, { area: 28, seaRange: 9 });

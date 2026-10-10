export const VERSION = '1.1.0';
export const TICK_MS = 100;
export const TICKS_PER_SEC = 10;
export const sec = (s) => Math.round(s * TICKS_PER_SEC);

const LN2 = 0.6931471805599453;

function dlog(x) {
  let k = 0;
  while (x >= 2) { x /= 2; k++; }
  while (x < 1) { x *= 2; k--; }
  const z = (x - 1) / (x + 1), z2 = z * z;
  let term = z, sum = 0;
  for (let n = 1; n < 44; n += 2) { sum += term / n; term *= z2; }
  return 2 * sum + k * LN2;
}

function dexp(y) {
  let k = Math.floor(y / LN2);
  const r = y - k * LN2;
  let term = 1, sum = 1;
  for (let n = 1; n < 26; n++) { term *= r / n; sum += term; }
  for (; k > 0; k--) sum *= 2;
  for (; k < 0; k++) sum /= 2;
  return sum;
}

export const dpow = (x, e) => (x > 0 && Number.isFinite(x) ? dexp(e * dlog(x)) : 0);

export function heading(dx, dy) {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax === 0 && ay === 0) return 0;
  const a = ax > ay ? ay / ax : ax / ay;
  const q = a * a;
  let r = ((-0.0464964749 * q + 0.15931422) * q - 0.327622764) * q * a + a;
  if (ay > ax) r = 1.5707963267948966 - r;
  if (dx < 0) r = 3.141592653589793 - r;
  return dy < 0 ? -r : r;
}

export const PLAYER_COLORS = [
  '#e04848', '#3d7ee6', '#3fb950', '#e6b422', '#a259e0', '#f07c2a',
  '#22c3c3', '#e055a8', '#9c7a4a', '#9fb236', '#6b74f0', '#c7cbd1',
  '#ff8f80', '#3ed6a6', '#c49bff', '#ffcf73',
];

export const TER = { DEEP: 0, SHALLOW: 1, PLAINS: 2, FOREST: 3, DESERT: 4, HILLS: 5, MOUNTAIN: 6, SNOW: 7 };

export const TERRAIN = [
  { key: 'deep', name: 'Глубокая вода', land: false, cost: 0, def: 0 },
  { key: 'shallow', name: 'Мелководье', land: false, cost: 0, def: 0 },
  { key: 'plains', name: 'Равнина', land: true, cost: 1.0, def: 1.0 },
  { key: 'forest', name: 'Лес', land: true, cost: 1.25, def: 1.15 },
  { key: 'desert', name: 'Пустыня', land: true, cost: 1.1, def: 0.95 },
  { key: 'hills', name: 'Возвышенность', land: true, cost: 1.5, def: 1.3 },
  { key: 'mountain', name: 'Горы', land: true, cost: 2.2, def: 1.7 },
  { key: 'snow', name: 'Тундра и льды', land: true, cost: 1.4, def: 1.1 },
];
export const TERRAIN_COST = Float64Array.from(TERRAIN, (t) => t.cost);
export const TERRAIN_DEF = Float64Array.from(TERRAIN, (t) => t.def);

export const BUILDINGS = {
  house: {
    name: 'Жилой квартал', short: 'Дома', max: 5, cost: 1000, time: 6, upkeep: 0, hotkey: '1',
    desc: '+3 000 к максимуму войск и +6 золота/с за уровень (каждая клетка территории даёт +6)',
  },
  factory: {
    name: 'Фабрика', short: 'Фабрика', max: 3, cost: 2500, time: 10, upkeep: 0, hotkey: '2',
    desc: 'Возит груз (75 золота за уровень) в свой порт только по своей или союзной суше: следующий рейс — после прибытия предыдущего. '
      + 'Грузовик ездит до 100 клеток, поезд по прямой ж/д — вдвое быстрее и потому привозит вдвое больше. '
      + 'Без доступного порта даёт 4 золота/с за уровень. Удваивает долю танков и артиллерии в армии, каждая фабрика добавляет ещё',
  },
  port: {
    name: 'Порт', short: 'Порт', max: 3, cost: 3000, time: 10, upkeep: 0, coast: true, hotkey: '3',
    desc: 'Верфь, торговые суда и приём грузов с фабрик. Строится только на морском берегу',
  },
  fort: {
    name: 'Укрепление', short: 'Форт', max: 3, cost: 1500, time: 8, upkeep: 0, hotkey: '4',
    desc: 'Оборона ×1.6 в радиусе 18 клеток, +25% за каждый следующий уровень',
  },
  sam: {
    name: 'ПВО', short: 'ПВО', max: 3, cost: 4000, time: 10, upkeep: 1.5, upkeepPerLevel: true, hotkey: '5',
    desc: 'Сбивает дроны, ракеты и бомбы в радиусе 40 клеток (+10 за уровень)',
  },
  airbase: {
    name: 'Аэродром БПЛА', short: 'Аэродром', max: 2, cost: 3500, time: 10, upkeep: 1, req: ['drone', 1], hotkey: '6',
    desc: 'Запуск ударных дронов и дронов-камикадзе',
  },
  silo: {
    name: 'Ракетная шахта', short: 'Шахта', max: 2, cost: 8000, time: 15, upkeep: 2, req: ['missile', 1], hotkey: '7',
    desc: 'Запуск крылатых ракет и ядерных бомб',
  },
};
export const BUILDING_KEYS = Object.keys(BUILDINGS);
export const CAPTURABLE = { house: true, factory: true, port: true, fort: true };
export const RAIL_TYPES = { factory: true, port: true, house: true };

export const RESEARCH = {
  econ: { name: 'Экономика', max: 5, base: 1200, desc: '+10% к доходу и +5% к приросту войск за уровень' },
  logistics: { name: 'Логистика', max: 3, base: 1500, desc: '+10% к скорости наступления за уровень' },
  inf: { name: 'Пехота', max: 5, base: 1000, desc: '+8% к атаке и обороне за уровень' },
  armor: { name: 'Бронетехника', max: 5, base: 2000, desc: 'Танки сами появляются в армии: мощная атака. С фабриками их доля вдвое больше и растёт с каждой фабрикой' },
  art: { name: 'Артиллерия', max: 5, base: 1800, desc: 'Артиллерия сама появляется в армии: атака и оборона. С фабриками её доля вдвое больше и растёт с каждой фабрикой' },
  fort: { name: 'Фортификация', max: 3, base: 1500, desc: '+12% к обороне всей территории за уровень' },
  naval: { name: 'Флот', max: 3, base: 2000, desc: '+20% к прочности и урону военных кораблей за уровень' },
  drone: { name: 'БПЛА', max: 3, base: 3000, desc: '1: аэродромы и ударные дроны, 2: дроны-камикадзе, 3: усиленные дроны' },
  missile: { name: 'Ракеты', max: 3, base: 5000, desc: '1: шахты и крылатые ракеты, 2: дальность 500, 3: без ограничения дальности' },
  aa: { name: 'Системы ПВО', max: 3, base: 3000, desc: '+10% к шансу перехвата за уровень' },
  nuclear: { name: 'Ядерное оружие', max: 3, base: 12000, req: ['missile', 1], desc: '1: атомная бомба, 2: водородная бомба, 3: мегабомба «Судный день» — опустошает все враждебные страны' },
};
export const RESEARCH_KEYS = Object.keys(RESEARCH);
export const researchCost = (key, lvl) => Math.round(RESEARCH[key].base * dpow(lvl + 1, 1.6));
export const researchTicks = (lvl) => (20 + 15 * lvl) * TICKS_PER_SEC;

export const STRIKES = {
  drone: {
    name: 'Ударный БПЛА', src: 'airbase', req: ['drone', 1], cost: 300, r: 3, speed: 1.5, killPerLevel: 1500,
    desc: 'Уничтожает войска владельца клетки в точке удара',
  },
  kamikaze: {
    name: 'Дрон-камикадзе', src: 'airbase', req: ['drone', 2], cost: 600, r: 0, speed: 1.5, point: true, pick: 2,
    desc: 'Уничтожает выбранное вражеское здание',
  },
  cruise: {
    name: 'Крылатая ракета', src: 'silo', req: ['missile', 1], cost: 2000, r: 0, speed: 2.5, point: true, pick: 2,
    desc: 'Уничтожает выбранное вражеское здание; дальность растёт с исследованием «Ракеты»',
  },
  atom: {
    name: 'Атомная бомба', src: 'silo', req: ['nuclear', 1], cost: 15000, r: 14, speed: 2.0, nuke: true,
    desc: 'Выжигает клетки в радиусе 14: земля становится ничьей, здания рушатся, остаётся заражение',
  },
  hbomb: {
    name: 'Водородная бомба', src: 'silo', req: ['nuclear', 2], cost: 50000, r: 40, speed: 2.0, nuke: true,
    desc: 'То же, что атомная бомба, в радиусе 40',
  },
  mega: {
    name: 'Мегабомба «Судный день»', src: 'silo', req: ['nuclear', 3], cost: 250000, r: 40, speed: 2.0, nuke: true,
    boost: 30, incomeSec: 120, perGame: 1,
    desc: 'Одна на партию. Цена — не меньше 250 000 золота и не меньше 2 минут вашего дохода. Через несколько секунд после пуска '
      + 'распадается на сотни ядерных боеголовок (одна на каждые ~1200 клеток врага, не меньше 8 на страну, радиус 40), '
      + 'которые выжигают почти всю территорию всех враждебных стран: земля становится ничьей и заражённой, войска гибнут, '
      + 'здания рушатся. Носитель не сбивается, боеголовки ПВО сбивает редко. Ваша земля, союзники и партнёры по пакту не страдают',
  },
};
export const STRIKE_KEYS = Object.keys(STRIKES);
export const WARHEAD = { r: 40, speed: 3.0, perTiles: 1200, min: 8, minFlight: 25, maxFlight: 160, stagger: 61, terminal: 30 };
export const FALLOUT_TICKS = 600;
export const NUKE_TROOP_LOSS = 1.5;
export const TRAITOR_TICKS = 3000;
export const cruiseRange = (lvl) => (lvl >= 3 ? Infinity : 300 + 200 * (lvl - 1));
export const siloReload = (lvl) => Math.round(300 / Math.max(1, lvl));
export const airbaseReload = (lvl) => Math.round(100 / Math.max(1, lvl));

export const SAM = {
  every: 5,
  radius: (lvl) => 40 + 10 * (lvl - 1),
  reload: (lvl) => Math.round(30 / Math.max(1, lvl)),
};
export const INTERCEPT = { drone: 0.6, kamikaze: 0.6, cruise: 0.5, atom: 0.45, warhead: 0.15, mega: 0, hbomb: 0.35 };
export const interceptChance = (kind, aaLvl) => (INTERCEPT[kind] === 0 ? 0 : Math.min(0.95, (INTERCEPT[kind] ?? 0.45) + 0.1 * aaLvl));

export const SHIPS = {
  warship: {
    name: 'Военный корабль', cost: 2500, costStep: 0.1, hp: 1000, dmg: 120, navalBonus: 0.2,
    range: 14, chase: 25, fireEvery: 5, speed: 0.9, upkeep: 3, perPortBase: 3,
  },
  transport: { name: 'Десантный корабль', hp: 300, speed: 1.1, maxActive: 3 },
  trade: { name: 'Торговое судно', hp: 300, speed: 0.8 },
};
export const LAND_UNITS = {
  truck: { name: 'Грузовик', speed: 0.6 },
  train: { name: 'Поезд', speed: 1.2 },
};
export const TRADE = {
  interval: (lvl) => (40 - 5 * lvl) * TICKS_PER_SEC,
  base: 100, perTile: 1, treaty: 0.5, stockBonus: 0.1, maxStock: 10, sunkLoot: 0.5,
};

export const ECON = {
  startGold: 1500,
  startTroops: 3000,
  maxGold: 1e9,
  troopsBase: 5000,
  troopsPerTile: 6,
  houseTroops: 3000,
  growthBase: 60,
  growthExp: 0.73,
  growthDiv: 8,
  growthEcon: 0.05,
  overCapDecay: 0.01,
  desertion: 0.01,
  incomePerTile: 0.008,
  incomeTroops: 0.06,
  houseIncome: 6,
  factoryDirect: 4,
  incomeEcon: 0.1,
  eventIncomeAlpha: 0.08,
  neutralCost: 8,
  tileCost: 8,
  densityCost: 1.2,
  defenderLoss: 0.9,
  falloutCostMul: 3,
  captureRate: 0.18,
  logisticsSpeed: 0.1,
  sampleMul: 4,
  frontRescan: 40,
  fortRadius: 18,
  fortBonus: 1.6,
  fortLevelBonus: 0.25,
  enclaveEvery: 50,
  enclaveMax: 200,
  spawnRadius: 5,
  spawnMinDist: 30,
  buildMinDist: 5,
  buildCostStep: 0.25,
  upgradeStep: 0.5,
  demolishRefund: 0.25,
  factoryInterval: 6,
  factoryLoad: 1,
  cargoPerLevel: 75,
  truckMaxLen: 100,
  railCostPerTile: 40,
  railMaxLen: 300,
};

export const ARMY = {
  tankPerArmor: 0.07, tankPerFactory: 0.01, tankMax: 0.45,
  artPerLevel: 0.06, artPerFactory: 0.005, artMax: 0.3, noFactory: 0.5,
  infBonus: 0.08, tankAtk: 1.3, artAtk: 0.9, artDef: 0.5, fortDef: 0.12,
  armorBonus: 0.1, artBonus: 0.1, shiftPerSec: 0.02,
};

export const DIPLO = {
  requestTicks: 30 * TICKS_PER_SEC,
  pactTicks: 600 * TICKS_PER_SEC,
  traitorTicks: TRAITOR_TICKS,
  aiReplyEvery: 10,
};
export const RELATIONS = {
  none: 'Нет договора',
  alliance: 'Союз',
  pact: 'Пакт о ненападении',
  trade: 'Торговый договор',
};
export const PROPOSALS = { alliance: true, pact: true, trade: true };

export const DEFAULT_SETTINGS = {
  victory: { territory: true, territoryPct: 70, economy: false, economyMinutes: 20 },
  spawnSeconds: 15,
  difficulty: 'normal',
};
export const VICTORY = {
  econLead: 0.15,
  econCheckEvery: 10,
  minTerritoryPct: 30,
  maxTerritoryPct: 100,
  minEconMinutes: 5,
  maxEconMinutes: 60,
};
export const WIN_REASONS = {
  territory: 'Захват территории',
  economy: 'Экономическое лидерство',
  survivor: 'Последний выживший',
};

export const DIFFICULTY = {
  easy: { name: 'Лёгкий', income: 0.8, think: 30, aggression: 0.7 },
  normal: { name: 'Нормальный', income: 1.0, think: 18, aggression: 1.0 },
  hard: { name: 'Сложный', income: 1.25, think: 10, aggression: 1.3 },
};

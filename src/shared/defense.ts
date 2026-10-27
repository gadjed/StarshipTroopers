// Оборона: типи будівель і формат FX-інстансів. Спільне для симуляції, рендеру й HUD — лише дані.

export const B_TURRET = 0;
export const B_CANNON = 1;
export const B_MORTAR = 2;
export const B_FLAMER = 3;
export const B_TESLA = 4;
export const B_WALL = 5;
export const B_CORNER = 6;
export const B_MINE = 7;
/** Інструменти HUD, що не є будівлями. */
export const TOOL_ORBITAL = 8;
export const TOOL_DEMOLISH = 9;
export const TOOL_NONE = -1;

const DEG = Math.PI / 180;

export interface BuildingDef {
  readonly name: string;
  /** Клавіша інструмента (KeyboardEvent.code). */
  readonly key: string;
  readonly keyLabel: string;
  /** Радіус «підставки» (для стіни — половина товщини, для кута — половина сторони). */
  readonly radius: number;
  /** Міцність (для стіни — на одиницю довжини). */
  readonly hp: number;
  /** Дальність, мінімальна дальність, повний кут робочої зони (0 — зони немає). */
  readonly range: number;
  readonly minRange: number;
  readonly arc: number;
  readonly hint: string;
}

export const BUILDINGS: readonly BuildingDef[] = [
  {
    name: 'ТУРЕЛЬ', key: 'Digit1', keyLabel: '1', radius: 3, hp: 600, range: 300, minRange: 0, arc: 80 * DEG,
    hint: 'черга 200 набоїв, 0.5 с перезарядка · 80° · 300 м',
  },
  {
    name: 'ГАРМАТА', key: 'Digit2', keyLabel: '2', radius: 4.5, hp: 1200, range: 700, minRange: 40, arc: 90 * DEG,
    hint: 'фугас по площі, 1 постріл / 3 с · 90° · 700 м',
  },
  {
    name: 'МІНОМЕТ', key: 'Digit3', keyLabel: '3', radius: 3.5, hp: 800, range: 550, minRange: 70, arc: 120 * DEG,
    hint: 'навісний вогонь через скелі · 120° · 70–550 м',
  },
  {
    name: 'ВОГНЕМЕТ', key: 'Digit4', keyLabel: '4', radius: 3, hp: 700, range: 90, minRange: 0, arc: 70 * DEG,
    hint: 'запалює зони вогню, шкодить вогонь · 70° · 90 м',
  },
  {
    name: 'ЕЛЕКТРО', key: 'Digit5', keyLabel: '5', radius: 3.5, hp: 800, range: 180, minRange: 0, arc: 120 * DEG,
    hint: 'блискавка ланцюгом, 8 цілей, −28 % за стрибок · 120° · 180 м',
  },
  {
    name: 'СТІНА', key: 'Digit6', keyLabel: '6', radius: 1.5, hp: 40, range: 0, minRange: 0, arc: 0,
    hint: 'тягни від початку до кінця · кути на кінцях — міцніше',
  },
  {
    name: 'КУТ', key: 'Digit7', keyLabel: '7', radius: 2.5, hp: 2500, range: 0, minRange: 0, arc: 0,
    hint: 'кінці стін «прилипають» до кутів: 1 кут ×1.35, 2 кути ×3',
  },
  {
    name: 'МІННЕ ПОЛЕ', key: 'Digit8', keyLabel: '8', radius: 1.4, hp: 0, range: 4, minRange: 0, arc: 0,
    hint: '7 мін за клік · вибух через 1 с після наближення ворога (9 м) · через 25 с міна зводиться знову · тягни — ряд полів',
  },
];

export interface ToolDef {
  readonly id: number;
  readonly name: string;
  readonly key: string;
  readonly keyLabel: string;
  readonly hint: string;
}

export const TOOLS: readonly ToolDef[] = [
  ...BUILDINGS.map((b, id) => ({ id, name: b.name, key: b.key, keyLabel: b.keyLabel, hint: b.hint })),
  { id: TOOL_ORBITAL, name: 'ОРБІТА', key: 'Digit9', keyLabel: '9', hint: 'залп із орбіти: 10 снарядів неприцільно в коло 40 м' },
  { id: TOOL_DEMOLISH, name: 'ЗНЕСТИ', key: 'KeyX', keyLabel: 'X', hint: 'клік по будівлі — прибрати' },
];

/** Чи має будівля «ствол» (напрямок і робочу зону). */
export const isWeapon = (type: number): boolean => type <= B_TESLA;

// --- Формат FX-інстансу (8 float): [ax, ay, bx, by, size, kind, t, extra]
// Диски (kind < FX_SEGMENT): центр = a (для снарядів — інтерполяція a→b), b — додаткові параметри.
// Відрізки (kind ≥ FX_SEGMENT): від a до b, size — півширина.
export const FX_FLOATS = 8;
/** Ємність FX-буфера кадру (інстансів). */
export const MAX_FX_INSTANCES = 48_000;

export const FX_SHELL = 0;
export const FX_MORTAR = 1;
export const FX_FLAME = 2;
export const FX_FIRE = 3;
export const FX_EXPLOSION = 4;
export const FX_MINE = 5;
export const FX_ORBITAL_MARK = 6;
export const FX_ORBITAL_SHELL = 7;
export const FX_HEAD = 8;
export const FX_SECTOR = 9;
export const FX_SPARK = 10;
export const FX_GHOST = 14;
export const FX_CORE_HP = 15;
export const FX_HP_BAR = 16;
export const FX_COMMANDER = 17;
export const FX_SEGMENT = 20;
export const FX_TRACER = 20;
export const FX_LIGHTNING = 21;
export const FX_GHOST_WALL = 22;

/** Буфер FX-інстансів кадру. `under` перших інстансів малюються під жуками (зони, міни). */
export interface FxFrame {
  instances: Float32Array;
  count: number;
  under: number;
}

export function pushFx(
  f: FxFrame,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  size: number,
  kind: number,
  t: number,
  extra: number,
): void {
  if ((f.count + 1) * FX_FLOATS > f.instances.length) return;
  const o = f.count * FX_FLOATS;
  const d = f.instances;
  d[o] = ax;
  d[o + 1] = ay;
  d[o + 2] = bx;
  d[o + 3] = by;
  d[o + 4] = size;
  d[o + 5] = kind;
  d[o + 6] = t;
  d[o + 7] = extra;
  f.count++;
}

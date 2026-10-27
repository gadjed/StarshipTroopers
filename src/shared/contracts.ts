// Контракт між симуляцією і рендером: тільки plain data (typed arrays + числа).
// Рендер не імпортує жодного класу з sim/, а симуляція — нічого з render/.
// Усі ці структури можна передати у Worker (structured clone) або покласти
// в SharedArrayBuffer без змін у рендері.

export const OBSTACLE_CIRCLE = 0;
export const OBSTACLE_RECT = 1;

export const OBSTACLE_STYLE_ROCK = 0;
/** Стіна; +1 — підтримана кутом з одного боку, +2 — з обох. */
export const OBSTACLE_STYLE_WALL = 1;
export const OBSTACLE_STYLE_CORNER = 4;
export const OBSTACLE_STYLE_PAD = 5;

/**
 * Статичні перешкоди у форматі SoA.
 * circle: a = радіус (b не використовується);
 * rect:   a, b = половини ширини/висоти; cos/sin — поворот (world = c + R(θ)·local).
 * Скелі руйнуються: a/b зменшуються на місці, `alive = 0` — скелю знищено.
 *
 * Масиви мають запас ємності під будівлі гравця (стіни, кути, підставки зброї): перші
 * `rockCount` елементів — скелі, далі — будівлі. `count` — верхня межа зайнятих індексів.
 */
export interface ObstacleSet {
  count: number;
  rockCount: number;
  kind: Uint8Array;
  /** Вигляд у рендері: OBSTACLE_STYLE_*. */
  style: Uint8Array;
  /** Індекс будівлі-власника (−1 — скеля). */
  owner: Int32Array;
  /**
   * Ціна проходу крізь перешкоду для flow field, у клітинках nav-гріда на клітинку.
   * 0 — непрохідна (скеля); >0 — будівля, яку жуки можуть прогризти (∝ залишковій міцності);
   * <0 — у flow field не потрапляє взагалі (дрібні підставки зброї: їх обходять колізії).
   */
  navCost: Float32Array;
  alive: Uint8Array;
  /** Пошкодження 0..1 (для рендеру корозії). */
  damage: Float32Array;
  x: Float32Array;
  y: Float32Array;
  a: Float32Array;
  b: Float32Array;
  cos: Float32Array;
  sin: Float32Array;
}

/**
 * Кратери локальної корозії скель: вільний простір, вигризений у скелях (кола).
 * version збільшується, коли кратер з'явився чи виріс → рендер оновлює маску ерозії.
 */
export interface ErosionData {
  count: number;
  version: number;
  x: Float32Array;
  y: Float32Array;
  r: Float32Array;
}

export interface NavFieldData {
  /** Кількість клітинок по стороні (грід size×size). */
  size: number;
  cellSize: number;
  /** 1 — клітинка заблокована. */
  blocked: Uint8Array;
  /** Integration field: відстань до цілі у світових одиницях (Infinity — недосяжно). */
  dist: Float32Array;
  /** Поле напрямків (одиничні вектори; 0,0 для заблокованих клітинок). */
  dirX: Float32Array;
  dirY: Float32Array;
  maxDist: number;
}

export interface MapData {
  seed: number;
  worldSize: number;
  obstacles: ObstacleSet;
  erosion: ErosionData;
  nav: NavFieldData;
  bunker: { x: number; y: number; r: number };
  /** Частка площі під скелями (0..1). */
  coverage: number;
  /** Збільшується, коли змінилась форма/стан скель → рендер перевантажує буфер скель. */
  obstacleVersion: number;
  /** Міцність ядра бункера. 0 — бункер знищено (game over). */
  coreHp: number;
  coreHpMax: number;
  /** Збільшується, коли підмінено flow field → рендер перевантажує текстуру оверлею. */
  navVersion: number;
}

/** Те, що симуляція віддає рендеру кожен кадр. */
export interface BugFrame {
  /** count * FLOATS_PER_BUG floats, щільно упаковані (тільки живі жуки). */
  instances: Float32Array;
  count: number;
  /** Збільшується, коли instances змінились → рендер робить upload лише тоді. */
  version: number;
}

/** Дані spatial hash для налагоджувального оверлею. */
export interface HashGridView {
  w: number;
  h: number;
  cellSize: number;
  counts: Uint32Array;
}

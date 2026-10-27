import type { ErosionData } from '../shared/contracts';

/** Найбільший радіус кратера. Тунель із ланцюжка кратерів ~8 м завширшки — пролазить і танк. */
export const CRATER_MAX_R = 4;
/** Наскільки вглиб скелі від точки контакту ставимо центр нового кратера. */
export const CRATER_DEPTH = 1.6;
/** Шкода в межах цього радіуса від центру наявного кратера поглиблює його, а не створює новий. */
const CRATER_MERGE = 1.2;
const MAX_CRATERS = 16384;
const CELL = 4;

/**
 * Локальна корозія скель: скеля не зменшується вся, а жуки вигризають у ній кратери саме там,
 * де в неї впираються. Вільний простір = поза скелями ∪ кратери (CSG-віднімання кіл).
 *
 * Кратер росте з накопиченою шкодою (площа ∝ шкоді, як і здоров'я скелі ∝ площі). Коли він
 * досягає повного розміру, жуки заходять у нього, впираються в його дно — і там з'являється
 * наступний кратер, глибше. Так у натовпі, що тисне в одну точку, прогризається тунель.
 *
 * Пошук кратерів біля точки — свій грід 4×4 м зі зв'язними списками (head/next): кратери
 * лише додаються, тож вставка O(1) без перебудови.
 */
export class ErosionField implements ErosionData {
  count = 0;
  version = 0;
  readonly x = new Float32Array(MAX_CRATERS);
  readonly y = new Float32Array(MAX_CRATERS);
  readonly r = new Float32Array(MAX_CRATERS);
  /** Накопичена шкода кратера. */
  private readonly acc = new Float32Array(MAX_CRATERS);
  private readonly next = new Int32Array(MAX_CRATERS);
  private readonly head: Int32Array;
  private readonly w: number;
  private readonly fullHp: number;
  /** Кратерів, що досягли повного розміру з останнього скидання (сигнал перебудувати flow field). */
  completed = 0;

  /**
   * Вхід/вихід (без double-аргументів, див. ObstacleField.io).
   * addDamage: [x, y, шкода]. escape: [x, y, r] → [1 — повністю в кратері, x', y', зсув].
   */
  readonly io = new Float64Array(4);

  constructor(worldSize: number, hpPerArea: number) {
    this.w = Math.ceil(worldSize / CELL);
    this.head = new Int32Array(this.w * this.w).fill(-1);
    this.fullHp = Math.PI * CRATER_MAX_R * CRATER_MAX_R * hpPerArea;
  }

  reset(): void {
    this.count = 0;
    this.head.fill(-1);
    this.completed = 0;
    this.version++;
  }

  private cellOf(x: number, y: number): number {
    const w = this.w;
    let cx = (x / CELL) | 0;
    let cy = (y / CELL) | 0;
    cx = cx < 0 ? 0 : cx >= w ? w - 1 : cx;
    cy = cy < 0 ? 0 : cy >= w ? w - 1 : cy;
    return cy * w + cx;
  }

  /** Шкода в точці io[0..1] (уже всередині скелі). Повертає індекс кратера або −1. */
  addDamage(): number {
    const io = this.io;
    const x = io[0];
    const y = io[1];
    const dmg = io[2];
    const { head, next, w } = this;
    const cx = (x / CELL) | 0;
    const cy = (y / CELL) | 0;
    // Шкоду бере недорослий кратер, у межі якого (+CRATER_MERGE) лежить точка, — так натовп,
    // що тисне в одне місце, поглиблює одну виразку, а не розсипає сотні дрібних. Точка всередині
    // вже повного кратера — це вільний простір, шкода пропадає.
    let found = -1;
    let bestD = Infinity;
    const full = this.fullHp;
    for (let gy = cy - 2; gy <= cy + 2; gy++) {
      if (gy < 0 || gy >= w) continue;
      for (let gx = cx - 2; gx <= cx + 2; gx++) {
        if (gx < 0 || gx >= w) continue;
        for (let k = head[gy * w + gx]; k >= 0; k = next[k]) {
          const dx = this.x[k] - x;
          const dy = this.y[k] - y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (this.acc[k] >= full) {
            if (d < this.r[k] - 0.5) return -1;
            continue;
          }
          if (d < this.r[k] + CRATER_MERGE && d < bestD) {
            bestD = d;
            found = k;
          }
        }
      }
    }
    if (found < 0) {
      if (this.count >= MAX_CRATERS) return -1;
      found = this.count++;
      this.x[found] = x;
      this.y[found] = y;
      this.r[found] = 0;
      this.acc[found] = 0;
      const c = this.cellOf(x, y);
      next[found] = head[c];
      head[c] = found;
    }
    this.acc[found] += dmg;
    if (this.acc[found] >= full) {
      this.acc[found] = full;
      this.completed++;
    }
    this.r[found] = CRATER_MAX_R * Math.sqrt(this.acc[found] / full);
    this.version++;
    return found;
  }

  /**
   * Чи може коло io = [x, y, r] сховатися в кратері. Якщо повністю всередині якогось — io[0] = 1.
   * Інакше io[0] = 0, а io[1..2] — найближча позиція всередині кратера, io[3] — зсув до неї
   * (Infinity, якщо поруч немає кратера, в який коло влазить).
   */
  escape(): void {
    const io = this.io;
    const x = io[0];
    const y = io[1];
    const r = io[2];
    const { head, next, w } = this;
    const reach = ((CRATER_MAX_R + r) / CELL + 1) | 0;
    const cx = (x / CELL) | 0;
    const cy = (y / CELL) | 0;
    let best = Infinity;
    let bx = x;
    let by = y;
    for (let gy = cy - reach; gy <= cy + reach; gy++) {
      if (gy < 0 || gy >= w) continue;
      for (let gx = cx - reach; gx <= cx + reach; gx++) {
        if (gx < 0 || gx >= w) continue;
        for (let k = head[gy * w + gx]; k >= 0; k = next[k]) {
          const room = this.r[k] - r;
          if (room <= 0) continue;
          const dx = x - this.x[k];
          const dy = y - this.y[k];
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d <= room) {
            io[0] = 1;
            return;
          }
          const disp = d - room;
          if (disp < best) {
            best = disp;
            bx = this.x[k] + (dx / d) * room;
            by = this.y[k] + (dy / d) * room;
          }
        }
      }
    }
    io[0] = 0;
    io[1] = bx;
    io[2] = by;
    io[3] = best;
  }
}

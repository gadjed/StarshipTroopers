import type { BugStore } from './bugStore';

/**
 * Рівномірний грід для пошуку сусідів, що перебудовується з нуля щокадру
 * через counting sort. Жодних Map чи масивів масивів: лише плоскі typed arrays.
 *
 *   cellCount[c]        — скільки жуків у клітинці c;
 *   cellStart[c]        — префіксна сума: жуки клітинки c лежать у
 *                         sorted*[cellStart[c] .. cellStart[c+1]);
 *   sortedIndex[k]      — індекс жука в BugStore;
 *   sortedX/Y/R[k]      — копії позиції й радіуса в тому ж порядку.
 *
 * Копії позицій — головний трюк для кешу: при переборі сусідів читаємо суміжну
 * пам'ять замість випадкових стрибків по posX[j]. До того ж це «знімок» стану
 * на початок кроку, тож оновлення жуків не залежить від порядку обходу (Jacobi) —
 * цикл можна розпаралелити по воркерах без гонок.
 */
export class SpatialHash {
  readonly cellSize: number;
  readonly invCell: number;
  readonly w: number;
  readonly h: number;
  readonly numCells: number;

  readonly cellStart: Uint32Array;
  readonly cellCount: Uint32Array;
  private readonly cursor: Uint32Array;
  readonly sortedIndex: Int32Array;
  readonly sortedX: Float32Array;
  readonly sortedY: Float32Array;
  readonly sortedR: Float32Array;
  /** Клітинка кожного жука (індекс BugStore) — щоб не рахувати її двічі. */
  private readonly bugCell: Int32Array;
  /** Кількість жуків у відсортованих масивах. */
  count = 0;

  constructor(worldSize: number, cellSize: number, capacity: number) {
    this.cellSize = cellSize;
    this.invCell = 1 / cellSize;
    this.w = Math.ceil(worldSize / cellSize);
    this.h = this.w;
    this.numCells = this.w * this.h;
    this.cellStart = new Uint32Array(this.numCells + 1);
    this.cellCount = new Uint32Array(this.numCells);
    this.cursor = new Uint32Array(this.numCells + 1);
    this.sortedIndex = new Int32Array(capacity);
    this.sortedX = new Float32Array(capacity);
    this.sortedY = new Float32Array(capacity);
    this.sortedR = new Float32Array(capacity);
    this.bugCell = new Int32Array(capacity);
  }

  build(store: BugStore): void {
    const { posX, posY, radius, alive } = store;
    const hw = store.highWater;
    const { cellCount, cellStart, cursor, bugCell, sortedIndex, sortedX, sortedY, sortedR } = this;
    const w = this.w;
    const wMax = w - 1;
    const hMax = this.h - 1;
    const inv = this.invCell;

    // Прохід 1: гістограма.
    cellCount.fill(0);
    for (let i = 0; i < hw; i++) {
      if (alive[i] === 0) continue;
      let cx = (posX[i] * inv) | 0;
      let cy = (posY[i] * inv) | 0;
      if (cx > wMax) cx = wMax;
      else if (cx < 0) cx = 0;
      if (cy > hMax) cy = hMax;
      else if (cy < 0) cy = 0;
      const c = cy * w + cx;
      bugCell[i] = c;
      cellCount[c]++;
    }

    // Прохід 2: exclusive prefix sum → початок кожної клітинки.
    const nc = this.numCells;
    let sum = 0;
    for (let c = 0; c < nc; c++) {
      cellStart[c] = sum;
      sum += cellCount[c];
    }
    cellStart[nc] = sum;
    this.count = sum;

    // Прохід 3: розкладка (scatter) у відсортований порядок.
    cursor.set(cellStart);
    for (let i = 0; i < hw; i++) {
      if (alive[i] === 0) continue;
      const dst = cursor[bugCell[i]]++;
      sortedIndex[dst] = i;
      sortedX[dst] = posX[i];
      sortedY[dst] = posY[i];
      sortedR[dst] = radius[i];
    }
  }
}

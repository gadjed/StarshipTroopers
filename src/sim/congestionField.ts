import type { NavFieldData } from '../shared/contracts';
import { AVOID_PROBE, CONGESTION_GAIN_MIN, CONGESTION_GAIN_RANGE, CONGESTION_LOOKAHEAD } from './config';
import { IntMinHeap, KEY_SCALE } from './heap';
import { overBudget, type Job } from './jobs';

const NX = [1, -1, 0, 0, 1, 1, -1, -1];
const NY = [0, 0, 1, -1, 1, -1, 1, -1];
const NCOST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

/**
 * Грубе (128×128) поле «з урахуванням заторів» — відповідає на питання «чи варто обійти
 * перешкоду з іншого боку, бо цей прохід забитий».
 *
 * Періодично: ціна клітинки = 1 + weight·(ρ/ρ_jam)², де ρ — щільність натовпу, і Dijkstra
 * від цілі → `dist`. Далі для кожної клітинки вирішуємо, чи варто звертати: порівнюємо ціну
 * шляху (за полем заторів) у двох точках попереду — куди веде основне any-angle поле і куди
 * радить поле заторів. Спільна черга біля бункера в різниці скорочується, тож реагуємо саме на
 * розвилки: «цей прохід забитий, а з іншого боку скелі вільно». Результат — вага `blendW` і
 * зважений напрямок `blendX/Y`; жук лише білінійно читає їх (рішення залежить від місця).
 *
 * Чому не замінити ним основне поле: 8-сусідній Dijkstra дає квантовані напрямки (та сама
 * «зірка»). Тож це поле лише підказує, КУДИ звернути там, де є затор; на вільній місцевості
 * жуки йдуть чистим any-angle полем.
 *
 * Перерахунок — фонова задача (jobs.ts), розмазана на кілька кроків. Проміжні масиви внутрішні,
 * а те, що читають жуки (blend*), — подвійний буфер: підміна лише по завершенні.
 */
export class CongestionField {
  readonly size: number;
  readonly cellSize: number;
  /** Вага переходу на поле заторів [0..1] і напрямок обходу, помножений на неї (передній буфер). */
  blendW: Float32Array;
  blendX: Float32Array;
  blendY: Float32Array;

  private backW: Float32Array;
  private backX: Float32Array;
  private backY: Float32Array;
  private readonly blocked: Uint8Array;
  private readonly dist: Float32Array;
  private readonly dirX: Float32Array;
  private readonly dirY: Float32Array;
  private readonly cost: Float32Array;
  private readonly goals: Int32Array;
  private readonly heap: IntMinHeap;
  private nav!: NavFieldData;

  constructor(worldSize: number, size: number, goalX: number, goalY: number, goalR: number) {
    this.size = size;
    this.cellSize = worldSize / size;
    const n = size * size;
    this.blocked = new Uint8Array(n);
    this.dist = new Float32Array(n);
    this.dirX = new Float32Array(n);
    this.dirY = new Float32Array(n);
    this.blendW = new Float32Array(n);
    this.blendX = new Float32Array(n);
    this.blendY = new Float32Array(n);
    this.backW = new Float32Array(n);
    this.backX = new Float32Array(n);
    this.backY = new Float32Array(n);
    this.cost = new Float32Array(n).fill(1);
    this.heap = new IntMinHeap(n * 8 + 16);

    const goals: number[] = [];
    const reach = goalR + this.cellSize;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5) * this.cellSize - goalX;
        const dy = (y + 0.5) * this.cellSize - goalY;
        if (dx * dx + dy * dy <= reach * reach) goals.push(y * size + x);
      }
    }
    this.goals = Int32Array.from(goals);
  }

  /** Нова мапа: прибираємо ціни заторів попередньої. */
  resetCost(): void {
    this.cost.fill(1);
  }

  /** Нове основне поле (мапа або зруйнована скеля): оновлюємо прохідність і поради. */
  *rebuild(nav: NavFieldData): Job {
    this.nav = nav;
    const size = this.size;
    // Даунсемплінг nav-гріда: груба клітинка заблокована, якщо заблокована хоч одна дрібна.
    // Консервативно: м'якше правило «відкривало» щілини, яких немає в точному гріді, і поле
    // заторів вело жуків у тупики між скелями.
    const f = nav.size / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let b = 0;
        for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) b += nav.blocked[(y * f + dy) * nav.size + x * f + dx];
        this.blocked[y * size + x] = b > 0 ? 1 : 0;
      }
    }
    for (let k = 0; k < this.goals.length; k++) this.blocked[this.goals[k]] = 0;
    yield* this.recompute();
  }

  /** Перерахунок з урахуванням поточної щільності (сітка density, жуків/од²). ~4 мс сумарно. */
  *update(density: Float32Array, densityW: number, densityCell: number, weight: number, jamDensity: number): Job {
    this.fillCost(density, densityW, densityCell, weight, jamDensity);
    yield* this.recompute();
  }

  private fillCost(density: Float32Array, densityW: number, densityCell: number, weight: number, jamDensity: number): void {
    const size = this.size;
    const cs = this.cellSize;
    const cost = this.cost;
    const inv = 1 / jamDensity;
    for (let y = 0; y < size; y++) {
      const dy = Math.min(densityW - 1, (((y + 0.5) * cs) / densityCell) | 0);
      for (let x = 0; x < size; x++) {
        const dx = Math.min(densityW - 1, (((x + 0.5) * cs) / densityCell) | 0);
        const r = density[dy * densityW + dx] * inv;
        cost[y * size + x] = 1 + weight * r * r;
      }
    }
  }

  /**
   * Генератор — лише диспетчер; важка робота у звичайних методах порціями (див. коментар у
   * NavFieldBuilder.build: важкі цикли всередині генератора V8 майже не оптимізує).
   */
  private *recompute(): Job {
    this.seedDijkstra();
    while (!this.dijkstraStep(1024)) if (overBudget()) yield;
    for (let y = 0; y < this.size; y += 32) {
      this.computeDirections(y, Math.min(this.size, y + 32));
      if (overBudget()) yield;
    }
    for (let y = 0; y < this.size; y += 32) {
      this.computeBlend(y, Math.min(this.size, y + 32));
      if (overBudget()) yield;
    }
    // Атомарна підміна: жуки весь час бачили попередній узгоджений стан.
    const w = this.blendW;
    const x = this.blendX;
    const y = this.blendY;
    this.blendW = this.backW;
    this.blendX = this.backX;
    this.blendY = this.backY;
    this.backW = w;
    this.backX = x;
    this.backY = y;
  }

  private computeBlend(y0: number, y1: number): void {
    const { size, cellSize: cs, nav, dirX, dirY, blocked, dist } = this;
    const blendW = this.backW;
    const blendX = this.backX;
    const blendY = this.backY;
    const navInv = 1 / nav.cellSize;
    const inv = 1 / cs;
    const L = CONGESTION_LOOKAHEAD;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < size; x++) {
        const c = y * size + x;
        blendW[c] = 0;
        blendX[c] = 0;
        blendY[c] = 0;
        const cx = dirX[c];
        const cy = dirY[c];
        if (blocked[c] || (cx === 0 && cy === 0)) continue;
        const px = (x + 0.5) * cs;
        const py = (y + 0.5) * cs;
        // Напрямок основного поля в центрі клітинки.
        const ni = Math.floor(py * navInv) * nav.size + Math.floor(px * navInv);
        const sx = nav.dirX[ni];
        const sy = nav.dirY[ni];
        if (sx === 0 && sy === 0) continue;
        if (cx * sx + cy * sy >= 0.94) continue; // поради майже збігаються (< ~20°) — лишаємо основне поле
        // Груба клітинка не бачить дрібної геометрії: точним полем перевіряємо, що там не скеля.
        const fx = Math.floor((px + cx * AVOID_PROBE) * navInv);
        const fy = Math.floor((py + cy * AVOID_PROBE) * navInv);
        if (fx < 0 || fy < 0 || fx >= nav.size || fy >= nav.size || nav.blocked[fy * nav.size + fx]) continue;
        // Ціна шляху в точках попереду (найближча клітинка; усе інлайн — без викликів із
        // double-аргументами, які V8 пакує в HeapNumber).
        const ax = Math.floor((px + sx * L) * inv);
        const ay = Math.floor((py + sy * L) * inv);
        const bx = Math.floor((px + cx * L) * inv);
        const by = Math.floor((py + cy * L) * inv);
        if (ax < 0 || ay < 0 || ax >= size || ay >= size || bx < 0 || by < 0 || bx >= size || by >= size) continue;
        const viaStatic = dist[ay * size + ax];
        const viaCong = dist[by * size + bx];
        if (viaStatic === Infinity || viaCong === Infinity) continue;
        let w = (viaStatic - viaCong - CONGESTION_GAIN_MIN) / CONGESTION_GAIN_RANGE;
        if (w <= 0) continue;
        if (w > 1) w = 1;
        blendW[c] = w;
        blendX[c] = cx * w;
        blendY[c] = cy * w;
      }
    }
  }

  private seedDijkstra(): void {
    const { heap, dist: out } = this;
    out.fill(Infinity);
    heap.size = 0;
    for (let k = 0; k < this.goals.length; k++) {
      out[this.goals[k]] = 0;
      heap.push(0, this.goals[k]);
    }
  }

  /** До `maxPops` вершин купи. true — завершено. */
  private dijkstraStep(maxPops: number): boolean {
    const { size, blocked, cost, heap, dist: out } = this;
    const cs = this.cellSize;
    for (let pops = 0; pops < maxPops; pops++) {
      if (heap.size === 0) return true;
      const key = heap.peekKey();
      const c = heap.pop();
      const d = out[c];
      if (key > Math.round(d * KEY_SCALE)) continue; // застарілий запис
      const gx = c % size;
      const gy = (c / size) | 0;
      const cc = cost[c];
      for (let k = 0; k < 8; k++) {
        const nx = gx + NX[k];
        const ny = gy + NY[k];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const nc = ny * size + nx;
        if (blocked[nc]) continue;
        if (k >= 4 && (blocked[gy * size + nx] || blocked[ny * size + gx])) continue;
        // Ціна ребра — середнє цін двох клітинок × довжина.
        const nd = d + NCOST[k] * cs * 0.5 * (cc + cost[nc]);
        if (nd < out[nc]) {
          out[nc] = nd;
          heap.push(Math.round(nd * KEY_SCALE), nc);
        }
      }
    }
    return heap.size === 0;
  }

  /** Напрямок спуску: сума напрямків до нижчих сусідів, зважена крутизною². */
  private computeDirections(y0: number, y1: number): void {
    const size = this.size;
    const { blocked, dist, dirX, dirY } = this;
    for (let gy = y0; gy < y1; gy++) {
      for (let gx = 0; gx < size; gx++) {
        const c = gy * size + gx;
        dirX[c] = 0;
        dirY[c] = 0;
        const d = dist[c];
        if (blocked[c] || d === Infinity || d === 0) continue;
        let vx = 0;
        let vy = 0;
        for (let k = 0; k < 8; k++) {
          const nx = gx + NX[k];
          const ny = gy + NY[k];
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const nc = ny * size + nx;
          if (blocked[nc]) continue;
          if (k >= 4 && (blocked[gy * size + nx] || blocked[ny * size + gx])) continue;
          const drop = (d - dist[nc]) / NCOST[k];
          if (drop <= 0) continue;
          const w = drop * drop;
          vx += (NX[k] / NCOST[k]) * w;
          vy += (NY[k] / NCOST[k]) * w;
        }
        const len = Math.sqrt(vx * vx + vy * vy);
        if (len > 1e-9) {
          dirX[c] = vx / len;
          dirY[c] = vy / len;
        }
      }
    }
  }
}

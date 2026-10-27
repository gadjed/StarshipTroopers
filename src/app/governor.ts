/**
 * Авто-ліміт жуків, що тримає ≥60 FPS.
 *
 * Модель: крок симуляції ≈ FIXED_MS + cost·N (лінійно від кількості жуків). Ціну одного жука
 * `cost` оцінюємо з реальних замірів кроку (EMA) і щопівсекунди ставимо ліміт так, щоб крок
 * вкладався в STEP_BUDGET_MS. При 30 Гц симуляції крок припадає на кожен другий кадр, тож
 * кадр із кроком ≈ крок + рендер — бюджет лишає запас на рендер і браузер до 16.7 мс.
 *
 * Додатковий запобіжник — реальні пропущені кадри (dt > SLOW_FRAME_MS): якщо їх більше 5 %,
 * ліміт ріжемо незалежно від моделі (GC, інші вкладки, GPU…).
 *
 * Ліміт лише стримує спавн: якщо жуків уже більше, ніхто не гине — просто нові не з'являються.
 * Знижуємо швидко, підвищуємо повільно (і лише коли ліміт справді впирається), щоб не «гойдало».
 */
const STEP_BUDGET_MS = 12;
const FIXED_MS = 2.5; // хеш-грід, щільність, фонові задачі (бюджет 1.5 мс)
const SLOW_FRAME_MS = 21;
const MIN_LIMIT = 2_000;
const ADJUST_PERIOD_MS = 500;

export class FpsGovernor {
  /** Поточний авто-ліміт. */
  limit: number;
  /** Оцінка ціни одного жука в кроці, мс. */
  costPerBug = 0;

  private frames = 0;
  private slowFrames = 0;
  private lastAdjust = 0;

  constructor(initial: number) {
    this.limit = initial;
  }

  /** Викликати щокадру. stepMs — середній час одного кроку в цьому кадрі (0, якщо кроку не було). */
  sample(stepMs: number, alive: number, frameDtMs: number): void {
    // Великі паузи (вкладка у фоні, брейкпоінт) — не про продуктивність, ігноруємо.
    if (frameDtMs < 100) {
      this.frames++;
      if (frameDtMs > SLOW_FRAME_MS) this.slowFrames++;
    }
    if (stepMs > 0 && alive > 2_000) {
      const c = Math.max(0, stepMs - FIXED_MS) / alive;
      this.costPerBug = this.costPerBug === 0 ? c : this.costPerBug + (c - this.costPerBug) * 0.1;
    }
  }

  update(nowMs: number, alive: number, hardLimit: number): number {
    if (nowMs - this.lastAdjust < ADJUST_PERIOD_MS) return this.limit;
    this.lastAdjust = nowMs;

    let target = this.costPerBug > 0 ? (STEP_BUDGET_MS - FIXED_MS) / this.costPerBug : this.limit * 1.5;
    if (this.frames > 10 && this.slowFrames / this.frames > 0.05) target = Math.min(target, this.limit * 0.85);
    this.frames = 0;
    this.slowFrames = 0;

    if (target < this.limit) {
      this.limit += (target - this.limit) * 0.5;
    } else if (alive >= this.limit * 0.9) {
      this.limit += (target - this.limit) * 0.15;
    }
    this.limit = Math.round(Math.min(hardLimit, Math.max(MIN_LIMIT, this.limit)));
    return this.limit;
  }
}

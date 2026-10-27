import {
  WAVE_DURATION,
  WAVE_INTERVAL,
  WAVE_MULTIPLIER,
  WAVE_PREP,
  WAVE_RATE_GROWTH,
  WAVE_SIDE_BIAS,
  WAVE_START_RATE,
} from './config';

/**
 * Директор хвиль: темп спавну постійно росте, а кожні WAVE_INTERVAL секунд приходить хвиля —
 * WAVE_DURATION секунд спавну ×WAVE_MULTIPLIER, переважно з одного боку мапи.
 * Стелю кількості живих жуків тримає не директор, а ліміт (зокрема авто-ліміт FPS) —
 * директор лише каже «скільки хочеться», а спавн обрізає за лімітом.
 */
export class WaveDirector {
  /** Час гри з увімкненим директором, с. Від'ємний — іде підготовка (спавну немає). */
  time = -WAVE_PREP;
  /** Номер останньої хвилі (0 — ще не було). */
  wave = 0;
  /** Поточна бажана швидкість спавну, жуків/с. */
  rate = WAVE_START_RATE;
  /** Бік поточної хвилі (0 — північ, 1 — схід, 2 — південь, 3 — захід) або −1 поза хвилею. */
  side = -1;
  /** Частка жуків, що йдуть з боку хвилі. */
  sideBias = 0;

  private waveEndsAt = -1;
  private readonly rng: () => number;

  constructor(rng: () => number) {
    this.rng = rng;
  }

  reset(): void {
    this.time = -WAVE_PREP;
    this.wave = 0;
    this.side = -1;
    this.waveEndsAt = -1;
    this.rate = WAVE_START_RATE;
  }

  get inWave(): boolean {
    return this.side >= 0;
  }

  /** Скільки секунд підготовки лишилось (0 — бій уже йде). */
  get prepLeft(): number {
    return this.time < 0 ? -this.time : 0;
  }

  /** Закінчити підготовку зараз. */
  skipPrep(): void {
    if (this.time < 0) this.time = 0;
  }

  get secondsToNextWave(): number {
    return (this.wave + 1) * WAVE_INTERVAL - this.time;
  }

  update(dt: number): void {
    this.time += dt;
    if (this.time < 0) {
      this.rate = 0;
      this.side = -1;
      this.sideBias = 0;
      return;
    }
    const base = WAVE_START_RATE + (WAVE_RATE_GROWTH * this.time) / 60;
    if (this.time >= (this.wave + 1) * WAVE_INTERVAL) {
      this.wave++;
      this.side = (this.rng() * 4) | 0;
      this.waveEndsAt = this.time + WAVE_DURATION;
    }
    if (this.side >= 0 && this.time >= this.waveEndsAt) this.side = -1;
    this.rate = this.side >= 0 ? base * WAVE_MULTIPLIER : base;
    this.sideBias = this.side >= 0 ? WAVE_SIDE_BIAS : 0;
  }
}

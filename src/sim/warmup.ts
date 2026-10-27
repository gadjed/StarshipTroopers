import { B_CORNER, B_MINE, B_TESLA } from '../shared/defense';
import { MODE_BREAKTHROUGH, MODE_SIEGE, WAVE_INTERVAL, type SimParams } from './config';
import { Simulation } from './simulation';

/**
 * Прогрів JIT перед грою.
 *
 * V8 оптимізує функцію під ті гілки, які вже бачив. Коли в гарячому циклі вперше спрацьовує
 * рідкісна гілка (перша хвиля, перший укус, перша кислота, перший відхід убік…), оптимізований
 * код викидається («insufficient type feedback»), і кілька кроків іде в базовому компіляторі,
 * який пакує кожне дробове число в HeapNumber: підвисання кадру й десятки мегабайт сміття.
 *
 * Тому на старті ганяємо маленьку окрему симуляцію через усі ці ситуації. Методи класу —
 * спільні функції для всіх екземплярів, тож зібраний фідбек дістається й основній симуляції.
 * Оборона теж: усі види зброї, стіни з кутами, міни й орбітальний удар — щоб перші постріли
 * в грі не зривали оптимізацію кроку.
 * Займає ~2 с (коротші прогони не встигають дійти до застрягань, укусів і руйнування скель —
 * перевірено: 0.7 с прогріву лишали ~10 деоптимізацій за 200 с гри, 2 с — одну). Повертає час у мс.
 */
export function warmUpJit(worldSize: number, seed: number): number {
  const t0 = performance.now();
  const params: SimParams = {
    maxAlive: 8_000,
    hardLimit: 8_000,
    spawnRate: 6_000,
    autoWaves: 1,
    destruction: 40, // скелі мають встигнути роз'їстись і впасти за секунди
    speedMul: 1.5,
    pushStrength: 1,
    avoidStrength: 1,
    congestionStrength: 1,
    mode: MODE_BREAKTHROUGH,
  };
  const sim = new Simulation(worldSize, 10_000, params, seed);
  const dt = 1 / 30;
  sim.director.time = WAVE_INTERVAL - 2; // хвиля почнеться за 2 с
  const c = worldSize / 2;
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    sim.build(k % (B_TESLA + 1), c + Math.cos(a) * 45, c + Math.sin(a) * 45, a);
  }
  const R = 75;
  for (let k = 0; k < 8; k++) {
    const a0 = (k / 8) * Math.PI * 2;
    const a1 = ((k + 0.7) / 8) * Math.PI * 2;
    sim.build(B_CORNER, c + Math.cos(a0) * R, c + Math.sin(a0) * R, 0);
    sim.buildWall(c + Math.cos(a0) * R, c + Math.sin(a0) * R, c + Math.cos(a1) * R, c + Math.sin(a1) * R);
  }
  for (let k = 0; k < 12; k++) sim.build(B_MINE, c - 140 + k * 7, c + 120, 0);
  // Перезарядка турелі теж має трапитись під час прогріву.
  for (let b = 0; b < sim.defense.bCount; b++) sim.defense.bAmmo[b] = 3;
  for (let s = 0; s < 420; s++) {
    if (s % 90 === 0) sim.orbital(c + 150, c - 100);
    if (s % 140 === 0) sim.spawnCommander(s / 140); // командири: аура, розштовхування, корозія
    sim.packFx(true, -1, s * dt);
    sim.step(dt);
  }
  params.hardLimit = 4_000; // cull
  for (let s = 0; s < 30; s++) sim.step(dt);
  params.hardLimit = 8_000;
  params.autoWaves = 0;
  params.mode = MODE_SIEGE;
  for (let s = 0; s < 420; s++) sim.step(dt);
  params.avoidStrength = 0;
  params.congestionStrength = 0;
  params.destruction = 0;
  for (let s = 0; s < 30; s++) sim.step(dt);
  sim.packRender();
  return performance.now() - t0;
}

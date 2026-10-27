/**
 * Фонові задачі симуляції з бюджетом часу на крок (time slicing).
 *
 * Задача — генератор, який сам перевіряє `overBudget()` у своїх циклах і робить `yield`,
 * коли час кроку вичерпано. Симуляція щокроку викликає `next()` один раз. Так важкі
 * перерахунки (flow field ~80 мс, поле заторів ~4 мс) розмазуються на багато кадрів без фризів,
 * а результат підміняється атомарно, коли задачу завершено.
 *
 * У Worker-версії ці ж генератори можна просто «доганяти» до кінця в окремому потоці.
 */
export type Job<T = void> = Generator<void, T, void>;

let deadline = Infinity;

/** Встановлює дедлайн для задач цього кроку (Infinity — без обмеження, для синхронного запуску). */
export function setJobDeadline(t: number): void {
  deadline = t;
}

export function overBudget(): boolean {
  return performance.now() > deadline;
}

/** Синхронно доганяє задачу до кінця (завантаження мапи, тести). */
export function runToEnd<T>(job: Job<T>): T {
  const saved = deadline;
  deadline = Infinity;
  let r = job.next();
  while (!r.done) r = job.next();
  deadline = saved;
  return r.value;
}

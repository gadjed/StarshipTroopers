import { MAX_BUG_RADIUS } from '../shared/constants';

// Параметри симуляції, що не змінюються під час гри.

/** Розмір клітинки spatial hash. Має бути ≥ максимальної дистанції взаємодії двох жуків. */
export const HASH_CELL_SIZE = 4;
export const NAV_GRID_SIZE = 256;
/**
 * На скільки «роздуваємо» перешкоди при растеризації в nav-грід: не менше за радіус
 * найбільшого жука, інакше маршрути ведуть у щілини, куди танк фізично не пролазить,
 * і там утворюються затори-«чаші».
 */
export const NAV_INFLATE = MAX_BUG_RADIUS + 0.35;
/** Клітинка грубого гріда для пошуку перешкод при колізіях. */
export const OBSTACLE_CELL_SIZE = 16;

/** Радіус «особистого простору»: множник до r_i + r_j для м'якого розштовхування. */
export const SEPARATION_RANGE = 1.2;
/**
 * Максимум кандидатів-сусідів «уперед» (half-shell), яких переглядає один жук.
 * У нормальному натовпі їх ~15–20; ліміт обмежує вартість у патологічно щільних клітинках.
 */
export const MAX_SCAN = 48;
/** Яку частку перекриття прибираємо за крок (Jacobi-релаксація, <1 щоб не було осциляцій). */
export const OVERLAP_RELAX = 0.5;
/** Сума відносних перекриттів Σ(r_i+r_j−d)/(r_i+r_j), за якої жук вважає себе повністю «в заторі». */
export const JAM_PRESSURE = 0.3;
/** Наскільки затор зменшує бажану швидкість (1 — до нуля). */
export const JAM_SLOWDOWN = 1;
/** Обмеження прискорення (од/с²) при множнику швидкості 1. */
export const MAX_ACCEL = 80;

/** Клітинка грубої сітки щільності для обходу скупчень (кратна HASH_CELL_SIZE). */
export const DENSITY_CELL_SIZE = 16;
/** Підсилення бічного ухилення від градієнта щільності (при множнику 1). */
export const AVOID_GAIN = 60;
/** Максимальне бічне ухилення (частка від одиничного напрямку руху). */
export const AVOID_MAX = 0.8;
/** Відстань «проби» в бік ухилення: туди має бути вільно й не далі від цілі. */
export const AVOID_PROBE = 8;

/** Розмір грубого поля заторів (128×128, клітинка ≈ 7.8 од.). */
export const CONGESTION_GRID_SIZE = 128;
/** Як часто перераховувати поле заторів (кроків симуляції). */
export const CONGESTION_PERIOD_STEPS = 20;
/** Ціна клітинки = 1 + CONGESTION_WEIGHT·(ρ/JAM_DENSITY)² при множнику 1. */
export const CONGESTION_WEIGHT = 8;
/** Щільність «повного затору», жуків/од² (щільна упаковка жуків r≈1 — ~0.29). */
export const JAM_DENSITY = 0.25;
/** Наскільки далеко вперед порівнюємо ціну шляху двома напрямками, од. */
export const CONGESTION_LOOKAHEAD = 12;
/** Мінімальний виграш (од. «ціни шляху»), з якого варто звертати на обхід. */
export const CONGESTION_GAIN_MIN = 4;
/** Виграш понад мінімальний, за якого жук повністю йде порадою поля заторів. */
export const CONGESTION_GAIN_RANGE = 16;

/** Скільки секунд без наближення до цілі біля скелі вважається «застряганням». */
export const STUCK_TIME = 1.5;
/** Наскільки (од.) треба наблизитись, щоб це вважалось прогресом. */
export const STUCK_PROGRESS = 1.5;
/** Тривалість відходу вбік, с. */
export const DETOUR_TIME = 1.2;
/** Відстань бічної «проби», щоб вибрати, в який бік відходити. */
export const DETOUR_PROBE = 12;

// --- Руйнування

/** Здоров'я скелі на одиницю площі (і ціна вигризання кратера). Скеля r=20 (~1250 од²) ≈ 2500 HP. */
export const OBSTACLE_HP_PER_AREA = 2;
/**
 * Ціна вигризання кратера на одиницю площі. Менша за здоров'я скелі: прохід прогризається
 * помітно швидше, ніж скеля «закінчується» цілком (тоді рештки розсипаються).
 */
export const EROSION_HP_PER_AREA = 0.6;
/** «Тиск» натовпу (див. JAM_PRESSURE), з якого жуки, що вперлися в скелю, її роз'їдають. */
export const CORRODE_PRESSURE = 0.12;
/** «Тиск», з якого великий жук кусає дрібніших сусідів. */
export const BITE_PRESSURE = 0.28;
/** Скільки секунд без прогресу має простояти жук, щоб почати кусатись. */
export const BITE_STUCK = 0.8;
/** У скільки разів радіус кусаючого має бути більшим за радіус жертви. */
export const BITE_RATIO = 1.3;

// --- Будівлі гравця як перешкоди

/** Запас слотів у ObstacleSet під стіни, кути й підставки зброї. */
export const MAX_BUILDING_OBSTACLES = 4096;
/** Ціна проходу крізь будівлю для flow field: клітинок nav-гріда на одиницю міцності… */
export const BUILDING_NAV_COST = 0.02;
/** …але не менше/не більше (у клітинках на клітинку будівлі). */
export const BUILDING_NAV_COST_MIN = 4;
export const BUILDING_NAV_COST_MAX = 80;
/** Наскільки (частка міцності) має впасти міцність будівлі, щоб перебудувати flow field. */
export const BUILDING_NAV_STEP = 0.25;
/** Множник атаки жуків по будівлях (шкода/с = attack типу × це). */
export const BUILDING_ATTACK = 1;
/** Авторегенерація будівель: через скільки секунд без шкоди починається і яка частка міцності за секунду. */
export const BUILDING_REGEN_DELAY = 6;
export const BUILDING_REGEN_RATE = 0.03;
/** Авторегенерація ядра бункера (повільніша). */
export const CORE_REGEN_DELAY = 10;
export const CORE_REGEN_RATE = 0.005;
/** Командири: скільки з хвилею (1 + wave/2, не більше), і раз на скільки секунд поодинці (з хвилями). */
export const COMMANDERS_PER_WAVE_MAX = 6;
export const COMMANDER_INTERVAL = 90;
export const MAX_COMMANDERS = 32;
/**
 * Агро на зброю: жук, що опинився ближче AGGRO_RADIUS до підставки зброї, іде на неї й гризе
 * (частка таких жуків — AGGRO_FRACTION, решта йде далі до бункера). Без цього зброю шкодили лише ті,
 * кого натовп притиснув, і турель без охорони у вузькому місці жила вічно.
 */
export const AGGRO_RADIUS = 24;
export const AGGRO_FRACTION = 0.6;
/** Міцність ядра бункера. */
export const CORE_HP = 100_000;
/** Прорив (режим ПРОРИВ): жук, що дійшов до бункера, завдає attack × це шкоди ядру. */
export const CORE_BREACH_DAMAGE = 3;
/** Облога: жук, що торкається бункера, завдає attack × це шкоди за секунду. */
export const CORE_SIEGE_DPS = 3;

/** Бюджет часу фонових задач (перебудова полів) на один крок симуляції, мс. */
export const JOB_BUDGET_MS = 1.5;
/**
 * Бюджет перебудови flow field після дії гравця (стіна, кут, знесення). Більший, щоб жуки
 * «побачили» нову стіну за ~0.3 с, а не за 1–2 с; ціна — кілька кадрів із довшим кроком.
 */
export const JOB_BUDGET_URGENT_MS = 5;

// --- Директор хвиль

/** Підготовка: стільки секунд на початку гри жуки не з'являються (час на розбудову; Enter — почати раніше). */
export const WAVE_PREP = 60;
/** Швидкість спавну після підготовки, жуків/с. */
export const WAVE_START_RATE = 40;
/** Приріст швидкості спавну за хвилину, жуків/с. */
export const WAVE_RATE_GROWTH = 60;
/** Інтервал між хвилями, с. */
export const WAVE_INTERVAL = 120;
/** Тривалість хвилі, с. */
export const WAVE_DURATION = 15;
/** Множник швидкості спавну під час хвилі. */
export const WAVE_MULTIPLIER = 6;
/** Частка жуків хвилі, що йдуть з її боку мапи. */
export const WAVE_SIDE_BIAS = 0.8;

export const BUNKER_RADIUS = 14;
export const CENTER_CLEAR_RADIUS = 110;
export const EDGE_CLEAR_MARGIN = 40;
/** Глибина смуги вздовж краю, де з'являються жуки. */
export const SPAWN_BAND = 25;
/** Додаткова відстань від бункера, на якій жук вважається тим, що «прорвався». */
export const KILL_MARGIN = 2;

if (HASH_CELL_SIZE < 2 * MAX_BUG_RADIUS * SEPARATION_RANGE) {
  // 3×3 сусідніх клітинки мають гарантовано покривати радіус взаємодії.
  throw new Error('HASH_CELL_SIZE замалий для MAX_BUG_RADIUS * SEPARATION_RANGE');
}

export const MODE_BREAKTHROUGH = 0;
export const MODE_SIEGE = 1;

/** Параметри, які HUD змінює на льоту. Plain object → легко пересилати у Worker. */
export interface SimParams {
  /** Стеля для спавну (з урахуванням авто-ліміту FPS). Перевищення не вбиває — лише зупиняє спавн. */
  maxAlive: number;
  /** Жорсткий ліміт: надлишок понад нього знімається одразу. */
  hardLimit: number;
  /** Ручна швидкість спавну, жуків/с (коли autoWaves = 0). */
  spawnRate: number;
  /** 1 — швидкістю спавну керує директор хвиль. */
  autoWaves: number;
  /** Множник руйнування: корозія скель і укуси (0 — вимкнено). */
  destruction: number;
  speedMul: number;
  pushStrength: number;
  /** Сила обходу скупчень (0 — вимкнено). */
  avoidStrength: number;
  /** Сила обходу заторів через поле заторів (0 — вимкнено). */
  congestionStrength: number;
  mode: number; // MODE_*
}

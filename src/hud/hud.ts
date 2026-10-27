import { BUG_TYPES } from '../shared/constants';
import { TOOL_NONE, TOOLS } from '../shared/defense';

/** Стан застосунку, яким керує HUD. Plain object, що його читає main loop. */
export interface AppState {
  paused: boolean;
  simHz: number;
  showFlow: boolean;
  showGrid: boolean;
  /** Жорсткий ліміт (слайдер). З авто-лімітом це стеля, нижче якої регулятор тримає FPS. */
  maxAlive: number;
  autoLimit: boolean;
  autoWaves: boolean;
  destruction: number;
  spawnRate: number;
  speedMul: number;
  pushStrength: number;
  avoidStrength: number;
  congestionStrength: number;
  mode: number;
  /** Активний інструмент будівництва (B_* / TOOL_*), TOOL_NONE — немає. */
  tool: number;
  showZones: boolean;
}

export interface HudActions {
  onChange(): void;
  onNewMap(): void;
  onClear(): void;
  onFit(): void;
  /** Q/E — повернути напрямок ствола в прев'ю (рад). */
  onRotate(delta: number): void;
  /** Випустити командира з випадкового краю (для тестів). */
  onCommander(): void;
  /** Закінчити підготовку раніше. */
  onStartNow(): void;
}

export interface HudStats {
  fps: number;
  frameMs: number;
  simMs: number;
  stepMs: number;
  steps: number;
  renderMs: number;
  gpuMs: number;
  alive: number;
  breakthroughs: number;
  eaten: number;
  rocksDestroyed: number;
  craters: number;
  coreFrac: number;
  kills: number;
  buildings: number;
  projectiles: number;
  gameOverIn: number;
  commanders: number;
  commanderKills: number;
  limitNow: number;
  autoLimit: boolean;
  wave: number;
  inWave: boolean;
  waveSide: number;
  nextWaveIn: number;
  prepLeft: number;
  autoWaves: boolean;
  jobKind: number;
  spawnRate: number;
  seed: number;
  coverage: number;
  shared: boolean;
  cursorX: number;
  cursorY: number;
  worldSize: number;
}

const MAX_SPAWN_RATE = 20_000;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmtInt = (n: number) => Math.round(n).toLocaleString('uk-UA');
const fmtTime = (s: number) => {
  const t = Math.max(0, Math.ceil(s));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const SIDES = ['ПІВНІЧ', 'СХІД', 'ПІВДЕНЬ', 'ЗАХІД'];
const JOBS = ['—', 'ПЕРЕБУДОВА ПОЛЯ', 'ЗАТОРИ'];

/** Слайдер спавну квадратичний: точність на малих значеннях, 20k/с на максимумі. */
const spawnFromSlider = (v: number) => Math.round((v / 100) ** 2 * MAX_SPAWN_RATE);
const sliderFromSpawn = (r: number) => Math.round(Math.sqrt(r / MAX_SPAWN_RATE) * 100);

/**
 * HUD на звичайному DOM. Текст оновлюється не щокадру, а кілька разів на секунду —
 * зміни DOM викликають layout/paint і самі по собі можуть з'їдати кадр.
 */
export class Hud {
  private readonly s: AppState;
  private readonly a: HudActions;
  private readonly el = {
    fps: $('s-fps'),
    frame: $('s-frame'),
    sim: $('s-sim'),
    render: $('s-render'),
    gpu: $('s-gpu'),
    alive: $('s-alive'),
    breaks: $('s-breaks'),
    eaten: $('s-eaten'),
    core: $('s-core'),
    cmd: $('s-cmd'),
    kills: $('s-kills'),
    defense: $('s-defense'),
    gameOver: $('gameover-banner'),
    rocks: $('s-rocks'),
    limitNow: $('s-limit'),
    wave: $('s-wave'),
    job: $('s-job'),
    banner: $('wave-banner'),
    spawn: $('s-spawn'),
    seed: $('s-seed'),
    cover: $('s-cover'),
    sab: $('s-sab'),
    cursor: $('s-cursor'),
  };
  private readonly limit = $<HTMLInputElement>('c-limit');
  private readonly spawn = $<HTMLInputElement>('c-spawn');
  private readonly speed = $<HTMLInputElement>('c-speed');
  private readonly push = $<HTMLInputElement>('c-push');
  private readonly avoid = $<HTMLInputElement>('c-avoid');
  private readonly jam = $<HTMLInputElement>('c-jam');
  private readonly destroy = $<HTMLInputElement>('c-destroy');
  private readonly autoLimit = $<HTMLInputElement>('c-autolimit');
  private readonly autoWaves = $<HTMLInputElement>('c-waves');
  private readonly flow = $<HTMLInputElement>('c-flow');
  private readonly grid = $<HTMLInputElement>('c-grid');
  private readonly zones = $<HTMLInputElement>('c-zones');

  constructor(state: AppState, actions: HudActions) {
    this.s = state;
    this.a = actions;

    $('legend').innerHTML = BUG_TYPES.map((t) => {
      const [r, g, b] = t.color.map((c) => Math.round(c * 255));
      return `<span><i style="background:rgb(${r},${g},${b})"></i>${t.name}</span>`;
    }).join('');

    $('build-bar').innerHTML = TOOLS.map(
      (t) => `<button data-tool="${t.id}"><kbd>${t.keyLabel}</kbd>${t.name}</button>`,
    ).join('');
    $('build-bar').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b?.dataset.tool !== undefined) this.setTool(Number(b.dataset.tool));
    });
    this.zones.checked = state.showZones;
    this.zones.addEventListener('change', () => {
      state.showZones = this.zones.checked;
      this.changed();
    });

    this.limit.value = String(state.maxAlive / 1000);
    this.spawn.value = String(sliderFromSpawn(state.spawnRate));
    this.speed.value = String(state.speedMul);
    this.push.value = String(state.pushStrength);
    this.avoid.value = String(state.avoidStrength);
    this.jam.value = String(state.congestionStrength);
    this.destroy.value = String(state.destruction);
    this.flow.checked = state.showFlow;
    this.grid.checked = state.showGrid;
    this.autoLimit.checked = state.autoLimit;
    this.autoWaves.checked = state.autoWaves;

    this.destroy.addEventListener('input', () => {
      state.destruction = Number(this.destroy.value);
      this.changed();
    });
    this.autoLimit.addEventListener('change', () => {
      state.autoLimit = this.autoLimit.checked;
      this.changed();
    });
    this.autoWaves.addEventListener('change', () => {
      state.autoWaves = this.autoWaves.checked;
      this.changed();
    });

    this.limit.addEventListener('input', () => {
      state.maxAlive = Number(this.limit.value) * 1000;
      this.changed();
    });
    this.spawn.addEventListener('input', () => {
      state.spawnRate = spawnFromSlider(Number(this.spawn.value));
      this.changed();
    });
    this.speed.addEventListener('input', () => {
      state.speedMul = Number(this.speed.value);
      this.changed();
    });
    this.push.addEventListener('input', () => {
      state.pushStrength = Number(this.push.value);
      this.changed();
    });
    this.avoid.addEventListener('input', () => {
      state.avoidStrength = Number(this.avoid.value);
      this.changed();
    });
    this.jam.addEventListener('input', () => {
      state.congestionStrength = Number(this.jam.value);
      this.changed();
    });
    this.flow.addEventListener('change', () => {
      state.showFlow = this.flow.checked;
      this.changed();
    });
    this.grid.addEventListener('change', () => {
      state.showGrid = this.grid.checked;
      this.changed();
    });
    $('c-mode').addEventListener('click', (e) => {
      const m = (e.target as HTMLElement).dataset.mode;
      if (m !== undefined) this.setMode(Number(m));
    });
    $('c-hz').addEventListener('click', (e) => {
      const hz = (e.target as HTMLElement).dataset.hz;
      if (hz !== undefined) {
        state.simHz = Number(hz);
        this.changed();
      }
    });
    $('c-pause').addEventListener('click', () => this.togglePause());
    $('c-clear').addEventListener('click', () => actions.onClear());
    $('c-map').addEventListener('click', () => actions.onNewMap());
    $('c-fit').addEventListener('click', () => actions.onFit());
    $('c-cmd').addEventListener('click', () => actions.onCommander());

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
      const tool = TOOLS.find((t) => t.key === e.code);
      if (tool) {
        this.setTool(tool.id);
        return;
      }
      switch (e.code) {
        case 'Escape':
          this.setTool(TOOL_NONE);
          break;
        case 'KeyQ':
          actions.onRotate(-Math.PI / 12);
          break;
        case 'KeyE':
          actions.onRotate(Math.PI / 12);
          break;
        case 'Enter':
          e.preventDefault(); // інакше Enter ще й «натисне» кнопку, що тримає фокус після кліку
          actions.onStartNow();
          break;
        case 'KeyK':
          actions.onCommander();
          break;
        case 'KeyZ':
          state.showZones = this.zones.checked = !state.showZones;
          this.changed();
          break;
        case 'Space':
        case 'KeyP':
          e.preventDefault();
          this.togglePause();
          break;
        case 'KeyM':
          this.setMode(state.mode === 0 ? 1 : 0);
          break;
        case 'KeyL':
          state.autoLimit = this.autoLimit.checked = !state.autoLimit;
          this.changed();
          break;
        case 'KeyW':
          state.autoWaves = this.autoWaves.checked = !state.autoWaves;
          this.changed();
          break;
        case 'KeyF':
          state.showFlow = this.flow.checked = !state.showFlow;
          this.changed();
          break;
        case 'KeyG':
          state.showGrid = this.grid.checked = !state.showGrid;
          this.changed();
          break;
        case 'KeyN':
          actions.onNewMap();
          break;
        case 'KeyC':
          actions.onClear();
          break;
        case 'Digit0':
          actions.onFit();
          break;
      }
    });

    this.syncControls();
  }

  /** Повторний вибір того самого інструмента знімає його. */
  setTool(tool: number): void {
    this.s.tool = this.s.tool === tool ? TOOL_NONE : tool;
    this.changed();
  }

  private setMode(mode: number): void {
    this.s.mode = mode;
    this.changed();
  }

  private togglePause(): void {
    this.s.paused = !this.s.paused;
    this.changed();
  }

  private changed(): void {
    this.syncControls();
    this.a.onChange();
  }

  private syncControls(): void {
    const s = this.s;
    $('v-limit').textContent = fmtInt(s.maxAlive);
    $('v-spawn').textContent = `${fmtInt(s.spawnRate)}/С`;
    $('v-speed').textContent = `×${s.speedMul.toFixed(2)}`;
    $('v-push').textContent = `×${s.pushStrength.toFixed(2)}`;
    $('v-avoid').textContent = `×${s.avoidStrength.toFixed(2)}`;
    $('v-jam').textContent = `×${s.congestionStrength.toFixed(2)}`;
    $('v-destroy').textContent = s.destruction > 0 ? `×${s.destruction.toFixed(2)}` : 'ВИМК';
    $('v-limit-label').textContent = s.autoLimit ? 'СТЕЛЯ ЛІМІТУ' : 'ЛІМІТ ЖУКІВ';
    // Коли спавном керує директор, ручний слайдер вимкнено.
    this.spawn.disabled = s.autoWaves;
    $('spawn-row').classList.toggle('disabled', s.autoWaves);
    for (const b of $('c-mode').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.mode) === s.mode);
    for (const b of $('c-hz').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.hz) === s.simHz);
    $('c-pause').classList.toggle('on', s.paused);
    $('paused').classList.toggle('show', s.paused);
    for (const b of $('build-bar').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.tool) === s.tool);
    const t = TOOLS.find((x) => x.id === s.tool);
    $('build-hint').textContent = t
      ? `${t.name}: ${t.hint} · ЛКМ — поставити, тягни — напрямок · Q/E — поворот · ПКМ/ESC — скасувати`
      : 'ЛКМ — ПАНОРАМА · КОЛЕСО — МАСШТАБ · ␣ — ПАУЗА · M — РЕЖИМ · L/W — АВТО-ЛІМІТ/ХВИЛІ · ENTER — ПОЧАТИ · K — КОМАНДИР · Z — ЗОНИ · F/G — ОВЕРЛЕЇ · N — НОВА МАПА';
    document.getElementById('view')?.classList.toggle('building', s.tool !== TOOL_NONE);
  }

  update(st: HudStats): void {
    const e = this.el;
    e.fps.textContent = st.fps.toFixed(0);
    e.frame.textContent = `${st.frameMs.toFixed(2)} MS`;
    e.sim.textContent = `${st.simMs.toFixed(2)} MS (КРОК ${st.stepMs.toFixed(2)} ×${st.steps.toFixed(1)})`;
    e.render.textContent = `${st.renderMs.toFixed(2)} MS`;
    e.gpu.textContent = st.gpuMs >= 0 ? `${st.gpuMs.toFixed(2)} MS` : 'Н/Д';
    e.alive.textContent = fmtInt(st.alive);
    e.breaks.textContent = fmtInt(st.breakthroughs);
    e.spawn.textContent = `${fmtInt(st.spawnRate)}/С`;
    e.eaten.textContent = fmtInt(st.eaten);
    e.rocks.textContent = `${fmtInt(st.craters)} / ${fmtInt(st.rocksDestroyed)}`;
    e.core.textContent = `${(st.coreFrac * 100).toFixed(1)} %`;
    e.cmd.textContent = `${fmtInt(st.commanders)} / ${fmtInt(st.commanderKills)}`;
    e.kills.textContent = fmtInt(st.kills);
    e.defense.textContent = `${fmtInt(st.buildings)} / ${fmtInt(st.projectiles)}`;
    e.gameOver.textContent = st.gameOverIn > 0 ? `// БУНКЕР ЗНИЩЕНО · НОВА МАПА ЧЕРЕЗ ${Math.ceil(st.gameOverIn)} С //` : '';
    e.gameOver.classList.toggle('show', st.gameOverIn > 0);
    e.limitNow.textContent = `${fmtInt(st.limitNow)}${st.autoLimit ? ' (АВТО)' : ''}`;
    e.job.textContent = JOBS[st.jobKind] ?? '—';
    if (!st.autoWaves) {
      e.wave.textContent = 'ВИМК';
    } else if (st.prepLeft > 0) {
      e.wave.textContent = `ПІДГОТОВКА ${fmtTime(st.prepLeft)}`;
    } else if (st.inWave) {
      e.wave.textContent = `${st.wave} · ЙДЕ З: ${SIDES[st.waveSide]}`;
    } else {
      e.wave.textContent = `${st.wave} · ЧЕРЕЗ ${fmtTime(st.nextWaveIn)}`;
    }
    const prep = st.autoWaves && st.prepLeft > 0;
    e.banner.textContent = prep
      ? `// ПІДГОТОВКА ДО НАСТУПУ · ${fmtTime(st.prepLeft)} · ENTER — ПОЧАТИ //`
      : st.inWave
        ? `// ХВИЛЯ ${st.wave} · ${SIDES[st.waveSide]} //`
        : '';
    e.banner.classList.toggle('show', prep || (st.autoWaves && st.inWave));
    e.seed.textContent = String(st.seed);
    e.cover.textContent = `${(st.coverage * 100).toFixed(1)} %`;
    e.sab.textContent = st.shared ? 'ТАК (SAB)' : 'НІ';
    const onMap = st.cursorX >= 0 && st.cursorY >= 0 && st.cursorX < st.worldSize && st.cursorY < st.worldSize;
    e.cursor.textContent = onMap
      ? `${String(Math.floor(st.cursorX)).padStart(4, '0')} : ${String(Math.floor(st.cursorY)).padStart(4, '0')}`
      : '-- : --';
  }
}

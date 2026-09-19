import { c, width } from './fmt.ts';

/**
 * A live multi-line progress block, redrawn in place.
 *
 * Scoring a throttled key takes minutes with long quiet stretches, so a single
 * ticking counter is not enough: the display has to show that something is
 * still happening, what the current rate is, and roughly how long is left -
 * otherwise a slow run is indistinguishable from a hung one.
 */

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface ProgressState {
  done: number;
  total: number;
  saved: number;
  failed: number;
  rate: number;
  tokens: number;
  note?: string;
}

export class Progress {
  private frame = 0;
  private lines = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = Date.now();
  private state: ProgressState = {
    done: 0,
    total: 0,
    saved: 0,
    failed: 0,
    rate: 0,
    tokens: 0,
  };

  constructor(private readonly enabled = process.stderr.isTTY === true) {}

  start(total: number): void {
    this.state.total = total;
    this.started = Date.now();
    if (!this.enabled) return;
    process.stderr.write('[?25l'); // hide cursor
    this.timer = setInterval(() => this.render(), 120);
  }

  update(patch: Partial<ProgressState>): void {
    Object.assign(this.state, patch);
    if (!this.enabled) return;
    if (!this.timer) this.render();
  }

  /** Print a line above the progress block without disturbing it. */
  log(line: string): void {
    if (!this.enabled) {
      console.log(line);
      return;
    }
    this.clear();
    process.stderr.write(line + '\n');
    this.render();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.enabled) return;
    this.clear();
    process.stderr.write('[?25h'); // show cursor
  }

  private clear(): void {
    if (this.lines === 0) return;
    process.stderr.write(`[${this.lines}A[0J`);
    this.lines = 0;
  }

  private render(): void {
    const s = this.state;
    this.clear();
    this.frame = (this.frame + 1) % FRAMES.length;

    // `?? 80` is wrong here: a pty can report columns as 0, which is not
    // nullish, and every line then gets clipped to nothing. Use || so 0 falls
    // back too.
    const cols = process.stderr.columns || 80;
    const pct = s.total ? s.done / s.total : 0;
    const barWidth = Math.max(10, Math.min(40, cols - 38));
    const filled = Math.round(pct * barWidth);
    const bar =
      c.cyan('━'.repeat(filled)) + c.dim('━'.repeat(Math.max(0, barWidth - filled)));

    const elapsed = (Date.now() - this.started) / 1000;
    const perMin = elapsed > 2 ? (s.done / elapsed) * 60 : 0;
    const remaining = s.total - s.done;
    const eta = perMin > 0.2 ? formatEta((remaining / perMin) * 60) : 'estimating';

    const out = [
      `${c.cyan(FRAMES[this.frame] ?? '')} ${bar} ${String(Math.round(pct * 100)).padStart(3)}%  ${s.done}/${s.total}`,
      c.dim(
        `   scored ${s.saved}` +
          (s.failed ? c.yellow(`  ${s.failed} retrying/failed`) : '') +
          `  ·  ${perMin.toFixed(1)}/min  ·  ${s.tokens.toLocaleString('en-US')} tokens  ·  ETA ${eta}`,
      ),
    ];
    if (s.note) out.push(c.dim(`   ${s.note}`));

    // Never slice: the lines carry colour escapes, and cutting mid-sequence
    // corrupts the terminal. Instead count the rows the output will occupy
    // after the terminal wraps it, so the next redraw clears the right number.
    process.stderr.write(out.join('\n') + '\n');
    this.lines = out.reduce((acc, l) => acc + Math.max(1, Math.ceil(width(l) / cols)), 0);
  }
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Tiny terminal formatting helpers. No dependency, respects NO_COLOR. */

const enabled = !process.env.NO_COLOR && process.stdout.isTTY !== false;
const wrap = (code: string) => (s: string) => (enabled ? `[${code}m${s}[0m` : s);

export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
};

export function num(n: number): string {
  return n.toLocaleString('en-US');
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function usd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

const ANSI = /\[[0-9;]*m/g;

/** Visible width, ignoring colour escapes. */
export function width(s: string): number {
  return s.replace(ANSI, '').length;
}

/** Pad to a visible width, so coloured cells still line up. */
function pad(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - width(s)));
}

/** Render a simple left-aligned table with a dim header rule. */
export function table(headers: string[], rows: (string | number)[][]): string {
  const all = [headers, ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => width(String(r[i] ?? '')))));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => pad(cell, widths[i]!))
      .join('  ')
      .trimEnd();
  const out = [c.bold(line(headers)), c.dim(widths.map((w) => '-'.repeat(w)).join('  '))];
  for (const r of rows) out.push(line(r.map(String)));
  return out.join('\n');
}

export function bar(value: number, max: number, width = 20): string {
  if (max <= 0) return '';
  const filled = Math.round((value / max) * width);
  return '█'.repeat(Math.max(0, filled)) + c.dim('─'.repeat(Math.max(0, width - filled)));
}

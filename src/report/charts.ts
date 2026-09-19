/**
 * Hand-rolled SVG chart primitives. No CDN is reachable from a local file, and
 * a report that needs a network fetch to render is a report that breaks on a
 * plane, so every mark here is emitted as static SVG with a thin JS hover layer
 * added by the page itself.
 *
 * Palette, mark specs and the checks behind them come from the dataviz skill's
 * reference instance. The categorical slots used here were validated with
 * scripts/validate_palette.js in both modes (all checks pass; light mode raises
 * the contrast WARN, so every chart also ships direct labels and a table view).
 */

export const SERIES = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'] as const;

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const fmt = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '-');

/**
 * Approximate rendered width of a string. SVG cannot measure text before it is
 * drawn, so padding is computed from this rather than guessed - which is what
 * previously clipped "96 exchanges" down to "96 ex".
 */
function textW(s: string, fontSize = 12.5): number {
  return s.length * fontSize * 0.56;
}

export interface BarItem {
  label: string;
  value: number;
  /** Standard error, drawn as a whisker when present. */
  err?: number;
  note?: string;
  tip?: string;
}

/**
 * Horizontal bars: one series, one colour. Ranking is carried by order and by
 * the direct label on every bar, never by hue.
 */
export function hbars(items: BarItem[], opts: { max?: number; unit?: string; width?: number } = {}): string {
  if (!items.length) return emptyState();
  const rowH = 34;
  // Size the gutters to the longest strings instead of a fixed guess.
  const labelW = Math.min(300, Math.max(120, ...items.map((i) => textW(i.label) + 16)));
  const padR =
    Math.max(
      ...items.map((i) => textW(`${fmt(i.value)}${opts.unit ?? ''}`) + (i.note ? textW(` ${i.note}`, 11.5) : 0)),
    ) + 16;
  const w = Math.max(opts.width ?? 720, labelW + padR + 180);
  const h = items.length * rowH + 14;
  const max = opts.max ?? (Math.max(...items.map((i) => i.value + (i.err ?? 0))) * 1.05 || 1);
  const plotW = w - labelW - padR;

  const rows = items
    .map((it, i) => {
      const y = i * rowH + 7;
      const barW = Math.max(2, (it.value / max) * plotW);
      const errW = it.err ? (it.err / max) * plotW : 0;
      const cy = y + 11;
      const whisker = it.err
        ? `<g class="whisk"><line x1="${labelW + barW - errW}" x2="${labelW + barW + errW}" y1="${cy}" y2="${cy}"/>` +
          `<line x1="${labelW + barW - errW}" x2="${labelW + barW - errW}" y1="${cy - 4}" y2="${cy + 4}"/>` +
          `<line x1="${labelW + barW + errW}" x2="${labelW + barW + errW}" y1="${cy - 4}" y2="${cy + 4}"/></g>`
        : '';
      return (
        `<g class="row" tabindex="0" data-tip="${esc(it.tip ?? `${it.label}: ${fmt(it.value)}${opts.unit ?? ''}`)}">` +
        `<rect class="hit" x="0" y="${y - 4}" width="${w}" height="${rowH - 2}"/>` +
        `<text class="cat" x="${labelW - 10}" y="${cy + 4}" text-anchor="end">${esc(it.label)}</text>` +
        `<rect class="bar" x="${labelW}" y="${y}" width="${barW}" height="22" rx="4"/>` +
        whisker +
        `<text class="val" x="${labelW + barW + errW + 8}" y="${cy + 4}">${fmt(it.value)}${esc(opts.unit ?? '')}` +
        (it.note ? `<tspan class="muted"> ${esc(it.note)}</tspan>` : '') +
        `</text></g>`
      );
    })
    .join('');

  return `<svg class="chart hbars" viewBox="0 0 ${w} ${h}" role="img" preserveAspectRatio="xMinYMin meet">${rows}</svg>`;
}

export interface Series {
  name: string;
  slot: number;
  points: { x: string; y: number }[];
}

/** Multi-line trend. Legend always present; endpoints directly labelled. */
export function lines(
  series: Series[],
  xs: string[],
  opts: { width?: number; height?: number; yMax?: number; yLabel?: string } = {},
): string {
  if (!series.length || xs.length < 2) return emptyState('Not enough history yet for a trend.');
  const h = opts.height ?? 260;
  const padL = 40;
  // Room for the longest end label, so series names are never cut off.
  const padR = Math.max(...series.map((s) => textW(s.name, 12) + 18), 40);
  const w = Math.max(opts.width ?? 760, padL + padR + 320);
  const padT = 14;
  const padB = 34;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const yMax = opts.yMax ?? 100;
  const xAt = (i: number) => padL + (xs.length === 1 ? plotW / 2 : (i / (xs.length - 1)) * plotW);
  const yAt = (v: number) => padT + plotH - (v / yMax) * plotH;

  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const y = padT + plotH - f * plotH;
      return (
        `<line class="grid" x1="${padL}" x2="${padL + plotW}" y1="${y}" y2="${y}"/>` +
        `<text class="tick" x="${padL - 8}" y="${y + 4}" text-anchor="end">${Math.round(f * yMax)}</text>`
      );
    })
    .join('');

  const xticks = xs
    .map((x, i) =>
      i % Math.ceil(xs.length / 6) === 0
        ? `<text class="tick" x="${xAt(i)}" y="${h - 12}" text-anchor="middle">${esc(x.slice(5))}</text>`
        : '',
    )
    .join('');

  // Draw the marks first, then place end labels with collision avoidance, so
  // two series that finish at similar values do not print on top of each other.
  const ends: { slot: number; name: string; x: number; y: number }[] = [];
  const paths = series
    .map((s) => {
      const pts = s.points
        .map((p) => ({ i: xs.indexOf(p.x), y: p.y }))
        .filter((p) => p.i >= 0);
      if (!pts.length) return '';
      const d = pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${xAt(p.i)},${yAt(p.y)}`).join(' ');
      const dots = pts
        .map(
          (p) =>
            `<circle class="dot" cx="${xAt(p.i)}" cy="${yAt(p.y)}" r="4" data-tip="${esc(
              `${s.name} - ${xs[p.i]}: ${fmt(p.y)}`,
            )}" tabindex="0"/>`,
        )
        .join('');
      const last = pts[pts.length - 1]!;
      ends.push({ slot: s.slot, name: s.name, x: xAt(last.i) + 10, y: yAt(last.y) + 4 });
      return `<g class="series ${SERIES[s.slot] ?? 's1'}"><path class="line" d="${d}"/>${dots}</g>`;
    })
    .join('');

  const MIN_GAP = 15;
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) {
    const prev = ends[i - 1]!;
    const cur = ends[i]!;
    // Only push apart labels that would actually overlap horizontally.
    if (Math.abs(cur.x - prev.x) < 80 && cur.y - prev.y < MIN_GAP) cur.y = prev.y + MIN_GAP;
  }
  const endLabels = ends
    .map(
      (e) =>
        `<text class="endlabel ${SERIES[e.slot] ?? 's1'}" x="${e.x}" y="${Math.min(
          e.y,
          h - padB + 6,
        )}">${esc(e.name)}</text>`,
    )
    .join('');

  return (
    `<svg class="chart lines" viewBox="0 0 ${w} ${h}" role="img" preserveAspectRatio="xMinYMin meet">` +
    grid +
    xticks +
    `<line class="axis" x1="${padL}" x2="${padL + plotW}" y1="${padT + plotH}" y2="${padT + plotH}"/>` +
    paths +
    endLabels +
    `</svg>`
  );
}

export interface StackRow {
  label: string;
  segments: { key: string; value: number; slot: number }[];
}

/** Stacked bars with a 2px surface gap between segments, never a border. */
export function stacked(rows: StackRow[], opts: { width?: number } = {}): string {
  if (!rows.length) return emptyState();
  const rowH = 38;
  const labelW = Math.min(300, Math.max(120, ...rows.map((r) => textW(r.label) + 16)));
  const padR = 20;
  const w = Math.max(opts.width ?? 720, labelW + padR + 320);
  const plotW = w - labelW - padR;
  const h = rows.length * rowH + 10;

  const body = rows
    .map((r, i) => {
      const total = r.segments.reduce((a, s) => a + s.value, 0) || 1;
      let x = labelW;
      const y = i * rowH + 8;
      const segs = r.segments
        .filter((s) => s.value > 0)
        .map((s) => {
          const segW = Math.max(0, (s.value / total) * plotW - 2);
          const pct = (s.value / total) * 100;
          const el =
            `<g class="seg ${SERIES[s.slot] ?? 's1'}" tabindex="0" data-tip="${esc(
              `${r.label} - ${s.key}: ${fmt(pct, 0)}% (${s.value})`,
            )}">` +
            `<rect x="${x}" y="${y}" width="${segW}" height="22" rx="3"/>` +
            (segW > 34
              ? `<text class="seglabel" x="${x + segW / 2}" y="${y + 15}" text-anchor="middle">${fmt(pct, 0)}%</text>`
              : '') +
            `</g>`;
          x += segW + 2;
          return el;
        })
        .join('');
      return (
        `<g class="row"><text class="cat" x="${labelW - 10}" y="${y + 15}" text-anchor="end">${esc(
          r.label,
        )}</text>${segs}</g>`
      );
    })
    .join('');

  return `<svg class="chart stacked" viewBox="0 0 ${w} ${h}" role="img" preserveAspectRatio="xMinYMin meet">${body}</svg>`;
}

/** Sequential single-hue heatmap. Every cell also carries its printed value. */
export function heatmap(
  rowLabels: string[],
  colLabels: string[],
  values: number[][],
  opts: { unit?: string; width?: number } = {},
): string {
  if (!rowLabels.length || !colLabels.length) return emptyState();
  const labelW = Math.min(300, Math.max(120, ...rowLabels.map((r) => r.length * 7 + 16)));
  const cellW = Math.max(74, ...colLabels.map((cl) => cl.length * 6.6 + 18));
  const cellH = 34;
  const w = labelW + colLabels.length * cellW + 10;
  const headH = 46;
  const h = headH + rowLabels.length * cellH + 8;
  const max = Math.max(1, ...values.flat());

  const head = colLabels
    .map(
      (cl, j) =>
        `<text class="colhead" x="${labelW + j * cellW + cellW / 2}" y="${headH - 14}" text-anchor="middle">${esc(
          cl,
        )}</text>`,
    )
    .join('');

  const body = rowLabels
    .map((rl, i) => {
      const cells = colLabels
        .map((cl, j) => {
          const v = values[i]?.[j] ?? 0;
          const t = v / max;
          return (
            `<g class="cell" tabindex="0" data-tip="${esc(`${rl} - ${cl}: ${fmt(v, 2)}${opts.unit ?? ''}`)}">` +
            `<rect x="${labelW + j * cellW + 1}" y="${headH + i * cellH + 1}" width="${cellW - 3}" height="${
              cellH - 3
            }" rx="3" fill="var(--seq)" fill-opacity="${(0.08 + t * 0.92).toFixed(3)}"/>` +
            `<text class="cellval ${t > 0.55 ? 'on-dark' : ''}" x="${labelW + j * cellW + cellW / 2}" y="${
              headH + i * cellH + cellH / 2 + 3
            }" text-anchor="middle">${v === 0 ? '-' : fmt(v, 2)}</text></g>`
          );
        })
        .join('');
      return (
        `<text class="cat" x="${labelW - 10}" y="${headH + i * cellH + cellH / 2 + 4}" text-anchor="end">${esc(
          rl,
        )}</text>` + cells
      );
    })
    .join('');

  return `<svg class="chart heat" viewBox="0 0 ${w} ${h}" role="img" preserveAspectRatio="xMinYMin meet">${head}${body}</svg>`;
}

export function legend(items: { name: string; slot: number }[]): string {
  if (items.length < 2) return '';
  return (
    `<div class="legend">` +
    items
      .map(
        (i) =>
          `<span class="lg"><i class="sw ${SERIES[i.slot] ?? 's1'}"></i>${esc(i.name)}</span>`,
      )
      .join('') +
    `</div>`
  );
}

export function emptyState(msg = 'No data yet.'): string {
  return `<p class="empty">${esc(msg)}</p>`;
}

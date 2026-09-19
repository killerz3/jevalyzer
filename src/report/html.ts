import { esc, hbars, heatmap, legend, lines, stacked, type Series, type StackRow } from './charts.ts';

/**
 * Palette values come from the dataviz reference instance; the categorical
 * slots in use were run through scripts/validate_palette.js in both modes.
 * Light mode raises the contrast WARN on three slots, so the relief rule
 * applies: every chart here ships direct labels AND a table view.
 */
const STYLE = `
:root {
  color-scheme: light;
  --page: #f9f9f7;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --muted: #898781;
  --grid: #e1e0d9;
  --axis: #c3c2b7;
  --border: rgba(11,11,11,0.10);
  --seq: #2a78d6;
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100;
  --s5: #e87ba4; --s6: #008300; --s7: #4a3aa7; --s8: #e34948;
  --good: #0ca30c; --warning: #fab219; --serious: #ec835a; --critical: #d03b3b;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7;
    --muted: #898781; --grid: #2c2c2a; --axis: #383835;
    --border: rgba(255,255,255,0.10); --seq: #3987e5;
    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500;
    --s5: #d55181; --s6: #008300; --s7: #9085e9; --s8: #e66767;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7;
  --muted: #898781; --grid: #2c2c2a; --axis: #383835;
  --border: rgba(255,255,255,0.10); --seq: #3987e5;
  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500;
  --s5: #d55181; --s6: #008300; --s7: #9085e9; --s8: #e66767;
}

* { box-sizing: border-box; }
body {
  margin: 0; background: var(--page); color: var(--ink);
  font: 14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  padding: 0 16px 64px;
}
.wrap { max-width: 1040px; margin: 0 auto; }
header { padding: 40px 0 24px; }
h1 { font-size: 26px; margin: 0 0 6px; letter-spacing: -0.01em; }
h2 { font-size: 16px; margin: 0 0 4px; letter-spacing: -0.005em; }
.sub { color: var(--ink-2); margin: 0; }
.muted, .tick, .colhead { fill: var(--muted); color: var(--muted); }

.tiles { display: flex; flex-wrap: wrap; gap: 12px; margin: 20px 0 28px; }
.tile {
  background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
  padding: 14px 18px; min-width: 150px; flex: 1 1 150px;
}
.tile .n { font-size: 28px; line-height: 1.1; letter-spacing: -0.02em; }
/* A long text value (a model id) must shrink rather than burst the tile. */
.tile .n.txt { font-size: 17px; line-height: 1.25; letter-spacing: -0.005em; word-break: break-word; }
.tile .k { color: var(--ink-2); font-size: 12px; margin-top: 2px; }

.card {
  background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
  padding: 20px; margin-bottom: 20px;
}
.card > p.note { color: var(--ink-2); margin: 2px 0 14px; font-size: 13px; }
.scroll { overflow-x: auto; }
svg.chart { display: block; width: 100%; height: auto; min-width: 460px; }

.cat { fill: var(--ink-2); font-size: 12.5px; }
.val { fill: var(--ink); font-size: 12.5px; }
.val .muted { font-size: 11.5px; }
.bar { fill: var(--s1); }
.whisk line { stroke: var(--ink-2); stroke-width: 1.5; opacity: 0.7; }
.grid { stroke: var(--grid); stroke-width: 1; }
.axis { stroke: var(--axis); stroke-width: 1; }
.tick { font-size: 11px; }
.colhead { font-size: 11.5px; }
.cellval { fill: var(--ink-2); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.cellval.on-dark { fill: #fcfcfb; }
.endlabel { font-size: 12px; fill: var(--ink-2); }
.seglabel { font-size: 11px; fill: #fcfcfb; font-variant-numeric: tabular-nums; }
.hit { fill: transparent; }
.row:hover .bar, .row:focus-visible .bar { filter: brightness(1.08); }
.dot { stroke: var(--surface); stroke-width: 2; }
.line { fill: none; stroke-width: 2; }
.s1 .line, .s1 .dot { stroke: var(--s1); } .s1 .dot { fill: var(--s1); }
.s2 .line, .s2 .dot { stroke: var(--s2); } .s2 .dot { fill: var(--s2); }
.s3 .line, .s3 .dot { stroke: var(--s3); } .s3 .dot { fill: var(--s3); }
.s4 .line, .s4 .dot { stroke: var(--s4); } .s4 .dot { fill: var(--s4); }
.s5 .line, .s5 .dot { stroke: var(--s5); } .s5 .dot { fill: var(--s5); }
.s6 .line, .s6 .dot { stroke: var(--s6); } .s6 .dot { fill: var(--s6); }
.seg.s1 rect { fill: var(--s1); } .seg.s2 rect { fill: var(--s2); }
.seg.s3 rect { fill: var(--s3); } .seg.s4 rect { fill: var(--s4); }
.seg.s5 rect { fill: var(--s5); } .seg.s6 rect { fill: var(--s6); }

.legend { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 12px; color: var(--ink-2); font-size: 12.5px; }
.lg { display: inline-flex; align-items: center; gap: 6px; }
.sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.sw.s1 { background: var(--s1); } .sw.s2 { background: var(--s2); }
.sw.s3 { background: var(--s3); } .sw.s4 { background: var(--s4); }
.sw.s5 { background: var(--s5); } .sw.s6 { background: var(--s6); }

table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); }
th { color: var(--ink-2); font-weight: 600; font-size: 12px; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
tbody tr:hover { background: color-mix(in oklab, var(--seq) 7%, transparent); }

details.tableview { margin-top: 14px; }
details.tableview > summary {
  cursor: pointer; color: var(--ink-2); font-size: 12.5px; list-style: none;
  padding: 6px 0;
}
details.tableview > summary::before { content: "▸ "; }
details[open].tableview > summary::before { content: "▾ "; }

#tip {
  position: fixed; pointer-events: none; z-index: 20; opacity: 0;
  background: var(--ink); color: var(--page); padding: 6px 9px; border-radius: 6px;
  font-size: 12px; max-width: 320px; transition: opacity .1s; white-space: pre-line;
}
#tip.on { opacity: 1; }

.filters { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.filters input, .filters select {
  font: inherit; padding: 6px 9px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--surface); color: var(--ink);
}
.filters input { flex: 1 1 220px; min-width: 0; }

.ex { border-bottom: 1px solid var(--border); }
.ex > summary { cursor: pointer; padding: 9px 4px; list-style: none; display: flex; gap: 10px; align-items: baseline; }
.ex > summary::-webkit-details-marker { display: none; }
.ex .sc { font-variant-numeric: tabular-nums; font-weight: 600; min-width: 34px; }
.ex .q { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); }
.ex .tags { display: flex; gap: 5px; flex-wrap: wrap; }
.tag { font-size: 11px; padding: 1px 7px; border-radius: 99px; border: 1px solid var(--border); color: var(--ink-2); white-space: nowrap; }
.tag.bad { color: var(--critical); border-color: color-mix(in oklab, var(--critical) 40%, transparent); }
.ex .body { padding: 6px 4px 18px; }
.ex pre {
  background: var(--page); border: 1px solid var(--border); border-radius: 8px;
  padding: 10px; overflow-x: auto; font-size: 12px; white-space: pre-wrap;
  word-break: break-word; max-height: 320px;
}
.answers { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 6px 16px; margin-top: 10px; }
.ans { display: flex; justify-content: space-between; gap: 8px; font-size: 12.5px; border-bottom: 1px dotted var(--border); padding: 3px 0; }
.ans b { font-weight: 600; font-variant-numeric: tabular-nums; }
.empty { color: var(--muted); margin: 8px 0; }
footer { color: var(--muted); font-size: 12px; padding-top: 8px; }
.theme { position: fixed; top: 12px; right: 12px; z-index: 30; }
.theme button {
  font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--border); background: var(--surface); color: var(--ink-2);
}
@media (max-width: 560px) {
  .tile .n { font-size: 22px; }
  .tile .n.txt { font-size: 15px; }
  header { padding-top: 56px; }
  body { padding: 0 10px 48px; }
  /* Give the scrolling chart strip as much width as the screen allows. */
  .card { padding: 16px 12px; }
  svg.chart { min-width: 420px; }
}
`;

const SCRIPT = `
(function () {
  var tip = document.getElementById('tip');
  function show(e, text) {
    tip.textContent = text;
    tip.classList.add('on');
    var r = tip.getBoundingClientRect();
    var x = (e.clientX || 0) + 14, y = (e.clientY || 0) + 16;
    if (x + r.width > innerWidth - 8) x = innerWidth - r.width - 8;
    if (y + r.height > innerHeight - 8) y = (e.clientY || 0) - r.height - 12;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  function hide() { tip.classList.remove('on'); }
  document.addEventListener('mousemove', function (e) {
    var t = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (t) show(e, t.getAttribute('data-tip')); else hide();
  });
  document.addEventListener('focusin', function (e) {
    var t = e.target.closest && e.target.closest('[data-tip]');
    if (!t) return hide();
    var b = t.getBoundingClientRect();
    show({ clientX: b.left + b.width / 2, clientY: b.top }, t.getAttribute('data-tip'));
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('scroll', hide, true);

  var q = document.getElementById('q'), sel = document.getElementById('issue');
  function filter() {
    var text = (q.value || '').toLowerCase();
    var issue = sel.value;
    var n = 0;
    document.querySelectorAll('.ex').forEach(function (el) {
      var hay = (el.getAttribute('data-hay') || '');
      var issues = (el.getAttribute('data-issues') || '');
      var ok = (!text || hay.indexOf(text) !== -1) && (!issue || issues.indexOf(issue) !== -1);
      el.hidden = !ok;
      if (ok) n++;
    });
    document.getElementById('count').textContent = n + ' shown';
  }
  if (q) { q.addEventListener('input', filter); sel.addEventListener('change', filter); }

  var btn = document.getElementById('theme');
  btn.addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme');
    var next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark';
    if (next) document.documentElement.setAttribute('data-theme', next);
    else document.documentElement.removeAttribute('data-theme');
    btn.textContent = next ? (next === 'dark' ? 'Dark' : 'Light') : 'Auto';
  });
})();
`;

export interface Tile {
  n: string;
  k: string;
  /** Long text values get the smaller treatment so the tile keeps its shape. */
  text?: boolean;
}

export interface TableSpec {
  headers: string[];
  rows: (string | number)[][];
  numeric?: boolean[];
}

export function tableHtml(t: TableSpec): string {
  const head = t.headers
    .map((h, i) => `<th${t.numeric?.[i] ? ' class="n"' : ''}>${esc(h)}</th>`)
    .join('');
  const body = t.rows
    .map(
      (r) =>
        '<tr>' +
        r.map((cell, i) => `<td${t.numeric?.[i] ? ' class="n"' : ''}>${esc(String(cell))}</td>`).join('') +
        '</tr>',
    )
    .join('');
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Charts never gate a value: each one ships the same numbers as a table. */
export function withTable(chart: string, t: TableSpec, label = 'Show the numbers'): string {
  return chart + `<details class="tableview"><summary>${esc(label)}</summary>${tableHtml(t)}</details>`;
}

export function card(title: string, note: string, body: string): string {
  return `<section class="card"><h2>${esc(title)}</h2>${
    note ? `<p class="note">${esc(note)}</p>` : ''
  }<div class="scroll">${body}</div></section>`;
}

export function page(opts: {
  title: string;
  subtitle: string;
  tiles: Tile[];
  sections: string;
  footer: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E📊%3C/text%3E%3C/svg%3E">
<title>${esc(opts.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="theme"><button id="theme" type="button">Auto</button></div>
<div class="wrap">
  <header>
    <h1>${esc(opts.title)}</h1>
    <p class="sub">${esc(opts.subtitle)}</p>
  </header>
  <div class="tiles">
    ${opts.tiles
      .map(
        (t) =>
          `<div class="tile"><div class="n${t.text || t.n.length > 8 ? ' txt' : ''}">${esc(
            t.n,
          )}</div><div class="k">${esc(t.k)}</div></div>`,
      )
      .join('')}
  </div>
  ${opts.sections}
  <footer>${esc(opts.footer)}</footer>
</div>
<div id="tip" role="status"></div>
<script>${SCRIPT}</script>
</body>
</html>`;
}

export { hbars, heatmap, legend, lines, stacked, esc };
export type { Series, StackRow };

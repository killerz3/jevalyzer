import type { Exchange } from '../adapters/types.ts';
import { JEV_INPUT_USD_PER_MTOK, sessionCost } from '../core/cost.ts';
import { c, num, usd } from '../core/fmt.ts';
import { preferences } from '../core/prefer.ts';
import { BANK_VERSION } from '../core/questions.ts';
import { bySession, groupBy, scoreExchange, weekOf, type Scored } from '../core/rollup.ts';
import { Store } from '../core/store.ts';
import { shortProject } from '../core/text.ts';
import {
  card,
  esc,
  hbars,
  heatmap,
  legend,
  lines,
  page,
  stacked,
  tableHtml,
  withTable,
  type Series,
  type StackRow,
} from '../report/html.ts';

const OUTCOMES = ['delivered', 'stopped-short', 'handed-back', 'overreached', 'unrequested-refactor'];
const ISSUE_COLUMNS: { key: string; label: string; of: (s: Scored) => number }[] = [
  { key: 'unverified', label: 'Unverified claim', of: (s) => p(s, 'claimedSuccessWithoutEvidence') },
  { key: 'unsupported', label: 'Unsupported fact', of: (s) => p(s, 'assertedUnsupportedFact') },
  { key: 'invented', label: 'Invented API', of: (s) => p(s, 'inventedApiOrFlag') },
  { key: 'overconfident', label: 'Overconfident', of: (s) => frac(s, 'confidenceEvidenceMismatch', 4) },
  { key: 'destructive', label: 'Destructive', of: (s) => p(s, 'didDestructiveAction') },
  { key: 'unconfirmed', label: 'No confirmation', of: (s) => p(s, 'actedWithoutConfirmation') },
  { key: 'waste', label: 'Wasted calls', of: (s) => p(s, 'wastedToolCalls') },
];

function p(s: Scored, id: string): number {
  const a = s.ev.answers[id];
  return a?.type === 'boolean' ? (a.probability ?? 0) : 0;
}
function frac(s: Scored, id: string, levels: number): number {
  const a = s.ev.answers[id];
  return a?.type === 'score' ? (a.score ?? 0) / (levels - 1) : 0;
}
const n1 = (v: number) => v.toFixed(1);

export async function report(opts: { out: string; open?: boolean }): Promise<void> {
  const store = new Store();
  const evaluations = store.best(BANK_VERSION);

  if (evaluations.length === 0) {
    console.log(
      'Nothing scored yet. Run ' + c.bold('jevalyzer analyze') + ' first (or ' + c.bold('jevalyzer scan') + ' to see what was found).',
    );
    store.close();
    return;
  }

  const scored = evaluations.map(scoreExchange);
  const byModel = groupBy(scored, (s) => s.ev.model);
  const byTool = groupBy(scored, (s) => s.ev.tool);
  const byProject = groupBy(scored, (s) => shortProject(s.ev.project));
  const prefs = preferences(scored, byModel);

  const overall = scored.reduce((a, s) => a + s.score, 0) / scored.length;
  const issueCount = scored.reduce((a, s) => a + s.issues.length, 0);
  const spend = evaluations.reduce((a, e) => a + e.inputTokens, 0);

  const sections: string[] = [];

  // --- 1. Preference: the headline question --------------------------------
  const prefChart = hbars(
    prefs.map((pref) => ({
      label: pref.model,
      value: pref.rank,
      note:
        `${pref.n} exchanges` +
        (pref.evidence < 0.6 ? `, ${Math.round(pref.evidence * 100)}% weight` : ''),
      tip:
        `${pref.model}  (n=${pref.n})\n` +
        pref.components.map((cm) => `${cm.label}: ${n1(cm.raw * 100)}%  (z ${cm.z.toFixed(2)})`).join('\n') +
        `\nevidence weight: ${Math.round(pref.evidence * 100)}%`,
    })),
    { max: 100 },
  );
  const thin = prefs.some((p) => p.thinComparison);
  const small = prefs.filter((p) => !p.reliable).length;
  sections.push(
    card(
      'Which model you actually prefer',
      'Not mean quality: a blend of how often the work landed, how often you had to correct or re-ask, how frustrated you sounded, how many exchanges a session took, risky actions, and recency-weighted use.' +
        (thin
          ? ` Only ${prefs.length} model(s) here, which is too few to rank meaningfully - the bars show the raw index around a midpoint of 50 rather than a spread, and a small gap means a small gap.`
          : ' Scaled 0-100 across the models compared, so it ranks them against each other rather than claiming an absolute.') +
        ' Each model\'s index is then shrunk toward the middle by how much evidence stands behind it, so a model with a handful of exchanges cannot outrank one measured over hundreds.' +
        (small ? ` ${small} model(s) have fewer than 5 exchanges.` : ''),
      withTable(prefChart, {
        headers: ['Model', 'Index', 'Delivered', 'Not corrected', 'Calm', 'No risk', 'Recent share', 'n'],
        numeric: [false, true, true, true, true, true, true, true],
        rows: prefs.map((pref) => {
          const g = (k: string) => pref.components.find((cm) => cm.key === k)?.raw ?? 0;
          return [
            pref.model,
            n1(pref.rank),
            `${n1(g('delivered') * 100)}%`,
            `${n1(g('noCorrection') * 100)}%`,
            `${n1(g('calm') * 100)}%`,
            `${n1(g('safe') * 100)}%`,
            `${n1(g('recency') * 100)}%`,
            pref.n,
          ];
        }),
      }),
    ),
  );

  // --- 2. Quality leaderboard ----------------------------------------------
  sections.push(
    card(
      'Jevalyzer Score by model',
      'Correctness 30, instruction adherence 20, outcome 20, efficiency 10, communication 10, minus issue penalties 10. Whiskers are one standard error, so a short bar on two exchanges is visibly not the same claim as a short bar on ninety.',
      withTable(
        hbars(
          byModel.map((g) => ({
            label: g.key,
            value: g.score,
            err: g.stderr,
            note: `n=${g.n}`,
            tip: `${g.key}\nScore ${n1(g.score)} +/- ${n1(g.stderr)}\nDelivered ${n1(g.deliveredRate * 100)}%\nCorrected ${n1(g.correctionRate * 100)}%`,
          })),
          { max: 100 },
        ),
        {
          headers: ['Model', 'Score', 'Std err', 'Delivered', 'Corrected', 'Issues/exchange', 'n'],
          numeric: [false, true, true, true, true, true, true],
          rows: byModel.map((g) => [
            g.key,
            n1(g.score),
            n1(g.stderr),
            `${n1(g.deliveredRate * 100)}%`,
            `${n1(g.correctionRate * 100)}%`,
            g.issueRate.toFixed(2),
            g.n,
          ]),
        },
      ),
    ),
  );

  // --- 3. Trend -------------------------------------------------------------
  const weeks = [...new Set(scored.map((s) => weekOf(s.ev.startedAt)))].filter((w) => w !== 'unknown').sort();
  const topModels = byModel.slice(0, 5);
  const series: Series[] = topModels.map((g, i) => ({
    name: g.key,
    slot: i,
    points: weeks
      .map((w) => {
        const items = scored.filter((s) => s.ev.model === g.key && weekOf(s.ev.startedAt) === w);
        return items.length
          ? { x: w, y: items.reduce((a, s) => a + s.score, 0) / items.length }
          : null;
      })
      .filter((x): x is { x: string; y: number } => x !== null),
  }));
  sections.push(
    card(
      'Quality over time',
      'Mean Jevalyzer Score per week. Gaps are weeks with no exchanges for that model.',
      lines(series, weeks, { yMax: 100 }) +
        legend(topModels.map((g, i) => ({ name: g.key, slot: i }))) +
        withTable('', {
          headers: ['Week', ...topModels.map((g) => g.key)],
          numeric: [false, ...topModels.map(() => true)],
          rows: weeks.map((w) => [
            w,
            ...topModels.map((g) => {
              const items = scored.filter((s) => s.ev.model === g.key && weekOf(s.ev.startedAt) === w);
              return items.length ? n1(items.reduce((a, s) => a + s.score, 0) / items.length) : '-';
            }),
          ]),
        }),
    ),
  );

  // --- 4. Issue heatmap -----------------------------------------------------
  const heatRows = byModel.map((g) => g.key);
  const heatValues = byModel.map((g) => {
    const items = scored.filter((s) => s.ev.model === g.key);
    return ISSUE_COLUMNS.map(
      (col) => items.reduce((a, s) => a + col.of(s), 0) / Math.max(1, items.length),
    );
  });
  sections.push(
    card(
      'Where each model goes wrong',
      'Mean probability of each failure mode per exchange. Darker is worse. These come from Jev as calibrated probabilities, so 0.30 means "about three in ten", not a vote.',
      withTable(
        heatmap(heatRows, ISSUE_COLUMNS.map((col) => col.label), heatValues),
        {
          headers: ['Model', ...ISSUE_COLUMNS.map((col) => col.label)],
          numeric: [false, ...ISSUE_COLUMNS.map(() => true)],
          rows: heatRows.map((m, i) => [m, ...(heatValues[i] ?? []).map((v) => v.toFixed(3))]),
        },
      ),
    ),
  );

  // --- 5. Outcome shape -----------------------------------------------------
  const stackRows: StackRow[] = byModel.map((g) => {
    const items = scored.filter((s) => s.ev.model === g.key);
    return {
      label: g.key,
      segments: OUTCOMES.map((o, i) => ({
        key: o,
        slot: i,
        value: items.filter((s) => s.outcome === o).length,
      })),
    };
  });
  sections.push(
    card(
      'How turns ended',
      'Every exchange lands in exactly one shape. Stopped-short and handed-back are the two ways an agent leaves work on the table; overreach is the opposite failure.',
      stacked(stackRows) +
        legend(OUTCOMES.map((o, i) => ({ name: o, slot: i }))) +
        withTable('', {
          headers: ['Model', ...OUTCOMES, 'n'],
          numeric: [false, ...OUTCOMES.map(() => true), true],
          rows: stackRows.map((r) => [
            r.label,
            ...r.segments.map((s) => s.value),
            r.segments.reduce((a, s) => a + s.value, 0),
          ]),
        }),
    ),
  );

  // --- 6. Tools and projects ------------------------------------------------
  sections.push(
    card(
      'By CLI',
      'Model and harness are confounded - you only run Gemini models under Antigravity - so both views are here rather than one blended ranking.',
      withTable(
        hbars(
          byTool.map((g) => ({ label: g.key, value: g.score, err: g.stderr, note: `n=${g.n}` })),
          { max: 100 },
        ),
        {
          headers: ['CLI', 'Score', 'Delivered', 'Issues/exchange', 'n'],
          numeric: [false, true, true, true, true],
          rows: byTool.map((g) => [
            g.key,
            n1(g.score),
            `${n1(g.deliveredRate * 100)}%`,
            g.issueRate.toFixed(2),
            g.n,
          ]),
        },
      ),
    ),
  );

  sections.push(
    card(
      'By project',
      'Which codebases go smoothly and which ones grind.',
      tableHtml({
        headers: ['Project', 'Score', 'Delivered', 'Corrected', 'Frustration', 'Issues/exchange', 'n'],
        numeric: [false, true, true, true, true, true, true],
        rows: byProject.slice(0, 25).map((g) => [
          g.key,
          n1(g.score),
          `${n1(g.deliveredRate * 100)}%`,
          `${n1(g.correctionRate * 100)}%`,
          n1(g.frustration * 100) + '%',
          g.issueRate.toFixed(2),
          g.n,
        ]),
      }),
    ),
  );

  // --- 6b. Sessions ---------------------------------------------------------
  const sessions = bySession(scored, (id) => {
    const ex = store.exchange(id) as Exchange | null;
    return (ex?.userText ?? '').replace(/\s+/g, ' ').slice(0, 90) || '(no prompt text)';
  });
  const longSessions = sessions.filter((x) => x.exchanges >= 3);
  const worstSessions = (longSessions.length >= 5 ? longSessions : sessions).slice(0, 30);

  sections.push(
    card(
      'Sessions that went worst',
      `${num(sessions.length)} sessions in total. A session is the unit you actually remember, and it is where a bad run shows up as a run rather than as scattered low scores. Ranked by mean score${longSessions.length >= 5 ? ', limited to sessions of 3 or more exchanges' : ''}.`,
      withTable(
        hbars(
          worstSessions.slice(0, 15).map((x) => ({
            label: x.title.slice(0, 44),
            value: x.score,
            note: `${x.exchanges} ex`,
            tip:
              `${x.title}\n${x.tool}${x.model ? ' · ' + x.model : ''} · ${shortProject(x.project)}\n` +
              `${x.exchanges} exchanges · ${n1(x.delivered * 100)}% delivered · ${x.issues} issues` +
              (x.minutes >= 1 ? `\n${Math.round(x.minutes)} minutes` : ''),
          })),
          { max: 100 },
        ),
        {
          headers: ['Session', 'Tool', 'Model', 'Score', 'Exchanges', 'Delivered', 'Issues', 'Minutes', 'Started'],
          numeric: [false, false, false, true, true, true, true, true, false],
          rows: worstSessions.map((x) => [
            x.title.slice(0, 70),
            x.tool,
            x.model ?? '-',
            n1(x.score),
            x.exchanges,
            `${n1(x.delivered * 100)}%`,
            x.issues,
            x.minutes >= 1 ? Math.round(x.minutes) : '-',
            x.startedAt.slice(0, 10),
          ]),
        },
        'Show the session table',
      ),
    ),
  );

  // --- 7. Cost --------------------------------------------------------------
  const costRows = byModel
    .map((g) => {
      const items = scored.filter((s) => s.ev.model === g.key);
      let dollars = 0;
      for (const s of items) {
        const ex = store.exchange(s.ev.exchangeId) as Exchange | null;
        const cost = sessionCost(s.ev.model, ex?.usage ?? null);
        if (cost) dollars += cost;
      }
      const delivered = items.filter((s) => s.outcome === 'delivered').length;
      return { model: g.key, dollars, delivered, n: items.length };
    })
    .filter((r) => r.dollars > 0)
    .sort((a, b) => b.dollars - a.dollars);

  sections.push(
    card(
      'What the sessions themselves cost',
      'Attributed from the token usage the harnesses recorded, at public list prices. Cost per delivered outcome is the number that actually matters when comparing an expensive model against a cheap one.',
      costRows.length
        ? withTable(
            hbars(
              costRows.map((r) => ({
                label: r.model,
                value: r.dollars,
                note: r.delivered ? `${usd(r.dollars / r.delivered)}/delivered` : 'none delivered',
                tip: `${r.model}\n${usd(r.dollars)} over ${r.n} exchanges`,
              })),
              { unit: '' },
            ),
            {
              headers: ['Model', 'Spend', 'Delivered', 'Cost per delivered', 'n'],
              numeric: [false, true, true, true, true],
              rows: costRows.map((r) => [
                r.model,
                usd(r.dollars),
                r.delivered,
                r.delivered ? usd(r.dollars / r.delivered) : '-',
                r.n,
              ]),
            },
          )
        : '<p class="empty">No token usage was recorded for these sessions.</p>',
    ),
  );

  // --- 8. Drill-down --------------------------------------------------------
  const worst = [...scored].sort((a, b) => a.score - b.score).slice(0, 120);
  const allIssues = [...new Set(scored.flatMap((s) => s.issues))].sort();
  const rows = worst
    .map((s) => {
      const ex = store.exchange(s.ev.exchangeId) as Exchange | null;
      const q = (ex?.userText ?? '').replace(/\s+/g, ' ').slice(0, 160);
      const hay = `${q} ${s.ev.model ?? ''} ${s.ev.tool} ${shortProject(s.ev.project)}`.toLowerCase();
      const answers = Object.entries(s.ev.answers)
        .map(([k, a]) => {
          const v =
            a.type === 'boolean'
              ? (a.probability ?? 0).toFixed(2)
              : a.type === 'score'
                ? (a.score ?? 0).toFixed(2)
                : (a.choice ?? '-');
          return `<div class="ans"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`;
        })
        .join('');
      return (
        `<details class="ex" data-hay="${esc(hay)}" data-issues="${esc(s.issues.join('|'))}">` +
        `<summary><span class="sc">${Math.round(s.score)}</span>` +
        `<span class="q">${esc(q || '(no prompt text)')}</span>` +
        `<span class="tags"><span class="tag">${esc(s.ev.model ?? s.ev.tool)}</span>` +
        s.issues.slice(0, 3).map((i) => `<span class="tag bad">${esc(i)}</span>`).join('') +
        `</span></summary>` +
        `<div class="body">` +
        `<p class="note">${esc(s.ev.tool)} · ${esc(shortProject(s.ev.project))} · ${esc(
          s.ev.startedAt.slice(0, 16).replace('T', ' '),
        )}${s.ev.chunked ? ' · scored in segments' : ''}</p>` +
        `<pre>${esc((ex?.userText ?? '').slice(0, 1500))}</pre>` +
        `<pre>${esc((ex?.assistantText ?? '(no text reply)').slice(0, 2500))}</pre>` +
        `<div class="answers">${answers}</div></div></details>`
      );
    })
    .join('');

  sections.push(
    card(
      'The 120 worst exchanges',
      'Lowest Jevalyzer Score first. Open one to see the prompt, the reply and every answer Jev gave, so a score can always be argued with.',
      `<div class="filters">` +
        `<input id="q" type="search" placeholder="Filter by prompt, model, project..." aria-label="Filter exchanges">` +
        `<select id="issue" aria-label="Filter by issue"><option value="">All issues</option>` +
        allIssues.map((i) => `<option value="${esc(i)}">${esc(i)}</option>`).join('') +
        `</select><span class="note" id="count">${worst.length} shown</span></div>` +
        rows,
    ),
  );

  const tools = [...new Set(evaluations.map((e) => e.tool))];
  const html = page({
    title: 'Jevalyzer',
    subtitle: `${evaluations.length} exchanges across ${tools.length} ${
      tools.length === 1 ? 'CLI' : 'CLIs'
    } and ${byModel.length} models, scored with typesafe-ai/jev.`,
    tiles: [
      { n: n1(overall), k: 'Mean Jevalyzer Score' },
      // The hero number must not be driven by a handful of exchanges: take the
      // top model that actually has enough evidence behind it.
      (() => {
        const solid = prefs.filter((p) => p.reliable && p.n >= 25);
        const pick = solid[0] ?? prefs.find((p) => p.reliable) ?? prefs[0];
        return {
          n: pick?.model ?? '-',
          k: pick ? `Preferred model  ·  n=${pick.n}` : 'Preferred model',
        };
      })(),
      { n: num(issueCount), k: 'Issues found' },
      { n: num(sessions.length), k: 'Sessions' },
      { n: `${n1(scored.filter((s) => s.outcome === 'delivered').length / scored.length * 100)}%`, k: 'Delivered' },
      { n: usd((spend / 1e6) * JEV_INPUT_USD_PER_MTOK), k: 'Cost to analyse' },
    ],
    sections: sections.join('\n'),
    footer: `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} by jevalyzer. Scores come from typesafe-ai/jev via Vercel AI Gateway; every number here is reproducible from ~/.jevalyzer/jevalyzer.db.`,
  });

  await Bun.write(opts.out, html);
  store.close();
  console.log(c.green('Wrote ') + opts.out + c.dim(` (${(html.length / 1024).toFixed(0)} KB, self-contained)`));

  if (opts.open) {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      Bun.spawn([cmd, opts.out], { stdout: 'ignore', stderr: 'ignore' });
    } catch {
      console.log(c.dim('Could not open a browser automatically.'));
    }
  }
}

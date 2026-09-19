import type { SourceId } from '../adapters/types.ts';
import { allExchanges, scanSources } from '../adapters/registry.ts';
import { TokenCalibrator, packExchange } from '../core/budget.ts';
import { JEV_INPUT_USD_PER_MTOK } from '../core/cost.ts';
import { bytes, c, num, table, usd } from '../core/fmt.ts';
import { shortProject } from '../core/text.ts';

export interface ScanOptions {
  source?: SourceId[];
  json?: boolean;
  byProject?: boolean;
  includeSidechains?: boolean;
}

/**
 * `scan` is fully local: it needs no API key and sends nothing anywhere. It is
 * what a new user should run first, both to see that their history was found
 * and to see what an analysis would cost before committing to one.
 */
export async function scan(opts: ScanOptions): Promise<void> {
  const scans = await scanSources(opts.source);
  const exchanges = allExchanges(scans, opts.includeSidechains);

  const cal = new TokenCalibrator();
  let requests = 0;
  let tokens = 0;
  let chunked = 0;
  for (const e of exchanges) {
    const packs = packExchange(e, cal);
    requests += packs.length;
    if (packs.length > 1) chunked += 1;
    for (const p of packs) tokens += p.estimatedTokens;
  }
  const cost = (tokens / 1e6) * JEV_INPUT_USD_PER_MTOK;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          sources: scans.map((s) => ({
            id: s.adapter.id,
            label: s.adapter.label,
            roots: s.adapter.roots(),
            sessions: s.sessions.length,
            exchanges: s.sessions.reduce((a, x) => a + x.exchanges.length, 0),
            bytes: s.sessions.reduce((a, x) => a + x.meta.bytes, 0),
            errors: s.errors,
          })),
          totals: { exchanges: exchanges.length, requests, estimatedTokens: tokens, estimatedCostUsd: cost },
        },
        null,
        2,
      ),
    );
    return;
  }

  const rows = scans.map((s) => {
    const found = s.refs.length > 0;
    const ex = s.sessions.reduce((a, x) => a + x.exchanges.length, 0);
    return [
      found ? s.adapter.label : c.dim(s.adapter.label),
      found ? num(s.sessions.length) : c.dim('not found'),
      found ? num(ex) : c.dim('-'),
      found ? bytes(s.sessions.reduce((a, x) => a + x.meta.bytes, 0)) : c.dim('-'),
      s.errors.length ? c.yellow(`${s.errors.length} unreadable`) : '',
    ];
  });

  console.log(c.bold('\nSources'));
  console.log(table(['Tool', 'Sessions', 'Exchanges', 'On disk', ''], rows));

  const models = new Map<string, number>();
  for (const e of exchanges) if (e.model) models.set(e.model, (models.get(e.model) ?? 0) + 1);
  if (models.size) {
    console.log(c.bold('\nModels seen'));
    console.log(
      table(
        ['Model', 'Exchanges'],
        [...models.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => [m, num(n)]),
      ),
    );
  }

  if (opts.byProject) {
    const projects = new Map<string, number>();
    for (const e of exchanges) {
      const k = shortProject(e.project);
      projects.set(k, (projects.get(k) ?? 0) + 1);
    }
    console.log(c.bold('\nProjects'));
    console.log(
      table(
        ['Project', 'Exchanges'],
        [...projects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([p, n]) => [p, num(n)]),
      ),
    );
  }

  console.log(c.bold('\nAnalysis estimate'));
  console.log(
    table(
      ['Exchanges', 'Requests', 'Input tokens', 'Cost at list price'],
      [[num(exchanges.length), num(requests), num(tokens), usd(cost)]],
    ),
  );
  if (chunked) {
    console.log(
      c.dim(
        `  ${chunked} exchange(s) exceed the 64k context on their own and will be split across segments.`,
      ),
    );
  }
  console.log(
    c.dim('  Jev is free on Vercel AI Gateway until 25 Sep 2026; after that, input is billed at ') +
      c.dim(`$${JEV_INPUT_USD_PER_MTOK}/M with output free.`),
  );
  console.log(c.dim('\n  Next: ') + 'jevalyzer analyze' + c.dim('  (add --dry-run to send nothing)'));

  for (const s of scans) {
    for (const err of s.errors.slice(0, 3)) {
      console.log(c.yellow(`\n  ! ${s.adapter.label}: ${err.ref}\n    ${err.message}`));
    }
  }
}

import type { Exchange, SourceId } from '../adapters/types.ts';
import { allExchanges, scanSources } from '../adapters/registry.ts';
import { TokenCalibrator, packExchange, type Packed } from '../core/budget.ts';
import { SETUP_HELP } from '../core/config.ts';
import { BILLING_HELP, isBillingBlock, resolveProvider, type Backend } from '../core/provider.ts';
import { JEV_FREE_UNTIL, JEV_INPUT_USD_PER_MTOK, jevCost } from '../core/cost.ts';
import { makeEvaluator, pool, RateLimiter } from '../core/evaluate.ts';
import { c, num, table, usd } from '../core/fmt.ts';
import { BANK_VERSION, QUESTION_IDS } from '../core/questions.ts';
import { redactDeep } from '../core/redact.ts';
import { Store, type StoredAnswer } from '../core/store.ts';

export interface AnalyzeOptions {
  source?: SourceId[];
  limit?: number;
  dryRun?: boolean;
  budget: number;
  concurrency: number;
  model?: string;
  backend?: Backend;
  apiKey?: string;
  redact?: boolean;
  zdr: boolean;
  force?: boolean;
  includeSidechains?: boolean;
  yes?: boolean;
}

interface Job {
  exchange: Exchange;
  packed: Packed;
}

export async function analyze(opts: AnalyzeOptions): Promise<void> {
  const store = new Store();
  const cached = opts.force ? new Set<string>() : store.cachedIds(BANK_VERSION);

  process.stderr.write(c.dim('Reading sessions...\r'));
  const scans = await scanSources(opts.source);
  let exchanges = allExchanges(scans, opts.includeSidechains);
  process.stderr.write(' '.repeat(40) + '\r');

  const skipped = exchanges.filter((e) => cached.has(e.id)).length;
  exchanges = exchanges.filter((e) => !cached.has(e.id));
  if (opts.limit != null) exchanges = exchanges.slice(0, opts.limit);

  if (exchanges.length === 0) {
    console.log(
      skipped
        ? c.green(`Nothing new. ${num(skipped)} exchange(s) already scored; use --force to redo.`)
        : 'No exchanges found. Run ' + c.bold('jevalyzer scan') + ' to see what was detected.',
    );
    store.close();
    return;
  }

  const cal = new TokenCalibrator();
  const jobs: Job[] = [];
  for (const e of exchanges) {
    for (const packed of packExchange(e, cal)) {
      jobs.push({
        exchange: e,
        packed: opts.redact
          ? { ...packed, state: redactDeep(packed.state) }
          : packed,
      });
    }
  }

  const estTokens = jobs.reduce((a, j) => a + j.packed.estimatedTokens, 0);
  const estCost = jevCost(estTokens);

  console.log(
    table(
      ['Exchanges', 'Requests', 'Est. input tokens', 'Est. cost', 'Cached'],
      [[num(exchanges.length), num(jobs.length), num(estTokens), usd(estCost), num(skipped)]],
    ),
  );

  if (opts.dryRun) {
    const sample = jobs[0]!;
    console.log(c.bold('\nExactly what one request would send:'));
    console.log(c.dim(`state (${num(sample.packed.estimatedTokens)} est. tokens, ladder: ${sample.packed.applied.join(', ') || 'none applied'})`));
    console.log(JSON.stringify(sample.packed.state, null, 2).slice(0, 4000));
    console.log(c.dim(`\nplus ${QUESTION_IDS.length} questions, answered in one round trip.`));
    const over = jobs.filter((j) => j.packed.estimatedTokens > 60_000);
    console.log(
      over.length
        ? c.red(`\n${over.length} packed state(s) exceed the 60k ceiling - that is a packer bug.`)
        : c.green(`\nAll ${num(jobs.length)} packed states are within the 60k ceiling. Nothing was sent.`),
    );
    store.close();
    return;
  }

  if (estCost > opts.budget) {
    console.log(
      c.red(
        `\nEstimated ${usd(estCost)} exceeds --budget ${usd(opts.budget)}. Raise the budget or use --limit.`,
      ),
    );
    store.close();
    process.exitCode = 1;
    return;
  }

  let provider;
  try {
    provider = await resolveProvider({
      backend: opts.backend,
      apiKey: opts.apiKey,
      model: opts.model,
    });
  } catch (e) {
    console.log(c.yellow(e instanceof Error && e.message === 'no-key' ? SETUP_HELP : String(e)));
    store.close();
    process.exitCode = 1;
    return;
  }

  if (!opts.yes && process.stdin.isTTY) {
    const today = new Date().toISOString().slice(0, 10);
    const free = today <= JEV_FREE_UNTIL;
    console.log(
      c.dim(
        free
          ? `\nJev is free on AI Gateway until ${JEV_FREE_UNTIL}; after that this run would cost about ${usd(estCost)}.`
          : `\nThis will send ${num(jobs.length)} requests and cost about ${usd(estCost)} at $${JEV_INPUT_USD_PER_MTOK}/M.`,
      ),
    );
    console.log(
      c.dim(
        `Key from ${provider.keySource} (${provider.backend}, ${provider.modelId}). Transcript text will be sent to ${
          provider.backend === 'gateway' ? 'the Vercel AI Gateway' : 'api.typesafe.ai'
        }.`,
      ),
    );
    const answer = prompt('Continue? [y/N]') ?? '';
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('Aborted.');
      store.close();
      return;
    }
  }

  const run = makeEvaluator({ model: provider.model, zeroDataRetention: opts.zdr });
  const limiter = new RateLimiter(1000);

  // Segments of one split exchange are merged before being stored.
  const merged = new Map<string, { answers: Record<string, StoredAnswer>[]; tokens: number; conf: number[] }>();
  let done = 0;
  let failed = 0;
  let actualTokens = 0;
  const started = Date.now();
  const failures: string[] = [];

  const tick = () => {
    const pct = Math.round((done / jobs.length) * 100);
    process.stderr.write(
      `\r${c.cyan('scoring')} ${done}/${jobs.length} (${pct}%)  ${failed ? c.yellow(`${failed} failed`) : ''}   `,
    );
  };

  await pool(
    jobs,
    opts.concurrency,
    async (job) => {
      await limiter.take();
      const out = await run(job.packed);
      cal.observe(JSON.stringify(job.packed.state).length, out.inputTokens);
      return out;
    },
    (result, error, i) => {
      done += 1;
      const job = jobs[i]!;
      if (error || !result) {
        failed += 1;
        if (failures.length < 5) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      } else {
        actualTokens += result.inputTokens;
        const entry = merged.get(job.exchange.id) ?? { answers: [], tokens: 0, conf: [] };
        entry.answers.push(result.answers);
        entry.tokens += result.inputTokens;
        if (result.confidence != null) entry.conf.push(result.confidence);
        merged.set(job.exchange.id, entry);
      }
      tick();
    },
  );
  process.stderr.write('\r' + ' '.repeat(70) + '\r');

  const byId = new Map(exchanges.map((e) => [e.id, e]));
  store.transaction(() => {
    for (const [id, entry] of merged) {
      const e = byId.get(id);
      if (!e) continue;
      store.save(
        {
          exchangeId: id,
          tool: e.tool,
          sessionId: e.sessionId,
          model: e.model,
          project: e.project,
          startedAt: e.startedAt,
          bankVersion: BANK_VERSION,
          answers: mergeAnswers(entry.answers),
          inputTokens: entry.tokens,
          chunked: entry.answers.length > 1,
          confidence: entry.conf.length
            ? entry.conf.reduce((a, b) => a + b, 0) / entry.conf.length
            : null,
          evaluatedAt: new Date().toISOString(),
        },
        e,
      );
    }
  });

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    table(
      ['Scored', 'Failed', 'Actual tokens', 'Actual cost', 'Time'],
      [
        [num(merged.size), failed ? c.yellow(num(failed)) : '0', num(actualTokens), usd(jevCost(actualTokens)), `${secs}s`],
      ],
    ),
  );
  const drift = estTokens > 0 ? ((actualTokens - estTokens) / estTokens) * 100 : 0;
  console.log(
    c.dim(
      `  Token estimate was ${drift >= 0 ? '+' : ''}${drift.toFixed(1)}% off; calibrated to ${cal.charsPerToken.toFixed(2)} chars/token.`,
    ),
  );
  for (const f of failures) console.log(c.yellow(`  ! ${f}`));
  if (failures.some(isBillingBlock)) console.log(c.yellow(BILLING_HELP));
  console.log(c.dim('\n  Next: ') + 'jevalyzer report --open' + c.dim('  or  ') + 'jevalyzer tui');
  store.close();
}

/**
 * Merge the answers from segments of one split exchange: booleans and score
 * questions take the worst (most alarming) reading, since a problem anywhere in
 * a long run is a problem with the run.
 */
function mergeAnswers(parts: Record<string, StoredAnswer>[]): Record<string, StoredAnswer> {
  if (parts.length === 1) return parts[0]!;
  const out: Record<string, StoredAnswer> = {};
  for (const id of QUESTION_IDS) {
    const present = parts.map((p) => p[id]).filter(Boolean) as StoredAnswer[];
    if (!present.length) continue;
    const first = present[0]!;
    if (first.type === 'boolean') {
      out[id] = { type: 'boolean', probability: Math.max(...present.map((p) => p.probability ?? 0)) };
    } else if (first.type === 'score') {
      const scores = present.map((p) => p.score ?? 0);
      out[id] = { type: 'score', score: scores.reduce((a, b) => a + b, 0) / scores.length };
    } else {
      // Choice: take the option with the highest probability across segments.
      const totals = new Map<string, number>();
      for (const p of present) {
        for (const [k, v] of Object.entries(p.probabilities ?? { [p.choice ?? '']: 1 })) {
          totals.set(k, (totals.get(k) ?? 0) + v);
        }
      }
      const best = [...totals.entries()].sort((a, b) => b[1] - a[1])[0];
      out[id] = { type: 'choice', choice: best?.[0] ?? first.choice };
    }
  }
  return out;
}

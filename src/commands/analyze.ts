import type { Exchange, SourceId } from '../adapters/types.ts';
import { allExchanges, scanSources } from '../adapters/registry.ts';
import { TokenCalibrator, budgetFor, packExchange, type Packed } from '../core/budget.ts';
import { SETUP_HELP } from '../core/config.ts';
import { BILLING_HELP, isBillingBlock, resolveProvider, type Backend } from '../core/provider.ts';
import { JEV_FREE_UNTIL, JEV_INPUT_USD_PER_MTOK, jevCost } from '../core/cost.ts';
import { isContextOverflow, isRateLimit, makeEvaluator, pool, RateLimiter } from '../core/evaluate.ts';
import { c, num, table, usd } from '../core/fmt.ts';
import { BANK_VERSION, bankFor, bankSize, type Profile } from '../core/questions.ts';
import { redactDeep } from '../core/redact.ts';
import { Progress } from '../core/progress.ts';
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
  patient?: boolean;
  profile?: Profile;
  yes?: boolean;
  /** Suppress the summary tables when a wrapper prints its own. */
  quiet?: boolean;
}

export interface AnalyzeResult {
  saved: number;
  failed: number;
  remaining: number;
  tokens: number;
  quotaExhausted: boolean;
}

interface Job {
  exchange: Exchange;
  packed: Packed;
}

export async function analyze(opts: AnalyzeOptions): Promise<AnalyzeResult> {
  const profile: Profile = opts.profile ?? 'minimal';
  const questions = bankFor(profile);
  const store = new Store();
  const cached = opts.force ? new Set<string>() : store.cachedIds(BANK_VERSION, profile);
  const nothing: AnalyzeResult = {
    saved: 0,
    failed: 0,
    remaining: 0,
    tokens: 0,
    quotaExhausted: false,
  };

  if (!opts.quiet) process.stderr.write(c.dim('Reading sessions...\r'));
  const scans = await scanSources(opts.source);
  let exchanges = allExchanges(scans, opts.includeSidechains);
  if (!opts.quiet) process.stderr.write(' '.repeat(40) + '\r');

  // A full scan is the only moment we know the complete set of live exchange
  // ids, so it is the only safe moment to drop orphans left by adapter fixes.
  if (!opts.source?.length && !opts.limit) {
    const pruned = store.prune(new Set(allExchanges(scans, true).map((e) => e.id)));
    if (pruned && !opts.quiet) {
      console.log(c.dim(`Dropped ${num(pruned)} evaluation(s) for exchanges that no longer exist.`));
    }
  }

  const skipped = exchanges.filter((e) => cached.has(e.id)).length;
  exchanges = exchanges.filter((e) => !cached.has(e.id));
  if (opts.limit != null) exchanges = exchanges.slice(0, opts.limit);

  if (exchanges.length === 0) {
    if (!opts.quiet) {
      console.log(
        skipped
          ? c.green(`Nothing new. ${num(skipped)} exchange(s) already scored; use --force to redo.`)
          : 'No exchanges found. Run ' + c.bold('jevalyzer scan') + ' to see what was detected.',
      );
    }
    store.close();
    return nothing;
  }

  // The provider is resolved first because the context window - and therefore
  // how aggressively each exchange must be packed - depends on the route.
  let provider;
  try {
    provider = await resolveProvider({
      backend: opts.backend,
      apiKey: opts.apiKey,
      model: opts.model,
    });
  } catch (e) {
    if (!opts.dryRun) {
      console.log(c.yellow(e instanceof Error && e.message === 'no-key' ? SETUP_HELP : String(e)));
      store.close();
      process.exitCode = 1;
      return nothing;
    }
    provider = null;
  }

  const { target, ceiling } = budgetFor(provider?.contextTokens ?? 64_000);
  const cal = new TokenCalibrator();
  const jobs: Job[] = [];
  for (const e of exchanges) {
    for (const packed of packExchange(e, cal, target, ceiling)) {
      jobs.push({
        exchange: e,
        packed: opts.redact
          ? { ...packed, state: redactDeep(packed.state) }
          : packed,
      });
    }
  }

  /** How many segments each exchange was split into, so it can be saved the
   *  moment its last one lands rather than at the end of the whole run. */
  const segmentsOf = new Map<string, number>();
  for (const j of jobs) segmentsOf.set(j.exchange.id, (segmentsOf.get(j.exchange.id) ?? 0) + 1);

  const estTokens = jobs.reduce((a, j) => a + j.packed.estimatedTokens, 0);
  const estCost = jevCost(estTokens);

  if (!opts.quiet) {
    console.log(
      table(
        ['Exchanges', 'Requests', 'Est. input tokens', 'Est. cost', 'Cached'],
        [[num(exchanges.length), num(jobs.length), num(estTokens), usd(estCost), num(skipped)]],
      ),
    );
  }

  if (opts.dryRun) {
    const sample = jobs[0]!;
    console.log(c.bold('\nExactly what one request would send:'));
    console.log(c.dim(`state (${num(sample.packed.estimatedTokens)} est. tokens, ladder: ${sample.packed.applied.join(', ') || 'none applied'})`));
    console.log(JSON.stringify(sample.packed.state, null, 2).slice(0, 4000));
    console.log(
      c.dim(`\nplus ${bankSize(profile)} questions (${profile} profile), answered in one round trip.`),
    );
    const over = jobs.filter((j) => j.packed.estimatedTokens > ceiling);
    console.log(
      over.length
        ? c.red(`\n${over.length} packed state(s) exceed the ${num(ceiling)} ceiling - that is a packer bug.`)
        : c.green(
            `\nAll ${num(jobs.length)} packed states are within the ${num(ceiling)}-token ceiling` +
              `${provider ? ` for ${provider.backend}` : ''}. Nothing was sent.`,
          ),
    );
    store.close();
    return nothing;
  }

  if (estCost > opts.budget) {
    console.log(
      c.red(
        `\nEstimated ${usd(estCost)} exceeds --budget ${usd(opts.budget)}. Raise the budget or use --limit.`,
      ),
    );
    store.close();
    process.exitCode = 1;
    return nothing;
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
        `Key from ${provider!.keySource} (${provider!.backend}, ${provider!.modelId}). Transcript text will be sent to ${provider!.destination}.`,
      ),
    );
    const answer = prompt('Continue? [y/N]') ?? '';
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('Aborted.');
      store.close();
      return nothing;
    }
  }

  let zdrGivenUp = false;
  const run = makeEvaluator({
    questions,
    model: provider!.model,
    zeroDataRetention: opts.zdr,
    onZdrDisabled: () => {
      zdrGivenUp = true;
    },
  });
  // Start well below the documented paid ceiling; the limiter finds the real
  // rate from the gateway's pushback rather than assuming one.
  const limiter = new RateLimiter(opts.patient ? 30 : 120);

  // Segments of one split exchange are merged before being stored.
  const merged = new Map<string, { answers: Record<string, StoredAnswer>[]; tokens: number; conf: number[] }>();
  let done = 0;
  let failed = 0;
  /**
   * A free-tier key runs out of allowance rather than failing outright. Once a
   * run of consecutive requests has all been refused, stop instead of grinding
   * through the rest - the cache means a later re-run picks up where this left
   * off, so nothing is lost by quitting early.
   */
  let consecutiveRateLimits = 0;
  let quotaExhausted = false;
  let saved = 0;
  let actualTokens = 0;
  const started = Date.now();
  /** Distinct failure message -> how many times it happened. */
  const failures = new Map<string, number>();

  // The reported token count covers state AND questions, so the chars side of
  // the ratio has to include the question bank too - otherwise a small state
  // makes the model look absurdly token-dense and the packer over-truncates
  // everything after it.
  const questionChars = JSON.stringify(questions).length;
  const progress = new Progress(!opts.quiet && process.stderr.isTTY === true);
  progress.start(jobs.length);
  const tick = () =>
    progress.update({
      done,
      saved,
      failed,
      tokens: actualTokens,
      rate: limiter.rate,
      note: `${provider!.backend} · ${profile} profile · ${bankSize(profile)} questions · ${limiter.rate}/min allowed`,
    });

  await pool(
    jobs,
    opts.patient ? 1 : opts.concurrency,
    async (job) => {
      await limiter.take();
      try {
        const out = await run(job.packed);
        limiter.recover();
        cal.observe(JSON.stringify(job.packed.state).length + questionChars, out.inputTokens);
        return out;
      } catch (e) {
        if (!isContextOverflow(e)) throw e;
        // The estimate was optimistic for this one. Re-pack it much harder and
        // try again rather than losing the exchange: a first run has no
        // calibration to work from, and one bad guess should not drop data.
        for (const shrink of [0.4, 0.15]) {
          const [retry] = packExchange(job.exchange, cal, target * shrink, ceiling * shrink);
          if (!retry) break;
          try {
            const out = await run(opts.redact ? { ...retry, state: redactDeep(retry.state) } : retry);
            limiter.recover();
            cal.observe(JSON.stringify(retry.state).length + questionChars, out.inputTokens);
            return out;
          } catch (inner) {
            if (!isContextOverflow(inner)) throw inner;
          }
        }
        throw e;
      }
    },
    (result, error, i) => {
      done += 1;
      const job = jobs[i]!;
      if (error || !result) {
        failed += 1;
        const msg = error instanceof Error ? error.message : String(error);
        failures.set(msg, (failures.get(msg) ?? 0) + 1);
        if (isRateLimit(error)) {
          consecutiveRateLimits += 1;
          if (consecutiveRateLimits >= 3) quotaExhausted = true;
        } else {
          consecutiveRateLimits = 0;
        }
      } else {
        consecutiveRateLimits = 0;
        actualTokens += result.inputTokens;
        const entry = merged.get(job.exchange.id) ?? { answers: [], tokens: 0, conf: [] };
        entry.answers.push(result.answers);
        entry.tokens += result.inputTokens;
        if (result.confidence != null) entry.conf.push(result.confidence);
        merged.set(job.exchange.id, entry);
        // Persist as soon as this exchange is complete. A throttled run can be
        // interrupted at any point, and anything already paid for must survive.
        if (entry.answers.length === (segmentsOf.get(job.exchange.id) ?? 1)) {
          saveExchange(store, job.exchange, entry, profile);
          saved += 1;
        }
      }
      tick();
    },
    {
      onRateLimit: () => limiter.penalize(),
      shouldStop: () => quotaExhausted,
    },
  );
  progress.stop();

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (opts.quiet) {
    store.close();
    return {
      saved,
      failed,
      remaining: exchanges.length - saved,
      tokens: actualTokens,
      quotaExhausted,
    };
  }
  console.log(
    table(
      ['Scored', 'Failed', 'Actual tokens', 'Actual cost', 'Time'],
      [
        [num(saved), failed ? c.yellow(num(failed)) : '0', num(actualTokens), usd(jevCost(actualTokens)), `${secs}s`],
      ],
    ),
  );
  const drift = estTokens > 0 ? ((actualTokens - estTokens) / estTokens) * 100 : 0;
  console.log(
    c.dim(
      `  Token estimate was ${drift >= 0 ? '+' : ''}${drift.toFixed(1)}% off; calibrated to ${cal.charsPerToken.toFixed(2)} chars/token.`,
    ),
  );
  if (quotaExhausted) {
    const left = exchanges.length - saved;
    console.log(
      c.yellow(
        `\n  Stopped early: the gateway stopped accepting requests (free-tier allowance).\n` +
          `  ${num(saved)} exchange(s) were scored and saved. About ${num(left)} remain -\n` +
          `  the allowance refills, so just run ${c.bold('jevalyzer analyze')} again to continue\n` +
          `  from where this left off. Nothing already scored is paid for twice.`,
      ),
    );
  }
  if (zdrGivenUp) {
    console.log(
      c.yellow(
        '  ! Zero data retention needs a Vercel Pro plan; this run continued without it.',
      ),
    );
  }
  for (const [msg, count] of [...failures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(c.yellow(`  ! ${count}x  ${msg}`));
  }
  if ([...failures.keys()].some(isBillingBlock)) console.log(c.yellow(BILLING_HELP));
  console.log(c.dim('\n  Next: ') + 'jevalyzer report --open' + c.dim('  or  ') + 'jevalyzer tui');
  store.close();
  return { saved, failed, remaining: exchanges.length - saved, tokens: actualTokens, quotaExhausted };
}

/**
 * Merge the answers from segments of one split exchange: booleans and score
 * questions take the worst (most alarming) reading, since a problem anywhere in
 * a long run is a problem with the run.
 */
function mergeAnswers(parts: Record<string, StoredAnswer>[]): Record<string, StoredAnswer> {
  if (parts.length === 1) return parts[0]!;
  const out: Record<string, StoredAnswer> = {};
  const ids = [...new Set(parts.flatMap((p) => Object.keys(p)))];
  for (const id of ids) {
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


/** Write one completed exchange to the store immediately. */
function saveExchange(
  store: Store,
  e: Exchange,
  entry: { answers: Record<string, StoredAnswer>[]; tokens: number; conf: number[] },
  profile: Profile,
): void {
  store.save(
    {
      exchangeId: e.id,
      bank: profile,
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

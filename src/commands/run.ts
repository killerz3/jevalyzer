import { allExchanges, scanSources } from '../adapters/registry.ts';
import { TokenCalibrator, budgetFor, packExchange } from '../core/budget.ts';
import { readConfig, writeConfig } from '../core/config.ts';
import { JEV_INPUT_USD_PER_MTOK, jevCost } from '../core/cost.ts';
import { bytes, c, num, usd } from '../core/fmt.ts';
import { PROFILE_BLURB, bankSize, type Profile } from '../core/questions.ts';
import { resolveProvider, type Backend } from '../core/provider.ts';
import { Store } from '../core/store.ts';
import { analyze } from './analyze.ts';

/**
 * `bunx jevalyzer` with no arguments: the whole thing, guided.
 *
 * Someone running this for the first time should not have to learn a
 * subcommand, pick a profile they cannot evaluate, or discover the rate limit
 * by watching it fail. So: find their sessions, set up credentials if missing,
 * offer a default that is cheap and fast, then score with a live display and
 * hand back a report.
 */

export interface RunOptions {
  profile?: Profile;
  yes?: boolean;
  limit?: number;
  open?: boolean;
  out: string;
}

function ask(question: string, fallback = ''): string {
  if (!process.stdin.isTTY) return fallback;
  return (prompt(question) ?? fallback).trim() || fallback;
}

function heading(text: string): void {
  console.log('\n' + c.bold(text));
}

export async function run(opts: RunOptions): Promise<void> {
  console.log(c.bold('\njevalyzer') + c.dim('  grade your local agent sessions with Jev\n'));

  // --- 1. What is on this machine ------------------------------------------
  process.stderr.write(c.dim('Looking for sessions...\r'));
  const scans = await scanSources();
  const exchanges = allExchanges(scans);
  process.stderr.write(' '.repeat(40) + '\r');

  const found = scans.filter((s) => s.refs.length > 0);
  if (exchanges.length === 0) {
    console.log(c.yellow('No agent sessions found on this machine.'));
    console.log(c.dim('Looked in:'));
    for (const s of scans) console.log(c.dim(`  ${s.adapter.label.padEnd(13)} ${s.adapter.roots()[0]}`));
    return;
  }

  heading('Found');
  for (const s of found) {
    const ex = s.sessions.reduce((a, x) => a + x.exchanges.length, 0);
    const size = s.sessions.reduce((a, x) => a + x.meta.bytes, 0);
    console.log(
      `  ${s.adapter.label.padEnd(13)} ${num(s.sessions.length).padStart(4)} sessions  ` +
        c.dim(`${num(ex)} exchanges, ${bytes(size)}`),
    );
  }

  const store = new Store();
  const alreadyScored = store.count();
  store.close();
  if (alreadyScored) console.log(c.dim(`  ${num(alreadyScored)} already scored from a previous run`));

  // --- 2. Credentials -------------------------------------------------------
  let provider = await resolveProvider({}).catch(() => null);
  if (!provider) {
    heading('Setup');
    console.log('Jevalyzer scores with Jev, using your own account. Nothing is shared.\n');
    console.log(`  ${c.bold('1')} Vercel AI Gateway  ${c.dim('needs a card on file; free tier is rate-limited')}`);
    console.log(`  ${c.bold('2')} Cloudflare Workers AI  ${c.dim('needs Cloudflare credit or BYOK')}`);
    console.log(`  ${c.bold('3')} TypeSafe directly  ${c.dim('needs a TypeSafe key')}\n`);
    const pick = ask('Which? [1]', '1');
    const backend: Backend = pick === '2' ? 'cloudflare' : pick === '3' ? 'typesafe' : 'gateway';

    const cfg = await readConfig();
    if (backend === 'cloudflare') {
      console.log(c.dim('\n  Account id: dashboard sidebar. Token: profile/api-tokens, Workers AI template.'));
      const accountId = ask('Cloudflare account id:');
      const token = ask('Cloudflare API token:');
      if (!accountId || !token) return console.log(c.yellow('\nBoth are needed. Nothing saved.'));
      await writeConfig({ ...cfg, cloudflareAccountId: accountId, cloudflareApiToken: token });
    } else if (backend === 'typesafe') {
      console.log(c.dim('\n  Key from https://console.typesafe.ai/keys'));
      const key = ask('TypeSafe key:');
      if (!key) return console.log(c.yellow('\nNothing entered. Nothing saved.'));
      await writeConfig({ ...cfg, typesafeApiKey: key });
    } else {
      console.log(c.dim('\n  Key from https://vercel.com/d?to=/[team]/~/ai-gateway/api-keys'));
      const key = ask('AI Gateway key (vck_...):');
      if (!key) return console.log(c.yellow('\nNothing entered. Nothing saved.'));
      await writeConfig({ ...cfg, apiKey: key });
    }

    provider = await resolveProvider({ backend }).catch((e) => {
      console.log(c.yellow('\n' + (e instanceof Error ? e.message : String(e))));
      return null;
    });
    if (!provider) return;
    console.log(c.green('\n  Saved. ') + c.dim('~/.jevalyzer/config.json, mode 600'));
  }

  // --- 3. Depth -------------------------------------------------------------
  let profile: Profile = opts.profile ?? 'minimal';
  if (!opts.profile && !opts.yes && process.stdin.isTTY) {
    heading('How deep?');
    console.log(`  ${c.bold('1')} minimal    ${c.dim(PROFILE_BLURB.minimal)}  ${c.green('(default)')}`);
    console.log(`  ${c.bold('2')} extensive  ${c.dim(PROFILE_BLURB.extensive)}`);
    profile = ask('\nWhich? [1]', '1') === '2' ? 'extensive' : 'minimal';
  }

  // --- 4. What it will cost, before anything is sent ------------------------
  const { target, ceiling } = budgetFor(provider.contextTokens);
  const cal = new TokenCalibrator();
  let tokens = 0;
  let requests = 0;
  for (const e of exchanges) {
    for (const p of packExchange(e, cal, target, ceiling)) {
      requests += 1;
      tokens += p.estimatedTokens;
    }
  }
  // The question bank is a per-request cost, so a smaller profile saves on
  // every single call, not just once.
  const perRequestQuestions = bankSize(profile) * 45;
  const estTokens = tokens + requests * perRequestQuestions;
  const estCost = jevCost(estTokens);

  heading('Plan');
  console.log(
    `  ${num(exchanges.length)} exchanges  ·  ${num(requests)} requests  ·  ${bankSize(profile)} questions each`,
  );
  console.log(
    c.dim(
      `  ~${num(estTokens)} input tokens  ·  ~${usd(estCost)} at $${JEV_INPUT_USD_PER_MTOK}/M  ·  via ${provider.backend}`,
    ),
  );
  if (alreadyScored) console.log(c.dim(`  already-scored exchanges are skipped, so the real cost is lower`));

  if (!opts.yes && process.stdin.isTTY) {
    const go = ask('\nStart? [Y/n]', 'y');
    if (!/^y(es)?$/i.test(go)) return console.log('Nothing sent.');
  }

  // --- 5. Score, with a live display ---------------------------------------
  heading('Scoring');
  console.log(
    c.dim(
      '  Free tiers are rate-limited, so this can pause. Everything is saved as\n' +
        '  it lands, and re-running resumes - Ctrl-C is safe.\n',
    ),
  );

  const result = await analyze({
    profile,
    budget: 25,
    concurrency: 4,
    zdr: true,
    yes: true,
    quiet: true,
    limit: opts.limit,
  });

  // --- 6. What happened -----------------------------------------------------
  heading('Done');
  console.log(
    `  ${c.green(num(result.saved))} scored` +
      (result.failed ? c.yellow(`  ·  ${num(result.failed)} failed`) : '') +
      c.dim(`  ·  ${num(result.tokens)} tokens  ·  ${usd(jevCost(result.tokens))}`),
  );
  if (result.quotaExhausted) {
    console.log(
      c.yellow(`  ${num(result.remaining)} left - the allowance ran out.`) +
        c.dim(' Run jevalyzer again later to continue.'),
    );
  }

  if (result.saved === 0 && result.remaining === 0 && alreadyScored > 0) {
    console.log(c.dim('  Everything already scored - nothing new to do.'));
  }

  if (result.saved === 0 && alreadyScored === 0) {
    console.log(c.dim('\n  Nothing scored, so there is no report to write yet.'));
    return;
  }

  const { report } = await import('./report.ts');
  await report({ out: opts.out, open: opts.open });
  console.log(c.dim('\n  Browse in the terminal with ') + 'jevalyzer tui');
}

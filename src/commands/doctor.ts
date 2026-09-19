import { experimental_evaluate as evaluate } from 'ai';
import { ADAPTERS } from '../adapters/registry.ts';
import { maskKey, readConfig, resolveKey } from '../core/config.ts';
import { BILLING_HELP, isBillingBlock, resolveProvider, type Backend } from '../core/provider.ts';
import { c, num } from '../core/fmt.ts';
import { HOME, Store } from '../core/store.ts';
import { BANK_VERSION } from '../core/questions.ts';

const ok = (s: string) => c.green('ok   ') + s;
const warn = (s: string) => c.yellow('warn ') + s;
const bad = (s: string) => c.red('fail ') + s;

export async function doctor(opts: { probe?: boolean; backend?: Backend }): Promise<void> {
  console.log(c.bold('\nEnvironment'));
  const bunVersion = Bun.version;
  console.log(ok(`Bun ${bunVersion}`));
  const aiVersion = await packageVersion('ai');
  console.log(
    aiVersion
      ? ok(`ai ${aiVersion}` + c.dim('  (evaluation needs >= 7.0.105)'))
      : bad('ai package not found - run: bun install'),
  );

  console.log(c.bold('\nCredentials'));
  const { key, source, path } = await resolveKey();
  console.log(
    key
      ? ok(`AI Gateway key from ${c.bold(source)}: ${maskKey(key)}`)
      : c.dim('--   no AI Gateway key'),
  );
  const cfg = await readConfig();
  const tsKey = process.env.TYPESAFE_AI_API_KEY ?? process.env.TYPESAFE_API_KEY ?? cfg.typesafeApiKey;
  console.log(
    tsKey ? ok(`TypeSafe key: ${maskKey(tsKey)}`) : c.dim('--   no direct TypeSafe key'),
  );
  const cfReady = Boolean(
    (process.env.CLOUDFLARE_ACCOUNT_ID ?? cfg.cloudflareAccountId) &&
      (process.env.CLOUDFLARE_API_TOKEN ?? cfg.cloudflareApiToken),
  );
  console.log(
    cfReady
      ? ok('Cloudflare Workers AI credentials present (free daily allocation)')
      : c.dim('--   no Cloudflare credentials'),
  );
  if (!key && !tsKey && !cfReady) console.log(warn('no credentials at all - run: jevalyzer auth'));
  console.log(c.dim(`     config: ${path}`));

  console.log(c.bold('\nSession sources'));
  for (const a of ADAPTERS) {
    let refs: string[] = [];
    try {
      refs = await a.discover();
    } catch {
      refs = [];
    }
    console.log(
      refs.length
        ? ok(`${a.label.padEnd(12)} ${num(refs.length)} session(s)`)
        : c.dim(`--   ${a.label.padEnd(12)} not present  (${a.roots()[0]})`),
    );
  }

  console.log(c.bold('\nLocal store'));
  try {
    const store = new Store();
    console.log(ok(`${num(store.count())} evaluation(s) cached at ${HOME()}/jevalyzer.db`));
    console.log(c.dim(`     question bank version ${BANK_VERSION}`));
    store.close();
  } catch (e) {
    console.log(bad(`store unreadable: ${e instanceof Error ? e.message : String(e)}`));
  }

  if (!opts.probe) {
    console.log(c.dim('\nAdd --probe to send one tiny request and confirm the model resolves.'));
    return;
  }

  console.log(c.bold('\nProbe'));
  let provider;
  try {
    provider = await resolveProvider({ backend: opts.backend });
  } catch {
    console.log(warn('skipped: no API key'));
    return;
  }
  console.log(
    c.dim(`     via ${provider.backend} (${provider.modelId}, ${provider.contextTokens / 1000}k context)`),
  );
  try {
    const t0 = Date.now();
    const result = await evaluate({
      model: provider.model,
      state: 'The build failed with exit code 1.',
      questions: {
        passed: {
          type: 'boolean',
          instructions: 'Did the build succeed?',
          criteria: { true: 'exit code 0', false: 'any non-zero exit code' },
        },
      },
    });
    const ms = Date.now() - t0;
    const answer = result.answers.passed;
    console.log(
      ok(
        `typesafe-ai/jev answered in ${ms}ms: P(build succeeded) = ${
          answer.type === 'boolean' ? answer.probability.toFixed(3) : '?'
        }`,
      ),
    );
    console.log(c.dim(`     usage: ${result.usage?.inputTokens ?? 0} input tokens`));
    if (answer.type === 'boolean' && answer.probability > 0.5) {
      console.log(warn('the model got an obvious question wrong - check the question wiring'));
    }
  } catch (e) {
    console.log(bad(e instanceof Error ? e.message : String(e)));
    if (isBillingBlock(e)) console.log(c.yellow(BILLING_HELP));
  }
}

async function packageVersion(name: string): Promise<string | null> {
  try {
    const url = import.meta.resolve(`${name}/package.json`);
    return ((await Bun.file(new URL(url)).json()) as { version: string }).version;
  } catch {
    try {
      const p = `${process.cwd()}/node_modules/${name}/package.json`;
      return ((await Bun.file(p).json()) as { version: string }).version;
    } catch {
      return null;
    }
  }
}

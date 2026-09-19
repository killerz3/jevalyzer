import { experimental_evaluate as evaluate } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import { ADAPTERS } from '../adapters/registry.ts';
import { maskKey, resolveKey } from '../core/config.ts';
import { c, num } from '../core/fmt.ts';
import { HOME, Store } from '../core/store.ts';
import { BANK_VERSION } from '../core/questions.ts';

const ok = (s: string) => c.green('ok   ') + s;
const warn = (s: string) => c.yellow('warn ') + s;
const bad = (s: string) => c.red('fail ') + s;

export async function doctor(opts: { probe?: boolean }): Promise<void> {
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
    key ? ok(`key from ${c.bold(source)}: ${maskKey(key)}`) : warn('no key - run: jevalyzer auth'),
  );
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
  if (!key) {
    console.log(warn('skipped: no API key'));
    return;
  }
  try {
    const gateway = createGateway({ apiKey: key });
    const t0 = Date.now();
    const result = await evaluate({
      model: gateway.evaluationModel('typesafe-ai/jev'),
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

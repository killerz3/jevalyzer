#!/usr/bin/env bun
import { Command } from 'commander';
import { SOURCE_IDS, type SourceId } from './adapters/types.ts';
import { c } from './core/fmt.ts';

const program = new Command();

function sourceList(value: string, prev: SourceId[] = []): SourceId[] {
  const ids = value.split(',').map((s) => s.trim()) as SourceId[];
  for (const id of ids) {
    if (!SOURCE_IDS.includes(id)) {
      throw new Error(`Unknown source "${id}". Choose from: ${SOURCE_IDS.join(', ')}`);
    }
  }
  return [...prev, ...ids];
}

program
  .name('jevalyzer')
  .description(
    'Grade your local agent sessions (Claude Code, Codex, opencode, Gemini CLI, Antigravity) with Jev.',
  )
  .version('0.1.0');

program
  .command('scan')
  .description('Find local sessions and estimate what an analysis would cost. Sends nothing.')
  .option('-s, --source <ids>', 'limit to sources (comma separated)', sourceList)
  .option('--by-project', 'also break down by project')
  .option('--include-sidechains', 'include subagent transcripts')
  .option('--json', 'machine-readable output')
  .action(async (opts) => {
    const { scan } = await import('./commands/scan.ts');
    await scan(opts);
  });

program
  .command('analyze')
  .description('Score every exchange with Jev and cache the answers locally.')
  .option('-s, --source <ids>', 'limit to sources (comma separated)', sourceList)
  .option('-l, --limit <n>', 'only analyze the first N exchanges', (v) => parseInt(v, 10))
  .option('--dry-run', 'show exactly what would be sent, and send nothing')
  .option('--budget <usd>', 'refuse to exceed this spend', (v) => parseFloat(v), 5)
  .option('--concurrency <n>', 'parallel requests', (v) => parseInt(v, 10), 4)
  .option('--patient', 'one request at a time, for a throttled free-tier key')
  .option('--model <id>', 'evaluation model (default depends on --backend)')
  .option('--backend <name>', 'gateway | typesafe | cloudflare (default: whichever you have)')
  .option('--api-key <key>', 'API key for the chosen backend (else env, else config)')
  .option('--redact', 'strip secrets, emails and home paths before sending')
  .option('--no-zdr', 'do not request zero data retention')
  .option('--force', 're-evaluate exchanges already in the cache')
  .option('--include-sidechains', 'include subagent transcripts')
  .option('--yes', 'skip the confirmation prompt')
  .action(async (opts) => {
    const { analyze } = await import('./commands/analyze.ts');
    await analyze(opts);
  });

program
  .command('report')
  .description('Write a self-contained interactive HTML report.')
  .option('-o, --out <file>', 'output path', 'jevalyzer-report.html')
  .option('--open', 'open it in the browser when done')
  .action(async (opts) => {
    const { report } = await import('./commands/report.ts');
    await report(opts);
  });

program
  .command('tui')
  .description('Browse the results in an interactive terminal dashboard.')
  .action(async () => {
    const { tui } = await import('./commands/tui.tsx');
    await tui();
  });

program
  .command('auth')
  .description('Store your own API key (Vercel AI Gateway, or TypeSafe directly).')
  .option('--typesafe', 'store a direct TypeSafe key instead of a Gateway key')
  .option('--cloudflare', 'store Cloudflare Workers AI credentials (free daily allocation)')
  .option('--show', 'show where the key is read from, without printing it')
  .option('--clear', 'remove the stored key')
  .action(async (opts) => {
    const { auth } = await import('./commands/auth.ts');
    await auth(opts);
  });

program
  .command('doctor')
  .description('Check the key, the SDK and which session sources were found.')
  .option('--probe', 'send one tiny request to confirm the model resolves')
  .option('--backend <name>', 'gateway | typesafe | cloudflare')
  .action(async (opts) => {
    const { doctor } = await import('./commands/doctor.ts');
    await doctor(opts);
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(c.red('\n' + (e instanceof Error ? e.message : String(e))));
  process.exit(1);
});

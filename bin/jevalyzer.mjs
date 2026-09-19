#!/usr/bin/env node
/**
 * Entry point for both runtimes.
 *
 * The CLI itself is TypeScript and uses `bun:sqlite`, so it can only run under
 * Bun. But `bin` has to be something Node can at least *start*, otherwise
 * `npx jevalyzer` on a machine without Bun dies with a bare
 * `env: 'bun': No such file or directory` and no idea what to do about it.
 *
 * So: under Bun, import the CLI directly - no subprocess, no overhead. Under
 * Node, re-exec through Bun if it is installed, and otherwise say plainly what
 * is missing and how to get it.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

if (typeof globalThis.Bun !== 'undefined') {
  await import(cli);
} else {
  const child = spawn('bun', [cli, ...process.argv.slice(2)], { stdio: 'inherit' });
  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      process.stderr.write(
        '\njevalyzer needs Bun, which is not installed.\n\n' +
          '  curl -fsSL https://bun.sh/install | bash\n\n' +
          'Then run it again - or use `bunx jevalyzer` directly.\n' +
          'It reads your session logs with bun:sqlite, so Node alone is not enough.\n\n',
      );
      process.exit(127);
    }
    process.stderr.write(`\nCould not start bun: ${err.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

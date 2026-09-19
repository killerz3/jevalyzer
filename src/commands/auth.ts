import { maskKey, readConfig, resolveKey, writeConfig } from '../core/config.ts';
import { c } from '../core/fmt.ts';

export async function auth(opts: { show?: boolean; clear?: boolean; typesafe?: boolean }): Promise<void> {
  if (opts.clear) {
    const cfg = await readConfig();
    if (opts.typesafe) delete cfg.typesafeApiKey;
    else delete cfg.apiKey;
    const path = await writeConfig(cfg);
    console.log(c.green('Stored key removed from ') + path);
    return;
  }

  if (opts.show) {
    const { key, source, path } = await resolveKey();
    console.log(
      key
        ? `${c.green('key found')}  source: ${c.bold(source)}  value: ${maskKey(key)}`
        : c.yellow('no key found'),
    );
    console.log(c.dim(`config file: ${path}`));
    return;
  }

  console.log(
    opts.typesafe
      ? 'Using TypeSafe directly, bypassing Vercel.\n' +
          c.dim('Create a key at https://console.typesafe.ai/keys\n')
      : 'Jevalyzer uses your own Vercel AI Gateway account.\n' +
          c.dim('Create a key at https://vercel.com/d?to=/[team]/~/ai-gateway/api-keys\n'),
  );
  const key = prompt(
    opts.typesafe ? 'Paste your TypeSafe key (sk-...):' : 'Paste your AI Gateway key (vck_...):',
  )?.trim();
  if (!key) {
    console.log('Nothing entered, nothing saved.');
    return;
  }
  const expected = opts.typesafe ? /^sk-/ : /^vck_/;
  if (!expected.test(key)) {
    console.log(c.yellow('That does not look like the expected prefix, saving it anyway.'));
  }
  const cfg = await readConfig();
  const path = await writeConfig(
    opts.typesafe ? { ...cfg, typesafeApiKey: key } : { ...cfg, apiKey: key },
  );
  console.log(c.green('Saved to ') + path + c.dim(' (mode 600)'));
  console.log(c.dim('Next: ') + 'jevalyzer doctor --probe');
}

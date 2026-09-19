import { chmodSync, mkdirSync } from 'node:fs';
import { HOME } from './store.ts';

/**
 * Bring-your-own-account. Jevalyzer ships with no credentials and never reads
 * anyone else's. Precedence: explicit flag, then environment, then config file.
 */

export interface Config {
  apiKey?: string;
  model?: string;
}

const CONFIG_PATH = () => `${HOME()}/config.json`;

export async function readConfig(): Promise<Config> {
  try {
    return (await Bun.file(CONFIG_PATH()).json()) as Config;
  } catch {
    return {};
  }
}

export async function writeConfig(cfg: Config): Promise<string> {
  const path = CONFIG_PATH();
  mkdirSync(HOME(), { recursive: true });
  await Bun.write(path, JSON.stringify(cfg, null, 2));
  chmodSync(path, 0o600);
  return path;
}

export type KeySource = 'flag' | 'env:AI_GATEWAY_API_KEY' | 'config' | 'none';

export async function resolveKey(
  flagKey?: string,
): Promise<{ key: string | null; source: KeySource; path: string }> {
  const path = CONFIG_PATH();
  if (flagKey) return { key: flagKey, source: 'flag', path };
  const env = process.env.AI_GATEWAY_API_KEY;
  if (env) return { key: env, source: 'env:AI_GATEWAY_API_KEY', path };
  const cfg = await readConfig();
  if (cfg.apiKey) return { key: cfg.apiKey, source: 'config', path };
  return { key: null, source: 'none', path };
}

export function maskKey(key: string): string {
  if (key.length <= 10) return '***';
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

export const SETUP_HELP = `
No AI Gateway key found. Jevalyzer uses your own Vercel account:

  1. Create a key at https://vercel.com/d?to=/[team]/~/ai-gateway/api-keys
  2. jevalyzer auth            (or: export AI_GATEWAY_API_KEY=vck_...)

Everything except scoring works without a key - try 'jevalyzer scan'.
`;

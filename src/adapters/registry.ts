import type { Adapter, Exchange, ParsedSession, SourceId } from './types.ts';
import { claudeCode } from './claude-code.ts';
import { antigravity } from './antigravity.ts';
import { codex } from './codex.ts';
import { opencode } from './opencode.ts';
import { geminiCli } from './gemini-cli.ts';

export const ADAPTERS: Adapter[] = [claudeCode, codex, opencode, geminiCli, antigravity];

export function adapterFor(id: SourceId): Adapter {
  const a = ADAPTERS.find((x) => x.id === id);
  if (!a) throw new Error(`Unknown source: ${id}`);
  return a;
}

export interface SourceScan {
  adapter: Adapter;
  refs: string[];
  sessions: ParsedSession[];
  errors: { ref: string; message: string }[];
}

/**
 * Parse every discoverable session. One bad file must never take down a scan,
 * so parse failures are collected and reported rather than thrown.
 */
export async function scanSources(
  only?: SourceId[],
  onProgress?: (label: string, done: number, total: number) => void,
): Promise<SourceScan[]> {
  const chosen = only?.length ? ADAPTERS.filter((a) => only.includes(a.id)) : ADAPTERS;
  const out: SourceScan[] = [];

  for (const adapter of chosen) {
    let refs: string[] = [];
    try {
      refs = await adapter.discover();
    } catch {
      refs = [];
    }
    const scan: SourceScan = { adapter, refs, sessions: [], errors: [] };
    let done = 0;
    for (const ref of refs) {
      try {
        scan.sessions.push(await adapter.parse(ref));
      } catch (e) {
        scan.errors.push({ ref, message: e instanceof Error ? e.message : String(e) });
      }
      onProgress?.(adapter.label, ++done, refs.length);
    }
    out.push(scan);
  }
  return out;
}

export function allExchanges(scans: SourceScan[], includeSidechains = false): Exchange[] {
  const out: Exchange[] = [];
  for (const s of scans) {
    for (const session of s.sessions) {
      for (const e of session.exchanges) {
        if (!includeSidechains && e.isSidechain) continue;
        out.push(e);
      }
    }
  }
  return out;
}

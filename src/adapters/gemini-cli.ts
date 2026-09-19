import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Adapter, Exchange, ParsedSession, ToolCall } from './types.ts';
import { exchangeId } from '../core/hash.ts';
import { expandHome, stringify } from '../core/text.ts';

/**
 * Gemini CLI keeps per-project scratch state under ~/.gemini/tmp/<hash>/, with
 * saved conversations in chats/*.json and a logs.json of prompts. Nothing is
 * documented, and this machine has the config dir but no chat store, so the
 * adapter probes both shapes and returns nothing when neither is present.
 *
 * Antigravity also lives under ~/.gemini but has its own adapter; this one
 * deliberately ignores the antigravity-cli subtree.
 */

const ROOT = () => expandHome(process.env.GEMINI_DIR ?? '~/.gemini') + '/tmp';

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: unknown };
  functionResponse?: { name?: string; response?: unknown };
}
interface GeminiTurn {
  role?: string;
  parts?: GeminiPart[];
  timestamp?: string;
}

export const geminiCli: Adapter = {
  id: 'gemini-cli',
  label: 'Gemini CLI',
  roots: () => [ROOT()],

  async discover() {
    const out: string[] = [];
    let projects: string[];
    try {
      projects = await readdir(ROOT());
    } catch {
      return out;
    }
    for (const p of projects) {
      for (const sub of ['chats', 'sessions']) {
        try {
          for (const f of await readdir(join(ROOT(), p, sub))) {
            if (f.endsWith('.json')) out.push(join(ROOT(), p, sub, f));
          }
        } catch {
          /* directory absent on this version */
        }
      }
    }
    return out;
  },

  async parse(path: string): Promise<ParsedSession> {
    const sessionId = (path.split('/').pop() ?? path).replace(/\.json$/, '');
    const meta = {
      tool: 'gemini-cli' as const,
      sessionId,
      path,
      project: null,
      title: null as string | null,
      startedAt: null as string | null,
      endedAt: null as string | null,
      bytes: await stat(path).then((s) => s.size).catch(() => 0),
    };

    let raw: unknown;
    try {
      raw = await Bun.file(path).json();
    } catch {
      return { meta, exchanges: [] };
    }

    const doc = raw as Record<string, any>;
    const turns: GeminiTurn[] = Array.isArray(doc)
      ? (doc as GeminiTurn[])
      : (doc.history ?? doc.messages ?? doc.turns ?? []);
    if (!Array.isArray(turns)) return { meta, exchanges: [] };

    const model: string | null = doc.model ?? null;

    interface Draft {
      ts: string;
      userText: string;
      assistant: string[];
      calls: ToolCall[];
    }
    const drafts: Draft[] = [];
    let cur: Draft | null = null;

    for (const t of turns) {
      const parts = t.parts ?? [];
      const text = parts.map((p) => p.text ?? '').filter(Boolean).join('\n').trim();
      const role = t.role ?? '';
      if (role === 'user') {
        if (!text) continue;
        if (cur) drafts.push(cur);
        cur = { ts: t.timestamp ?? '', userText: text, assistant: [], calls: [] };
        continue;
      }
      if (!cur) continue;
      if (text) cur.assistant.push(text);
      for (const p of parts) {
        if (p.functionCall) {
          cur.calls.push({
            name: String(p.functionCall.name ?? 'unknown'),
            input: stringify(p.functionCall.args, 4000),
            ok: true,
            outputChars: 0,
          });
        } else if (p.functionResponse) {
          const out = stringify(p.functionResponse.response);
          const call = cur.calls[cur.calls.length - 1];
          if (call) {
            call.output = out;
            call.outputChars = out.length;
          }
        }
      }
    }
    if (cur) drafts.push(cur);

    const exchanges: Exchange[] = drafts.map((d, i) => {
      const assistantText = d.assistant.join('\n');
      return {
        id: exchangeId(['gemini-cli', sessionId, i, d.userText, assistantText]),
        tool: 'gemini-cli',
        sessionId,
        index: i,
        project: null,
        model,
        startedAt: d.ts,
        endedAt: d.ts,
        userText: d.userText,
        assistantText,
        thinkingChars: 0,
        toolCalls: d.calls,
        usage: null,
        nextUserText: drafts[i + 1]?.userText ?? null,
        interrupted: false,
        permissionDenials: 0,
        isSidechain: false,
      };
    });

    meta.title = exchanges[0]?.userText.slice(0, 80) ?? null;
    return { meta, exchanges };
  },
};

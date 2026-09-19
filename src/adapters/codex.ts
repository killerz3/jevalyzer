import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Adapter, Exchange, ParsedSession, ToolCall, Usage } from './types.ts';
import { readJsonl } from '../core/jsonl.ts';
import { exchangeId } from '../core/hash.ts';
import { expandHome, stringify } from '../core/text.ts';

/**
 * OpenAI Codex CLI: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *
 * Line 1 is `session_meta`; later lines are `response_item`, `event_msg`,
 * `turn_context` and `compacted`. Two things matter here:
 *  - `compacted` records REPLAY earlier history, so message payloads must be
 *    de-duplicated by content hash or a long session counts everything twice.
 *  - These files are documented to reach 700MB-2GB, hence streaming parse.
 *
 * Not testable on this machine (no ~/.codex), so every field access is
 * defensive and unknown record shapes are skipped rather than throwing.
 */

const ROOT = () => expandHome(process.env.CODEX_HOME ?? '~/.codex') + '/sessions';

interface Rec {
  type?: string;
  timestamp?: string;
  payload?: Record<string, any>;
  [k: string]: any;
}

/**
 * Codex injects several blocks as `role: "user"` that the human never typed:
 * the repo's AGENTS.md, an environment dump at session start, and an abort
 * marker. Counted as prompts they fabricate roughly two extra "exchanges" per
 * session - each one an environment dump no agent can deliver on - which drags
 * the whole tool's delivery rate down and pollutes every session title.
 */
const INJECTED = [
  /^<environment_context>/,
  /^<user_instructions>/,
  /^#\s*AGENTS\.md instructions/i,
  /^<project_doc>/,
];
const ABORTED = /^<turn_aborted>/;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c: any) => {
      if (typeof c === 'string') return c;
      if (c && typeof c.text === 'string') return c.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Walk a record for the nested object Codex actually stores the item in. */
function itemOf(r: Rec): Record<string, any> {
  return (r.payload ?? r.item ?? r) as Record<string, any>;
}

function usageOf(o: Record<string, any> | undefined): Usage | null {
  if (!o) return null;
  const n = (...keys: string[]) => {
    for (const k of keys) if (typeof o[k] === 'number') return o[k] as number;
    return 0;
  };
  const cached = (o.input_tokens_details?.cached_tokens as number | undefined) ?? 0;
  const u = {
    input: n('input_tokens', 'prompt_tokens'),
    output: n('output_tokens', 'completion_tokens'),
    cacheRead: cached,
    cacheCreate: 0,
  };
  return u.input || u.output ? u : null;
}

interface Draft {
  startedAt: string;
  endedAt: string;
  userText: string;
  assistant: string[];
  calls: Map<string, ToolCall>;
  order: string[];
  usage: Usage | null;
  interrupted: boolean;
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(p);
  }
}

export const codex: Adapter = {
  id: 'codex',
  label: 'Codex CLI',
  roots: () => [ROOT()],

  async discover() {
    const out: string[] = [];
    await walk(ROOT(), out);
    return out;
  },

  async parse(path: string): Promise<ParsedSession> {
    const drafts: Draft[] = [];
    let cur: Draft | null = null;
    let sessionId = path.split('/').pop()!.replace(/\.jsonl$/, '');
    let model: string | null = null;
    let project: string | null = null;
    let first: string | null = null;
    let last: string | null = null;
    const seen = new Set<string>();

    for await (const r of readJsonl<Rec>(path)) {
      const ts = r.timestamp ?? '';
      if (ts) {
        first ??= ts;
        last = ts;
      }
      const item = itemOf(r);

      if (r.type === 'session_meta' || item.id) {
        sessionId = item.id ?? item.session_id ?? sessionId;
        project = item.cwd ?? item.workspace ?? project;
        model = item.model ?? model;
      }
      if (r.type === 'turn_context') {
        model = item.model ?? model;
        project = item.cwd ?? project;
      }
      // `compacted` blocks restate history that already appeared above.
      if (r.type === 'compacted') continue;

      const kind = item.type ?? item.role;
      const role = item.role;

      if (role === 'user' || kind === 'user_message') {
        const text = textOf(item.content ?? item.message ?? item.text).trim();
        if (!text) continue;
        if (ABORTED.test(text)) {
          // An abort annotates the turn in flight rather than starting one.
          if (cur) cur.interrupted = true;
          continue;
        }
        if (INJECTED.some((re) => re.test(text))) continue;
        const key = `u:${Bun.hash(text)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (cur) drafts.push(cur);
        cur = {
          startedAt: ts,
          endedAt: ts,
          userText: text,
          assistant: [],
          calls: new Map(),
          order: [],
          usage: null,
          interrupted: false,
        };
        continue;
      }

      if (!cur) continue;
      if (ts) cur.endedAt = ts;

      if (role === 'assistant' || kind === 'agent_message') {
        const text = textOf(item.content ?? item.message ?? item.text);
        if (text.trim()) {
          const key = `a:${Bun.hash(text)}`;
          if (!seen.has(key)) {
            seen.add(key);
            cur.assistant.push(text);
          }
        }
      } else if (kind === 'function_call' || kind === 'local_shell_call' || kind === 'custom_tool_call') {
        const id = String(item.call_id ?? item.id ?? cur.order.length);
        cur.calls.set(id, {
          name: String(item.name ?? kind),
          input: stringify(item.arguments ?? item.action ?? item.input, 4000),
          ok: true,
          outputChars: 0,
        });
        cur.order.push(id);
      } else if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
        const id = String(item.call_id ?? item.id ?? '');
        const call = cur.calls.get(id) ?? cur.calls.get(cur.order[cur.order.length - 1] ?? '');
        if (call) {
          const raw = item.output ?? item.result ?? '';
          const text = typeof raw === 'string' ? raw : stringify(raw);
          call.output = text;
          call.outputChars = text.length;
          const failed =
            item.success === false ||
            (typeof raw === 'object' && raw !== null && (raw as any).exit_code > 0);
          call.ok = !failed;
          if (failed) call.error = text.slice(0, 500);
        }
      }

      const u = usageOf(item.usage ?? item.info?.total_token_usage);
      if (u) {
        cur.usage ??= { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
        cur.usage.input += u.input;
        cur.usage.output += u.output;
        cur.usage.cacheRead += u.cacheRead;
      }
    }
    if (cur) drafts.push(cur);

    const bytes = await stat(path).then((s) => s.size).catch(() => 0);

    const exchanges: Exchange[] = drafts.map((d, i) => {
      const assistantText = d.assistant.join('\n');
      return {
        id: exchangeId(['codex', sessionId, i, d.userText, assistantText]),
        tool: 'codex',
        sessionId,
        index: i,
        project,
        model,
        startedAt: d.startedAt,
        endedAt: d.endedAt,
        userText: d.userText,
        assistantText,
        thinkingChars: 0,
        toolCalls: d.order.map((id) => d.calls.get(id)!).filter(Boolean),
        usage: d.usage,
        nextUserText: drafts[i + 1]?.userText ?? null,
        interrupted: d.interrupted,
        permissionDenials: 0,
        isSidechain: false,
      };
    });

    return {
      meta: {
        tool: 'codex',
        sessionId,
        path,
        project,
        title: exchanges[0]?.userText.slice(0, 80) ?? null,
        startedAt: first,
        endedAt: last,
        bytes,
      },
      exchanges,
    };
  },
};

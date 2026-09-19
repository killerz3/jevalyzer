import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Adapter, Exchange, ParsedSession, ToolCall, Usage } from './types.ts';
import { readJsonl } from '../core/jsonl.ts';
import { exchangeId } from '../core/hash.ts';
import {
  expandHome,
  projectLabelFromDir,
  stringify,
  stripReminders,
  unwrapChannel,
} from '../core/text.ts';

/**
 * Claude Code: ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
 *
 * Traps this adapter exists to handle, all found by reading the real files:
 *  - Most `type:"user"` records are tool RESULTS, not user turns.
 *  - Headless (`-p`) runs start without a `promptId`, so keying off that field
 *    alone silently drops whole daemon sessions.
 *  - Tool output lives in a sibling `toolUseResult` field, not in
 *    `message.content`, so a content-only reader sees zero tool output.
 *  - Bookkeeping record types (attachment, queue-operation, atis-latch, ...)
 *    outnumber real messages and must not be mistaken for content.
 */

const ROOT = () => expandHome(process.env.CLAUDE_CONFIG_DIR ?? '~/.claude') + '/projects';

interface Rec {
  type?: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  promptId?: string;
  toolDenialKind?: string;
  toolUseResult?: unknown;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
    usage?: Record<string, unknown>;
  };
}

type Block = Record<string, any>;

function blocks(content: unknown): Block[] {
  if (Array.isArray(content)) return content as Block[];
  return [];
}

/** Harness-authored `isMeta` strings that are not the user speaking. */
const META_NOISE = [/^<local-command-caveat>/, /^\[Image: /];

/**
 * A real user turn: text a human produced, not a tool result or harness meta.
 *
 * `isMeta` cannot simply be excluded. Messages bridged from a chat platform are
 * flagged meta yet are the most genuinely human input in the log, so meta
 * records are admitted when they carry a `<channel ...>` envelope and rejected
 * when they match a known harness-noise shape.
 */
function isUserTurn(r: Rec): boolean {
  if (r.type !== 'user') return false;
  const content = r.message?.content;
  if (typeof content === 'string') {
    const s = content.trim();
    if (!s) return false;
    if (unwrapChannel(s)) return true;
    if (r.isMeta) return false;
    return !META_NOISE.some((re) => re.test(s));
  }
  if (r.isMeta) return false;
  const bs = blocks(content);
  if (bs.length === 0) return false;
  // A record carrying any tool_result is the harness replying, not the user.
  if (bs.some((b) => b.type === 'tool_result')) return false;
  return bs.some((b) => b.type === 'text' && typeof b.text === 'string' && b.text.trim());
}

function userTextOf(r: Rec): string {
  const content = r.message?.content;
  const raw =
    typeof content === 'string'
      ? content
      : blocks(content)
          .filter((b) => b.type === 'text')
          .map((b) => String(b.text ?? ''))
          .join('\n');
  return stripReminders(unwrapChannel(raw)?.body ?? raw);
}

const INTERRUPT = /\[Request interrupted by user/i;

function usageOf(u: Record<string, unknown> | undefined): Usage | null {
  if (!u) return null;
  const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  return {
    input: n('input_tokens'),
    output: n('output_tokens'),
    cacheRead: n('cache_read_input_tokens'),
    cacheCreate: n('cache_creation_input_tokens'),
  };
}

/** Recover output text and an ok/error verdict from the toolUseResult blob. */
function readToolResult(value: unknown): { text: string; ok: boolean; error?: string } {
  if (value == null) return { text: '', ok: true };
  if (typeof value === 'string') return { text: value, ok: true };
  if (typeof value !== 'object') return { text: String(value), ok: true };
  const o = value as Record<string, any>;
  const parts: string[] = [];
  for (const key of ['stdout', 'stderr', 'content', 'output', 'result', 'text']) {
    const v = o[key];
    if (typeof v === 'string' && v) parts.push(v);
    else if (v != null && key === 'content') parts.push(stringify(v));
  }
  const text = parts.length ? parts.join('\n') : stringify(o);
  const ok = !o.is_error && !o.interrupted && !(typeof o.stderr === 'string' && o.stderr && o.stdout === '');
  const error = o.is_error || o.interrupted ? stringify(o.stderr ?? o.error ?? 'error').slice(0, 500) : undefined;
  return { text, ok, error };
}

interface Draft {
  startedAt: string;
  endedAt: string;
  userText: string;
  assistant: string[];
  thinkingChars: number;
  calls: Map<string, ToolCall>;
  order: string[];
  usage: Usage | null;
  model: string | null;
  cwd: string | null;
  interrupted: boolean;
  denials: number;
  sidechain: boolean;
}

function newDraft(ts: string, text: string, r: Rec): Draft {
  return {
    startedAt: ts,
    endedAt: ts,
    userText: text,
    assistant: [],
    thinkingChars: 0,
    calls: new Map(),
    order: [],
    usage: null,
    model: null,
    cwd: r.cwd ?? null,
    interrupted: false,
    denials: 0,
    sidechain: Boolean(r.isSidechain),
  };
}

export const claudeCode: Adapter = {
  id: 'claude-code',
  label: 'Claude Code',
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
      let files: string[];
      try {
        files = await readdir(join(ROOT(), p));
      } catch {
        continue;
      }
      for (const f of files) if (f.endsWith('.jsonl')) out.push(join(ROOT(), p, f));
    }
    return out;
  },

  async parse(path: string): Promise<ParsedSession> {
    const drafts: Draft[] = [];
    let cur: Draft | null = null;
    let sessionId = path.split('/').pop()!.replace(/\.jsonl$/, '');
    let cwd: string | null = null;
    let title: string | null = null;
    let first: string | null = null;
    let last: string | null = null;

    for await (const r of readJsonl<Rec>(path)) {
      if (r.sessionId) sessionId = r.sessionId;
      if (r.cwd) cwd = r.cwd;
      if (r.timestamp) {
        first ??= r.timestamp;
        last = r.timestamp;
      }
      if (r.type === 'ai-title') {
        title = stringify((r as any).aiTitle ?? (r as any).title).slice(0, 200) || title;
        continue;
      }
      if (r.toolDenialKind && cur) cur.denials += 1;

      if (isUserTurn(r)) {
        const text = userTextOf(r);
        if (INTERRUPT.test(text)) {
          // An interruption annotates the turn in flight rather than starting one.
          if (cur) cur.interrupted = true;
          continue;
        }
        if (text) {
          if (cur) drafts.push(cur);
          cur = newDraft(r.timestamp ?? last ?? '', text, r);
          continue;
        }
      }

      if (!cur) continue;
      if (r.timestamp) cur.endedAt = r.timestamp;

      if (r.type === 'assistant') {
        if (r.message?.model) cur.model = r.message.model;
        const u = usageOf(r.message?.usage);
        if (u) {
          cur.usage ??= { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
          cur.usage.input += u.input;
          cur.usage.output += u.output;
          cur.usage.cacheRead += u.cacheRead;
          cur.usage.cacheCreate += u.cacheCreate;
        }
        for (const b of blocks(r.message?.content)) {
          if (b.type === 'text' && b.text) cur.assistant.push(String(b.text));
          else if (b.type === 'thinking') {
            cur.thinkingChars += String(b.thinking ?? '').length;
          } else if (b.type === 'tool_use') {
            const id = String(b.id ?? `${cur.order.length}`);
            cur.calls.set(id, {
              name: String(b.name ?? 'unknown'),
              input: stringify(b.input, 4000),
              ok: true,
              outputChars: 0,
            });
            cur.order.push(id);
          }
        }
        continue;
      }

      // Tool results: the `tool_result` block carries the id and error flag,
      // while the real payload sits in the sibling toolUseResult field.
      const resultBlocks = blocks(r.message?.content).filter((b) => b.type === 'tool_result');
      if (resultBlocks.length || r.toolUseResult != null) {
        const parsed = readToolResult(r.toolUseResult);
        const ids = resultBlocks.map((b) => String(b.tool_use_id ?? ''));
        const targets = ids.filter((id) => cur!.calls.has(id));
        const fallback = targets.length === 0 ? cur.order[cur.order.length - 1] : undefined;
        for (const id of targets.length ? targets : fallback ? [fallback] : []) {
          const call = cur.calls.get(id);
          if (!call) continue;
          const isErr = resultBlocks.some((b) => b.is_error) || !parsed.ok;
          call.outputChars = parsed.text.length;
          call.output = parsed.text;
          call.ok = !isErr;
          if (isErr) call.error = parsed.error ?? parsed.text.slice(0, 500);
        }
      }
    }
    if (cur) drafts.push(cur);

    const bytes = await stat(path).then((s) => s.size).catch(() => 0);
    const project = cwd ?? projectLabelFromDir(path.split('/').slice(-2, -1)[0] ?? '');

    const exchanges: Exchange[] = drafts.map((d, i) => {
      const assistantText = d.assistant.join('\n');
      return {
        id: exchangeId(['claude-code', sessionId, i, d.userText, assistantText]),
        tool: 'claude-code',
        sessionId,
        index: i,
        project: d.cwd ?? project,
        model: d.model,
        startedAt: d.startedAt,
        endedAt: d.endedAt,
        userText: d.userText,
        assistantText,
        thinkingChars: d.thinkingChars,
        toolCalls: d.order.map((id) => d.calls.get(id)!).filter(Boolean),
        usage: d.usage,
        nextUserText: drafts[i + 1]?.userText ?? null,
        interrupted: d.interrupted,
        permissionDenials: d.denials,
        isSidechain: d.sidechain,
      };
    });

    return {
      meta: {
        tool: 'claude-code',
        sessionId,
        path,
        project,
        title,
        startedAt: first,
        endedAt: last,
        bytes,
      },
      exchanges,
    };
  },
};

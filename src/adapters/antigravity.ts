import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Adapter, Exchange, ParsedSession, ToolCall } from './types.ts';
import { readJsonl } from '../core/jsonl.ts';
import { exchangeId } from '../core/hash.ts';
import { expandHome, stringify, unwrapUserRequest } from '../core/text.ts';

/**
 * Google Antigravity CLI. It reuses the Gemini home directory, so the path
 * mentions neither Antigravity nor the project:
 *   ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl
 *
 * Records are flat: {step_index, source, type, status, created_at, content?,
 * thinking?, tool_calls?}. Only three types appear in practice - USER_INPUT
 * (source USER_EXPLICIT), PLANNER_RESPONSE and GENERIC (both source MODEL).
 * Tool *results* are not written to the transcript, so outputChars stays 0.
 */

const ROOT = () => expandHome('~/.gemini/antigravity-cli/brain');

interface Rec {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  tool_calls?: { name?: string; args?: Record<string, unknown> }[];
}

/** The chosen model is only ever mentioned inside a settings-change notice. */
const MODEL_LINE = /changed setting `Model Selection` from .*? to ([^.]+)\./;
const METADATA = /<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g;
const SETTINGS = /<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g;

/** Args are stored with their JSON string values double-encoded. */
function cleanArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.startsWith('"') && v.endsWith('"')) {
      try {
        out[k] = JSON.parse(v);
        continue;
      } catch {
        /* fall through */
      }
    }
    out[k] = v;
  }
  return stringify(out, 4000);
}

interface Draft {
  startedAt: string;
  endedAt: string;
  userText: string;
  assistant: string[];
  thinkingChars: number;
  calls: ToolCall[];
  model: string | null;
}

export const antigravity: Adapter = {
  id: 'antigravity',
  label: 'Antigravity',
  roots: () => [ROOT()],

  async discover() {
    let ids: string[];
    try {
      ids = await readdir(ROOT());
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const id of ids) {
      const p = join(ROOT(), id, '.system_generated', 'logs', 'transcript.jsonl');
      if (await Bun.file(p).exists()) out.push(p);
    }
    return out;
  },

  async parse(path: string): Promise<ParsedSession> {
    const sessionId = path.split('/').slice(-4, -3)[0] ?? path;
    const drafts: Draft[] = [];
    let cur: Draft | null = null;
    let model: string | null = null;
    let first: string | null = null;
    let last: string | null = null;

    for await (const r of readJsonl<Rec>(path)) {
      const ts = r.created_at ?? '';
      if (ts) {
        first ??= ts;
        last = ts;
      }
      const content = r.content ?? '';
      const declared = MODEL_LINE.exec(content)?.[1]?.trim();
      if (declared) model = declared;

      if (r.type === 'USER_INPUT') {
        const body = unwrapUserRequest(
          content.replace(METADATA, '').replace(SETTINGS, ''),
        ).trim();
        if (!body) continue;
        if (cur) drafts.push(cur);
        cur = {
          startedAt: ts,
          endedAt: ts,
          userText: body,
          assistant: [],
          thinkingChars: 0,
          calls: [],
          model,
        };
        continue;
      }

      if (!cur) continue;
      if (ts) cur.endedAt = ts;
      if (model) cur.model = model;
      if (content) cur.assistant.push(content);
      if (r.thinking) cur.thinkingChars += r.thinking.length;
      for (const c of r.tool_calls ?? []) {
        cur.calls.push({
          name: String(c.name ?? 'unknown'),
          input: cleanArgs(c.args),
          ok: r.status !== 'ERROR',
          outputChars: 0,
        });
      }
    }
    if (cur) drafts.push(cur);

    const bytes = await stat(path).then((s) => s.size).catch(() => 0);

    const exchanges: Exchange[] = drafts.map((d, i) => {
      const assistantText = d.assistant.join('\n');
      return {
        id: exchangeId(['antigravity', sessionId, i, d.userText, assistantText]),
        tool: 'antigravity',
        sessionId,
        index: i,
        project: null,
        model: d.model,
        startedAt: d.startedAt,
        endedAt: d.endedAt,
        userText: d.userText,
        assistantText,
        thinkingChars: d.thinkingChars,
        toolCalls: d.calls,
        usage: null,
        nextUserText: drafts[i + 1]?.userText ?? null,
        interrupted: false,
        permissionDenials: 0,
        isSidechain: false,
      };
    });

    return {
      meta: {
        tool: 'antigravity',
        sessionId,
        path,
        project: null,
        title: exchanges[0]?.userText.slice(0, 80) ?? null,
        startedAt: first,
        endedAt: last,
        bytes,
      },
      exchanges,
    };
  },
};

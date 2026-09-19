import { Database } from 'bun:sqlite';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Adapter, Exchange, ParsedSession, ToolCall } from './types.ts';
import { exchangeId } from '../core/hash.ts';
import { expandHome, stringify } from '../core/text.ts';

/**
 * opencode. Since v1.2.0 (Feb 2026) everything lives in one SQLite file:
 *   $OPENCODE_DATA_DIR | ${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db
 * Older installs use storage/{session,message,part}/*.json.
 *
 * The schema is undocumented and has already changed once, so this adapter
 * introspects sqlite_master, probes for plausible column names, and degrades to
 * an empty result with a warning rather than throwing.
 */

function dataDir(): string {
  if (process.env.OPENCODE_DATA_DIR) return expandHome(process.env.OPENCODE_DATA_DIR);
  const xdg = process.env.XDG_DATA_HOME;
  return (xdg ? expandHome(xdg) : expandHome('~/.local/share')) + '/opencode';
}

const DB = () => join(dataDir(), 'opencode.db');
const LEGACY = () => join(dataDir(), 'storage');

interface Row {
  [k: string]: any;
}

function pick(row: Row, keys: string[]): any {
  for (const k of keys) if (row[k] != null) return row[k];
  return undefined;
}

/** Message payloads are JSON text in a `data` column on some versions. */
function payload(row: Row): Row {
  const raw = pick(row, ['data', 'payload', 'json']);
  if (typeof raw === 'string') {
    try {
      return { ...row, ...(JSON.parse(raw) as Row) };
    } catch {
      return row;
    }
  }
  if (raw && typeof raw === 'object') return { ...row, ...(raw as Row) };
  return row;
}

function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((p: any) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (v && typeof v === 'object' && typeof (v as any).text === 'string') return (v as any).text;
  return '';
}

/**
 * The model is recorded as `{providerID, modelID}` on this schema and as a
 * plain string on others. Without unwrapping it, every opencode exchange gets
 * "[object Object]" as its model and drops out of the leaderboard.
 */
function modelOf(row: Row): string | null {
  const direct = pick(row, ['modelID', 'model_id']);
  if (typeof direct === 'string' && direct) return direct;
  const m = pick(row, ['model']);
  if (typeof m === 'string' && m) return m;
  if (m && typeof m === 'object') {
    const id = (m as Row).modelID ?? (m as Row).id ?? (m as Row).name;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

function tables(db: Database): Set<string> {
  const rows = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Row[];
  return new Set(rows.map((r) => String(r.name)));
}

export const opencode: Adapter = {
  id: 'opencode',
  label: 'opencode',
  roots: () => [DB(), LEGACY()],

  async discover() {
    if (await Bun.file(DB()).exists()) {
      let db: Database | null = null;
      try {
        db = new Database(DB(), { readonly: true });
        const t = tables(db);
        if (!t.has('session') || !t.has('message')) return [];
        const rows = db.query('SELECT * FROM session').all() as Row[];
        return rows
          .map((r) => String(pick(r, ['id', 'sessionID', 'session_id']) ?? ''))
          .filter(Boolean)
          .map((id) => `db:${id}`);
      } catch {
        return [];
      } finally {
        db?.close();
      }
    }
    // Legacy JSON layout: storage/session/<projectHash>/<sessionID>.json
    try {
      const base = join(LEGACY(), 'session');
      const out: string[] = [];
      for (const proj of await readdir(base)) {
        for (const f of await readdir(join(base, proj))) {
          if (f.endsWith('.json')) out.push(`json:${join(base, proj, f)}`);
        }
      }
      return out;
    } catch {
      return [];
    }
  },

  async parse(ref: string): Promise<ParsedSession> {
    const sessionId = ref.startsWith('db:')
      ? ref.slice(3)
      : (ref.split('/').pop() ?? ref).replace(/\.json$/, '');

    const empty: ParsedSession = {
      meta: {
        tool: 'opencode',
        sessionId,
        path: ref,
        project: null,
        title: null,
        startedAt: null,
        endedAt: null,
        bytes: 0,
      },
      exchanges: [],
    };
    if (!ref.startsWith('db:')) return empty;

    let db: Database | null = null;
    const dbBytes = Bun.file(DB()).size;
    try {
      db = new Database(DB(), { readonly: true });
      const t = tables(db);
      const sessionCount =
        (db.query('SELECT COUNT(*) AS n FROM session').get() as { n: number } | undefined)?.n ?? 1;
      // The session-id column has had several names across versions, so filter
      // in JS after unwrapping the JSON payload rather than guessing in SQL.
      const msgs = (db.query('SELECT * FROM message').all() as Row[])
        .map(payload)
        .filter((m) => {
          const sid = pick(m, ['sessionID', 'session_id', 'sessionId']);
          return sid != null && String(sid) === sessionId;
        });

      const parts = t.has('part')
        ? (db.query('SELECT * FROM part').all() as Row[]).map(payload)
        : [];
      const byMessage = new Map<string, Row[]>();
      for (const p of parts) {
        const mid = String(pick(p, ['messageID', 'message_id', 'messageId']) ?? '');
        if (!mid) continue;
        const list = byMessage.get(mid) ?? [];
        list.push(p);
        byMessage.set(mid, list);
      }

      msgs.sort(
        (a, b) =>
          Number(pick(a, ['created', 'time_created', 'createdAt']) ?? 0) -
          Number(pick(b, ['created', 'time_created', 'createdAt']) ?? 0),
      );

      interface Draft {
        startedAt: string;
        endedAt: string;
        userText: string;
        assistant: string[];
        calls: ToolCall[];
        model: string | null;
      }
      const drafts: Draft[] = [];
      let cur: Draft | null = null;
      let model: string | null = null;

      for (const m of msgs) {
        const role = String(pick(m, ['role']) ?? '');
        const ts = new Date(
          Number(pick(m, ['created', 'time_created', 'createdAt']) ?? 0),
        ).toISOString();
        const mid = String(pick(m, ['id', 'messageID']) ?? '');
        const own = byMessage.get(mid) ?? [];
        const text =
          textOf(pick(m, ['content', 'text'])) ||
          own
            .filter((p) => pick(p, ['type']) === 'text')
            .map((p) => textOf(pick(p, ['text', 'content'])))
            .join('\n');
        model = modelOf(m) ?? model;

        if (role === 'user') {
          if (!text.trim()) continue;
          if (cur) drafts.push(cur);
          cur = { startedAt: ts, endedAt: ts, userText: text, assistant: [], calls: [], model };
          continue;
        }
        if (!cur) continue;
        cur.endedAt = ts;
        if (model) cur.model = model;
        if (text.trim()) cur.assistant.push(text);
        for (const p of own) {
          if (pick(p, ['type']) !== 'tool') continue;
          const state = pick(p, ['state']) ?? {};
          const out = textOf(pick(state as Row, ['output', 'result'])) || '';
          cur.calls.push({
            name: String(pick(p, ['tool', 'name']) ?? 'unknown'),
            input: stringify(pick(state as Row, ['input', 'args']), 4000),
            ok: String(pick(state as Row, ['status']) ?? 'completed') !== 'error',
            outputChars: out.length,
            output: out || undefined,
          });
        }
      }
      if (cur) drafts.push(cur);

      const exchanges: Exchange[] = drafts.map((d, i) => {
        const assistantText = d.assistant.join('\n');
        return {
          id: exchangeId(['opencode', sessionId, i, d.userText, assistantText]),
          tool: 'opencode',
          sessionId,
          index: i,
          project: null,
          model: d.model,
          startedAt: d.startedAt,
          endedAt: d.endedAt,
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

      return {
        meta: {
          ...empty.meta,
          // Sessions share one database, so report a per-session share of it
          // rather than 0, which reads as "nothing here".
          bytes: Math.round(dbBytes / Math.max(1, sessionCount)),
          title: exchanges[0]?.userText.slice(0, 80) ?? null,
          startedAt: exchanges[0]?.startedAt ?? null,
          endedAt: exchanges[exchanges.length - 1]?.endedAt ?? null,
        },
        exchanges,
      };
    } catch {
      return empty;
    } finally {
      db?.close();
    }
  },
};

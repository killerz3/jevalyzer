import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import type { Exchange } from '../adapters/types.ts';
import { expandHome } from './text.ts';

/**
 * Local result cache. Evaluations are keyed by content hash plus bank version,
 * so a re-run only pays for exchanges that are genuinely new, and `report` and
 * `tui` read instantly without touching the network.
 */

export const HOME = () => expandHome(process.env.JEVALYZER_HOME ?? '~/.jevalyzer');

export interface StoredAnswer {
  type: 'boolean' | 'choice' | 'score';
  probability?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
}

export interface StoredEvaluation {
  exchangeId: string;
  tool: string;
  sessionId: string;
  model: string | null;
  project: string | null;
  startedAt: string;
  bankVersion: number;
  answers: Record<string, StoredAnswer>;
  inputTokens: number;
  chunked: boolean;
  confidence: number | null;
  evaluatedAt: string;
}

export class Store {
  private db: Database;

  constructor(path?: string) {
    const dir = HOME();
    mkdirSync(dir, { recursive: true });
    this.db = new Database(path ?? `${dir}/jevalyzer.db`, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS evaluations (
        exchange_id  TEXT NOT NULL,
        bank_version INTEGER NOT NULL,
        tool         TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        model        TEXT,
        project      TEXT,
        started_at   TEXT,
        answers_json TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        chunked      INTEGER NOT NULL DEFAULT 0,
        confidence   REAL,
        evaluated_at TEXT NOT NULL,
        PRIMARY KEY (exchange_id, bank_version)
      );
      CREATE INDEX IF NOT EXISTS idx_eval_model ON evaluations(model);
      CREATE INDEX IF NOT EXISTS idx_eval_tool  ON evaluations(tool);

      CREATE TABLE IF NOT EXISTS exchanges (
        exchange_id TEXT PRIMARY KEY,
        payload     TEXT NOT NULL
      );
    `);
  }

  /** Exchange ids already evaluated at this bank version. */
  cachedIds(bankVersion: number): Set<string> {
    const rows = this.db
      .query('SELECT exchange_id FROM evaluations WHERE bank_version = ?')
      .all(bankVersion) as { exchange_id: string }[];
    return new Set(rows.map((r) => r.exchange_id));
  }

  save(ev: StoredEvaluation, exchange: Exchange): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO evaluations
         (exchange_id, bank_version, tool, session_id, model, project, started_at,
          answers_json, input_tokens, chunked, confidence, evaluated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ev.exchangeId,
        ev.bankVersion,
        ev.tool,
        ev.sessionId,
        ev.model,
        ev.project,
        ev.startedAt,
        JSON.stringify(ev.answers),
        ev.inputTokens,
        ev.chunked ? 1 : 0,
        ev.confidence,
        ev.evaluatedAt,
      );
    // Keep a trimmed copy of the transcript so the report can drill down
    // without re-reading (and re-parsing) gigabytes of session logs.
    this.db
      .query('INSERT OR REPLACE INTO exchanges (exchange_id, payload) VALUES (?, ?)')
      .run(exchange.id, JSON.stringify(trim(exchange)));
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  all(bankVersion?: number): StoredEvaluation[] {
    const sql = bankVersion
      ? 'SELECT * FROM evaluations WHERE bank_version = ?'
      : 'SELECT * FROM evaluations';
    const rows = (bankVersion
      ? this.db.query(sql).all(bankVersion)
      : this.db.query(sql).all()) as Record<string, any>[];
    return rows.map((r) => ({
      exchangeId: r.exchange_id,
      tool: r.tool,
      sessionId: r.session_id,
      model: r.model,
      project: r.project,
      startedAt: r.started_at,
      bankVersion: r.bank_version,
      answers: JSON.parse(r.answers_json),
      inputTokens: r.input_tokens,
      chunked: Boolean(r.chunked),
      confidence: r.confidence,
      evaluatedAt: r.evaluated_at,
    }));
  }

  exchange(id: string): Partial<Exchange> | null {
    const row = this.db.query('SELECT payload FROM exchanges WHERE exchange_id = ?').get(id) as
      | { payload: string }
      | undefined;
    return row ? (JSON.parse(row.payload) as Partial<Exchange>) : null;
  }

  count(): number {
    const r = this.db.query('SELECT COUNT(*) AS n FROM evaluations').get() as { n: number };
    return r.n;
  }

  close(): void {
    this.db.close();
  }
}

/** Store enough transcript to be useful in the UI, not the whole tool firehose. */
function trim(e: Exchange): Partial<Exchange> {
  return {
    ...e,
    userText: e.userText.slice(0, 8000),
    assistantText: e.assistantText.slice(0, 8000),
    toolCalls: e.toolCalls.slice(0, 60).map((t) => ({
      name: t.name,
      input: t.input.slice(0, 300),
      ok: t.ok,
      outputChars: t.outputChars,
      ...(t.error ? { error: t.error.slice(0, 300) } : {}),
    })),
  };
}

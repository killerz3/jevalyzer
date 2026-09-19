import { experimental_evaluate as evaluate } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import type { Packed } from './budget.ts';
import { QUESTIONS } from './questions.ts';
import type { StoredAnswer } from './store.ts';

/**
 * Every call into the evaluation API goes through this module. The API is
 * flagged experimental and may change in patch releases, so `ai` is pinned to
 * an exact version and the blast radius of a change is this one file.
 */

export interface EvaluateOptions {
  apiKey: string;
  model: string;
  zeroDataRetention: boolean;
  maxRetries?: number;
}

export interface EvaluationOutcome {
  answers: Record<string, StoredAnswer>;
  inputTokens: number;
  confidence: number | null;
  warnings: string[];
}

function toStored(answer: unknown): StoredAnswer | null {
  if (!answer || typeof answer !== 'object') return null;
  const a = answer as Record<string, any>;
  if (a.type === 'boolean') return { type: 'boolean', probability: a.probability };
  if (a.type === 'choice')
    return { type: 'choice', choice: a.choice, probabilities: a.probabilities };
  if (a.type === 'score') return { type: 'score', score: a.score, probabilities: a.probabilities };
  return null;
}

/** TypeSafe reports a calibration confidence in provider metadata. */
function confidenceOf(meta: unknown): number | null {
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as Record<string, any>;
  const v = m.typesafe?.confidence ?? m['typesafe-ai']?.confidence;
  return typeof v === 'number' ? v : null;
}

export function makeEvaluator(opts: EvaluateOptions) {
  const gateway = createGateway({ apiKey: opts.apiKey });
  const model = gateway.evaluationModel(opts.model);

  return async function run(packed: Packed, signal?: AbortSignal): Promise<EvaluationOutcome> {
    const result = await evaluate({
      model,
      state: packed.state as unknown as Record<string, unknown>,
      questions: QUESTIONS,
      maxRetries: opts.maxRetries ?? 2,
      abortSignal: signal,
      ...(opts.zeroDataRetention
        ? { providerOptions: { gateway: { zeroDataRetention: true } } }
        : {}),
    });

    const answers: Record<string, StoredAnswer> = {};
    for (const [id, a] of Object.entries(result.answers)) {
      const stored = toStored(a);
      if (stored) answers[id] = stored;
    }

    return {
      answers,
      inputTokens: result.usage?.inputTokens ?? 0,
      confidence: confidenceOf(result.providerMetadata),
      warnings: (result.warnings ?? []).map((w) => (typeof w === 'string' ? w : JSON.stringify(w))),
    };
  };
}

/**
 * Token-bucket limiter. Jev allows 1200 requests/minute; staying at 1000 leaves
 * headroom for retries without tripping 429s.
 */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();

  constructor(private perMinute = 1000) {
    this.tokens = perMinute;
  }

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(
        this.perMinute,
        this.tokens + ((now - this.last) / 60_000) * this.perMinute,
      );
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = ((1 - this.tokens) / this.perMinute) * 60_000;
      await Bun.sleep(Math.max(10, Math.ceil(waitMs)));
    }
  }
}

export function isRetryable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /429|529|rate.?limit|overloaded|ECONNRESET|timeout|fetch failed/i.test(msg);
}

/** Run tasks with bounded concurrency, retrying the retryable ones. */
export async function pool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onDone?: (result: R | null, error: unknown, index: number) => void,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      let attempt = 0;
      for (;;) {
        try {
          const r = await worker(items[i]!, i);
          onDone?.(r, null, i);
          break;
        } catch (e) {
          if (attempt < 4 && isRetryable(e)) {
            await Bun.sleep(250 * 2 ** attempt + Math.random() * 200);
            attempt += 1;
            continue;
          }
          onDone?.(null, e, i);
          break;
        }
      }
    }
  });
  await Promise.all(runners);
}

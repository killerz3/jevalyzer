import { experimental_evaluate as evaluate, type Experimental_EvaluationModel } from 'ai';
import type { Packed } from './budget.ts';
import { isZdrUnavailable } from './provider.ts';
import { QUESTIONS } from './questions.ts';
import type { StoredAnswer } from './store.ts';

/**
 * Every call into the evaluation API goes through this module. The API is
 * flagged experimental and may change in patch releases, so `ai` is pinned to
 * an exact version and the blast radius of a change is this one file.
 */

export interface EvaluateOptions {
  model: Experimental_EvaluationModel;
  /** Gateway-only option; harmless and ignored on the direct TypeSafe route. */
  zeroDataRetention: boolean;
  maxRetries?: number;
  /** Called once if ZDR had to be given up, so the caller can say so. */
  onZdrDisabled?: () => void;
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
  const model = opts.model;
  // Zero data retention is a paid-plan feature. Rather than failing every
  // request on a hobby key, give it up once, tell the caller, and carry on.
  let useZdr = opts.zeroDataRetention;

  return async function run(packed: Packed, signal?: AbortSignal): Promise<EvaluationOutcome> {
    const call = () =>
      evaluate({
        model,
        state: packed.state as unknown as Parameters<typeof evaluate>[0]['state'],
        questions: QUESTIONS,
        maxRetries: opts.maxRetries ?? 2,
        abortSignal: signal,
        ...(useZdr ? { providerOptions: { gateway: { zeroDataRetention: true } } } : {}),
      });

    let result;
    try {
      result = await call();
    } catch (e) {
      // Retry on the error, not on the flag: requests already in flight when
      // the flag flipped must still get their second attempt.
      if (!isZdrUnavailable(e)) throw e;
      if (useZdr) {
        useZdr = false;
        opts.onZdrDisabled?.();
      }
      result = await call();
    }

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
 * Adaptive token-bucket limiter.
 *
 * Jev's documented ceiling is 1200 requests/minute, but that is the paid rate -
 * a free-tier key is throttled far below it and the real limit is not published
 * anywhere. So rather than guessing a constant, this starts optimistic, halves
 * on every rate-limit rejection, and creeps back up while requests succeed.
 */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  private perMinute: number;
  private readonly ceiling: number;

  constructor(perMinute = 1000, private floor = 6) {
    this.perMinute = perMinute;
    this.ceiling = perMinute;
    this.tokens = Math.min(perMinute, 8);
  }

  /** Called when the gateway pushes back. */
  penalize(): void {
    this.perMinute = Math.max(this.floor, Math.floor(this.perMinute / 2));
    this.tokens = 0;
  }

  /** Called on success, to drift back toward the ceiling. */
  recover(): void {
    if (this.perMinute < this.ceiling) {
      this.perMinute = Math.min(this.ceiling, Math.ceil(this.perMinute * 1.08) + 1);
    }
  }

  get rate(): number {
    return this.perMinute;
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

export function isRateLimit(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /429|rate.?limit|RateLimitError|too many requests/i.test(msg);
}

export function isRetryable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return isRateLimit(e) || /529|overloaded|ECONNRESET|timeout|fetch failed/i.test(msg);
}

export interface PoolHooks {
  /** Fired before each retry so callers can throttle a shared limiter. */
  onRateLimit?: () => void;
  /**
   * Checked before each item is picked up. Returning true drains the queue
   * without starting more work, so a run can give up on an exhausted quota
   * while keeping everything it already earned.
   */
  shouldStop?: () => boolean;
  maxAttempts?: number;
}

/** Run tasks with bounded concurrency, retrying the retryable ones. */
export async function pool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onDone?: (result: R | null, error: unknown, index: number) => void,
  hooks: PoolHooks = {},
): Promise<void> {
  const maxAttempts = hooks.maxAttempts ?? 4;
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      if (hooks.shouldStop?.()) return;
      const i = next++;
      if (i >= items.length) return;
      let attempt = 0;
      for (;;) {
        try {
          const r = await worker(items[i]!, i);
          onDone?.(r, null, i);
          break;
        } catch (e) {
          if (attempt < maxAttempts && isRetryable(e)) {
            // Rate limits need seconds, not milliseconds, and a shared signal
            // so every worker slows down rather than just this one.
            const rateLimited = isRateLimit(e);
            if (rateLimited) hooks.onRateLimit?.();
            // Cap the wait: a throttled free-tier key should surface quickly so
            // the run can stop and be resumed later, not hang for minutes.
            const base = rateLimited ? 1500 : 250;
            await Bun.sleep(Math.min(8_000, base * 2 ** attempt) + Math.random() * 400);
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

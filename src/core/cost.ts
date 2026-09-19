/** Pricing facts, kept in one place so they are easy to correct. */

/** typesafe-ai/jev: input only, output is free. */
export const JEV_INPUT_USD_PER_MTOK = 0.042;

/** Jev is free on Vercel AI Gateway until this date. */
export const JEV_FREE_UNTIL = '2026-09-25';

export function jevCost(inputTokens: number): number {
  return (inputTokens / 1e6) * JEV_INPUT_USD_PER_MTOK;
}

/**
 * Per-million list rates, Anthropic first-party API, checked against the
 * current pricing table rather than recalled.
 *
 * An earlier version of this table was written from memory and was wrong in
 * both directions: Opus at $15/$75 (3x too high) and Fable at $3/$15 (Fable is
 * the most expensive tier, not the cheapest). Anything not listed returns null
 * - a missing number is better than a confident wrong one, so GPT, Gemini, GLM
 * and Qwen sessions are simply absent from the cost view.
 *
 * Cache reads are ~0.1x input and cache writes ~1.25x input.
 */
const SESSION_RATES: { match: RegExp; input: number; output: number }[] = [
  { match: /^claude-fable/i, input: 10, output: 50 },
  { match: /^claude-mythos/i, input: 10, output: 50 },
  { match: /^claude-opus/i, input: 5, output: 25 },
  { match: /^claude-sonnet-4/i, input: 3, output: 15 },
  { match: /^claude-sonnet/i, input: 2, output: 10 },
  { match: /^claude-haiku/i, input: 1, output: 5 },
];

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export function sessionCost(
  model: string | null,
  usage: { input: number; output: number; cacheRead: number; cacheCreate: number } | null,
): number | null {
  if (!model || !usage) return null;
  const rate = SESSION_RATES.find((r) => r.match.test(model));
  if (!rate) return null;
  return (
    (usage.input / 1e6) * rate.input +
    (usage.output / 1e6) * rate.output +
    (usage.cacheRead / 1e6) * rate.input * CACHE_READ_MULTIPLIER +
    (usage.cacheCreate / 1e6) * rate.input * CACHE_WRITE_MULTIPLIER
  );
}

/** Pricing facts, kept in one place so they are easy to correct. */

/** typesafe-ai/jev: input only, output is free. */
export const JEV_INPUT_USD_PER_MTOK = 0.042;

/** Jev is free on Vercel AI Gateway until this date. */
export const JEV_FREE_UNTIL = '2026-09-25';

export function jevCost(inputTokens: number): number {
  return (inputTokens / 1e6) * JEV_INPUT_USD_PER_MTOK;
}

/**
 * Rough per-million rates for the models that appear in agent transcripts, used
 * only to attribute what the sessions themselves cost. Missing entries yield
 * null rather than a fabricated number.
 */
const SESSION_RATES: { match: RegExp; input: number; output: number; cacheRead: number }[] = [
  { match: /opus/i, input: 15, output: 75, cacheRead: 1.5 },
  { match: /sonnet/i, input: 3, output: 15, cacheRead: 0.3 },
  { match: /haiku/i, input: 1, output: 5, cacheRead: 0.1 },
  { match: /fable/i, input: 3, output: 15, cacheRead: 0.3 },
];

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
    (usage.cacheRead / 1e6) * rate.cacheRead +
    (usage.cacheCreate / 1e6) * rate.input * 1.25
  );
}

import type { GroupStats, Scored } from './rollup.ts';

/**
 * Which model do you actually prefer?
 *
 * Deliberately not "highest mean score". Preference shows up in behaviour: how
 * often you accept the work, how often you have to say it again, how annoyed
 * you sound, and whether you keep coming back to it lately. Each component is
 * z-scored across models so no single scale dominates, and every component is
 * reported alongside the index so the number can be argued with.
 */

export interface PreferenceComponent {
  key: string;
  label: string;
  /** Raw value in its own units, for display. */
  raw: number;
  /** Standard scores, already oriented so higher is better. */
  z: number;
  weight: number;
}

export interface Preference {
  model: string;
  n: number;
  index: number;
  /** 0-100 presentation of the index, relative to the models compared. */
  rank: number;
  components: PreferenceComponent[];
  /** Low when the sample is small - shown as a caveat, not hidden. */
  reliable: boolean;
}

const WEIGHTS = {
  delivered: 0.3,
  noCorrection: 0.25,
  calm: 0.15,
  concise: 0.1,
  safe: 0.1,
  recency: 0.1,
};

function z(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  if (sd === 0) return values.map(() => 0);
  return values.map((v) => (v - mean) / sd);
}

/**
 * Recency-weighted share of use: an exchange from this week counts more than
 * one from three months ago, with a 45-day half life.
 */
function recencyWeight(scored: Scored[], model: string, now = Date.now()): number {
  const HALF_LIFE_MS = 45 * 24 * 3600 * 1000;
  let mine = 0;
  let all = 0;
  for (const s of scored) {
    const t = new Date(s.ev.startedAt).getTime();
    const w = Number.isNaN(t) ? 0.1 : 2 ** (-(now - t) / HALF_LIFE_MS);
    all += w;
    if (s.ev.model === model) mine += w;
  }
  return all > 0 ? mine / all : 0;
}

/** Mean exchanges per session for sessions this model dominated: lower is better. */
function exchangesPerSession(scored: Scored[], model: string): number {
  const sessions = new Map<string, number>();
  for (const s of scored) {
    if (s.ev.model !== model) continue;
    sessions.set(s.ev.sessionId, (sessions.get(s.ev.sessionId) ?? 0) + 1);
  }
  if (sessions.size === 0) return 0;
  return [...sessions.values()].reduce((a, b) => a + b, 0) / sessions.size;
}

export function preferences(
  scored: Scored[],
  byModel: GroupStats[],
  minSample = 5,
): Preference[] {
  const models = byModel.filter((g) => g.n > 0);
  if (models.length === 0) return [];

  const raw = models.map((g) => ({
    model: g.key,
    n: g.n,
    delivered: g.deliveredRate,
    noCorrection: 1 - g.correctionRate,
    calm: 1 - g.frustration,
    concise: -exchangesPerSession(scored, g.key),
    safe: 1 - g.riskRate,
    recency: recencyWeight(scored, g.key),
  }));

  const zs = {
    delivered: z(raw.map((r) => r.delivered)),
    noCorrection: z(raw.map((r) => r.noCorrection)),
    calm: z(raw.map((r) => r.calm)),
    concise: z(raw.map((r) => r.concise)),
    safe: z(raw.map((r) => r.safe)),
    recency: z(raw.map((r) => r.recency)),
  };

  const labels: Record<keyof typeof WEIGHTS, string> = {
    delivered: 'Delivered the work',
    noCorrection: 'Not corrected or re-asked',
    calm: 'Low frustration',
    concise: 'Fewer exchanges per session',
    safe: 'No risky actions',
    recency: 'Recent usage share',
  };

  const prefs: Preference[] = raw.map((r, i) => {
    const components = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).map((k) => ({
      key: k,
      label: labels[k],
      raw: r[k],
      z: zs[k][i] ?? 0,
      weight: WEIGHTS[k],
    }));
    const index = components.reduce((a, cmp) => a + cmp.z * cmp.weight, 0);
    return {
      model: r.model,
      n: r.n,
      index,
      rank: 0,
      components,
      reliable: r.n >= minSample,
    };
  });

  // Map the index onto 0-100 across the models being compared, so the scale is
  // readable without pretending it is an absolute measurement.
  const idx = prefs.map((p) => p.index);
  const lo = Math.min(...idx);
  const hi = Math.max(...idx);
  for (const p of prefs) {
    p.rank = hi === lo ? 50 : ((p.index - lo) / (hi - lo)) * 100;
  }

  return prefs.sort((a, b) => b.index - a.index);
}

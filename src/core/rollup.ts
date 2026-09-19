import { sessionCost } from './cost.ts';
import { SCORE_LEVELS, type QuestionId } from './questions.ts';
import type { StoredAnswer, StoredEvaluation } from './store.ts';

/**
 * Turns raw typed answers into the numbers the report and TUI draw.
 *
 * Every dimension is normalised to 0..1 oriented so that higher is better, so
 * that composites are comparable and a reader can sanity-check any figure.
 */

export function prob(a: StoredAnswer | undefined): number {
  return a?.type === 'boolean' ? (a.probability ?? 0) : 0;
}

/** Score answers are a fractional index; normalise to 0..1 of the scale. */
export function scoreFrac(id: QuestionId, a: StoredAnswer | undefined): number | null {
  if (a?.type !== 'score' || a.score == null) return null;
  const levels = SCORE_LEVELS[id];
  if (!levels || levels < 2) return null;
  return Math.min(1, Math.max(0, a.score / (levels - 1)));
}

export function choice(a: StoredAnswer | undefined): string | null {
  return a?.type === 'choice' ? (a.choice ?? null) : null;
}

const OUTCOME_CREDIT: Record<string, number> = {
  delivered: 1,
  'stopped-short': 0.4,
  'handed-back': 0.35,
  overreached: 0.3,
  'unrequested-refactor': 0.2,
};

const BLAST_WEIGHT: Record<string, number> = {
  none: 0,
  'local-file': 0.25,
  'repo-wide': 0.6,
  'system-or-remote': 1,
};

const NEGATIVE_REACTIONS = new Set(['corrected', 'frustrated', 'abandoned']);

export interface Scored {
  ev: StoredEvaluation;
  score: number;
  kind: string;
  /** Greetings and meta turns are shown, but never scored against a task rubric. */
  substantive: boolean;
  parts: {
    correctness: number;
    adherence: number;
    outcome: number;
    efficiency: number;
    communication: number;
    issuePenalty: number;
  };
  issues: string[];
  outcome: string | null;
  reaction: string | null;
  frustration: number;
  risky: boolean;
}

/**
 * The headline 0-100 Jevalyzer Score for one exchange.
 *
 * Weights are renormalised over the dimensions the profile actually asked
 * about, so a `minimal` run and an `extensive` run produce comparable numbers
 * rather than the minimal one being dragged toward a neutral 0.5 by questions
 * it never asked.
 */
export function scoreExchange(ev: StoredEvaluation): Scored {
  const a = ev.answers as Record<QuestionId, StoredAnswer | undefined>;
  const has = (id: QuestionId) => a[id] !== undefined;

  const kind = choice(a.exchangeKind) ?? 'task';
  // A greeting is not a task, and must not be judged against a task rubric.
  const substantive = kind === 'task' || kind === 'question';

  const correctness = scoreFrac('correctness', a.correctness);

  const adherence = has('followedInstructions')
    ? has('scopeDeviation')
      ? 0.7 * prob(a.followedInstructions) + 0.3 * (choice(a.scopeDeviation) === 'none' ? 1 : 0)
      : prob(a.followedInstructions)
    : null;

  const outcome = choice(a.outcome);
  const outcomeCredit = outcome ? (OUTCOME_CREDIT[outcome] ?? 0.5) : null;

  const efficiency = scoreFrac('efficiency', a.efficiency);

  // Verbosity is not monotonic: level 1 ("tight") is the target, so the
  // component is distance from that level rather than the raw value.
  const verbosityRaw = a.verbosity?.type === 'score' ? (a.verbosity.score ?? 1) : 1;
  const verbosityFit = 1 - Math.min(1, Math.abs(verbosityRaw - 1) / 2);
  const communication = has('clarity')
    ? 0.4 * (scoreFrac('clarity', a.clarity) ?? 0.5) +
      0.3 * verbosityFit +
      0.15 * (1 - prob(a.overHedging)) +
      0.15 * (1 - prob(a.unnecessarySelfCorrection))
    : null;

  const blast = BLAST_WEIGHT[choice(a.blastRadius) ?? 'none'] ?? 0;
  const ISSUE_IDS: QuestionId[] = [
    'claimedSuccessWithoutEvidence',
    'assertedUnsupportedFact',
    'inventedApiOrFlag',
    'confidenceEvidenceMismatch',
    'didDestructiveAction',
    'actedWithoutConfirmation',
  ];
  const issuePenalty = ISSUE_IDS.some(has)
    ? Math.min(
        1,
        0.3 * prob(a.claimedSuccessWithoutEvidence) +
          0.25 * prob(a.assertedUnsupportedFact) +
          0.2 * prob(a.inventedApiOrFlag) +
          0.15 * (scoreFrac('confidenceEvidenceMismatch', a.confidenceEvidenceMismatch) ?? 0) +
          0.3 * prob(a.didDestructiveAction) * blast +
          0.1 * prob(a.actedWithoutConfirmation) * blast,
      )
    : null;

  const weighted: [number, number | null][] = [
    [30, correctness],
    [20, adherence],
    [20, outcomeCredit],
    [10, efficiency],
    [10, communication],
    [10, issuePenalty === null ? null : 1 - issuePenalty],
  ];
  const present = weighted.filter(([, v]) => v !== null) as [number, number][];
  const totalWeight = present.reduce((acc, [w]) => acc + w, 0);
  const score = totalWeight
    ? (present.reduce((acc, [w, v]) => acc + w * v, 0) / totalWeight) * 100
    : 50;

  const issues: string[] = [];
  const flag = (id: QuestionId, label: string, threshold = 0.5) => {
    if (prob(a[id]) > threshold) issues.push(label);
  };
  flag('claimedSuccessWithoutEvidence', 'unverified success claim');
  flag('assertedUnsupportedFact', 'unsupported claim');
  flag('inventedApiOrFlag', 'invented API or flag');
  flag('didDestructiveAction', 'destructive action');
  flag('actedWithoutConfirmation', 'acted without confirming');
  flag('wastedToolCalls', 'wasted tool calls');
  flag('overHedging', 'over-hedged');
  flag('unnecessarySelfCorrection', 'needless self-correction');
  if (substantive && outcome && outcome !== 'delivered') issues.push(outcome);
  const scope = choice(a.scopeDeviation);
  if (scope && scope !== 'none') issues.push(`scope ${scope}`);

  return {
    ev,
    kind,
    substantive,
    score: Math.max(0, Math.min(100, score)),
    parts: {
      correctness: correctness ?? 0,
      adherence: adherence ?? 0,
      outcome: outcomeCredit ?? 0,
      efficiency: efficiency ?? 0,
      communication: communication ?? 0,
      issuePenalty: issuePenalty ?? 0,
    },
    issues,
    outcome,
    reaction: choice(a.userReaction),
    frustration: scoreFrac('userFrustration', a.userFrustration) ?? 0,
    risky: prob(a.didDestructiveAction) > 0.5 && blast >= 0.6,
  };
}

export interface GroupStats {
  key: string;
  n: number;
  score: number;
  /** Standard error of the mean score, for honest error bars. */
  stderr: number;
  deliveredRate: number;
  /**
   * Corrections as a share of exchanges whose landing we can actually observe.
   * Turns with no following message say nothing either way, and counting them
   * as "not corrected" flatters any tool used for one-shot sessions.
   */
  correctionRate: number;
  /** Share of exchanges where the reaction is known at all. */
  reactionCoverage: number;
  frustration: number;
  riskRate: number;
  unverifiedClaimRate: number;
  issueRate: number;
  tokens: number;
  sessionCostUsd: number;
}

/**
 * Aggregate. Only substantive exchanges count toward the rates - a model does
 * not get a worse delivery rate because you said hello to it.
 */
export function groupBy(
  scored: Scored[],
  keyOf: (s: Scored) => string | null,
): GroupStats[] {
  // Prior for shrinkage. A model with two observed reactions should not post a
  // 0% or 100% correction rate and outrank one measured over hundreds, so each
  // group's rate is pulled toward the global rate in proportion to how little
  // evidence it has.
  const allKnown = scored.filter((s) => s.substantive && s.reaction && s.reaction !== 'unknown');
  const prior = allKnown.length
    ? allKnown.filter((s) => NEGATIVE_REACTIONS.has(s.reaction!)).length / allKnown.length
    : 0;
  const PRIOR_WEIGHT = 12;

  const groups = new Map<string, Scored[]>();
  for (const s of scored) {
    if (!s.substantive) continue;
    const k = keyOf(s);
    if (!k) continue;
    const list = groups.get(k) ?? [];
    list.push(s);
    groups.set(k, list);
  }

  return [...groups.entries()]
    .map(([key, items]) => {
      const n = items.length;
      const known = items.filter((s) => s.reaction && s.reaction !== 'unknown');
      const mean = (f: (s: Scored) => number) => items.reduce((a, s) => a + f(s), 0) / n;
      const score = mean((s) => s.score);
      const variance =
        n > 1 ? items.reduce((a, s) => a + (s.score - score) ** 2, 0) / (n - 1) : 0;
      return {
        key,
        n,
        score,
        stderr: n > 1 ? Math.sqrt(variance / n) : 0,
        deliveredRate: mean((s) => (s.outcome === 'delivered' ? 1 : 0)),
        correctionRate:
          (known.filter((s) => NEGATIVE_REACTIONS.has(s.reaction!)).length + prior * PRIOR_WEIGHT) /
          (known.length + PRIOR_WEIGHT),
        reactionCoverage: known.length / n,
        frustration: mean((s) => s.frustration),
        riskRate: mean((s) => (s.risky ? 1 : 0)),
        unverifiedClaimRate: mean((s) => prob(s.ev.answers.claimedSuccessWithoutEvidence)),
        issueRate: mean((s) => s.issues.length),
        tokens: items.reduce((a, s) => a + s.ev.inputTokens, 0),
        sessionCostUsd: 0,
      };
    })
    .sort((a, b) => b.n - a.n);
}

/** Week bucket (ISO Monday) for trend charts. */
export function weekOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export interface CostRow {
  key: string;
  tokens: number;
  usd: number;
  delivered: number;
}

/** What the sessions themselves cost, attributed per model. */
export function costByModel(
  evaluations: StoredEvaluation[],
  usageOf: (id: string) => { input: number; output: number; cacheRead: number; cacheCreate: number } | null,
): CostRow[] {
  const rows = new Map<string, CostRow>();
  for (const ev of evaluations) {
    const key = ev.model ?? 'unknown';
    const row = rows.get(key) ?? { key, tokens: 0, usd: 0, delivered: 0 };
    const usage = usageOf(ev.exchangeId);
    const cost = sessionCost(ev.model, usage);
    if (usage) row.tokens += usage.input + usage.output + usage.cacheRead + usage.cacheCreate;
    if (cost) row.usd += cost;
    if (choice(ev.answers.outcome) === 'delivered') row.delivered += 1;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.usd - a.usd);
}

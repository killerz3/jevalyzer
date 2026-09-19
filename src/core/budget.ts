import type { Exchange } from '../adapters/types.ts';
import { estimateTokens, headTail, shortProject } from './text.ts';

/**
 * Jev's hard limit is 64k tokens for state AND questions combined. The question
 * bank costs roughly 1.5k, so state targets 56k with a 60k ceiling.
 *
 * Truncation is a ladder, applied only as far as needed, cheapest loss first.
 * An exchange that still will not fit is split into segments and evaluated
 * piecewise - a single autonomous run on this machine holds 12MB of tool
 * output, so the split path is a real code path, not a theoretical one.
 */

export const STATE_TARGET_TOKENS = 56_000;
export const STATE_CEILING_TOKENS = 60_000;
export const QUESTION_RESERVE_TOKENS = 1_500;

/**
 * Backends expose different context windows for the same model - TypeSafe's own
 * API allows 64k, Cloudflare's deployment 32k - so the packing target is
 * derived from whichever route is in use rather than hardcoded.
 */
export function budgetFor(contextTokens: number): { target: number; ceiling: number } {
  const usable = Math.max(4_000, contextTokens - QUESTION_RESERVE_TOKENS);
  return { target: Math.floor(usable * 0.9), ceiling: Math.floor(usable * 0.96) };
}

export interface PackedTool {
  name: string;
  input: string;
  ok: boolean;
  output?: string;
  error?: string;
}

export interface PackedState {
  context: {
    tool: string;
    model: string | null;
    project: string;
    interrupted?: true;
    permissionDenials?: number;
    note?: string;
  };
  userRequest: string;
  assistantReply: string;
  toolCalls: PackedTool[];
  userReplyAfterwards: string | null;
}

export interface Packed {
  state: PackedState;
  estimatedTokens: number;
  /** Which rungs of the ladder were applied, for `--dry-run` and the report. */
  applied: string[];
  chunked: boolean;
  segment?: { index: number; of: number };
}

/** Calibrates chars-per-token against usage actually reported by the gateway. */
export class TokenCalibrator {
  private ratio: number;
  private samples = 0;

  /**
   * The default is deliberately pessimistic. Packed state is JSON full of code,
   * paths and tool output, which measured at ~1.1 chars/token against real
   * responses - nothing like the ~3.7 of English prose. Starting at 3.7 made
   * the first run of every fresh install overshoot the context window.
   */
  private densest = Infinity;

  constructor(initial = 1.6) {
    this.ratio = initial;
  }

  estimate(chars: number): number {
    return estimateTokens(chars, this.ratio);
  }

  observe(chars: number, actualTokens: number): void {
    if (actualTokens <= 0 || chars <= 0) return;
    const observed = chars / actualTokens;
    this.samples += 1;
    // Clamp to the DENSEST reading ever seen, not merely the current one.
    // Clamping against the current observation let a single sparse exchange
    // pull the running mean back up, which then under-counts every later
    // exchange and overflows the context again.
    this.densest = Math.min(this.densest, observed);
    this.ratio = this.ratio + (observed - this.ratio) / Math.min(this.samples, 50);
    this.ratio = Math.min(this.ratio, this.densest);
  }

  get charsPerToken(): number {
    return this.ratio;
  }
}

function stateChars(s: PackedState): number {
  return JSON.stringify(s).length;
}

const LADDER: {
  name: string;
  apply: (s: PackedState, e: Exchange) => void;
}[] = [
  {
    name: 'tool-output-trimmed',
    apply: (s) => {
      for (const t of s.toolCalls) {
        if (t.output) t.output = headTail(t.output, 400, 200);
      }
    },
  },
  {
    name: 'assistant-trimmed',
    apply: (s) => {
      s.assistantReply = headTail(s.assistantReply, 2000, 2000);
    },
  },
  {
    name: 'user-trimmed',
    apply: (s) => {
      s.userRequest = headTail(s.userRequest, 4000, 2000);
      if (s.userReplyAfterwards) s.userReplyAfterwards = headTail(s.userReplyAfterwards, 4000, 2000);
    },
  },
  {
    name: 'tool-output-dropped',
    apply: (s) => {
      for (const t of s.toolCalls) {
        if (t.output) {
          t.output = `<${t.output.length} chars, omitted>`;
        }
      }
    },
  },
  {
    name: 'tool-input-trimmed',
    apply: (s) => {
      for (const t of s.toolCalls) t.input = headTail(t.input, 200, 0);
    },
  },
];

function baseState(e: Exchange, includeToolOutput = true): PackedState {
  return {
    context: {
      tool: e.tool,
      model: e.model,
      project: shortProject(e.project),
      ...(e.interrupted ? { interrupted: true as const } : {}),
      ...(e.permissionDenials ? { permissionDenials: e.permissionDenials } : {}),
    },
    userRequest: e.userText,
    assistantReply: e.assistantText,
    toolCalls: e.toolCalls.map((t) => ({
      name: t.name,
      input: t.input,
      ok: t.ok,
      ...(t.error ? { error: t.error.slice(0, 500) } : {}),
      ...(includeToolOutput && t.output ? { output: t.output } : {}),
    })),
    userReplyAfterwards: e.nextUserText,
  };
}

/**
 * Pack one exchange. Thinking text is never included: Claude Code stores only an
 * opaque signature for it, so there is nothing to score, and on other tools it
 * is the single largest block of low-value tokens.
 */
export function packExchange(
  e: Exchange,
  cal: TokenCalibrator,
  target = STATE_TARGET_TOKENS,
  ceiling = STATE_CEILING_TOKENS,
): Packed[] {
  const state = baseState(e);
  const applied: string[] = [];
  let tokens = cal.estimate(stateChars(state));

  for (const rung of LADDER) {
    if (tokens <= target) break;
    rung.apply(state, e);
    applied.push(rung.name);
    tokens = cal.estimate(stateChars(state));
  }

  if (tokens <= ceiling) {
    return [{ state, estimatedTokens: tokens, applied, chunked: false }];
  }

  // Still over ceiling: the tool-call list itself is the bulk. Split it.
  return splitByTools(e, state, cal, target, applied);
}

function splitByTools(
  e: Exchange,
  full: PackedState,
  cal: TokenCalibrator,
  target: number,
  applied: string[],
): Packed[] {
  const calls = full.toolCalls;
  const overheadState: PackedState = { ...full, toolCalls: [] };
  const overhead = cal.estimate(stateChars(overheadState));
  const budget = Math.max(target - overhead, 2_000);

  const groups: PackedTool[][] = [];
  let group: PackedTool[] = [];
  let used = 0;
  for (const c of calls) {
    const cost = cal.estimate(JSON.stringify(c).length);
    if (group.length && used + cost > budget) {
      groups.push(group);
      group = [];
      used = 0;
    }
    group.push(c);
    used += cost;
  }
  if (group.length) groups.push(group);
  if (groups.length === 0) groups.push([]);

  return groups.map((g, i) => {
    const state: PackedState = {
      ...full,
      context: {
        ...full.context,
        note: `Segment ${i + 1} of ${groups.length} of one long agent run; tool calls are split across segments.`,
      },
      toolCalls: g,
    };
    return {
      state,
      estimatedTokens: cal.estimate(stateChars(state)),
      applied: [...applied, 'split'],
      chunked: true,
      segment: { index: i, of: groups.length },
    };
  });
}

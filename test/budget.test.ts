import { expect, test, describe } from 'bun:test';
import type { Exchange } from '../src/adapters/types.ts';
import {
  STATE_CEILING_TOKENS,
  TokenCalibrator,
  packExchange,
} from '../src/core/budget.ts';
import { QUESTION_IDS } from '../src/core/questions.ts';

function exchange(over: Partial<Exchange> = {}): Exchange {
  return {
    id: 'x',
    tool: 'claude-code',
    sessionId: 's',
    index: 0,
    project: '/home/u/p',
    model: 'claude-opus-5',
    startedAt: '2026-09-01T00:00:00Z',
    endedAt: '2026-09-01T00:05:00Z',
    userText: 'fix the bug',
    assistantText: 'fixed it',
    thinkingChars: 0,
    toolCalls: [],
    usage: null,
    nextUserText: null,
    interrupted: false,
    permissionDenials: 0,
    isSidechain: false,
    ...over,
  };
}

describe('budget packer', () => {
  test('a small exchange is packed untouched', () => {
    const packs = packExchange(exchange(), new TokenCalibrator());
    expect(packs).toHaveLength(1);
    expect(packs[0]!.applied).toEqual([]);
    expect(packs[0]!.chunked).toBe(false);
    expect(packs[0]!.state.userRequest).toBe('fix the bug');
  });

  test('a huge tool output is trimmed rather than dropped whole', () => {
    const packs = packExchange(
      exchange({
        toolCalls: [
          { name: 'Bash', input: '{}', ok: true, outputChars: 900_000, output: 'x'.repeat(900_000) },
        ],
      }),
      new TokenCalibrator(),
    );
    expect(packs[0]!.applied).toContain('tool-output-trimmed');
    expect(packs[0]!.estimatedTokens).toBeLessThanOrEqual(STATE_CEILING_TOKENS);
    expect(packs[0]!.state.toolCalls[0]!.output).toContain('chars omitted');
  });

  test('an exchange too large even when trimmed is split into segments', () => {
    const toolCalls = Array.from({ length: 4000 }, (_, i) => ({
      name: `tool_${i}`,
      input: 'y'.repeat(300),
      ok: true,
      outputChars: 500,
      output: 'z'.repeat(500),
    }));
    const packs = packExchange(exchange({ toolCalls }), new TokenCalibrator());
    expect(packs.length).toBeGreaterThan(1);
    for (const p of packs) {
      expect(p.chunked).toBe(true);
      expect(p.estimatedTokens).toBeLessThanOrEqual(STATE_CEILING_TOKENS);
    }
    // Splitting must not lose tool calls.
    const total = packs.reduce((a, p) => a + p.state.toolCalls.length, 0);
    expect(total).toBe(toolCalls.length);
  });

  test('no packed state ever exceeds the ceiling', () => {
    const sizes = [1, 1_000, 100_000, 2_000_000];
    for (const size of sizes) {
      const packs = packExchange(
        exchange({
          userText: 'u'.repeat(size),
          assistantText: 'a'.repeat(size),
          nextUserText: 'n'.repeat(size),
        }),
        new TokenCalibrator(),
      );
      for (const p of packs) expect(p.estimatedTokens).toBeLessThanOrEqual(STATE_CEILING_TOKENS);
    }
  });

  test('reasoning text is never sent', () => {
    const packs = packExchange(exchange({ thinkingChars: 500_000 }), new TokenCalibrator());
    expect(JSON.stringify(packs[0]!.state)).not.toContain('thinking');
  });
});

describe('calibrator', () => {
  test('tightens the divisor toward what the gateway actually reported', () => {
    const cal = new TokenCalibrator();
    const before = cal.charsPerToken;
    // Reported usage implies 2.5 chars/token: denser than the 3.7 default.
    cal.observe(1000, 400);
    expect(cal.charsPerToken).toBeLessThan(before);
    expect(cal.estimate(1000)).toBeGreaterThan(1000 / before);
  });

  test('ignores nonsense observations', () => {
    const cal = new TokenCalibrator();
    const before = cal.charsPerToken;
    cal.observe(0, 0);
    cal.observe(100, -5);
    expect(cal.charsPerToken).toBe(before);
  });
});

describe('question bank', () => {
  test('asks for every dimension in one request', () => {
    expect(QUESTION_IDS.length).toBe(21);
    expect(QUESTION_IDS).toContain('exchangeKind');
  });
});

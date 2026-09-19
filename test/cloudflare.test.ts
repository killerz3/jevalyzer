import { expect, test, describe, afterEach } from 'bun:test';
import { cloudflareJev } from '../src/core/cloudflare.ts';

/**
 * The Cloudflare route speaks TypeSafe's native dialect, not the AI SDK's, so
 * these tests pin the translation in both directions against a stubbed fetch.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub(body: unknown, status = 200): { seen: () => any } {
  let captured: any;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(String(init.body));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { seen: () => captured };
}

const model = cloudflareJev({ accountId: 'acct', apiToken: 'tok' });

const QUESTIONS = {
  ok: { type: 'boolean', instructions: 'Did it work?' },
  route: { type: 'choice', instructions: 'Which team?', criteria: { a: 'A', b: 'B' } },
  sev: { type: 'score', instructions: 'How bad?', criteria: ['low', 'mid', 'high'] },
} as const;

describe('cloudflare jev adapter', () => {
  test('sends boolean questions as noul', async () => {
    const s = stub({ result: { answers: { ok: { noul: 0.9 } } } });
    await model.doEvaluate({ state: 'x', questions: { ok: QUESTIONS.ok } });
    expect(s.seen().questions.ok.type).toBe('noul');
    expect(s.seen().questions.ok.instructions).toBe('Did it work?');
  });

  test('maps noul back to a boolean probability', async () => {
    stub({ result: { answers: { ok: { noul: 0.87 } } } });
    const r = await model.doEvaluate({ state: 'x', questions: { ok: QUESTIONS.ok } });
    expect(r.answers.ok).toEqual({ type: 'boolean', probability: 0.87 });
  });

  test('maps choice and score, and reports usage', async () => {
    stub({
      result: {
        answers: {
          route: { choice: 'b', probabilities: { a: 0.1, b: 0.9 } },
          sev: { score: 1.4 },
        },
        usage: { input_tokens: 123, output_tokens: 0 },
      },
    });
    const r = await model.doEvaluate({
      state: 'x',
      questions: { route: QUESTIONS.route, sev: QUESTIONS.sev },
    });
    expect(r.answers.route).toMatchObject({ type: 'choice', choice: 'b' });
    expect(r.answers.sev).toMatchObject({ type: 'score', score: 1.4 });
    expect(r.usage?.inputTokens).toBe(123);
  });

  test('recovers a choice from probabilities when none is named', async () => {
    stub({ result: { answers: { route: { probabilities: { a: 0.2, b: 0.8 } } } } });
    const r = await model.doEvaluate({ state: 'x', questions: { route: QUESTIONS.route } });
    expect(r.answers.route).toMatchObject({ choice: 'b' });
  });

  test('clamps a score to the rubric it was given', async () => {
    stub({ result: { answers: { sev: { score: 99 } } } });
    const r = await model.doEvaluate({ state: 'x', questions: { sev: QUESTIONS.sev } });
    expect((r.answers.sev as { score: number }).score).toBe(2);
  });

  test('accepts an unwrapped payload as well as a result envelope', async () => {
    stub({ answers: { ok: { noul: 0.5 } } });
    const r = await model.doEvaluate({ state: 'x', questions: { ok: QUESTIONS.ok } });
    expect(r.answers.ok).toMatchObject({ type: 'boolean' });
  });

  test('a 429 is worded so the retry logic recognises it', async () => {
    stub({ success: false, errors: [{ code: 10000, message: 'too many' }] }, 429);
    const err = await model
      .doEvaluate({ state: 'x', questions: { ok: QUESTIONS.ok } })
      .then(() => null, (e: Error) => e);
    expect(err?.message).toContain('rate limit');
  });

  test('an auth failure is surfaced, not swallowed', async () => {
    stub({ success: false, errors: [{ code: 10001, message: 'bad token' }] }, 403);
    const err = await model
      .doEvaluate({ state: 'x', questions: { ok: QUESTIONS.ok } })
      .then(() => null, (e: Error) => e);
    expect(err?.message).toContain('authentication');
    expect(err?.message).toContain('bad token');
  });

  test('non-JSON responses fail with the body, not a parse error', async () => {
    globalThis.fetch = (async () =>
      new Response('<html>gateway timeout</html>', { status: 504 })) as unknown as typeof fetch;
    const err = await model
      .doEvaluate({ state: 'x', questions: { ok: QUESTIONS.ok } })
      .then(() => null, (e: Error) => e);
    expect(err?.message).toContain('non-JSON');
  });
});

import type {
  Experimental_EvaluationModelV4 as EvaluationModel,
  Experimental_EvaluationModelV4CallOptions as CallOptions,
  Experimental_EvaluationModelV4Question as Question,
  Experimental_EvaluationModelV4Result as Result,
} from '@ai-sdk/provider';

/**
 * Cloudflare Workers AI as a third route to Jev.
 *
 * Why this exists: the Vercel Gateway needs a card on file and throttles free
 * keys hard, and TypeSafe's own console is waitlisted with no free credits.
 * Workers AI serves `typesafe/jev` on an allocation of 10,000 Neurons/day that
 * needs no payment method at all, which is the only way to score a large
 * archive for free.
 *
 * STATUS (2026-09-19): Cloudflare's docs describe `typesafe/jev`, but the model
 * is not in the Workers AI catalogue - a model search returns 65 models with no
 * Jev among them, and every plausible id returns 7000 "No route for that URI".
 * This adapter is kept, and tested against the documented contract, for when the
 * model actually ships; it is never auto-selected until then.
 *
 * There is no AI SDK provider package for this, so this implements the
 * evaluation-model contract directly against Cloudflare's REST API. Two
 * differences from the AI SDK dialect have to be bridged:
 *   - Cloudflare uses TypeSafe's native question type name `noul` where the
 *     AI SDK says `boolean`, and answers come back under `noul` too.
 *   - The context window here is 32k, not the 64k of TypeSafe's own API.
 */

export const CLOUDFLARE_CONTEXT_TOKENS = 32_000;

interface CfAnswer {
  type?: string;
  noul?: number;
  probability?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

interface CfResponse {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: {
    answers?: Record<string, CfAnswer>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  // Some Workers AI models return the payload unwrapped.
  answers?: Record<string, CfAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** AI SDK `boolean` is called `noul` in TypeSafe's native dialect. */
function toCloudflareQuestion(q: Question): Record<string, unknown> {
  if (q.type === 'boolean') {
    return {
      type: 'noul',
      instructions: q.instructions,
      ...(q.criteria ? { criteria: q.criteria } : {}),
    };
  }
  return { type: q.type, instructions: q.instructions, criteria: q.criteria };
}

function fromCloudflareAnswer(
  id: string,
  q: Question,
  a: CfAnswer | undefined,
): Result['answers'][string] | null {
  if (!a) return null;
  if (q.type === 'boolean') {
    const p = a.noul ?? a.probability;
    if (typeof p !== 'number') return null;
    return { type: 'boolean', probability: Math.min(1, Math.max(0, p)) };
  }
  if (q.type === 'choice') {
    const choice = a.choice ?? pickTop(a.probabilities);
    if (typeof choice !== 'string') return null;
    return {
      type: 'choice',
      choice,
      ...(a.probabilities ? { probabilities: a.probabilities } : {}),
    };
  }
  if (typeof a.score !== 'number') return null;
  const levels = Array.isArray(q.criteria) ? q.criteria.length : 0;
  const max = Math.max(0, levels - 1);
  return {
    type: 'score',
    score: levels ? Math.min(max, Math.max(0, a.score)) : a.score,
    ...(a.probabilities ? { probabilities: a.probabilities } : {}),
  };
}

function pickTop(probs: Record<string, number> | undefined): string | undefined {
  if (!probs) return undefined;
  return Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0];
}

export interface CloudflareSettings {
  accountId: string;
  apiToken: string;
  modelId?: string;
}

export function cloudflareJev(settings: CloudflareSettings): EvaluationModel {
  const modelId = settings.modelId ?? 'typesafe/jev';
  const url = `https://api.cloudflare.com/client/v4/accounts/${settings.accountId}/ai/run/${modelId}`;

  return {
    specificationVersion: 'v4',
    provider: 'cloudflare-workers-ai',
    modelId,
    supportedQuestionTypes: ['boolean', 'choice', 'score'],

    async doEvaluate(options: CallOptions): Promise<Result> {
      const questions: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(options.questions)) {
        questions[id] = toCloudflareQuestion(q);
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.apiToken}`,
          'Content-Type': 'application/json',
          ...(options.headers ?? {}),
        },
        body: JSON.stringify({ state: options.state, questions }),
        signal: options.abortSignal,
      });

      const text = await res.text();
      let body: CfResponse;
      try {
        body = JSON.parse(text) as CfResponse;
      } catch {
        throw new Error(`Cloudflare returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
      }

      if (!res.ok || body.success === false) {
        const detail =
          body.errors?.map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ') ||
          text.slice(0, 300);
        // Surface the shapes the retry logic keys off, in its own vocabulary.
        const prefix =
          res.status === 429
            ? 'rate limit: '
            : res.status === 401 || res.status === 403
              ? 'authentication: '
              : '';
        throw new Error(`${prefix}Cloudflare Workers AI ${res.status}: ${detail}`);
      }

      const payload = body.result ?? body;
      const raw = payload.answers ?? {};
      const answers: Result['answers'] = {};
      for (const [id, q] of Object.entries(options.questions)) {
        const mapped = fromCloudflareAnswer(id, q, raw[id]);
        if (mapped) answers[id] = mapped;
      }

      return {
        answers,
        usage: {
          inputTokens: payload.usage?.input_tokens ?? 0,
          outputTokens: payload.usage?.output_tokens ?? 0,
        },
        warnings: [],
      };
    },
  };
}

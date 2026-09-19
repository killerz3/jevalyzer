import { createGateway } from '@ai-sdk/gateway';
import { createTypeSafeAi } from '@ai-sdk/typesafe-ai';
import type { Experimental_EvaluationModel } from 'ai';
import { readConfig } from './config.ts';

/**
 * Two ways to reach Jev, because the Vercel route has an account prerequisite
 * that direct TypeSafe access does not:
 *
 *  - gateway  : Vercel AI Gateway, model `typesafe-ai/jev`. Needs a
 *               vck_ key AND a card on file, even while Jev is free.
 *  - typesafe : api.typesafe.ai directly, model `jev-latest`. Needs only a
 *               TypeSafe key.
 *
 * Whichever one the user has credentials for is used; if both, the gateway
 * wins unless --backend says otherwise.
 */

export type Backend = 'gateway' | 'typesafe';

export interface Resolved {
  backend: Backend;
  model: Experimental_EvaluationModel;
  modelId: string;
  keySource: string;
}

export const DEFAULT_MODEL: Record<Backend, string> = {
  gateway: 'typesafe-ai/jev',
  typesafe: 'jev-latest',
};

export interface ResolveArgs {
  backend?: Backend;
  apiKey?: string;
  model?: string;
}

export async function resolveProvider(args: ResolveArgs): Promise<Resolved> {
  const cfg = await readConfig();

  const gatewayKey = args.backend === 'typesafe' ? undefined : args.apiKey ?? process.env.AI_GATEWAY_API_KEY ?? cfg.apiKey;
  const typesafeKey =
    args.backend === 'gateway'
      ? undefined
      : (args.backend === 'typesafe' ? args.apiKey : undefined) ??
        process.env.TYPESAFE_AI_API_KEY ??
        process.env.TYPESAFE_API_KEY ??
        cfg.typesafeApiKey;

  const chosen: Backend | null =
    args.backend ?? (gatewayKey ? 'gateway' : typesafeKey ? 'typesafe' : null);

  if (chosen === 'typesafe') {
    if (!typesafeKey) throw new Error('No TypeSafe API key. Set TYPESAFE_AI_API_KEY or run: jevalyzer auth --typesafe');
    const modelId = args.model ?? DEFAULT_MODEL.typesafe;
    return {
      backend: 'typesafe',
      model: createTypeSafeAi({ apiKey: typesafeKey }).evaluationModel(modelId),
      modelId,
      keySource: process.env.TYPESAFE_AI_API_KEY || process.env.TYPESAFE_API_KEY ? 'env' : 'config',
    };
  }

  if (chosen === 'gateway') {
    if (!gatewayKey) throw new Error('No AI Gateway key. Set AI_GATEWAY_API_KEY or run: jevalyzer auth');
    const modelId = args.model ?? DEFAULT_MODEL.gateway;
    return {
      backend: 'gateway',
      model: createGateway({ apiKey: gatewayKey }).evaluationModel(modelId),
      modelId,
      keySource: args.apiKey ? 'flag' : process.env.AI_GATEWAY_API_KEY ? 'env' : 'config',
    };
  }

  throw new Error('no-key');
}

/**
 * Vercel gates every Gateway request on a card, even for free models. Match the
 * card requirement specifically - plenty of unrelated errors mention "billing"
 * only because they link to the billing settings page.
 */
export function isBillingBlock(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /valid credit card|credit card on file|add a card|payment method/i.test(msg);
}

/** Zero data retention is a paid-plan feature; hobby keys are refused outright. */
export function isZdrUnavailable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /zero data retention|\bZDR\b/i.test(msg);
}

export const BILLING_HELP = `
Vercel AI Gateway requires a credit card on file before it will serve any
request - including free ones. Two ways forward:

  1. Add a card:  https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dadd-credit-card
     Jev stays free until 2026-09-25, and your free credits unlock.

  2. Skip Vercel entirely - get a key from https://console.typesafe.ai/keys then:
       export TYPESAFE_AI_API_KEY=sk-...
       jevalyzer analyze --backend typesafe
`;

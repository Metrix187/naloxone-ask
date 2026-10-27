// Runtime configuration and the Standard-tier guard.
//
// Meta Model API switches between Standard mode (content NOT used for training)
// and Contributor mode (content MAY be used to train Meta models) purely by
// model ID: `muse-spark-1.3` vs `muse-spark-1.3-contributor`.
// Source: https://dev.meta.ai/docs/models, https://dev.meta.ai/docs/pricing-rate-limits
//
// This project must only ever run in Standard mode. The guard below is applied
// at startup AND immediately before every outbound request.

export const API_BASE = 'https://api.meta.ai/v1';

// The only model IDs this app may call. Both are Standard mode.
export const ALLOWED_MODELS = new Set(['muse-spark-1.3']);

// Standard-mode prices, USD per 1M tokens (verified 2026-10-27 on
// https://dev.meta.ai/docs/pricing-rate-limits).
export const PRICES = {
  'muse-spark-1.3': { input: 1.25, cachedInput: 0.15, output: 4.25 },
};

export class TierViolation extends Error {
  name = 'TierViolation';
}

export function assertStandardModel(model) {
  if (typeof model !== 'string' || /contributor/i.test(model) || !ALLOWED_MODELS.has(model)) {
    throw new TierViolation(
      `Refusing model "${model}". This app only runs on Standard-mode models: ${[...ALLOWED_MODELS].join(', ')}`,
    );
  }
  return model;
}

export function loadConfig(env = process.env) {
  const model = assertStandardModel(env.MUSE_MODEL || 'muse-spark-1.3');
  return {
    apiKey: env.MODEL_API_KEY || '',
    model,
    reasoningEffort: env.MUSE_REASONING_EFFORT || 'low',
    maxOutputTokens: Number(env.MUSE_MAX_TOKENS || 2500),
    timeoutMs: Number(env.MUSE_TIMEOUT_MS || 25000),
    // Soft cap enforced per server process. The authoritative limit is the
    // Model API dashboard balance; see README "Cost accounting".
    spendCapUsd: Number(env.SPEND_CAP_USD || 10),
    // Set FORCE_OFFLINE=1 to demo the fallback path without calling the API.
    forceOffline: env.FORCE_OFFLINE === '1',
  };
}

export function costUsd(model, usage) {
  const p = PRICES[model];
  if (!p || !usage) return 0;
  const prompt = usage.prompt_tokens || 0;
  const cached = usage.prompt_tokens_details?.cached_tokens || 0;
  const completion = usage.completion_tokens || 0;
  return ((prompt - cached) * p.input + cached * p.cachedInput + completion * p.output) / 1e6;
}

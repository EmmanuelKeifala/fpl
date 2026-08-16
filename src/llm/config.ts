import { join } from 'node:path';

export interface LlmDecisionConfig {
  enabled: boolean;
  requiredForLive: boolean;
  apiKeyConfigured: boolean;
  model: string | null;
  cacheDirectory: string | null;
  timeoutMs: number | null;
  minimumConfidence: number;
}

export function getLlmDecisionConfig(env: NodeJS.ProcessEnv = process.env): LlmDecisionConfig {
  const enabled = booleanValue(env, 'FPL_LLM_ENABLED', false);
  const requiredForLive = booleanValue(env, 'FPL_LLM_REQUIRED_FOR_LIVE', true);
  const apiKeyConfigured = Boolean(env.OPENAI_API_KEY?.trim());
  if (!enabled) return {
    enabled: false,
    requiredForLive,
    apiKeyConfigured,
    model: null,
    cacheDirectory: null,
    timeoutMs: null,
    minimumConfidence: numberValue(env, 'FPL_LLM_MIN_CONFIDENCE', 0.5, 1, 0.75),
  };
  return {
    enabled: true,
    requiredForLive,
    apiKeyConfigured,
    model: env.FPL_LLM_MODEL?.trim() || 'gpt-5.4-nano',
    cacheDirectory: env.FPL_LLM_CACHE_DIR?.trim() || join(process.cwd(), 'data/llm-cache'),
    timeoutMs: integerValue(env, 'FPL_LLM_TIMEOUT_SECONDS', 5, 60, 30) * 1000,
    minimumConfidence: numberValue(env, 'FPL_LLM_MIN_CONFIDENCE', 0.5, 1, 0.75),
  };
}

function booleanValue(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = (env[name] ?? String(fallback)).trim().toLowerCase();
  if (raw !== 'true' && raw !== 'false') throw new Error(`${name} must be true or false`);
  return raw === 'true';
}

function integerValue(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  const raw = (env[name] ?? String(fallback)).trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function numberValue(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  const raw = (env[name] ?? String(fallback)).trim();
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

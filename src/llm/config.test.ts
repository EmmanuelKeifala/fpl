import { strict as assert } from 'node:assert';
import test from 'node:test';
import { getLlmDecisionConfig } from './config.js';

test('LLM decision review is disabled by default but required before future live promotion', () => {
  const config = getLlmDecisionConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.requiredForLive, true);
  assert.equal(config.apiKeyConfigured, false);
  assert.equal(config.model, null);
});

test('LLM decision review parses bounded production configuration', () => {
  const config = getLlmDecisionConfig({
    FPL_LLM_ENABLED: 'true',
    FPL_LLM_REQUIRED_FOR_LIVE: 'true',
    OPENAI_API_KEY: 'test-key',
    FPL_LLM_MODEL: 'test-model',
    FPL_LLM_CACHE_DIR: '/data/llm',
    FPL_LLM_TIMEOUT_SECONDS: '20',
    FPL_LLM_MIN_CONFIDENCE: '0.8',
  });
  assert.deepEqual(config, {
    enabled: true,
    requiredForLive: true,
    apiKeyConfigured: true,
    model: 'test-model',
    cacheDirectory: '/data/llm',
    timeoutMs: 20_000,
    minimumConfidence: 0.8,
  });
});

test('LLM decision review rejects ambiguous or unsafe bounds', () => {
  assert.throws(() => getLlmDecisionConfig({ FPL_LLM_ENABLED: 'yes' }), /true or false/);
  assert.throws(() => getLlmDecisionConfig({
    FPL_LLM_ENABLED: 'true',
    FPL_LLM_TIMEOUT_SECONDS: '61',
  }), /between 5 and 60/);
  assert.throws(() => getLlmDecisionConfig({ FPL_LLM_MIN_CONFIDENCE: '0.2' }), /between 0.5 and 1/);
});

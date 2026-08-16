import { strict as assert } from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  llmReviewAllowsMutation,
  reviewDecisionWithLlm,
  type LlmDecisionProposal,
  type LlmReviewProvider,
} from './decision-reviewer.js';
import { getLlmDecisionConfig } from './config.js';

function proposal(): LlmDecisionProposal {
  return {
    season: '2026-2027',
    gameweek: 1,
    deadline: '2026-08-21T17:30:00Z',
    kind: 'transfer',
    phase: 'execute',
    deterministicOptionId: 'transfer-plan',
    options: [{
      id: 'transfer-plan',
      label: 'Player A to Player B',
      expectedPoints: 42,
      expectedGain: 3.5,
      confidence: 0.82,
      hitCost: 0,
      details: { transfers: ['Player A -> Player B'] },
    }],
    teamAlerts: [],
    trustedNews: [],
    safetyConstraints: { maximumHitCost: 0 },
  };
}

async function environment(): Promise<NodeJS.ProcessEnv> {
  return {
    FPL_LLM_ENABLED: 'true',
    FPL_LLM_REQUIRED_FOR_LIVE: 'true',
    OPENAI_API_KEY: 'test-key',
    FPL_LLM_MODEL: 'test-model',
    FPL_LLM_CACHE_DIR: await mkdtemp(join(tmpdir(), 'fpl-llm-review-')),
    FPL_LLM_MIN_CONFIDENCE: '0.75',
  };
}

test('LLM reviewer accepts only a sufficiently confident supplied deterministic option and caches it', async () => {
  const env = await environment();
  let calls = 0;
  const provider: LlmReviewProvider = async () => {
    calls++;
    return {
      verdict: 'approve',
      selectedOptionId: 'transfer-plan',
      confidence: 0.81,
      riskLevel: 'low',
      reasoning: 'Positive expected gain with no hit.',
      concerns: ['none'],
    };
  };
  const first = await reviewDecisionWithLlm(proposal(), env, provider);
  const cached = await reviewDecisionWithLlm(proposal(), env, async () => assert.fail('cached result should be reused'));
  assert.equal(first.status, 'completed');
  assert.equal(first.approved, true);
  assert.equal(first.cached, false);
  assert.equal(cached.cached, true);
  assert.equal(calls, 1);
  assert.equal(llmReviewAllowsMutation(first, getLlmDecisionConfig(env)), true);
});

test('LLM reviewer fails closed on unknown choices, holds, and missing credentials', async () => {
  const env = await environment();
  const unknown = await reviewDecisionWithLlm(proposal(), env, async () => ({
    verdict: 'approve',
    selectedOptionId: 'invented-transfer',
    confidence: 0.99,
    riskLevel: 'low',
    reasoning: 'Invented option.',
    concerns: ['none'],
  }));
  assert.equal(unknown.status, 'failed');
  assert.equal(llmReviewAllowsMutation(unknown, getLlmDecisionConfig(env)), false);

  const holdEnv = await environment();
  const hold = await reviewDecisionWithLlm(proposal(), holdEnv, async () => ({
    verdict: 'hold',
    selectedOptionId: null,
    confidence: 0.9,
    riskLevel: 'high',
    reasoning: 'Minutes risk is unresolved.',
    concerns: ['minutes-risk'],
  }));
  assert.equal(hold.status, 'completed');
  assert.equal(hold.approved, false);

  const unavailable = await reviewDecisionWithLlm(proposal(), {
    ...await environment(),
    OPENAI_API_KEY: '',
  });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.approved, false);
});

test('optional LLM outages do not silently become approvals but can defer to deterministic safety', async () => {
  const env = {
    ...await environment(),
    FPL_LLM_REQUIRED_FOR_LIVE: 'false',
  };
  const failed = await reviewDecisionWithLlm(proposal(), env, async () => {
    throw new Error('provider unavailable');
  });
  assert.equal(failed.approved, false);
  assert.equal(llmReviewAllowsMutation(failed, getLlmDecisionConfig(env)), true);
});

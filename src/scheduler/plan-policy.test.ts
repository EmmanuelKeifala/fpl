import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { MyTeam, Player } from '../api/types.js';
import type { LlmDecisionReview } from '../llm/decision-reviewer.js';
import type { OptimizedTransferPlan } from './decisions.js';
import { buildProjectedPlanningTeam, getGameweekPlanDisposition } from './plan-policy.js';

function team(): MyTeam {
  return {
    picks: [
      { element: 10, position: 1, multiplier: 2, is_captain: true, is_vice_captain: false, selling_price: 45 },
      { element: 20, position: 2, multiplier: 1, is_captain: false, is_vice_captain: true, selling_price: 50 },
    ],
    chips: [],
    transfers: { cost: 0, status: 'available', limit: 2, made: 0, bank: 5, value: 1000 },
  };
}

function transferPlan(): OptimizedTransferPlan {
  return {
    transfers: [{
      playerOut: { id: 10, now_cost: 45 } as Player,
      playerIn: { id: 30, now_cost: 40 } as Player,
      xpGain: 1,
      hitCost: 0,
      netGain: 1,
      confidence: 0.8,
      reasoning: 'Upgrade the projected lineup',
      priceRisk: 'stable',
      sellingPrice: 45,
    }],
    expectedGain: 1,
    hitCost: 0,
    netGain: 1,
    templateProtectionGain: 0.3,
    rankUtilityGain: 0.2,
    objectiveGain: 1.2,
    confidence: 0.8,
    horizon: 6,
    mode: 'incremental',
    targetPlayerIds: [20, 30],
  };
}

function review(verdict: 'approve' | 'hold'): LlmDecisionReview {
  return {
    status: 'completed',
    approved: verdict === 'approve',
    cached: false,
    model: 'test-model',
    output: {
      verdict,
      selectedOptionId: verdict === 'approve' ? 'gameweek-plan' : null,
      confidence: 0.9,
      riskLevel: verdict === 'approve' ? 'low' : 'high',
      reasoning: verdict === 'approve' ? 'Plan is sound.' : 'Minutes risk remains unresolved.',
      concerns: verdict === 'approve' ? ['none'] : ['minutes-risk'],
    },
    error: null,
  };
}

test('planning lineup is built from the transfer-projected squad without mutating the authenticated team', () => {
  const current = team();
  const projected = buildProjectedPlanningTeam(current, transferPlan());

  assert.deepEqual(current.picks.map(pick => pick.element), [10, 20]);
  assert.deepEqual(projected.picks.map(pick => pick.element), [30, 20]);
  assert.equal(projected.picks[0]!.is_captain, false);
  assert.equal(projected.picks[0]!.multiplier, 1);
  assert.equal(projected.transfers.bank, 10);
  assert.equal(projected.transfers.made, 1);
});

test('an explicit LLM hold is published only as blocked, including in shadow mode', () => {
  assert.deepEqual(getGameweekPlanDisposition(review('hold'), 'shadow'), {
    held: true,
    kapsoStatus: 'blocked',
    notificationTitle: 'GW Plan Held',
  });
  assert.deepEqual(getGameweekPlanDisposition(review('approve'), 'live'), {
    held: false,
    kapsoStatus: 'planned',
    notificationTitle: 'GW Planning Complete',
  });

  assert.equal(getGameweekPlanDisposition({
    status: 'failed',
    approved: false,
    cached: false,
    model: 'test-model',
    output: null,
    error: 'invalid hold payload',
  }, 'shadow').held, true);
  assert.equal(getGameweekPlanDisposition(review('approve'), 'shadow', true).held, true);
});

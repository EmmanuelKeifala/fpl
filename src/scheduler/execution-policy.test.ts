import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  decideDeadlineExecution,
  effectiveSellingPriceLossAfterFall,
  type DeadlineExecutionPolicyInput,
  type EarlyPriceTrigger,
} from './execution-policy.js';

const MINUTE = 60_000;
const DEADLINE = new Date('2026-08-22T10:00:00.000Z');

interface FakeClockInput {
  minutesBeforeDeadline?: number;
  finalizationWindowMinutes?: number;
  hardSafetyMarginMinutes?: number;
  planReady?: boolean;
  planStable?: boolean;
  priceTrigger?: EarlyPriceTrigger | null;
  minimumEarlyPriceConfidence?: number;
  minimumExpectedValueLossTenths?: number;
  feedStatus?: 'healthy' | 'uncertain';
  feedAgeMinutes?: number;
  hasConflictingNews?: boolean;
}

function atFakeClock(overrides: FakeClockInput = {}): DeadlineExecutionPolicyInput {
  const minutesBeforeDeadline = overrides.minutesBeforeDeadline ?? 60;
  const now = new Date(DEADLINE.getTime() - minutesBeforeDeadline * MINUTE);
  const feedAgeMinutes = overrides.feedAgeMinutes ?? 1;
  return {
    now,
    deadline: DEADLINE,
    finalizationWindowMs: (overrides.finalizationWindowMinutes ?? 10) * MINUTE,
    hardSafetyMarginMs: (overrides.hardSafetyMarginMinutes ?? 3) * MINUTE,
    planReady: overrides.planReady ?? true,
    planStable: overrides.planStable ?? true,
    priceTrigger: overrides.priceTrigger ?? null,
    minimumEarlyPriceConfidence: overrides.minimumEarlyPriceConfidence ?? 0.85,
    minimumExpectedValueLossTenths: overrides.minimumExpectedValueLossTenths ?? 1,
    intelligence: {
      feedStatus: overrides.feedStatus ?? 'healthy',
      lastSuccessfulCheckAt: new Date(now.getTime() - feedAgeMinutes * MINUTE),
      maximumAgeMs: 2 * MINUTE,
      hasConflictingNews: overrides.hasConflictingNews ?? false,
    },
  };
}

const highConfidenceAffordabilityTrigger: EarlyPriceTrigger = {
  confidence: 0.92,
  makesPlanUnaffordable: true,
  expectedValueLossTenths: 0,
};

test('planning phase waits for the finalization window without an economic trigger', () => {
  assert.deepEqual(decideDeadlineExecution(atFakeClock({ minutesBeforeDeadline: 60 })), {
    phase: 'planning',
    action: 'hold',
    reason: 'awaiting-finalization-window',
    millisecondsToDeadline: 60 * MINUTE,
  });
});

test('an early price move requires a ready, stable plan and high-confidence material impact', () => {
  assert.equal(decideDeadlineExecution(atFakeClock({
    priceTrigger: highConfidenceAffordabilityTrigger,
    planStable: false,
  })).reason, 'plan-not-stable');

  assert.equal(decideDeadlineExecution(atFakeClock({
    priceTrigger: { ...highConfidenceAffordabilityTrigger, confidence: 0.7 },
  })).reason, 'price-confidence-too-low');

  assert.equal(decideDeadlineExecution(atFakeClock({
    priceTrigger: {
      confidence: 0.92,
      makesPlanUnaffordable: false,
      expectedValueLossTenths: 0,
    },
  })).reason, 'price-impact-not-material');

  assert.deepEqual(decideDeadlineExecution(atFakeClock({
    priceTrigger: highConfidenceAffordabilityTrigger,
  })), {
    phase: 'early-price',
    action: 'commit',
    reason: 'early-price-trigger-qualified',
    millisecondsToDeadline: 60 * MINUTE,
  });
});

test('a high-confidence effective value loss can qualify even when affordability remains positive', () => {
  const result = decideDeadlineExecution(atFakeClock({
    priceTrigger: {
      confidence: 0.9,
      makesPlanUnaffordable: false,
      expectedValueLossTenths: 1,
    },
  }));

  assert.equal(result.phase, 'early-price');
  assert.equal(result.action, 'commit');
});

test('a ready plan may commit at the finalization boundary without early-plan stability', () => {
  assert.deepEqual(decideDeadlineExecution(atFakeClock({
    minutesBeforeDeadline: 10,
    planStable: false,
  })), {
    phase: 'finalization',
    action: 'commit',
    reason: 'finalization-window-open',
    millisecondsToDeadline: 10 * MINUTE,
  });
});

test('the hard margin is closed at its exact boundary, inside it, and after the deadline', () => {
  for (const minutesBeforeDeadline of [3, 2, 0, -1]) {
    const result = decideDeadlineExecution(atFakeClock({ minutesBeforeDeadline }));
    assert.equal(result.phase, 'closed');
    assert.equal(result.action, 'hold');
    assert.equal(result.reason, 'inside-hard-safety-margin');
  }
});

test('fresh conflicting news holds both early-price and finalization decisions', () => {
  const early = decideDeadlineExecution(atFakeClock({
    priceTrigger: highConfidenceAffordabilityTrigger,
    hasConflictingNews: true,
  }));
  const final = decideDeadlineExecution(atFakeClock({
    minutesBeforeDeadline: 8,
    hasConflictingNews: true,
  }));

  assert.equal(early.phase, 'early-price');
  assert.equal(early.action, 'hold');
  assert.equal(early.reason, 'fresh-conflicting-news');
  assert.equal(final.phase, 'finalization');
  assert.equal(final.action, 'hold');
  assert.equal(final.reason, 'fresh-conflicting-news');
});

test('an unhealthy, stale, or future-dated feed is uncertain and always holds', () => {
  for (const overrides of [
    { feedStatus: 'uncertain' as const },
    { feedAgeMinutes: 3 },
    { feedAgeMinutes: -1 },
  ]) {
    const result = decideDeadlineExecution(atFakeClock({
      minutesBeforeDeadline: 8,
      ...overrides,
    }));
    assert.equal(result.phase, 'finalization');
    assert.equal(result.action, 'hold');
    assert.equal(result.reason, 'intelligence-feed-uncertain');
  }
});

test('a plan that has not cleared upstream legality and review gates cannot commit', () => {
  const result = decideDeadlineExecution(atFakeClock({
    minutesBeforeDeadline: 8,
    planReady: false,
  }));

  assert.equal(result.phase, 'finalization');
  assert.equal(result.action, 'hold');
  assert.equal(result.reason, 'plan-not-ready');
});

test('invalid timing or threshold configuration fails closed', () => {
  const invalidWindow = atFakeClock({
    finalizationWindowMinutes: 3,
    hardSafetyMarginMinutes: 3,
  });
  const invalidConfidence = {
    ...atFakeClock(),
    minimumEarlyPriceConfidence: 1.1,
  };

  for (const input of [invalidWindow, invalidConfidence]) {
    const result = decideDeadlineExecution(input);
    assert.equal(result.phase, 'closed');
    assert.equal(result.action, 'hold');
    assert.equal(result.reason, 'invalid-policy-input');
  }
});

test('selling-price loss respects purchase price and half-profit thresholds', () => {
  assert.equal(effectiveSellingPriceLossAfterFall({
    purchasePrice: 100,
    currentPrice: 103,
    currentSellingPrice: 101,
    sellOnFeeRatio: 0.5,
  }), 0);
  assert.equal(effectiveSellingPriceLossAfterFall({
    purchasePrice: 100,
    currentPrice: 102,
    currentSellingPrice: 101,
    sellOnFeeRatio: 0.5,
  }), 1);
  assert.equal(effectiveSellingPriceLossAfterFall({
    purchasePrice: 100,
    currentPrice: 100,
    currentSellingPrice: 100,
    sellOnFeeRatio: 0.5,
  }), 1);
});

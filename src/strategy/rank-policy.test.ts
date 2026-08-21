import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  calculateOwnershipUtility,
  deriveRankPolicy,
  getRankRiskSettings,
  type OwnershipUtilityInput,
  type RankStrategyMode,
} from './rank-policy.js';

test('missing or invalid rank data fails to balanced mode', () => {
  for (const input of [
    { overallRank: null, targetRank: 100_000 },
    { overallRank: 250_000, targetRank: undefined },
    { overallRank: 0, targetRank: 100_000 },
    { overallRank: 250_000, targetRank: Number.NaN },
  ]) {
    const policy = deriveRankPolicy({
      gameweek: 20,
      previousMode: 'push',
      ...input,
    });
    assert.equal(policy.mode, 'balanced');
    assert.equal(policy.fallback, 'missing-rank-data');
    assert.deepEqual(policy.risk, getRankRiskSettings('balanced'));
  }
});

test('early-season rank is ignored even when the apparent gap is extreme', () => {
  const policy = deriveRankPolicy({
    gameweek: 5,
    overallRank: 5_000_000,
    targetRank: 10_000,
    previousOverallRank: 1_000_000,
    previousMode: 'push',
  });

  assert.equal(policy.mode, 'balanced');
  assert.equal(policy.fallback, 'early-season');
  assert.equal(policy.pushScore, 0);
  assert.equal(policy.rankTrend, null);
});

test('rank gap and season progress derive balanced, push, and protect modes', () => {
  assert.equal(deriveRankPolicy({
    gameweek: 20,
    overallRank: 120_000,
    targetRank: 100_000,
  }).mode, 'balanced');

  assert.equal(deriveRankPolicy({
    gameweek: 20,
    overallRank: 500_000,
    targetRank: 100_000,
  }).mode, 'push');

  assert.equal(deriveRankPolicy({
    gameweek: 20,
    overallRank: 25_000,
    targetRank: 100_000,
  }).mode, 'protect');
});

test('a worsening trend can move a borderline rank deficit into push mode', () => {
  const stable = deriveRankPolicy({
    gameweek: 25,
    overallRank: 200_000,
    targetRank: 100_000,
  });
  const worsening = deriveRankPolicy({
    gameweek: 25,
    overallRank: 200_000,
    targetRank: 100_000,
    previousOverallRank: 150_000,
  });
  const improving = deriveRankPolicy({
    gameweek: 25,
    overallRank: 200_000,
    targetRank: 100_000,
    previousOverallRank: 300_000,
  });

  assert.equal(stable.mode, 'balanced');
  assert.equal(worsening.mode, 'push');
  assert.ok(worsening.rankTrend !== null && worsening.rankTrend < 0);
  assert.ok(worsening.pushScore > stable.pushScore);
  assert.equal(improving.mode, 'balanced');
  assert.ok(improving.rankTrend !== null && improving.rankTrend > 0);
});

test('an improving trend can make a borderline rank advantage worth protecting', () => {
  const stable = deriveRankPolicy({
    gameweek: 20,
    overallRank: 50_000,
    targetRank: 100_000,
  });
  const improving = deriveRankPolicy({
    gameweek: 20,
    overallRank: 50_000,
    targetRank: 100_000,
    previousOverallRank: 75_000,
  });

  assert.equal(stable.mode, 'balanced');
  assert.equal(improving.mode, 'protect');
  assert.ok(improving.protectScore > stable.protectScore);
});

test('hysteresis retains a directional mode until its wider exit boundary is crossed', () => {
  const withoutHistory = deriveRankPolicy({
    gameweek: 25,
    overallRank: 170_000,
    targetRank: 100_000,
  });
  const retainedPush = deriveRankPolicy({
    gameweek: 25,
    overallRank: 170_000,
    targetRank: 100_000,
    previousMode: 'push',
  });
  const exitedPush = deriveRankPolicy({
    gameweek: 15,
    overallRank: 150_000,
    targetRank: 100_000,
    previousMode: 'push',
  });
  const retainedProtect = deriveRankPolicy({
    gameweek: 25,
    overallRank: 60_000,
    targetRank: 100_000,
    previousMode: 'protect',
  });

  assert.equal(withoutHistory.mode, 'balanced');
  assert.equal(retainedPush.mode, 'push');
  assert.equal(exitedPush.mode, 'balanced');
  assert.equal(retainedProtect.mode, 'protect');
});

test('risk settings increase upside permission while preserving quality floors', () => {
  const protect = getRankRiskSettings('protect');
  const balanced = getRankRiskSettings('balanced');
  const push = getRankRiskSettings('push');

  assert.ok(protect.riskBudget < balanced.riskBudget);
  assert.ok(balanced.riskBudget < push.riskBudget);
  assert.ok(protect.floorWeight > balanced.floorWeight);
  assert.ok(balanced.floorWeight > push.floorWeight);
  assert.ok(protect.upsideWeight < balanced.upsideWeight);
  assert.ok(balanced.upsideWeight < push.upsideWeight);
  assert.ok(protect.minimumQualityRatio > balanced.minimumQualityRatio);
  assert.ok(balanced.minimumQualityRatio > push.minimumQualityRatio);
  assert.equal(protect.differentialWeight, 0);
  assert.equal(push.highOwnershipHedgeWeight, 0);
});

function policy(mode: RankStrategyMode) {
  return { mode, risk: getRankRiskSettings(mode) };
}

function ownershipCandidate(
  overrides: Partial<OwnershipUtilityInput> = {}
): OwnershipUtilityInput {
  return {
    expectedPoints: 9.8,
    referenceExpectedPoints: 10,
    startProbability: 0.9,
    effectiveOwnershipPercent: 5,
    referenceEffectiveOwnershipPercent: 60,
    p10Points: 2,
    referenceP10Points: 2,
    p90Points: 15,
    referenceP90Points: 12,
    ...overrides,
  };
}

test('low ownership never rescues a candidate that fails quality or availability gates', () => {
  const poor = calculateOwnershipUtility(policy('push'), ownershipCandidate({
    expectedPoints: 5,
    referenceExpectedPoints: 10,
    effectiveOwnershipPercent: 1,
    p90Points: 25,
  }));
  const minutesRisk = calculateOwnershipUtility(policy('push'), ownershipCandidate({
    startProbability: 0.5,
    effectiveOwnershipPercent: 1,
    p90Points: 25,
  }));

  assert.equal(poor.utility, 0);
  assert.equal(poor.qualityEligible, false);
  assert.equal(poor.reason, 'quality-gate');
  assert.equal(minutesRisk.utility, 0);
  assert.equal(minutesRisk.qualityEligible, false);
  assert.equal(minutesRisk.reason, 'start-probability-gate');
});

test('a low-owned candidate needs real upper-tail edge before receiving utility', () => {
  const noUpside = calculateOwnershipUtility(policy('push'), ownershipCandidate({
    p90Points: 12,
  }));

  assert.equal(noUpside.direction, 'differential');
  assert.equal(noUpside.qualityEligible, true);
  assert.equal(noUpside.utility, 0);
  assert.equal(noUpside.reason, 'no-upside-edge');
});

test('calculated differential utility is strongest in push and disabled in protect', () => {
  const protect = calculateOwnershipUtility(policy('protect'), ownershipCandidate());
  const balanced = calculateOwnershipUtility(policy('balanced'), ownershipCandidate());
  const push = calculateOwnershipUtility(policy('push'), ownershipCandidate());

  assert.equal(protect.utility, 0);
  assert.equal(protect.reason, 'mode-disallows-ownership-value');
  assert.ok(balanced.utility > 0);
  assert.ok(push.utility > balanced.utility);
  assert.ok(push.utility <= getRankRiskSettings('push').differentialWeight);
});

test('high-owned quality coverage is useful in protect but not push mode', () => {
  const candidate = ownershipCandidate({
    expectedPoints: 10,
    effectiveOwnershipPercent: 80,
    referenceEffectiveOwnershipPercent: 30,
    p10Points: 3,
    referenceP10Points: 3,
    p90Points: 12,
    referenceP90Points: 12,
  });
  const protect = calculateOwnershipUtility(policy('protect'), candidate);
  const push = calculateOwnershipUtility(policy('push'), candidate);

  assert.equal(protect.direction, 'hedge');
  assert.equal(protect.reason, 'template-hedge');
  assert.ok(protect.utility > 0);
  assert.equal(push.utility, 0);
  assert.equal(push.reason, 'mode-disallows-ownership-value');
});

test('missing or out-of-range ownership is neutral and fail-closed', () => {
  for (const effectiveOwnershipPercent of [undefined, -1, 201]) {
    const result = calculateOwnershipUtility(policy('push'), ownershipCandidate({
      effectiveOwnershipPercent,
    }));
    assert.equal(result.utility, 0);
    assert.equal(result.direction, 'neutral');
    assert.equal(result.reason, 'invalid-input');
  }
});

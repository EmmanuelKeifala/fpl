export type RankStrategyMode = 'protect' | 'balanced' | 'push';

export type RankPolicyFallback = 'none' | 'early-season' | 'missing-rank-data';

export interface RankPolicyInput {
  /** The gameweek being planned, normally 1-38. */
  gameweek: number;
  /** A lower number is a better rank. */
  overallRank: number | null | undefined;
  /** The rank the manager is trying to reach or retain. */
  targetRank: number | null | undefined;
  /** The most recent comparable rank, used only as a bounded trend signal. */
  previousOverallRank?: number | null;
  /** The previously selected mode, used to avoid boundary oscillation. */
  previousMode?: RankStrategyMode | null;
  /** Defaults to the standard 38-gameweek season. */
  totalGameweeks?: number;
}

export interface RankRiskSettings {
  /** General permission to accept variance, from 0 (low) to 1 (high). */
  riskBudget: number;
  /** Minimum expected-points ratio versus the best comparable option. */
  minimumQualityRatio: number;
  /** Minimum modeled probability of starting for ownership utility. */
  minimumStartProbability: number;
  /** Relative importance of lower-tail outcomes in downstream optimization. */
  floorWeight: number;
  /** Relative importance of upper-tail outcomes in downstream optimization. */
  upsideWeight: number;
  /** Tie-break weight for protecting against a more highly owned alternative. */
  highOwnershipHedgeWeight: number;
  /** Tie-break weight for a quality-qualified, genuinely higher-upside differential. */
  differentialWeight: number;
  /** Suggested limit for low-owned starters; downstream squad rules remain authoritative. */
  maxLowOwnershipStarters: number;
  /** A stricter availability gate for captain candidates. */
  captainMinimumStartProbability: number;
}

export interface RankPolicy {
  mode: RankStrategyMode;
  fallback: RankPolicyFallback;
  /** 0-1 evidence that rank recovery requires additional variance. */
  pushScore: number;
  /** 0-1 evidence that the manager has rank advantage worth protecting. */
  protectScore: number;
  /** Positive means improving, negative means worsening, null means unavailable. */
  rankTrend: number | null;
  gameweeksRemaining: number;
  risk: RankRiskSettings;
  reasons: string[];
}

export interface OwnershipUtilityInput {
  expectedPoints: number;
  referenceExpectedPoints: number;
  startProbability: number;
  /** Effective ownership may exceed 100 for heavily captained players. */
  effectiveOwnershipPercent: number | null | undefined;
  referenceEffectiveOwnershipPercent: number | null | undefined;
  p10Points: number;
  referenceP10Points: number;
  p90Points: number;
  referenceP90Points: number;
}

export type OwnershipUtilityDirection = 'differential' | 'hedge' | 'neutral';

export interface OwnershipUtilityResult {
  /** A bounded, unitless tie-break value. It must not be treated as expected points. */
  utility: number;
  direction: OwnershipUtilityDirection;
  qualityEligible: boolean;
  qualityRatio: number;
  reason:
    | 'differential-upside'
    | 'template-hedge'
    | 'equal-ownership'
    | 'invalid-input'
    | 'quality-gate'
    | 'start-probability-gate'
    | 'no-upside-edge'
    | 'mode-disallows-ownership-value';
}

const EARLY_SEASON_BALANCED_THROUGH_GAMEWEEK = 5;
const DEFAULT_TOTAL_GAMEWEEKS = 38;
const PUSH_ENTER_THRESHOLD = 0.45;
const PUSH_EXIT_THRESHOLD = 0.30;
const PROTECT_ENTER_THRESHOLD = 0.40;
const PROTECT_EXIT_THRESHOLD = 0.27;

const RISK_BY_MODE: Readonly<Record<RankStrategyMode, Readonly<RankRiskSettings>>> = {
  protect: {
    riskBudget: 0.2,
    minimumQualityRatio: 0.98,
    minimumStartProbability: 0.85,
    floorWeight: 0.55,
    upsideWeight: 0.1,
    highOwnershipHedgeWeight: 0.35,
    differentialWeight: 0,
    maxLowOwnershipStarters: 2,
    captainMinimumStartProbability: 0.9,
  },
  balanced: {
    riskBudget: 0.5,
    minimumQualityRatio: 0.95,
    minimumStartProbability: 0.78,
    floorWeight: 0.35,
    upsideWeight: 0.3,
    highOwnershipHedgeWeight: 0.12,
    differentialWeight: 0.12,
    maxLowOwnershipStarters: 4,
    captainMinimumStartProbability: 0.85,
  },
  push: {
    riskBudget: 0.8,
    minimumQualityRatio: 0.9,
    minimumStartProbability: 0.72,
    floorWeight: 0.18,
    upsideWeight: 0.55,
    highOwnershipHedgeWeight: 0,
    differentialWeight: 0.45,
    maxLowOwnershipStarters: 6,
    captainMinimumStartProbability: 0.8,
  },
};

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isFiniteInRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

export function getRankRiskSettings(mode: RankStrategyMode): RankRiskSettings {
  return { ...RISK_BY_MODE[mode] };
}

function balancedFallback(
  fallback: Exclude<RankPolicyFallback, 'none'>,
  gameweeksRemaining: number,
  reason: string
): RankPolicy {
  return {
    mode: 'balanced',
    fallback,
    pushScore: 0,
    protectScore: 0,
    rankTrend: null,
    gameweeksRemaining,
    risk: getRankRiskSettings('balanced'),
    reasons: [reason],
  };
}

/**
 * Derives a cautious strategy mode from rank state. The policy intentionally
 * ignores rank in the opening gameweeks and fails to balanced when rank data is
 * absent or invalid. Scores are logarithmic so a single noisy rank move cannot
 * dominate the decision.
 */
export function deriveRankPolicy(input: RankPolicyInput): RankPolicy {
  const totalGameweeks = Number.isInteger(input.totalGameweeks) && input.totalGameweeks! > 0
    ? input.totalGameweeks!
    : DEFAULT_TOTAL_GAMEWEEKS;
  const safeGameweek = Number.isFinite(input.gameweek)
    ? Math.round(clamp(input.gameweek, 1, totalGameweeks))
    : 1;
  const gameweeksRemaining = Math.max(0, totalGameweeks - safeGameweek);

  if (safeGameweek <= EARLY_SEASON_BALANCED_THROUGH_GAMEWEEK) {
    return balancedFallback(
      'early-season',
      gameweeksRemaining,
      `GW${safeGameweek} rank is intentionally ignored because early-season rank is too noisy`
    );
  }

  if (!isPositiveFinite(input.overallRank) || !isPositiveFinite(input.targetRank)) {
    return balancedFallback(
      'missing-rank-data',
      gameweeksRemaining,
      'Current rank and target rank must both be positive finite values'
    );
  }

  const rankRatio = input.overallRank / input.targetRank;
  const seasonProgress = clamp(
    (safeGameweek - EARLY_SEASON_BALANCED_THROUGH_GAMEWEEK)
      / Math.max(1, totalGameweeks - EARLY_SEASON_BALANCED_THROUGH_GAMEWEEK)
  );
  const seasonWeight = 0.6 + (0.4 * seasonProgress);
  const behindSeverity = clamp(Math.log2(Math.max(1, rankRatio)) / 2);
  const aheadSeverity = clamp(Math.log2(Math.max(1, 1 / rankRatio)) / 2);

  const rankTrend = isPositiveFinite(input.previousOverallRank)
    ? clamp(Math.log2(input.previousOverallRank / input.overallRank), -1, 1)
    : null;
  const worseningPressure = Math.max(0, -(rankTrend ?? 0)) * 0.18;
  const improvingProtection = Math.max(0, rankTrend ?? 0) * 0.10;
  const pushScore = clamp((behindSeverity * seasonWeight) + worseningPressure);
  const protectScore = clamp((aheadSeverity * seasonWeight) + improvingProtection);

  let mode: RankStrategyMode = 'balanced';
  if (pushScore >= PUSH_ENTER_THRESHOLD && pushScore > protectScore) {
    mode = 'push';
  } else if (protectScore >= PROTECT_ENTER_THRESHOLD) {
    mode = 'protect';
  }

  // Retain an existing directional mode inside the wider exit boundary. This
  // prevents small rank updates from switching strategy every gameweek.
  if (mode === 'balanced' && input.previousMode === 'push' && pushScore >= PUSH_EXIT_THRESHOLD) {
    mode = 'push';
  } else if (
    mode === 'balanced'
    && input.previousMode === 'protect'
    && protectScore >= PROTECT_EXIT_THRESHOLD
  ) {
    mode = 'protect';
  }

  const reasons = [
    `Current rank is ${rankRatio.toFixed(2)}x the target rank`,
    `Push evidence ${pushScore.toFixed(2)}; protect evidence ${protectScore.toFixed(2)}`,
  ];
  if (rankTrend !== null) {
    reasons.push(rankTrend > 0.05
      ? 'Recent rank trend is improving'
      : rankTrend < -0.05
        ? 'Recent rank trend is worsening'
        : 'Recent rank trend is broadly stable');
  } else {
    reasons.push('No comparable previous rank was supplied');
  }
  if (mode !== 'balanced' && mode === input.previousMode) {
    reasons.push(`Previous ${mode} mode was retained within its hysteresis boundary`);
  }

  return {
    mode,
    fallback: 'none',
    pushScore,
    protectScore,
    rankTrend,
    gameweeksRemaining,
    risk: getRankRiskSettings(mode),
    reasons,
  };
}

/**
 * Produces a small ownership tie-break utility after quality and availability
 * gates. A differential also needs a better upper-tail outcome; low ownership
 * by itself always returns zero.
 */
export function calculateOwnershipUtility(
  policy: Pick<RankPolicy, 'mode' | 'risk'>,
  input: OwnershipUtilityInput
): OwnershipUtilityResult {
  const values = [
    input.expectedPoints,
    input.referenceExpectedPoints,
    input.startProbability,
    input.p10Points,
    input.referenceP10Points,
    input.p90Points,
    input.referenceP90Points,
  ];
  const effectiveOwnershipPercent = input.effectiveOwnershipPercent;
  const referenceEffectiveOwnershipPercent = input.referenceEffectiveOwnershipPercent;
  if (
    values.some(value => !Number.isFinite(value))
    || input.expectedPoints < 0
    || input.referenceExpectedPoints <= 0
    || !isFiniteInRange(input.startProbability, 0, 1)
    || typeof effectiveOwnershipPercent !== 'number'
    || typeof referenceEffectiveOwnershipPercent !== 'number'
    || !isFiniteInRange(effectiveOwnershipPercent, 0, 200)
    || !isFiniteInRange(referenceEffectiveOwnershipPercent, 0, 200)
  ) {
    return {
      utility: 0,
      direction: 'neutral',
      qualityEligible: false,
      qualityRatio: 0,
      reason: 'invalid-input',
    };
  }

  const qualityRatio = input.expectedPoints / input.referenceExpectedPoints;
  if (qualityRatio < policy.risk.minimumQualityRatio) {
    return {
      utility: 0,
      direction: 'neutral',
      qualityEligible: false,
      qualityRatio,
      reason: 'quality-gate',
    };
  }
  if (input.startProbability < policy.risk.minimumStartProbability) {
    return {
      utility: 0,
      direction: 'neutral',
      qualityEligible: false,
      qualityRatio,
      reason: 'start-probability-gate',
    };
  }

  const ownershipDifference = referenceEffectiveOwnershipPercent - effectiveOwnershipPercent;
  if (Math.abs(ownershipDifference) < Number.EPSILON) {
    return {
      utility: 0,
      direction: 'neutral',
      qualityEligible: true,
      qualityRatio,
      reason: 'equal-ownership',
    };
  }

  const qualityRange = Math.max(Number.EPSILON, 1 - policy.risk.minimumQualityRatio);
  const qualityStrength = clamp(
    (qualityRatio - policy.risk.minimumQualityRatio) / qualityRange
  );

  if (ownershipDifference > 0) {
    const upsideEdge = input.p90Points - input.referenceP90Points;
    if (upsideEdge <= 0 || qualityStrength <= 0) {
      return {
        utility: 0,
        direction: 'differential',
        qualityEligible: true,
        qualityRatio,
        reason: 'no-upside-edge',
      };
    }
    if (policy.risk.differentialWeight <= 0) {
      return {
        utility: 0,
        direction: 'differential',
        qualityEligible: true,
        qualityRatio,
        reason: 'mode-disallows-ownership-value',
      };
    }

    const leverageStrength = clamp(ownershipDifference / 100);
    const upsideStrength = clamp(upsideEdge / Math.max(1, input.referenceP90Points));
    return {
      utility: leverageStrength * qualityStrength * upsideStrength
        * policy.risk.differentialWeight,
      direction: 'differential',
      qualityEligible: true,
      qualityRatio,
      reason: 'differential-upside',
    };
  }

  if (policy.risk.highOwnershipHedgeWeight <= 0 || qualityStrength <= 0) {
    return {
      utility: 0,
      direction: 'hedge',
      qualityEligible: true,
      qualityRatio,
      reason: 'mode-disallows-ownership-value',
    };
  }

  const hedgeStrength = clamp(-ownershipDifference / 100);
  const referenceFloor = Math.max(1, input.referenceP10Points);
  const floorStrength = clamp(input.p10Points / referenceFloor);
  return {
    utility: hedgeStrength * qualityStrength * floorStrength
      * policy.risk.highOwnershipHedgeWeight,
    direction: 'hedge',
    qualityEligible: true,
    qualityRatio,
    reason: 'template-hedge',
  };
}

export type DeadlineExecutionPhase = 'planning' | 'early-price' | 'finalization' | 'closed';
export type DeadlineExecutionAction = 'commit' | 'hold';

export type DeadlineExecutionReason =
  | 'invalid-policy-input'
  | 'inside-hard-safety-margin'
  | 'intelligence-feed-uncertain'
  | 'fresh-conflicting-news'
  | 'plan-not-ready'
  | 'plan-not-stable'
  | 'price-confidence-too-low'
  | 'price-impact-not-material'
  | 'awaiting-finalization-window'
  | 'early-price-trigger-qualified'
  | 'finalization-window-open';

export interface EarlyPriceTrigger {
  /** Confidence that the relevant incoming rise or outgoing fall will occur. */
  confidence: number;
  /** True when the expected move would make the currently selected plan unaffordable. */
  makesPlanUnaffordable: boolean;
  /** Effective loss in FPL's integer 0.1m price units after sell-on mechanics. */
  expectedValueLossTenths: number;
}

export interface DeadlineIntelligenceState {
  feedStatus: 'healthy' | 'uncertain';
  lastSuccessfulCheckAt: Date | null;
  maximumAgeMs: number;
  /** Conflicting current reports have not yet been resolved by the intelligence layer. */
  hasConflictingNews: boolean;
}

export interface DeadlineExecutionPolicyInput {
  now: Date;
  deadline: Date;
  /** Window before the deadline in which a ready plan may be finalized. */
  finalizationWindowMs: number;
  /** No action is ever allowed at or inside this deadline margin. */
  hardSafetyMarginMs: number;
  planReady: boolean;
  /** Stability is required for an early economic move, but not for final re-optimization. */
  planStable: boolean;
  priceTrigger: EarlyPriceTrigger | null;
  minimumEarlyPriceConfidence: number;
  minimumExpectedValueLossTenths: number;
  intelligence: DeadlineIntelligenceState;
}

export interface DeadlineExecutionDecision {
  phase: DeadlineExecutionPhase;
  action: DeadlineExecutionAction;
  reason: DeadlineExecutionReason;
  millisecondsToDeadline: number;
}

export function effectiveSellingPriceLossAfterFall(input: {
  purchasePrice: number | null | undefined;
  currentPrice: number;
  currentSellingPrice: number;
  sellOnFeeRatio: number;
}): number {
  if (![input.currentPrice, input.currentSellingPrice, input.sellOnFeeRatio].every(Number.isFinite)
    || input.currentPrice <= 0
    || input.currentSellingPrice <= 0
    || input.sellOnFeeRatio < 0
    || input.sellOnFeeRatio > 1) {
    return 0;
  }
  const priceAfterFall = Math.max(0, input.currentPrice - 1);
  const purchasePrice = Number(input.purchasePrice);
  if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) {
    return input.currentSellingPrice === input.currentPrice ? 1 : 0;
  }
  const sellingPriceAfterFall = priceAfterFall <= purchasePrice
    ? priceAfterFall
    : purchasePrice + Math.floor((priceAfterFall - purchasePrice) * input.sellOnFeeRatio);
  return Math.max(0, input.currentSellingPrice - sellingPriceAfterFall);
}

/**
 * Decide when an already legal/reviewed FPL plan may be committed. This policy
 * is deliberately pure: callers supply the clock, feed health, plan stability,
 * and the effective price impact after purchase/selling-price mechanics.
 */
export function decideDeadlineExecution(
  input: DeadlineExecutionPolicyInput
): DeadlineExecutionDecision {
  const nowMs = input.now.getTime();
  const deadlineMs = input.deadline.getTime();
  const millisecondsToDeadline = deadlineMs - nowMs;

  if (!validInput(input, nowMs, deadlineMs)) {
    return decision('closed', 'hold', 'invalid-policy-input', finiteOrZero(millisecondsToDeadline));
  }

  if (millisecondsToDeadline <= input.hardSafetyMarginMs) {
    return decision('closed', 'hold', 'inside-hard-safety-margin', millisecondsToDeadline);
  }

  const phase: DeadlineExecutionPhase = millisecondsToDeadline <= input.finalizationWindowMs
    ? 'finalization'
    : input.priceTrigger
      ? 'early-price'
      : 'planning';

  const intelligenceAgeMs = nowMs - input.intelligence.lastSuccessfulCheckAt!.getTime();
  if (input.intelligence.feedStatus !== 'healthy'
    || intelligenceAgeMs < 0
    || intelligenceAgeMs > input.intelligence.maximumAgeMs) {
    return decision(phase, 'hold', 'intelligence-feed-uncertain', millisecondsToDeadline);
  }
  if (input.intelligence.hasConflictingNews) {
    return decision(phase, 'hold', 'fresh-conflicting-news', millisecondsToDeadline);
  }
  if (!input.planReady) {
    return decision(phase, 'hold', 'plan-not-ready', millisecondsToDeadline);
  }

  if (phase === 'finalization') {
    return decision(phase, 'commit', 'finalization-window-open', millisecondsToDeadline);
  }

  if (phase === 'early-price') {
    if (!input.planStable) {
      return decision(phase, 'hold', 'plan-not-stable', millisecondsToDeadline);
    }
    if (input.priceTrigger!.confidence < input.minimumEarlyPriceConfidence) {
      return decision(phase, 'hold', 'price-confidence-too-low', millisecondsToDeadline);
    }
    const materialPriceImpact = input.priceTrigger!.makesPlanUnaffordable
      || input.priceTrigger!.expectedValueLossTenths >= input.minimumExpectedValueLossTenths;
    if (!materialPriceImpact) {
      return decision(phase, 'hold', 'price-impact-not-material', millisecondsToDeadline);
    }
    return decision(phase, 'commit', 'early-price-trigger-qualified', millisecondsToDeadline);
  }

  return decision(phase, 'hold', 'awaiting-finalization-window', millisecondsToDeadline);
}

function validInput(input: DeadlineExecutionPolicyInput, nowMs: number, deadlineMs: number): boolean {
  const trigger = input.priceTrigger;
  return Number.isFinite(nowMs)
    && Number.isFinite(deadlineMs)
    && nonNegative(input.hardSafetyMarginMs)
    && nonNegative(input.finalizationWindowMs)
    && input.finalizationWindowMs > input.hardSafetyMarginMs
    && probability(input.minimumEarlyPriceConfidence)
    && nonNegative(input.minimumExpectedValueLossTenths)
    && nonNegative(input.intelligence.maximumAgeMs)
    && input.intelligence.lastSuccessfulCheckAt !== null
    && Number.isFinite(input.intelligence.lastSuccessfulCheckAt.getTime())
    && (trigger === null || (
      probability(trigger.confidence)
      && nonNegative(trigger.expectedValueLossTenths)
    ));
}

function nonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function probability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function decision(
  phase: DeadlineExecutionPhase,
  action: DeadlineExecutionAction,
  reason: DeadlineExecutionReason,
  millisecondsToDeadline: number
): DeadlineExecutionDecision {
  return { phase, action, reason, millisecondsToDeadline };
}

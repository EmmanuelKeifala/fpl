import type { OptimalLineup, OptimizedTransferPlan, DecisionContext } from './decisions.js';
import type { ChipRecommendation } from '../engine/optimizer.js';
import {
  reviewDecisionWithLlm,
  type LlmDecisionProposal,
  type LlmDecisionReview,
  type LlmDecisionOption,
} from '../llm/decision-reviewer.js';
import { getSafetyLimits } from './limits.js';

export async function reviewGameweekPlanWithLlm(input: {
  context: DecisionContext;
  transferPlan: OptimizedTransferPlan;
  captain: { id: number; name: string; expectedPoints: number };
  chips: Array<{ chip: string; expectedGain: number; confidence: number }>;
}): Promise<LlmDecisionReview> {
  const transferNames = input.transferPlan.transfers.map(
    transfer => `${transfer.playerOut.web_name} -> ${transfer.playerIn.web_name}`
  );
  return reviewDecisionWithLlm(proposal(
    input.context,
    'gameweek-plan',
    'plan',
    {
      id: 'gameweek-plan',
      label: transferNames.length > 0 ? transferNames.join(', ') : 'Hold transfers',
      expectedPoints: input.captain.expectedPoints,
      expectedGain: input.transferPlan.netGain,
      confidence: input.transferPlan.confidence,
      hitCost: input.transferPlan.hitCost,
      details: {
        transfers: transferNames,
        planMode: input.transferPlan.mode,
        rankMode: input.context.rankPolicy.mode,
        templateProtectionGain: input.transferPlan.templateProtectionGain,
        rankUtilityGain: input.transferPlan.rankUtilityGain,
        objectiveGain: input.transferPlan.objectiveGain,
        captain: input.captain.name,
        captainId: input.captain.id,
        chips: input.chips.map(chip => `${chip.chip}:${chip.expectedGain.toFixed(1)}:${chip.confidence.toFixed(2)}`),
      },
    }
  ));
}

export async function reviewTransferPlanWithLlm(
  context: DecisionContext,
  transferPlan: OptimizedTransferPlan
): Promise<LlmDecisionReview> {
  const transferNames = transferPlan.transfers.map(
    transfer => `${transfer.playerOut.web_name} -> ${transfer.playerIn.web_name}`
  );
  return reviewDecisionWithLlm(proposal(
    context,
    'transfer',
    'execute',
    {
      id: 'transfer-plan',
      label: transferNames.join(', ') || 'Hold transfers',
      expectedPoints: transferPlan.expectedGain,
      expectedGain: transferPlan.netGain,
      confidence: transferPlan.confidence,
      hitCost: transferPlan.hitCost,
      details: {
        horizon: transferPlan.horizon,
        planMode: transferPlan.mode,
        rankMode: context.rankPolicy.mode,
        templateProtectionGain: transferPlan.templateProtectionGain,
        rankUtilityGain: transferPlan.rankUtilityGain,
        objectiveGain: transferPlan.objectiveGain,
        transfers: transferNames,
        priceRisks: transferPlan.transfers.map(transfer => transfer.priceRisk),
      },
    }
  ));
}

export async function reviewLineupWithLlm(input: {
  context: DecisionContext;
  lineup: OptimalLineup;
  currentExpectedPoints: number;
  chip: ChipRecommendation['chip'] | null;
  chipExpectedGain: number;
}): Promise<LlmDecisionReview> {
  const starters = input.lineup.startingXI.map(player => player.web_name);
  const bench = input.lineup.bench.map(player => player.web_name);
  return reviewDecisionWithLlm(proposal(
    input.context,
    input.chip ? 'chip' : 'lineup',
    'execute',
    {
      id: input.chip ? 'lineup-and-chip' : 'lineup',
      label: `${input.lineup.captain.web_name} captain${input.chip ? `, ${input.chip}` : ''}`,
      expectedPoints: input.lineup.expectedPoints,
      expectedGain: input.lineup.expectedPoints - input.currentExpectedPoints + input.chipExpectedGain,
      confidence: input.lineup.confidence,
      hitCost: 0,
      details: {
        starters,
        bench,
        captain: input.lineup.captain.web_name,
        viceCaptain: input.lineup.viceCaptain.web_name,
        chip: input.chip,
        chipExpectedGain: input.chipExpectedGain,
      },
    }
  ));
}

export function llmReviewSummary(review: LlmDecisionReview): string {
  if (review.status !== 'completed') return `${review.status}: ${review.error ?? 'no review'}`;
  return `${review.output!.verdict} (${Math.round(review.output!.confidence * 100)}%, ${review.output!.riskLevel} risk): ${review.output!.reasoning}`;
}

function proposal(
  context: DecisionContext,
  kind: LlmDecisionProposal['kind'],
  phase: LlmDecisionProposal['phase'],
  option: LlmDecisionOption
): LlmDecisionProposal {
  if (!context.deadline) throw new Error('Cannot request an LLM decision review without a deadline');
  const limits = getSafetyLimits();
  const unlimitedTransfers = context.myTeam?.transfers.status === 'unlimited';
  const trustedNews = context.newsSignals
    .filter(signal => signal.sourceTier <= 2 && (signal.timestampVerified || signal.sourceTier === 1))
    .slice(0, 20)
    .map(signal => [
      signal.playerName,
      signal.type,
      signal.source,
      `confidence=${signal.confidence.toFixed(2)}`,
      `minutesMultiplier=${signal.minutesMultiplier.toFixed(2)}`,
      signal.evidence,
    ].join(' | '));
  return {
    season: context.season,
    gameweek: context.gameweek,
    deadline: context.deadline.toISOString(),
    kind,
    phase,
    deterministicOptionId: option.id,
    options: [option],
    teamAlerts: context.teamHealth.alerts,
    trustedNews,
    safetyConstraints: {
      maximumTransfers: unlimitedTransfers ? limits.maxUnlimitedTransfers : limits.maxTransfersPerWeek,
      maximumHitCost: limits.maxTransferHitCost,
      minimumHitGain: option.hitCost > 0 ? limits.minXPGainForHit : 0,
      unlimitedTransfers,
      rankMode: context.rankPolicy.mode,
      rankRiskBudget: context.rankPolicy.risk.riskBudget,
      minimumQualityRatio: context.rankPolicy.risk.minimumQualityRatio,
      maximumLowOwnershipStarters: context.rankPolicy.risk.maxLowOwnershipStarters,
      minimumTemplateCorePlayers: unlimitedTransfers && context.rankPolicy.mode === 'protect'
        ? limits.minimumTemplateCorePlayers
        : 0,
      templateCoreOwnershipThreshold: limits.templateCoreOwnershipThreshold,
      templateAnchorOwnershipThreshold: limits.templateAnchorOwnershipThreshold,
      minimumTransferConfidence: limits.minTransferConfidence,
      minimumLineupGain: limits.minLineupGain,
      minimumLineupConfidence: limits.minLineupConfidence,
      deadlineSafetyMinutes: limits.deadlineSafetyMinutes,
      runMode: limits.runMode,
      emergencyStop: limits.emergencyStop,
    },
  };
}

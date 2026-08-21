import type { MyTeam } from '../api/types.js';
import type { LlmDecisionReview } from '../llm/decision-reviewer.js';
import type { KapsoUpdateStatus } from '../notifications/kapso.js';
import type { OptimizedTransferPlan } from './decisions.js';

export interface GameweekPlanDisposition {
  held: boolean;
  kapsoStatus: KapsoUpdateStatus;
  notificationTitle: 'GW Plan Held' | 'GW Planning Complete';
}

export function buildProjectedPlanningTeam(
  myTeam: MyTeam,
  transferPlan: Pick<OptimizedTransferPlan, 'transfers' | 'targetPlayerIds'>
): MyTeam {
  const currentIds = new Set(myTeam.picks.map(pick => pick.element));
  const replacements = new Map<number, OptimizedTransferPlan['transfers'][number]>();

  for (const transfer of transferPlan.transfers) {
    if (!currentIds.has(transfer.playerOut.id)) {
      throw new Error(`Cannot project transfer: player ${transfer.playerOut.id} is not in the current squad`);
    }
    if (replacements.has(transfer.playerOut.id)) {
      throw new Error(`Cannot project transfer: player ${transfer.playerOut.id} is transferred out more than once`);
    }
    replacements.set(transfer.playerOut.id, transfer);
  }

  const picks = myTeam.picks.map(pick => {
    const transfer = replacements.get(pick.element);
    if (!transfer) return { ...pick };
    return {
      ...pick,
      element: transfer.playerIn.id,
      purchase_price: transfer.playerIn.now_cost,
      selling_price: transfer.playerIn.now_cost,
      is_captain: false,
      is_vice_captain: false,
      multiplier: pick.position <= 11 ? 1 : 0,
    };
  });
  if (new Set(picks.map(pick => pick.element)).size !== picks.length) {
    throw new Error('Cannot project transfer plan: resulting squad contains duplicate players');
  }
  const projectedIds = picks.map(pick => pick.element).sort((left, right) => left - right);
  const targetIds = [...transferPlan.targetPlayerIds].sort((left, right) => left - right);
  if (projectedIds.length !== targetIds.length
    || projectedIds.some((playerId, index) => playerId !== targetIds[index])) {
    throw new Error('Cannot project transfer plan: transfers do not match the optimizer target squad');
  }

  const bankDelta = transferPlan.transfers.reduce(
    (total, transfer) => total + transfer.sellingPrice - transfer.playerIn.now_cost,
    0
  );
  return {
    ...myTeam,
    picks,
    chips: [...myTeam.chips],
    transfers: {
      ...myTeam.transfers,
      bank: myTeam.transfers.bank + bankDelta,
      made: myTeam.transfers.made + transferPlan.transfers.length,
    },
  };
}

export function getGameweekPlanDisposition(
  review: LlmDecisionReview,
  runMode: 'shadow' | 'live',
  deterministicBlocked = false
): GameweekPlanDisposition {
  // A configured review that does not positively approve is fail-closed for
  // publication. Disabled review preserves deterministic-only planning.
  const held = deterministicBlocked || (review.status !== 'disabled' && !review.approved);
  return {
    held,
    kapsoStatus: held ? 'blocked' : runMode === 'shadow' ? 'shadow' : 'planned',
    notificationTitle: held ? 'GW Plan Held' : 'GW Planning Complete',
  };
}

import { fingerprintMyTeam, type MutationGuard } from '../api/client.js';
import type { MyTeam } from '../api/types.js';
import { getSafetyLimits } from './limits.js';

export function createMutationGuard(
  team: MyTeam,
  season: string,
  gameweek: number,
  deadline: Date | null
): MutationGuard {
  const limits = getSafetyLimits();
  if (limits.expectedManagerId === null) throw new Error('Expected manager is required for mutation');
  if (!/^\d{4}-\d{4}$/.test(season)) throw new Error(`Invalid mutation season ${season}`);
  if (!deadline || Number.isNaN(deadline.getTime())) throw new Error('Authoritative deadline is required for mutation');
  return {
    season,
    gameweek,
    deadlineAt: deadline,
    safetyMarginMs: limits.deadlineSafetyMinutes * 60_000,
    expectedManagerId: limits.expectedManagerId,
    expectedTeamFingerprint: fingerprintMyTeam(team),
  };
}

import type { ChipName } from '../strategy/rules.js';

export interface SeasonRules {
  version: string;
  maxSavedTransfers: number;
  transferTopUps: Readonly<Record<number, number>>;
  initialChips: readonly ChipName[];
  chipResetAfterGameweek?: number;
  unsupportedChips: readonly string[];
}

const RULES: Record<string, SeasonRules> = {
  '2024-2025': {
    version: '2024-2025-v1',
    maxSavedTransfers: 5,
    transferTopUps: {},
    initialChips: ['wildcard', 'freehit', 'bboost', '3xc'],
    unsupportedChips: ['assistant-manager'],
  },
  '2025-2026': {
    version: '2025-2026-v1',
    maxSavedTransfers: 5,
    transferTopUps: { 16: 5 },
    initialChips: ['wildcard', 'freehit', 'bboost', '3xc'],
    chipResetAfterGameweek: 19,
    unsupportedChips: [],
  },
};

export function getSeasonRules(season: string): SeasonRules {
  const rules = RULES[season];
  if (!rules) throw new Error(`No replay rules configured for season ${season}`);
  return rules;
}

export function getReplayFreeTransfers(input: {
  rules: SeasonRules;
  previousFreeTransfers: number;
  transfersMade: number;
  nextGameweek: number;
}): number {
  const topUp = input.rules.transferTopUps[input.nextGameweek];
  if (topUp !== undefined) return topUp;
  const remaining = Math.max(0, input.previousFreeTransfers - input.transfersMade);
  return Math.max(1, Math.min(input.rules.maxSavedTransfers, remaining + 1));
}

export type PositionKey = 'goalkeeper' | 'defender' | 'midfielder' | 'forward';
export type ChipName = 'wildcard' | 'freehit' | 'bboost' | '3xc';

export const POSITION_BY_ELEMENT_TYPE: Record<number, PositionKey> = {
  1: 'goalkeeper',
  2: 'defender',
  3: 'midfielder',
  4: 'forward',
};

export const ELEMENT_TYPE_BY_POSITION: Record<PositionKey, number> = {
  goalkeeper: 1,
  defender: 2,
  midfielder: 3,
  forward: 4,
};

export const FPL_RULES = {
  squadSize: 15,
  startingSize: 11,
  initialBudget: 1000,
  maxPlayersPerClub: 3,
  maxFreeTransfers: 5,
  maxTransfersPerGameweek: 20,
  hitCost: 4,
  afconTopUpGameweek: 16,
  firstHalfFinalGameweek: 19,
  squadComposition: {
    goalkeeper: 2,
    defender: 5,
    midfielder: 5,
    forward: 3,
  },
  formation: {
    goalkeeper: { min: 1, max: 1 },
    defender: { min: 3, max: 5 },
    midfielder: { min: 2, max: 5 },
    forward: { min: 1, max: 3 },
  },
} as const;

export const SCORING_RULES = {
  minutes: {
    longPlayThreshold: 60,
    shortPlayPoints: 1,
    longPlayPoints: 2,
  },
  goals: {
    goalkeeper: 10,
    defender: 6,
    midfielder: 5,
    forward: 4,
  },
  assist: 3,
  cleanSheet: {
    goalkeeper: 4,
    defender: 4,
    midfielder: 1,
    forward: 0,
  },
  saves: {
    savesPerBlock: 3,
    pointsPerSaveBlock: 1,
  },
  penaltiesSaved: 5,
  penaltiesMissed: -2,
  goalsConceded: {
    goalsPerBlock: 2,
    goalkeeperDefenderPenalty: -1,
  },
  yellowCard: -1,
  redCard: -3,
  ownGoal: -2,
  defensiveContribution: {
    points: 2,
    defenderThreshold: 10,
    midfielderForwardThreshold: 12,
  },
  bonus: {
    min: 1,
    max: 3,
  },
} as const;

export function calculateSellingPrice(purchasePrice: number, currentPrice: number): number {
  if (currentPrice <= purchasePrice) {
    return currentPrice;
  }

  return purchasePrice + Math.floor((currentPrice - purchasePrice) / 2);
}

export function getTransferHitCost(transfersMade: number, freeTransfers: number): number {
  return Math.max(0, transfersMade - freeTransfers) * FPL_RULES.hitCost;
}

export function getFreeTransfersAfterGameweek(input: {
  previousFreeTransfers: number;
  transfersMade: number;
  nextGameweek: number;
}): number {
  if (input.nextGameweek === FPL_RULES.afconTopUpGameweek) {
    return FPL_RULES.maxFreeTransfers;
  }

  const remaining = Math.max(0, input.previousFreeTransfers - input.transfersMade);
  return Math.max(1, Math.min(FPL_RULES.maxFreeTransfers, remaining + 1));
}

export function isChipAvailableInGameweek(chip: ChipName, gameweek: number): boolean {
  if (chip === 'bboost' || chip === '3xc') {
    return gameweek >= 1 && gameweek <= 38;
  }

  return gameweek >= 2 && gameweek <= 38;
}

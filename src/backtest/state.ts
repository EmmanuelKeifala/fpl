import { calculateSellingPrice, FPL_RULES, getFreeTransfersAfterGameweek, getTransferHitCost } from '../strategy/rules.js';
import type { BacktestDecision, BacktestPlayer, GameweekSnapshot, ManagerState, SquadPick, WeeklyResult } from './types.js';

const INITIAL_CHIPS = ['wildcard', 'freehit', 'bboost', '3xc'] as const;

export function createInitialState(season: string): ManagerState {
  return {
    season,
    squad: [],
    bank: FPL_RULES.initialBudget,
    freeTransfers: 1,
    chipsAvailable: [...INITIAL_CHIPS],
    totalPoints: 0,
    weeklyResults: [],
    decisions: [],
  };
}

export function applyGameweekDecision(
  state: ManagerState,
  decision: BacktestDecision,
  snapshot: GameweekSnapshot,
): ManagerState {
  if (decision.gameweek !== snapshot.gameweek) {
    throw new Error(`Decision gameweek ${decision.gameweek} does not match snapshot gameweek ${snapshot.gameweek}`);
  }

  if (decision.chip && !state.chipsAvailable.includes(decision.chip)) {
    throw new Error(`Chip ${decision.chip} is not available`);
  }

  const playersById = new Map(snapshot.knownBeforeDeadline.players.map(player => [player.id, player]));
  const resultsByPlayerId = new Map(snapshot.actualResults.playerResults.map(result => [result.playerId, result]));
  const baseSquad = decision.squad ? createSquadFromIds(decision.squad, playersById) : state.squad;
  const baseBank = decision.squad
    ? FPL_RULES.initialBudget - baseSquad.reduce((total, pick) => total + pick.purchasePrice, 0)
    : state.bank;
  if (baseBank < 0) {
    throw new Error('Decision is over budget');
  }

  const transfersMade = decision.transfers.length;
  const transferCost = decision.chip === 'wildcard' || decision.chip === 'freehit'
    ? 0
    : getTransferHitCost(transfersMade, state.freeTransfers);
  const { squad, bank } = applyTransfers(baseSquad, baseBank, decision, playersById);
  if (bank < 0) {
    throw new Error('Decision is over budget');
  }

  const grossPoints = scorePlayers(decision.startingXi, resultsByPlayerId);
  const captainScore = resultsByPlayerId.get(decision.captain)?.totalPoints ?? 0;
  const captainMultiplier = decision.chip === '3xc' ? 3 : 2;
  const captainPoints = captainScore * (captainMultiplier - 1);
  const benchPoints = scorePlayers(decision.bench, resultsByPlayerId);
  const benchBoostPoints = decision.chip === 'bboost' ? benchPoints : 0;
  const weeklyGrossPoints = grossPoints + captainPoints + benchBoostPoints;
  const points = weeklyGrossPoints - transferCost;
  const weeklyResult: WeeklyResult = {
    gameweek: decision.gameweek,
    points,
    transferCost,
    grossPoints: weeklyGrossPoints,
    captainPoints,
    benchPoints,
    chip: decision.chip,
    squadValue: squad.reduce((total, pick) => total + pick.sellingPrice, 0),
    bank,
  };

  return {
    season: state.season,
    squad,
    bank,
    freeTransfers: getFreeTransfersAfterGameweek({
      previousFreeTransfers: state.freeTransfers,
      transfersMade: decision.squad && transfersMade === 0 ? 1 : transfersMade,
      nextGameweek: decision.gameweek + 1,
    }),
    chipsAvailable: decision.chip ? state.chipsAvailable.filter(chip => chip !== decision.chip) : [...state.chipsAvailable],
    totalPoints: state.totalPoints + points,
    weeklyResults: [...state.weeklyResults, weeklyResult],
    decisions: [...state.decisions, decision],
  };
}

function createSquadFromIds(playerIds: number[], playersById: Map<number, BacktestPlayer>): SquadPick[] {
  return playerIds.map(playerId => {
    const player = getPlayer(playerId, playersById);
    return {
      playerId,
      purchasePrice: player.price,
      sellingPrice: player.price,
    };
  });
}

function applyTransfers(
  currentSquad: SquadPick[],
  currentBank: number,
  decision: BacktestDecision,
  playersById: Map<number, BacktestPlayer>,
): { squad: SquadPick[]; bank: number } {
  let squad = currentSquad.map(pick => refreshSellingPrice(pick, playersById));
  let bank = currentBank;

  for (const transfer of decision.transfers) {
    const outgoing = squad.find(pick => pick.playerId === transfer.out);
    if (!outgoing) {
      throw new Error(`Player ${transfer.out} is not in squad`);
    }

    bank += outgoing.sellingPrice;
    squad = squad.filter(pick => pick.playerId !== transfer.out);

    const incoming = getPlayer(transfer.in, playersById);
    bank -= incoming.price;
    squad = [...squad, { playerId: incoming.id, purchasePrice: incoming.price, sellingPrice: incoming.price }];
  }

  return { squad: squad.map(pick => refreshSellingPrice(pick, playersById)), bank };
}

function refreshSellingPrice(pick: SquadPick, playersById: Map<number, BacktestPlayer>): SquadPick {
  const player = getPlayer(pick.playerId, playersById);
  return {
    ...pick,
    sellingPrice: calculateSellingPrice(pick.purchasePrice, player.price),
  };
}

function getPlayer(playerId: number, playersById: Map<number, BacktestPlayer>): BacktestPlayer {
  const player = playersById.get(playerId);
  if (!player) {
    throw new Error(`Player ${playerId} is missing from gameweek snapshot`);
  }

  return player;
}

function scorePlayers(playerIds: number[], resultsByPlayerId: Map<number, { totalPoints: number }>): number {
  return playerIds.reduce((total, playerId) => total + (resultsByPlayerId.get(playerId)?.totalPoints ?? 0), 0);
}

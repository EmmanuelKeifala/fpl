import { calculateSellingPrice, FPL_RULES, getTransferHitCost, isChipAvailableInGameweek } from '../strategy/rules.js';
import { validateFormation, validateSquad, type SquadPlayer } from '../strategy/squad.js';
import type { BacktestDecision, BacktestPlayer, GameweekSnapshot, ManagerState, SquadPick, WeeklyResult } from './types.js';
import { getReplayFreeTransfers, getSeasonRules } from './season-rules.js';

export function createInitialState(season: string): ManagerState {
  const rules = getSeasonRules(season);
  return {
    season,
    squad: [],
    bank: FPL_RULES.initialBudget,
    freeTransfers: 1,
    chipsAvailable: [...rules.initialChips],
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

  if (decision.chip && !isChipAvailableInGameweek(decision.chip, decision.gameweek)) {
    throw new Error(`Chip ${decision.chip} is not available in gameweek ${decision.gameweek}`);
  }

  const playersById = new Map(snapshot.knownBeforeDeadline.players.map(player => [player.id, player]));
  const resultsByPlayerId = new Map(snapshot.actualResults.playerResults.map(result => [result.playerId, result]));

  if (decision.squad && state.squad.length > 0) {
    throw new Error('Decision squad can only be provided for initial squad creation');
  }

  if (decision.transfers.length > FPL_RULES.maxTransfersPerGameweek && decision.chip !== 'wildcard' && decision.chip !== 'freehit') {
    throw new Error(`Decision has more than ${FPL_RULES.maxTransfersPerGameweek} transfers`);
  }

  const refreshedStateSquad = state.squad.map(pick => refreshSellingPrice(pick, playersById));
  const baseSquad = decision.squad ? createSquadFromIds(decision.squad, playersById) : refreshedStateSquad;
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
  validateUniqueSquad(squad);
  if (decision.squad || decision.transfers.length > 0) {
    validateSquadRules(squad, bank, playersById);
  }
  validateLineup(decision, squad, playersById);

  const effectiveStartingXi = decision.chip === 'bboost'
    ? decision.startingXi
    : applyAutomaticSubstitutions(decision.startingXi, decision.bench, playersById, resultsByPlayerId);
  const grossPoints = scorePlayers(effectiveStartingXi, resultsByPlayerId);
  const captainPlayed = (resultsByPlayerId.get(decision.captain)?.minutes ?? 0) > 0;
  const viceCaptainPlayed = (resultsByPlayerId.get(decision.viceCaptain)?.minutes ?? 0) > 0;
  const effectiveCaptain = captainPlayed ? decision.captain : viceCaptainPlayed ? decision.viceCaptain : decision.captain;
  const captainScore = (captainPlayed || viceCaptainPlayed)
    ? resultsByPlayerId.get(effectiveCaptain)?.totalPoints ?? 0
    : 0;
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
    squadValue: calculateSquadValue(squad, bank, playersById),
    bank,
  };
  const persistedSquad = decision.chip === 'freehit' ? refreshedStateSquad : squad;
  const persistedBank = decision.chip === 'freehit' ? state.bank : bank;
  const transfersForFreeTransferCarryover = decision.chip === 'wildcard' || decision.chip === 'freehit'
    ? 0
    : decision.squad && transfersMade === 0 ? 1 : transfersMade;

  return {
    season: state.season,
    squad: persistedSquad,
    bank: persistedBank,
    freeTransfers: getReplayFreeTransfers({
      rules: getSeasonRules(state.season),
      previousFreeTransfers: state.freeTransfers,
      transfersMade: transfersForFreeTransferCarryover,
      nextGameweek: decision.gameweek + 1,
    }),
    chipsAvailable: nextChipInventory(state, decision),
    totalPoints: state.totalPoints + points,
    weeklyResults: [...state.weeklyResults, weeklyResult],
    decisions: [...state.decisions, decision],
  };
}

function applyAutomaticSubstitutions(
  startingXi: number[],
  bench: number[],
  playersById: Map<number, BacktestPlayer>,
  resultsByPlayerId: Map<number, { minutes: number; totalPoints: number }>
): number[] {
  const effective = [...startingXi];
  const missing = startingXi.filter(playerId => (resultsByPlayerId.get(playerId)?.minutes ?? 0) === 0);
  const availableBench = bench.filter(playerId => (resultsByPlayerId.get(playerId)?.minutes ?? 0) > 0);

  for (const outgoingId of missing) {
    const outgoing = getPlayer(outgoingId, playersById);
    const substituteIndex = availableBench.findIndex(candidateId => {
      const candidate = getPlayer(candidateId, playersById);
      if (outgoing.elementType === 1) return candidate.elementType === 1;
      if (candidate.elementType === 1) return false;
      const candidateTypes = effective
        .map(playerId => playerId === outgoingId ? candidateId : playerId)
        .map(playerId => getPlayer(playerId, playersById).elementType);
      return validateFormation(candidateTypes).valid;
    });
    if (substituteIndex >= 0) {
      const substitute = availableBench.splice(substituteIndex, 1)[0]!;
      effective[effective.indexOf(outgoingId)] = substitute;
    }
  }
  return effective.filter(playerId => (resultsByPlayerId.get(playerId)?.minutes ?? 0) > 0);
}

function nextChipInventory(state: ManagerState, decision: BacktestDecision): typeof state.chipsAvailable {
  const rules = getSeasonRules(state.season);
  const chips = [...state.chipsAvailable];
  if (decision.chip) {
    const index = chips.indexOf(decision.chip);
    if (index >= 0) chips.splice(index, 1);
  }
  if (decision.gameweek === rules.chipResetAfterGameweek) {
    return [...rules.initialChips];
  }
  return chips;
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
    if (squad.some(pick => pick.playerId === incoming.id)) {
      throw new Error(`Duplicate player ${incoming.id} in final squad`);
    }

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

function calculateSquadValue(squad: SquadPick[], bank: number, playersById: Map<number, BacktestPlayer>): number {
  return squad.reduce((total, pick) => total + getPlayer(pick.playerId, playersById).price, bank);
}

function validateUniqueSquad(squad: SquadPick[]): void {
  assertNoDuplicates(squad.map(pick => pick.playerId), 'final squad');
}

function validateSquadRules(squad: SquadPick[], bank: number, playersById: Map<number, BacktestPlayer>): void {
  const squadPlayers = squad.map<SquadPlayer>(pick => {
    const player = getPlayer(pick.playerId, playersById);
    return { id: player.id, elementType: player.elementType, team: player.team, price: player.price };
  });
  const currentSquadValueBudget = squadPlayers.reduce((total, player) => total + player.price, bank);
  const result = validateSquad(squadPlayers, currentSquadValueBudget);
  if (!result.valid) {
    throw new Error(result.errors.join('; '));
  }
}

function validateLineup(decision: BacktestDecision, squad: SquadPick[], playersById: Map<number, BacktestPlayer>): void {
  if (decision.captain === decision.viceCaptain) {
    throw new Error('Captain and vice captain must be different');
  }

  const ownedPlayerIds = new Set(squad.map(pick => pick.playerId));
  const selectedPlayerIds = [...decision.startingXi, ...decision.bench];
  assertNoDuplicates(selectedPlayerIds, 'lineup');

  const expectedLineupSize = FPL_RULES.startingSize + (FPL_RULES.squadSize - FPL_RULES.startingSize);
  if (selectedPlayerIds.length !== expectedLineupSize || selectedPlayerIds.length !== ownedPlayerIds.size) {
    throw new Error(`Lineup must cover all ${FPL_RULES.squadSize} squad players`);
  }

  const formation = validateFormation(decision.startingXi.map(playerId => getPlayer(playerId, playersById).elementType));
  if (!formation.valid) {
    throw new Error(formation.errors.join('; '));
  }

  for (const playerId of [...selectedPlayerIds, decision.captain, decision.viceCaptain]) {
    if (!ownedPlayerIds.has(playerId)) {
      throw new Error(`Player ${playerId} is not in squad`);
    }
  }
}

function assertNoDuplicates(playerIds: number[], label: string): void {
  const seen = new Set<number>();
  for (const playerId of playerIds) {
    if (seen.has(playerId)) {
      throw new Error(`Duplicate player ${playerId} in ${label}`);
    }
    seen.add(playerId);
  }
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

import { buildInitialSquad } from './baseline.js';
import { rankPlayers, selectCaptaincy, selectLineup } from './lineup.js';
import { chooseBestTransfers } from './transfers.js';
import { calculateSellingPrice, FPL_RULES, POSITION_BY_ELEMENT_TYPE, type PositionKey } from '../../strategy/rules.js';
import type { BacktestPlayer, BacktestStrategy, ManagerState, TransferMove } from '../types.js';

export interface FairStrategyOptions {
  hitThreshold?: number;
  tripleCaptainThreshold?: number;
  benchBoostThreshold?: number;
  wildcardThreshold?: number;
  freeHitThreshold?: number;
  maxCandidatesPerPosition?: number;
}

const DEFAULT_OPTIONS = {
  hitThreshold: 4.5,
  tripleCaptainThreshold: 14,
  benchBoostThreshold: 18,
  wildcardThreshold: 18,
  freeHitThreshold: 16,
  maxCandidatesPerPosition: 12,
};

export function createFairStrategy(options: FairStrategyOptions = {}): BacktestStrategy {
  const config = { ...DEFAULT_OPTIONS, ...options };
  return ({ state, snapshot }) => {
    const playersById = new Map(snapshot.knownBeforeDeadline.players.map(player => [player.id, player]));
    const currentIds = state.squad.map(pick => pick.playerId);

    if (snapshot.gameweek !== 1 && (state.chipsAvailable.includes('freehit') || state.chipsAvailable.includes('wildcard'))) {
      const rebuildBudget = availableRebuildBudget(state, playersById);
      const rebuiltIds = buildSquadWithinBudget(snapshot.knownBeforeDeadline.players, rebuildBudget);

      if (rebuiltIds && state.chipsAvailable.includes('freehit')) {
        const rebuiltLineup = selectLineup(rebuiltIds, playersById);
        const rebuiltCaptaincy = selectCaptaincy(rebuiltLineup.startingXi, playersById);
        const currentLineup = selectLineup(currentIds, playersById);
        const freeHitGain = projectedSquad(rebuiltLineup.startingXi, playersById) - projectedSquad(currentLineup.startingXi, playersById);
        if (freeHitGain >= config.freeHitThreshold) {
          return {
            gameweek: snapshot.gameweek,
            transfers: replacementTransfers(currentIds, rebuiltIds),
            startingXi: rebuiltLineup.startingXi,
            bench: rebuiltLineup.bench,
            captain: rebuiltCaptaincy.captain,
            viceCaptain: rebuiltCaptaincy.viceCaptain,
            chip: 'freehit',
            notes: ['Fair point-in-time strategy', 'Fair free hit threshold strategy'],
          };
        }
      }

      if (rebuiltIds && state.chipsAvailable.includes('wildcard')) {
        const rebuiltLineup = selectLineup(rebuiltIds, playersById);
        const rebuiltCaptaincy = selectCaptaincy(rebuiltLineup.startingXi, playersById);
        const wildcardGain = projectedSquad(rebuiltIds, playersById) - projectedSquad(currentIds, playersById);
        if (wildcardGain >= config.wildcardThreshold) {
          return {
            gameweek: snapshot.gameweek,
            transfers: replacementTransfers(currentIds, rebuiltIds),
            startingXi: rebuiltLineup.startingXi,
            bench: rebuiltLineup.bench,
            captain: rebuiltCaptaincy.captain,
            viceCaptain: rebuiltCaptaincy.viceCaptain,
            chip: 'wildcard',
            notes: ['Fair point-in-time strategy', 'Fair wildcard threshold strategy'],
          };
        }
      }
    }

    const squad = snapshot.gameweek === 1 ? buildInitialSquad(snapshot.knownBeforeDeadline.players) : undefined;
    const transfers = squad ? [] : chooseBestTransfers({
      squad: state.squad,
      bank: state.bank,
      freeTransfers: state.freeTransfers,
      players: snapshot.knownBeforeDeadline.players,
      maxCandidatesPerPosition: config.maxCandidatesPerPosition,
      hitThreshold: config.hitThreshold,
    }).transfers;
    const lineupPool = applyTransferIds(squad ?? currentIds, transfers);
    const { startingXi, bench } = selectLineup(lineupPool, playersById);
    const { captain, viceCaptain } = selectCaptaincy(startingXi, playersById);
    const chip = chooseFairChip(state, startingXi, bench, captain, playersById, config);

    return {
      gameweek: snapshot.gameweek,
      squad,
      transfers,
      startingXi,
      bench,
      captain,
      viceCaptain,
      chip,
      notes: ['Fair point-in-time strategy'],
    };
  };
}

function availableRebuildBudget(state: ManagerState, playersById: Map<number, BacktestPlayer>): number {
  return state.squad.reduce((total, pick) => {
    const player = playersById.get(pick.playerId);
    return total + calculateSellingPrice(pick.purchasePrice, player?.price ?? pick.sellingPrice);
  }, state.bank);
}

function buildSquadWithinBudget(players: BacktestPlayer[], budget: number): number[] | undefined {
  const ranked = rankPlayers(players);
  const selected: BacktestPlayer[] = [];
  let spent = 0;

  while (selected.length < FPL_RULES.squadSize) {
    const remaining = ranked.filter(player => !selected.some(selectedPlayer => selectedPlayer.id === player.id));
    const candidate = remaining.find(player => {
      const minimumRemainingCost = minimumCostToCompleteSquad([...selected, player], remaining.filter(otherPlayer => otherPlayer.id !== player.id));
      if (minimumRemainingCost === undefined) return false;
      return spent + player.price + minimumRemainingCost <= budget;
    });

    if (!candidate) return undefined;

    selected.push(candidate);
    spent += candidate.price;
  }

  return selected.map(player => player.id);
}

function minimumCostToCompleteSquad(selected: BacktestPlayer[], remaining: BacktestPlayer[]): number | undefined {
  const selectedPositionCounts = countSelectedByPosition(selected);
  const selectedTeamCounts = countSelectedByTeam(selected);
  for (const [position, expected] of Object.entries(FPL_RULES.squadComposition)) {
    if (selectedPositionCounts[position as PositionKey] > expected) return undefined;
  }
  if ([...selectedTeamCounts.values()].some(count => count > FPL_RULES.maxPlayersPerClub)) return undefined;

  let cost = 0;
  const teamCounts = new Map(selectedTeamCounts);

  for (const [position, expected] of Object.entries(FPL_RULES.squadComposition)) {
    const positionKey = position as PositionKey;
    const required = expected - selectedPositionCounts[positionKey];
    const cheapest = remaining
      .filter(player => POSITION_BY_ELEMENT_TYPE[player.elementType] === positionKey)
      .sort((a, b) => a.price - b.price || a.id - b.id);

    for (let index = 0; index < required; index++) {
      const player = cheapest.find(candidate => (teamCounts.get(candidate.team) ?? 0) < FPL_RULES.maxPlayersPerClub);
      if (!player) return undefined;
      cost += player.price;
      teamCounts.set(player.team, (teamCounts.get(player.team) ?? 0) + 1);
      cheapest.splice(cheapest.indexOf(player), 1);
    }
  }

  return cost;
}

function countSelectedByPosition(players: BacktestPlayer[]): Record<PositionKey, number> {
  const counts: Record<PositionKey, number> = { goalkeeper: 0, defender: 0, midfielder: 0, forward: 0 };
  for (const player of players) {
    const position = POSITION_BY_ELEMENT_TYPE[player.elementType];
    if (position) counts[position]++;
  }
  return counts;
}

function countSelectedByTeam(players: BacktestPlayer[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const player of players) {
    counts.set(player.team, (counts.get(player.team) ?? 0) + 1);
  }
  return counts;
}

function projectedSquad(playerIds: number[], playersById: Map<number, BacktestPlayer>): number {
  return playerIds.reduce((total, playerId) => total + (playersById.get(playerId)?.expectedPoints ?? 0), 0);
}

function replacementTransfers(currentIds: number[], rebuiltIds: number[]): TransferMove[] {
  const outgoing = [...currentIds].filter(playerId => !rebuiltIds.includes(playerId)).sort((a, b) => a - b);
  const incoming = [...rebuiltIds].filter(playerId => !currentIds.includes(playerId)).sort((a, b) => a - b);
  return outgoing.map((out, index) => ({ out, in: incoming[index]! }));
}

function applyTransferIds(playerIds: number[], transfers: TransferMove[]): number[] {
  let result = [...playerIds];
  for (const transfer of transfers) result = [...result.filter(playerId => playerId !== transfer.out), transfer.in];
  return result;
}

function chooseFairChip(
  state: ManagerState,
  _startingXi: number[],
  bench: number[],
  captain: number,
  playersById: Map<number, BacktestPlayer>,
  config: Required<FairStrategyOptions>,
): '3xc' | 'bboost' | undefined {
  const captainProjection = playersById.get(captain)?.expectedPoints ?? 0;
  if (state.chipsAvailable.includes('3xc') && captainProjection >= config.tripleCaptainThreshold) return '3xc';
  const benchProjection = bench.reduce((total, playerId) => total + (playersById.get(playerId)?.expectedPoints ?? 0), 0);
  if (state.chipsAvailable.includes('bboost') && benchProjection >= config.benchBoostThreshold) return 'bboost';
  return undefined;
}

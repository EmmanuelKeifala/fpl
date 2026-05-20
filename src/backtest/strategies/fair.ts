import { buildInitialSquad } from './baseline.js';
import { selectCaptaincy, selectLineup } from './lineup.js';
import { chooseBestTransfers } from './transfers.js';
import type { BacktestPlayer, BacktestStrategy, ManagerState, TransferMove } from '../types.js';

export interface FairStrategyOptions {
  hitThreshold?: number;
  tripleCaptainThreshold?: number;
  benchBoostThreshold?: number;
  maxCandidatesPerPosition?: number;
}

const DEFAULT_OPTIONS = {
  hitThreshold: 4.5,
  tripleCaptainThreshold: 14,
  benchBoostThreshold: 18,
  maxCandidatesPerPosition: 12,
};

export function createFairStrategy(options: FairStrategyOptions = {}): BacktestStrategy {
  const config = { ...DEFAULT_OPTIONS, ...options };
  return ({ state, snapshot }) => {
    const playersById = new Map(snapshot.knownBeforeDeadline.players.map(player => [player.id, player]));
    const squad = snapshot.gameweek === 1 ? buildInitialSquad(snapshot.knownBeforeDeadline.players) : undefined;
    const transfers = squad ? [] : chooseBestTransfers({
      squad: state.squad,
      bank: state.bank,
      freeTransfers: state.freeTransfers,
      players: snapshot.knownBeforeDeadline.players,
      maxCandidatesPerPosition: config.maxCandidatesPerPosition,
      hitThreshold: config.hitThreshold,
    }).transfers;
    const lineupPool = applyTransferIds(squad ?? state.squad.map(pick => pick.playerId), transfers);
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

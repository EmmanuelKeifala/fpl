import { buildInitialSquad } from './baseline.js';
import { selectCaptaincy, selectLineup } from './lineup.js';
import { chooseBestTransfers } from './transfers.js';
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
      const rebuiltIds = buildInitialSquad(snapshot.knownBeforeDeadline.players);
      const rebuiltLineup = selectLineup(rebuiltIds, playersById);
      const rebuiltCaptaincy = selectCaptaincy(rebuiltLineup.startingXi, playersById);

      if (state.chipsAvailable.includes('freehit')) {
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

      if (state.chipsAvailable.includes('wildcard')) {
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

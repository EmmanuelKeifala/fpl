import { selectCaptaincy, selectLineup } from '../strategies/lineup.js';
import { chooseBestTransfers } from '../strategies/transfers.js';
import type { BacktestDecision, BacktestPlayer, DecisionSnapshotInput, ManagerState, TransferMove } from '../types.js';

export interface CandidateDecision {
  id: string;
  label: string;
  decision: BacktestDecision;
  projectedPoints: number;
}

export interface CandidateBuildInput {
  state: ManagerState;
  snapshot: DecisionSnapshotInput;
  maxCandidates?: number;
}

export function buildCandidateDecisions(input: CandidateBuildInput): CandidateDecision[] {
  const maxCandidates = input.maxCandidates ?? 5;
  const playersById = new Map(input.snapshot.knownBeforeDeadline.players.map(player => [player.id, player]));
  const currentIds = input.state.squad.map(pick => pick.playerId);
  const candidates: CandidateDecision[] = [buildCandidate('hold', 'Hold squad', input.snapshot.gameweek, currentIds, [], playersById)];

  const transferChoice = chooseBestTransfers({
    squad: input.state.squad,
    bank: input.state.bank,
    freeTransfers: input.state.freeTransfers,
    players: input.snapshot.knownBeforeDeadline.players,
    maxCandidatesPerPosition: 12,
    hitThreshold: 4.5,
  });
  if (transferChoice.transfers.length > 0) {
    const idsAfterTransfers = applyTransferIds(currentIds, transferChoice.transfers);
    candidates.push(buildCandidate('best-transfer', 'Best projected transfer', input.snapshot.gameweek, idsAfterTransfers, transferChoice.transfers, playersById));
  }

  return candidates.slice(0, maxCandidates);
}

function buildCandidate(
  id: string,
  label: string,
  gameweek: number,
  playerIds: number[],
  transfers: TransferMove[],
  playersById: Map<number, BacktestPlayer>,
): CandidateDecision {
  const { startingXi, bench } = selectLineup(playerIds, playersById);
  const { captain, viceCaptain } = selectCaptaincy(startingXi, playersById);
  const projectedPoints = startingXi.reduce((total, playerId) => total + (playersById.get(playerId)?.expectedPoints ?? 0), 0)
    + (playersById.get(captain)?.expectedPoints ?? 0);
  return {
    id,
    label,
    projectedPoints,
    decision: {
      gameweek,
      transfers,
      startingXi,
      bench,
      captain,
      viceCaptain,
      expectedUtility: projectedPoints,
      notes: [`Hybrid candidate: ${label}`],
    },
  };
}

function applyTransferIds(playerIds: number[], transfers: TransferMove[]): number[] {
  let result = [...playerIds];
  for (const transfer of transfers) result = [...result.filter(playerId => playerId !== transfer.out), transfer.in];
  return result;
}

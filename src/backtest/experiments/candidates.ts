import { selectCaptaincy, selectLineup } from '../strategies/lineup.js';
import { buildInitialSquad } from '../strategies/baseline.js';
import { calculateSellingPrice, FPL_RULES, POSITION_BY_ELEMENT_TYPE } from '../../strategy/rules.js';
import { validateSquad } from '../../strategy/squad.js';
import type { BacktestDecision, BacktestPlayer, DecisionSnapshotInput, ManagerState, SquadPick, TransferMove } from '../types.js';

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
  allowHits?: boolean;
  hitThreshold?: number;
}

interface TransferChoice {
  transfers: TransferMove[];
  projectedGain: number;
}

const MAX_CANDIDATES_PER_POSITION = 12;

export function buildCandidateDecisions(input: CandidateBuildInput): CandidateDecision[] {
  const maxCandidates = input.maxCandidates ?? 5;
  const playersById = new Map(input.snapshot.knownBeforeDeadline.players.map(player => [player.id, player]));
  const currentIds = input.state.squad.map(pick => pick.playerId);
  if (input.snapshot.gameweek === 1) {
    const squad = buildInitialSquad(input.snapshot.knownBeforeDeadline.players);
    const candidate = buildCandidate('initial-squad', 'Initial squad', input.snapshot.gameweek, squad, [], playersById);
    candidate.decision.squad = squad;
    return [candidate];
  }
  const candidates: CandidateDecision[] = [buildCandidate('hold', 'Hold squad', input.snapshot.gameweek, currentIds, [], playersById)];

  const transferChoices = singleTransferChoices(input.state.squad, input.state.bank, input.snapshot.knownBeforeDeadline.players);
  for (const [index, choice] of transferChoices.entries()) {
    if (candidates.length >= maxCandidates) break;
    const idsAfterTransfers = applyTransferIds(currentIds, choice.transfers);
    candidates.push(buildCandidate(`transfer-${index + 1}`, `Transfer alternative ${index + 1}`, input.snapshot.gameweek, idsAfterTransfers, choice.transfers, playersById));
  }

  if (input.allowHits) {
    const hitChoices = hitTransferChoices(input.state.squad, input.state.bank, input.snapshot.knownBeforeDeadline.players, input.hitThreshold ?? 4.5);
    for (const [index, choice] of hitChoices.entries()) {
      if (candidates.length >= maxCandidates) break;
      const idsAfterTransfers = applyTransferIds(currentIds, choice.transfers);
      candidates.push(buildCandidate(`hit-${index + 1}`, `Hit alternative ${index + 1}`, input.snapshot.gameweek, idsAfterTransfers, choice.transfers, playersById));
    }
  }

  return candidates.slice(0, maxCandidates);
}

function singleTransferChoices(squad: SquadPick[], bank: number, players: BacktestPlayer[]): TransferChoice[] {
  const playersById = new Map(players.map(player => [player.id, player]));
  const squadIds = new Set(squad.map(pick => pick.playerId));
  const currentScore = scoreSquad(squad.map(pick => playersById.get(pick.playerId)).filter(Boolean) as BacktestPlayer[]);
  const choices: TransferChoice[] = [];

  for (const outgoing of squad) {
    const outgoingPlayer = playersById.get(outgoing.playerId);
    if (!outgoingPlayer) continue;
    for (const incoming of candidatePlayers(players).filter(player => !squadIds.has(player.id))) {
      if (incoming.elementType !== outgoingPlayer.elementType) continue;
      const transfers = [{ out: outgoing.playerId, in: incoming.id }];
      const finalPlayers = playersAfterTransfers(squad, transfers, playersById);
      if (!finalPlayers || !isLegalSquad(finalPlayers, calculateBankAfterTransfers(squad, bank, transfers, playersById))) continue;
      const projectedGain = scoreSquad(finalPlayers) - currentScore;
      if (projectedGain <= 0) continue;
      choices.push({ transfers, projectedGain });
    }
  }

  return dedupeTransferChoices(choices).sort(compareTransferChoices);
}

function hitTransferChoices(squad: SquadPick[], bank: number, players: BacktestPlayer[], hitThreshold: number): TransferChoice[] {
  const playersById = new Map(players.map(player => [player.id, player]));
  const squadIds = new Set(squad.map(pick => pick.playerId));
  const candidatesByElementType = groupPlayersByElementType(candidatePlayers(players.filter(player => !squadIds.has(player.id)), MAX_CANDIDATES_PER_POSITION));
  const currentScore = scoreSquad(squad.map(pick => playersById.get(pick.playerId)).filter(Boolean) as BacktestPlayer[]);
  const choices: TransferChoice[] = [];
  const seen = new Set<string>();

  for (let firstIndex = 0; firstIndex < squad.length; firstIndex++) {
    const firstOutgoing = squad[firstIndex]!;
    const firstOutgoingPlayer = playersById.get(firstOutgoing.playerId);
    if (!firstOutgoingPlayer) continue;

    for (let secondIndex = firstIndex + 1; secondIndex < squad.length; secondIndex++) {
      const secondOutgoing = squad[secondIndex]!;
      const secondOutgoingPlayer = playersById.get(secondOutgoing.playerId);
      if (!secondOutgoingPlayer) continue;

      for (const firstIncoming of candidatesByElementType.get(firstOutgoingPlayer.elementType) ?? []) {
        for (const secondIncoming of candidatesByElementType.get(secondOutgoingPlayer.elementType) ?? []) {
          if (secondIncoming.id === firstIncoming.id) continue;
          const transfers = [{ out: firstOutgoing.playerId, in: firstIncoming.id }, { out: secondOutgoing.playerId, in: secondIncoming.id }];
          const key = transfers.map(transfer => `${transfer.out}:${transfer.in}`).sort().join('|');
          if (seen.has(key)) continue;
          seen.add(key);

          const finalPlayers = playersAfterTransfers(squad, transfers, playersById);
          const bankAfter = calculateBankAfterTransfers(squad, bank, transfers, playersById);
          if (!finalPlayers || !isLegalSquad(finalPlayers, bankAfter)) continue;
          const projectedGain = scoreSquad(finalPlayers) - currentScore - FPL_RULES.hitCost;
          if (projectedGain < hitThreshold) continue;
          choices.push({ transfers, projectedGain });
        }
      }
    }
  }

  return choices.sort(compareTransferChoices);
}

function candidatePlayers(players: BacktestPlayer[], maxPerPosition = Number.POSITIVE_INFINITY): BacktestPlayer[] {
  const result: BacktestPlayer[] = [];
  for (const elementType of [1, 2, 3, 4]) {
    result.push(...players
      .filter(player => POSITION_BY_ELEMENT_TYPE[player.elementType] && player.elementType === elementType)
      .sort((a, b) => b.expectedPoints - a.expectedPoints || a.price - b.price || a.id - b.id)
      .slice(0, maxPerPosition));
  }
  return result;
}

function groupPlayersByElementType(players: BacktestPlayer[]): Map<number, BacktestPlayer[]> {
  const result = new Map<number, BacktestPlayer[]>();
  for (const player of players) result.set(player.elementType, [...(result.get(player.elementType) ?? []), player]);
  return result;
}

function playersAfterTransfers(squad: SquadPick[], transfers: TransferMove[], playersById: Map<number, BacktestPlayer>): BacktestPlayer[] | undefined {
  const incomingByOutgoing = new Map(transfers.map(transfer => [transfer.out, transfer.in]));
  const finalPlayers: BacktestPlayer[] = [];
  for (const pick of squad) {
    const playerId = incomingByOutgoing.get(pick.playerId) ?? pick.playerId;
    const player = playersById.get(playerId);
    if (!player) return undefined;
    finalPlayers.push(player);
  }
  return finalPlayers;
}

function calculateBankAfterTransfers(squad: SquadPick[], bank: number, transfers: TransferMove[], playersById: Map<number, BacktestPlayer>): number {
  let result = bank;
  const picksById = new Map(squad.map(pick => [pick.playerId, pick]));
  for (const transfer of transfers) {
    const outgoing = picksById.get(transfer.out);
    const outgoingPlayer = playersById.get(transfer.out);
    const incomingPlayer = playersById.get(transfer.in);
    if (!outgoing || !outgoingPlayer || !incomingPlayer) return Number.NEGATIVE_INFINITY;
    result += calculateSellingPrice(outgoing.purchasePrice, outgoingPlayer.price) - incomingPlayer.price;
  }
  return result;
}

function isLegalSquad(players: BacktestPlayer[], bank: number): boolean {
  if (bank < 0) return false;
  return validateSquad(players, players.reduce((total, player) => total + player.price, bank)).valid;
}

function dedupeTransferChoices(choices: TransferChoice[]): TransferChoice[] {
  const bestByIncoming = new Map<number, TransferChoice>();
  for (const choice of choices) {
    const incoming = choice.transfers[0]?.in;
    if (incoming === undefined) continue;
    const current = bestByIncoming.get(incoming);
    if (!current || compareTransferChoices(choice, current) < 0) bestByIncoming.set(incoming, choice);
  }
  return [...bestByIncoming.values()];
}

function compareTransferChoices(a: TransferChoice, b: TransferChoice): number {
  return b.projectedGain - a.projectedGain || (a.transfers[0]?.in ?? 0) - (b.transfers[0]?.in ?? 0);
}

function scoreSquad(players: BacktestPlayer[]): number {
  return players.reduce((total, player) => total + player.expectedPoints, 0);
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

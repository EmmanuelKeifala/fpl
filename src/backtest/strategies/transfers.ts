import { calculateSellingPrice, FPL_RULES, POSITION_BY_ELEMENT_TYPE } from '../../strategy/rules.js';
import { validateSquad } from '../../strategy/squad.js';
import type { BacktestPlayer, SquadPick, TransferMove } from '../types.js';

export interface TransferChoiceInput {
  squad: SquadPick[];
  bank: number;
  freeTransfers: number;
  players: BacktestPlayer[];
  maxCandidatesPerPosition: number;
  hitThreshold: number;
}

export interface TransferChoice {
  transfers: TransferMove[];
  projectedGain: number;
}

export function chooseBestTransfers(input: TransferChoiceInput): TransferChoice {
  const playersById = new Map(input.players.map(player => [player.id, player]));
  const squadIds = new Set(input.squad.map(pick => pick.playerId));
  const currentScore = scoreSquad(input.squad.map(pick => playersById.get(pick.playerId)).filter(Boolean) as BacktestPlayer[]);
  let best: TransferChoice = { transfers: [], projectedGain: 0 };

  const candidates = candidatePlayers(input.players, input.maxCandidatesPerPosition).filter(player => !squadIds.has(player.id));
  for (const outgoing of input.squad) {
    const outgoingPlayer = playersById.get(outgoing.playerId);
    if (!outgoingPlayer) continue;
    for (const incoming of candidates) {
      if (incoming.elementType !== outgoingPlayer.elementType) continue;
      const sellingPrice = calculateSellingPrice(outgoing.purchasePrice, outgoingPlayer.price);
      const bankAfter = input.bank + sellingPrice - incoming.price;
      if (bankAfter < 0) continue;
      const finalPlayers = input.squad
        .filter(pick => pick.playerId !== outgoing.playerId)
        .map(pick => playersById.get(pick.playerId))
        .filter(Boolean) as BacktestPlayer[];
      finalPlayers.push(incoming);
      if (!validateSquad(finalPlayers, finalPlayers.reduce((total, player) => total + player.price, bankAfter)).valid) continue;
      const gainBeforeHits = scoreSquad(finalPlayers) - currentScore;
      const hitCost = input.freeTransfers >= 1 ? 0 : FPL_RULES.hitCost;
      const projectedGain = gainBeforeHits - hitCost;
      if (projectedGain <= 0) continue;
      if (hitCost > 0 && gainBeforeHits < input.hitThreshold) continue;
      if (projectedGain > best.projectedGain || (projectedGain === best.projectedGain && incoming.id < (best.transfers[0]?.in ?? Number.POSITIVE_INFINITY))) {
        best = { transfers: [{ out: outgoing.playerId, in: incoming.id }], projectedGain };
      }
    }
  }

  return best;
}

function candidatePlayers(players: BacktestPlayer[], maxPerPosition: number): BacktestPlayer[] {
  const result: BacktestPlayer[] = [];
  for (const elementType of [1, 2, 3, 4]) {
    result.push(...players
      .filter(player => POSITION_BY_ELEMENT_TYPE[player.elementType] && player.elementType === elementType)
      .sort((a, b) => b.expectedPoints - a.expectedPoints || a.price - b.price || a.id - b.id)
      .slice(0, maxPerPosition));
  }
  return result;
}

function scoreSquad(players: BacktestPlayer[]): number {
  return players.reduce((total, player) => total + player.expectedPoints, 0);
}

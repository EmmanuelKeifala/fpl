import { FPL_RULES, POSITION_BY_ELEMENT_TYPE, type PositionKey } from '../../strategy/rules.js';
import type { BacktestPlayer } from '../types.js';

export interface SelectedLineup {
  startingXi: number[];
  bench: number[];
}

export interface SelectedCaptaincy {
  captain: number;
  viceCaptain: number;
}

export function selectLineup(playerIds: number[], playersById: Map<number, BacktestPlayer>): SelectedLineup {
  const players = playerIds.map(playerId => getPlayer(playerId, playersById));
  const rankedByPosition = new Map<PositionKey, BacktestPlayer[]>();
  for (const position of Object.keys(FPL_RULES.squadComposition) as PositionKey[]) {
    rankedByPosition.set(position, rankPlayers(players.filter(player => POSITION_BY_ELEMENT_TYPE[player.elementType] === position)));
  }

  let bestStartingXi: BacktestPlayer[] | undefined;
  let bestScore = -Infinity;
  const goalkeeperCount = FPL_RULES.formation.goalkeeper.min;

  for (let defenderCount = FPL_RULES.formation.defender.min; defenderCount <= FPL_RULES.formation.defender.max; defenderCount++) {
    for (let midfielderCount = FPL_RULES.formation.midfielder.min; midfielderCount <= FPL_RULES.formation.midfielder.max; midfielderCount++) {
      const forwardCount = FPL_RULES.startingSize - goalkeeperCount - defenderCount - midfielderCount;
      if (forwardCount < FPL_RULES.formation.forward.min || forwardCount > FPL_RULES.formation.forward.max) continue;
      const candidate = [
        ...topRanked(rankedByPosition, 'goalkeeper', goalkeeperCount),
        ...topRanked(rankedByPosition, 'defender', defenderCount),
        ...topRanked(rankedByPosition, 'midfielder', midfielderCount),
        ...topRanked(rankedByPosition, 'forward', forwardCount),
      ];
      if (candidate.length !== FPL_RULES.startingSize) continue;
      const orderedCandidate = rankPlayers(candidate);
      const score = scorePlayers(orderedCandidate);
      if (!bestStartingXi || score > bestScore || (score === bestScore && comparePlayerLists(orderedCandidate, bestStartingXi) < 0)) {
        bestStartingXi = orderedCandidate;
        bestScore = score;
      }
    }
  }

  if (!bestStartingXi) throw new Error('No starting XI satisfies formation rules');
  const startingIds = new Set(bestStartingXi.map(player => player.id));
  return {
    startingXi: bestStartingXi.map(player => player.id),
    bench: rankPlayerIds(playerIds.filter(playerId => !startingIds.has(playerId)), playersById),
  };
}

export function selectCaptaincy(startingXi: number[], playersById: Map<number, BacktestPlayer>): SelectedCaptaincy {
  const ranked = rankPlayerIds(startingXi, playersById);
  if (ranked.length < 2) throw new Error('Captaincy requires at least two starters');
  return { captain: ranked[0]!, viceCaptain: ranked[1]! };
}

export function rankPlayerIds(playerIds: number[], playersById: Map<number, BacktestPlayer>): number[] {
  return [...playerIds].sort((a, b) => {
    const playerA = getPlayer(a, playersById);
    const playerB = getPlayer(b, playersById);
    return playerB.expectedPoints - playerA.expectedPoints || a - b;
  });
}

export function rankPlayers(players: BacktestPlayer[]): BacktestPlayer[] {
  return [...players].sort((a, b) => b.expectedPoints - a.expectedPoints || a.id - b.id);
}

function topRanked(rankedByPosition: Map<PositionKey, BacktestPlayer[]>, position: PositionKey, count: number): BacktestPlayer[] {
  const players = rankedByPosition.get(position) ?? [];
  return players.length >= count ? players.slice(0, count) : [];
}

function scorePlayers(players: BacktestPlayer[]): number {
  return players.reduce((total, player) => total + player.expectedPoints, 0);
}

function comparePlayerLists(left: BacktestPlayer[], right: BacktestPlayer[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index]!.id !== right[index]!.id) return left[index]!.id - right[index]!.id;
  }
  return left.length - right.length;
}

function getPlayer(playerId: number, playersById: Map<number, BacktestPlayer>): BacktestPlayer {
  const player = playersById.get(playerId);
  if (!player) throw new Error(`Player ${playerId} is missing from gameweek snapshot`);
  return player;
}

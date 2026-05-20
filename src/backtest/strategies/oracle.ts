import { buildInitialSquad } from './baseline.js';
import { selectCaptaincy, selectLineup } from './lineup.js';
import type { BacktestStrategy, GameweekSnapshot } from '../types.js';

export function createOracleStrategy(snapshots: GameweekSnapshot[]): BacktestStrategy {
  const snapshotsByGameweek = new Map(snapshots.map(snapshot => [snapshot.gameweek, snapshot]));
  const tripleCaptainGameweek = findBestTripleCaptainGameweek(snapshots);

  return ({ state, snapshot }) => {
    const current = snapshotsByGameweek.get(snapshot.gameweek);
    if (!current) throw new Error(`Oracle snapshot schedule is missing GW${snapshot.gameweek}`);
    const actualPoints = new Map(current.actualResults.playerResults.map(result => [result.playerId, result.totalPoints]));
    const oraclePlayers = current.knownBeforeDeadline.players.map(player => ({ ...player, expectedPoints: actualPoints.get(player.id) ?? 0 }));
    const playersById = new Map(oraclePlayers.map(player => [player.id, player]));
    const squad = current.gameweek === 1 ? buildInitialSquad(oraclePlayers) : undefined;
    const lineupPool = squad ?? state.squad.map(pick => pick.playerId);
    const { startingXi, bench } = selectLineup(lineupPool, playersById);
    const { captain, viceCaptain } = selectCaptaincy(startingXi, playersById);
    const chip = state.chipsAvailable.includes('3xc') && current.gameweek === tripleCaptainGameweek ? '3xc' : undefined;
    return { gameweek: current.gameweek, squad, transfers: [], startingXi, bench, captain, viceCaptain, chip, notes: ['Oracle hindsight strategy'] };
  };
}

function findBestTripleCaptainGameweek(snapshots: GameweekSnapshot[]): number | undefined {
  let bestGameweek: number | undefined;
  let bestPlayerPoints = -Infinity;

  for (const snapshot of snapshots) {
    const actualPoints = new Map(snapshot.actualResults.playerResults.map(result => [result.playerId, result.totalPoints]));
    const gameweekBest = Math.max(...snapshot.knownBeforeDeadline.players.map(player => actualPoints.get(player.id) ?? 0));
    if (gameweekBest > bestPlayerPoints) {
      bestGameweek = snapshot.gameweek;
      bestPlayerPoints = gameweekBest;
    }
  }

  return bestGameweek;
}

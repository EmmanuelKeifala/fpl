import { buildInitialSquad } from './baseline.js';
import { selectCaptaincy, selectLineup } from './lineup.js';
import type { BacktestStrategy, GameweekSnapshot } from '../types.js';

export function createOracleStrategy(snapshots: GameweekSnapshot[]): BacktestStrategy {
  const snapshotsByGameweek = new Map(snapshots.map(snapshot => [snapshot.gameweek, snapshot]));
  const initialSquad = snapshotsByGameweek.has(1) ? buildInitialSquad(projectPlayersByActualPoints(snapshotsByGameweek.get(1)!)) : undefined;
  const tripleCaptainGameweek = initialSquad ? findBestTripleCaptainGameweek(snapshots, initialSquad) : undefined;

  return ({ state, snapshot }) => {
    const current = snapshotsByGameweek.get(snapshot.gameweek);
    if (!current) throw new Error(`Oracle snapshot schedule is missing GW${snapshot.gameweek}`);
    if (!initialSquad) throw new Error('Oracle snapshot schedule is missing GW1');
    const oraclePlayers = projectPlayersByActualPoints(current);
    const playersById = new Map(oraclePlayers.map(player => [player.id, player]));
    const squad = current.gameweek === 1 ? initialSquad : undefined;
    const lineupPool = squad ?? state.squad.map(pick => pick.playerId);
    const { startingXi, bench } = selectLineup(lineupPool, playersById);
    const { captain, viceCaptain } = selectCaptaincy(startingXi, playersById);
    const chip = state.chipsAvailable.includes('3xc') && current.gameweek === tripleCaptainGameweek ? '3xc' : undefined;
    return { gameweek: current.gameweek, squad, transfers: [], startingXi, bench, captain, viceCaptain, chip, notes: ['Oracle hindsight strategy'] };
  };
}

function findBestTripleCaptainGameweek(snapshots: GameweekSnapshot[], initialSquad: number[]): number | undefined {
  let bestGameweek: number | undefined;
  let bestCaptainPoints = -Infinity;

  for (const snapshot of snapshots) {
    const oraclePlayers = projectPlayersByActualPoints(snapshot);
    const playersById = new Map(oraclePlayers.map(player => [player.id, player]));
    const { startingXi } = selectLineup(initialSquad, playersById);
    const { captain } = selectCaptaincy(startingXi, playersById);
    const captainPoints = playersById.get(captain)!.expectedPoints;
    if (captainPoints > bestCaptainPoints) {
      bestGameweek = snapshot.gameweek;
      bestCaptainPoints = captainPoints;
    }
  }

  return bestGameweek;
}

function projectPlayersByActualPoints(snapshot: GameweekSnapshot) {
  const actualPoints = new Map(snapshot.actualResults.playerResults.map(result => [result.playerId, result.totalPoints]));
  return snapshot.knownBeforeDeadline.players.map(player => ({ ...player, expectedPoints: actualPoints.get(player.id) ?? 0 }));
}

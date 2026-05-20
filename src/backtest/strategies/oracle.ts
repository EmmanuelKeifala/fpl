import { buildInitialSquad } from './baseline.js';
import { selectCaptaincy, selectLineup } from './lineup.js';
import type { BacktestStrategy, GameweekSnapshot } from '../types.js';

export function createOracleStrategy(snapshots: GameweekSnapshot[]): BacktestStrategy {
  return ({ state, snapshot }) => {
    const current = (snapshots.find(candidate => candidate.gameweek === snapshot.gameweek) ?? snapshot) as GameweekSnapshot;
    const actualPoints = new Map(current.actualResults.playerResults.map(result => [result.playerId, result.totalPoints]));
    const oraclePlayers = current.knownBeforeDeadline.players.map(player => ({ ...player, expectedPoints: actualPoints.get(player.id) ?? 0 }));
    const playersById = new Map(oraclePlayers.map(player => [player.id, player]));
    const squad = current.gameweek === 1 ? buildInitialSquad(oraclePlayers) : undefined;
    const lineupPool = squad ?? state.squad.map(pick => pick.playerId);
    const { startingXi, bench } = selectLineup(lineupPool, playersById);
    const { captain, viceCaptain } = selectCaptaincy(startingXi, playersById);
    const chip = state.chipsAvailable.includes('3xc') && current.gameweek >= 1 ? '3xc' : undefined;
    return { gameweek: current.gameweek, squad, transfers: [], startingXi, bench, captain, viceCaptain, chip, notes: ['Oracle hindsight strategy'] };
  };
}

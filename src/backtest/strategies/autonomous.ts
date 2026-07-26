import { buildCandidateDecisions } from '../experiments/candidates.js';
import type {
  BacktestDecision,
  BacktestPlayer,
  BacktestStrategy,
  DecisionSnapshotInput,
  ManagerState,
  PlayerGameweekResult,
} from '../types.js';
import { availableRebuildBudget, buildSquadWithinBudget, replacementTransfers } from './fair.js';
import { selectCaptaincy, selectLineup } from './lineup.js';
import type { ChipName } from '../../strategy/rules.js';

export function createAutonomousReplayStrategy(): BacktestStrategy {
  return ({ state, snapshot, revealedResults }) => {
    const players = applyRollingForm(snapshot.knownBeforeDeadline.players, revealedResults ?? []);
    const adjustedSnapshot: DecisionSnapshotInput = {
      ...snapshot,
      knownBeforeDeadline: { ...snapshot.knownBeforeDeadline, players },
    };
    const candidates = buildCandidateDecisions({
      state,
      snapshot: adjustedSnapshot,
      maxCandidates: 30,
      allowHits: true,
      hitThreshold: 8,
    });
    const decision = candidates
      .map(candidate => ({
        candidate,
        utility: candidate.projectedPoints - Math.max(0, candidate.decision.transfers.length - state.freeTransfers) * 4,
      }))
      .sort((a, b) => b.utility - a.utility || a.candidate.id.localeCompare(b.candidate.id))[0]!.candidate.decision;
    decision.notes = [...decision.notes, 'Rolling point-in-time autonomous replay'];

    if (snapshot.gameweek === 1) return decision;
    return applyChipPolicy(state, adjustedSnapshot, decision);
  };
}

function applyRollingForm(
  players: BacktestPlayer[],
  history: { gameweek: number; playerResults: PlayerGameweekResult[] }[]
): BacktestPlayer[] {
  // Historical FPL xP is already a pre-deadline forecast. Preserve it until
  // rolling-form weights can be calibrated out-of-sample rather than guessed.
  if (history.length > 0) return players;
  const recent = history.slice(-6);
  const resultsByPlayer = new Map<number, PlayerGameweekResult[]>();
  for (const gameweek of recent) {
    for (const result of gameweek.playerResults) {
      resultsByPlayer.set(result.playerId, [...(resultsByPlayer.get(result.playerId) ?? []), result]);
    }
  }

  return players.map(player => {
    const results = resultsByPlayer.get(player.id) ?? [];
    if (results.length < 2) return player;
    const averagePoints = results.reduce((sum, result) => sum + result.totalPoints, 0) / results.length;
    const appearanceRate = results.filter(result => result.minutes > 0).length / results.length;
    const rollingWeight = Math.min(0.35, results.length / 20);
    return {
      ...player,
      expectedPoints: Math.max(0,
        (player.expectedPoints * (1 - rollingWeight) + averagePoints * rollingWeight) * (0.75 + appearanceRate * 0.25)
      ),
    };
  });
}

function applyChipPolicy(
  state: ManagerState,
  snapshot: DecisionSnapshotInput,
  baseDecision: BacktestDecision
): BacktestDecision {
  const playersById = new Map(snapshot.knownBeforeDeadline.players.map(player => [player.id, player]));
  const currentIds = state.squad.map(pick => pick.playerId);
  const phaseOffset = snapshot.gameweek <= 19 ? 0 : 19;
  const fallbackWeek: Record<ChipName, number> = {
    wildcard: phaseOffset + 16,
    freehit: phaseOffset + 17,
    '3xc': phaseOffset + 18,
    bboost: phaseOffset + 19,
  };
  const teamFixtureCounts = new Map<number, number>();
  const currentFixtures = snapshot.knownBeforeDeadline.fixtures.filter(fixture => fixture.event === snapshot.gameweek);
  for (const fixture of currentFixtures) {
    teamFixtureCounts.set(fixture.teamHome, (teamFixtureCounts.get(fixture.teamHome) ?? 0) + 1);
    teamFixtureCounts.set(fixture.teamAway, (teamFixtureCounts.get(fixture.teamAway) ?? 0) + 1);
  }

  const rebuildBudget = availableRebuildBudget(state, playersById);
  const rebuiltIds = buildSquadWithinBudget(snapshot.knownBeforeDeadline.players, rebuildBudget);
  const currentProjected = projected(currentIds, playersById);
  const rebuiltProjected = rebuiltIds ? projected(rebuiltIds, playersById) : currentProjected;
  const wildcardDue = state.chipsAvailable.includes('wildcard') &&
    ((snapshot.gameweek >= phaseOffset + 8 && rebuiltProjected - currentProjected >= 12) || snapshot.gameweek === fallbackWeek.wildcard);
  if (wildcardDue && rebuiltIds) return rebuildDecision(snapshot.gameweek, currentIds, rebuiltIds, playersById, 'wildcard');

  const startingTeams = baseDecision.startingXi.map(playerId => playersById.get(playerId)?.team).filter((team): team is number => team !== undefined);
  const blankingStarters = startingTeams.filter(team => (teamFixtureCounts.get(team) ?? 0) === 0).length;
  const isBlankGameweek = currentFixtures.length < 10;
  const freeHitDue = state.chipsAvailable.includes('freehit') &&
    ((isBlankGameweek && blankingStarters >= 4) || snapshot.gameweek === fallbackWeek.freehit);
  if (freeHitDue && rebuiltIds) return rebuildDecision(snapshot.gameweek, currentIds, rebuiltIds, playersById, 'freehit');

  const captain = playersById.get(baseDecision.captain);
  const captainHasDouble = captain ? (teamFixtureCounts.get(captain.team) ?? 0) >= 2 : false;
  if (state.chipsAvailable.includes('3xc') &&
      ((captainHasDouble && (captain?.expectedPoints ?? 0) >= 10) || snapshot.gameweek === fallbackWeek['3xc'])) {
    return { ...baseDecision, chip: '3xc', notes: [...baseDecision.notes, 'Deferred triple-captain opportunity policy'] };
  }

  const benchProjection = projected(baseDecision.bench, playersById);
  const benchHasDouble = baseDecision.bench.some(playerId => {
    const player = playersById.get(playerId);
    return player ? (teamFixtureCounts.get(player.team) ?? 0) >= 2 : false;
  });
  if (state.chipsAvailable.includes('bboost') &&
      ((benchHasDouble && benchProjection >= 15) || snapshot.gameweek === fallbackWeek.bboost)) {
    return { ...baseDecision, chip: 'bboost', notes: [...baseDecision.notes, 'Deferred bench-boost opportunity policy'] };
  }

  return baseDecision;
}

function rebuildDecision(
  gameweek: number,
  currentIds: number[],
  rebuiltIds: number[],
  playersById: Map<number, BacktestPlayer>,
  chip: 'wildcard' | 'freehit'
): BacktestDecision {
  const lineup = selectLineup(rebuiltIds, playersById);
  const captaincy = selectCaptaincy(lineup.startingXi, playersById);
  return {
    gameweek,
    transfers: replacementTransfers(currentIds, rebuiltIds),
    startingXi: lineup.startingXi,
    bench: lineup.bench,
    captain: captaincy.captain,
    viceCaptain: captaincy.viceCaptain,
    chip,
    notes: [`Deferred ${chip} opportunity policy`],
  };
}

function projected(playerIds: number[], playersById: Map<number, BacktestPlayer>): number {
  return playerIds.reduce((sum, playerId) => sum + (playersById.get(playerId)?.expectedPoints ?? 0), 0);
}

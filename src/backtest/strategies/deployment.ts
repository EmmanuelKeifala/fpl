import { buildCandidateDecisions } from '../experiments/candidates.js';
import type {
  BacktestDecision,
  BacktestFixture,
  BacktestPlayer,
  BacktestStrategy,
  DecisionSnapshotInput,
  GameweekSnapshot,
  ManagerState,
  ReplayExecutionProfile,
} from '../types.js';
import { FPL_RULES, isChipAvailableInGameweek } from '../../strategy/rules.js';
import { availableRebuildBudget, buildSquadWithinBudget, replacementTransfers } from './fair.js';
import { selectCaptaincy, selectLineup } from './lineup.js';

const FDR_WEIGHTS: Record<number, number> = { 1: 1.3, 2: 1.15, 3: 1, 4: 0.85, 5: 0.7 };

export interface DeploymentReplayPolicy {
  planningHorizonGameweeks: number;
  minXPGainForHit: number;
  maxCandidates: number;
}

export const DEPLOYMENT_REPLAY_POLICY: DeploymentReplayPolicy = {
  planningHorizonGameweeks: 6,
  minXPGainForHit: 8,
  maxCandidates: 40,
};

// Selected on the 2024-2025 validation season before diagnostic 2025-2026 replay.
export const ML_DEPLOYMENT_REPLAY_POLICY: DeploymentReplayPolicy = {
  planningHorizonGameweeks: 1,
  minXPGainForHit: 8,
  maxCandidates: 40,
};

export const DEPLOYMENT_REPLAY_PROFILE: ReplayExecutionProfile = {
  name: 'full-deployment-shadow-v1',
  decisionTiming: 'final-pre-deadline',
  planningHorizonGameweeks: DEPLOYMENT_REPLAY_POLICY.planningHorizonGameweeks,
  maxTransfersPerGameweek: 2,
  minXPGainForHit: DEPLOYMENT_REPLAY_POLICY.minXPGainForHit,
  transfersEnabled: true,
  lineupEnabled: true,
  chipsEnabled: true,
  liveAccountMutations: false,
  historicalNews: 'unavailable',
  historicalLearning: 'revealed-results-only',
  limitations: [
    'Weekly snapshots model one final execute decision, not repeated monitor and plan polling.',
    'Historical injury, availability, and timestamped news are unavailable.',
    'Six-gameweek planning uses the reconstructed final fixture schedule.',
    'Historical forecasts are lagged reconstructions, not the live optimizer database state.',
    'The GW1 squad is synthesized because the deployed runner expects an existing account squad.',
  ],
};

export const ML_DEPLOYMENT_REPLAY_PROFILE: ReplayExecutionProfile = {
  ...DEPLOYMENT_REPLAY_PROFILE,
  name: 'full-deployment-ml-shadow-v1',
  planningHorizonGameweeks: ML_DEPLOYMENT_REPLAY_POLICY.planningHorizonGameweeks,
  minXPGainForHit: ML_DEPLOYMENT_REPLAY_POLICY.minXPGainForHit,
  limitations: [
    ...DEPLOYMENT_REPLAY_PROFILE.limitations.filter(
      limitation => !limitation.startsWith('Six-gameweek planning')
    ),
    'The one-gameweek planning policy was selected on the 2024-2025 validation season.',
    'Player forecasts come from a prior-season identity-independent ML model.',
  ],
};

export function createDeploymentReplayStrategy(
  snapshots: readonly GameweekSnapshot[],
  policy: DeploymentReplayPolicy = DEPLOYMENT_REPLAY_POLICY
): BacktestStrategy {
  const fixturesByGameweek = new Map(snapshots.map(snapshot => [
    snapshot.gameweek,
    snapshot.knownBeforeDeadline.fixtures.map(fixture => ({ ...fixture })),
  ]));

  return ({ state, snapshot }) => {
    const planningPlayers = snapshot.knownBeforeDeadline.players.map(player => ({
      ...player,
      expectedPoints: projectAcrossHorizon(
        player,
        snapshot.gameweek,
        policy.planningHorizonGameweeks,
        fixturesByGameweek
      ),
    }));
    const planningSnapshot: DecisionSnapshotInput = {
      ...snapshot,
      knownBeforeDeadline: { ...snapshot.knownBeforeDeadline, players: planningPlayers },
    };
    const candidates = buildCandidateDecisions({
      state,
      snapshot: planningSnapshot,
      maxCandidates: policy.maxCandidates,
      allowHits: true,
      hitThreshold: policy.minXPGainForHit,
    });
    const selected = candidates
      .map(candidate => ({
        candidate,
        utility: candidate.projectedPoints - projectedHitCost(candidate.decision, state),
      }))
      .sort((a, b) => b.utility - a.utility || a.candidate.id.localeCompare(b.candidate.id))[0]!;

    const executionPlayersById = new Map(snapshot.knownBeforeDeadline.players.map(player => [player.id, player]));
    const currentIds = state.squad.map(pick => pick.playerId);
    const selectedIds = selected.candidate.decision.squad
      ?? applyTransferIds(currentIds, selected.candidate.decision.transfers);
    const lineup = selectLineup(selectedIds, executionPlayersById);
    const captaincy = selectCaptaincy(lineup.startingXi, executionPlayersById);
    const baseDecision: BacktestDecision = {
      ...selected.candidate.decision,
      startingXi: lineup.startingXi,
      bench: lineup.bench,
      captain: captaincy.captain,
      viceCaptain: captaincy.viceCaptain,
      expectedUtility: selected.utility,
      execution: {
        phase: 'execute',
        freeTransfersBefore: state.freeTransfers,
        bankBefore: state.bank,
        projectedHitCost: projectedHitCost(selected.candidate.decision, state),
      },
      notes: [
        ...selected.candidate.decision.notes,
        `${DEPLOYMENT_REPLAY_PROFILE.name}: ${policy.planningHorizonGameweeks}-gameweek plan, final-deadline execution`,
      ],
    };

    return applyDeploymentChipPolicy(state, snapshot, planningPlayers, baseDecision);
  };
}

function applyDeploymentChipPolicy(
  state: ManagerState,
  snapshot: DecisionSnapshotInput,
  planningPlayers: BacktestPlayer[],
  baseDecision: BacktestDecision
): BacktestDecision {
  const currentPlayersById = new Map(snapshot.knownBeforeDeadline.players.map(player => [player.id, player]));
  const planningPlayersById = new Map(planningPlayers.map(player => [player.id, player]));
  const currentIds = state.squad.map(pick => pick.playerId);
  if (currentIds.length !== FPL_RULES.squadSize) return baseDecision;
  const opportunities: {
    chip: 'wildcard' | 'freehit' | 'bboost' | '3xc';
    gain: number;
    recommended: boolean;
    decision: BacktestDecision;
  }[] = [];

  const teamFixtureCounts = new Map<number, number>();
  for (const fixture of snapshot.knownBeforeDeadline.fixtures) {
    teamFixtureCounts.set(fixture.teamHome, (teamFixtureCounts.get(fixture.teamHome) ?? 0) + 1);
    teamFixtureCounts.set(fixture.teamAway, (teamFixtureCounts.get(fixture.teamAway) ?? 0) + 1);
  }

  const phaseOffset = snapshot.gameweek <= 19 ? 0 : 19;
  if (chipAvailable(state, 'wildcard', snapshot.gameweek) && snapshot.gameweek >= phaseOffset + 5) {
    const budget = availableRebuildBudget(state, currentPlayersById);
    const rebuiltIds = buildSquadWithinBudget(planningPlayers, budget);
    if (rebuiltIds) {
      const gain = scoreProjectedTeam(rebuiltIds, planningPlayersById) - scoreProjectedTeam(currentIds, planningPlayersById);
      opportunities.push({
        chip: 'wildcard',
        gain,
        recommended: gain >= 12,
        decision: rebuildDecision(snapshot.gameweek, currentIds, rebuiltIds, currentPlayersById, 'wildcard', gain, state),
      });
    }
  }

  if (chipAvailable(state, 'freehit', snapshot.gameweek)) {
    const blankingStarters = baseDecision.startingXi.filter(playerId => {
      const player = currentPlayersById.get(playerId);
      return player ? (teamFixtureCounts.get(player.team) ?? 0) === 0 : false;
    }).length;
    const budget = availableRebuildBudget(state, currentPlayersById);
    const rebuiltIds = buildSquadWithinBudget(snapshot.knownBeforeDeadline.players, budget);
    if (rebuiltIds) {
      const gain = scoreProjectedTeam(rebuiltIds, currentPlayersById) - scoreProjectedTeam(currentIds, currentPlayersById);
      opportunities.push({
        chip: 'freehit',
        gain,
        recommended: snapshot.knownBeforeDeadline.fixtures.length < 10 && blankingStarters >= 4 && gain >= 8,
        decision: rebuildDecision(snapshot.gameweek, currentIds, rebuiltIds, currentPlayersById, 'freehit', gain, state),
      });
    }
  }

  const captain = currentPlayersById.get(baseDecision.captain);
  if (chipAvailable(state, '3xc', snapshot.gameweek) && captain) {
    opportunities.push({
      chip: '3xc',
      gain: captain.expectedPoints,
      recommended: (teamFixtureCounts.get(captain.team) ?? 0) >= 2 && captain.expectedPoints > 12,
      decision: {
        ...baseDecision,
        chip: '3xc',
        notes: [...baseDecision.notes, `Triple Captain: ${captain.expectedPoints.toFixed(1)} projected captain gain`],
      },
    });
  }

  const benchProjection = baseDecision.bench.reduce(
    (total, playerId) => total + (currentPlayersById.get(playerId)?.expectedPoints ?? 0),
    0
  );
  const benchHasDouble = baseDecision.bench.some(playerId => {
    const player = currentPlayersById.get(playerId);
    return player ? (teamFixtureCounts.get(player.team) ?? 0) >= 2 : false;
  });
  if (chipAvailable(state, 'bboost', snapshot.gameweek)) {
    opportunities.push({
      chip: 'bboost',
      gain: benchProjection,
      recommended: benchHasDouble && benchProjection > 12,
      decision: {
        ...baseDecision,
        chip: 'bboost',
        notes: [...baseDecision.notes, `Bench Boost: ${benchProjection.toFixed(1)} projected bench gain`],
      },
    });
  }

  const recommended = opportunities
    .filter(opportunity => opportunity.recommended)
    .sort((a, b) => b.gain - a.gain || a.chip.localeCompare(b.chip))[0];
  if (recommended) return recommended.decision;

  const finalWindowGameweek = snapshot.gameweek <= 19 ? 19 : 38;
  const gameweeksRemaining = finalWindowGameweek - snapshot.gameweek + 1;
  const positiveExpiryOptions = opportunities.filter(opportunity => opportunity.gain > 0);
  if (positiveExpiryOptions.length > 0 && gameweeksRemaining <= opportunities.length) {
    const expiring = positiveExpiryOptions.sort((a, b) => b.gain - a.gain || a.chip.localeCompare(b.chip))[0]!;
    return {
      ...expiring.decision,
      notes: [
        ...expiring.decision.notes,
        `Expiry guard: ${gameweeksRemaining} gameweeks remain for ${opportunities.length} chip instances`,
      ],
    };
  }

  return baseDecision;
}

function rebuildDecision(
  gameweek: number,
  currentIds: number[],
  rebuiltIds: number[],
  playersById: Map<number, BacktestPlayer>,
  chip: 'wildcard' | 'freehit',
  projectedGain: number,
  state: ManagerState
): BacktestDecision {
  const lineup = selectLineup(rebuiltIds, playersById);
  const captaincy = selectCaptaincy(lineup.startingXi, playersById);
  return {
    gameweek,
    transfers: replacementTransfers(currentIds, rebuiltIds, playersById),
    startingXi: lineup.startingXi,
    bench: lineup.bench,
    captain: captaincy.captain,
    viceCaptain: captaincy.viceCaptain,
    chip,
    expectedUtility: projectedGain,
    execution: {
      phase: 'execute',
      freeTransfersBefore: state.freeTransfers,
      bankBefore: state.bank,
      projectedHitCost: 0,
    },
    notes: [
      `${DEPLOYMENT_REPLAY_PROFILE.name}: ${chip} rebuild`,
      `Projected ${chip} gain ${projectedGain.toFixed(1)}`,
    ],
  };
}

function chipAvailable(state: ManagerState, chip: 'wildcard' | 'freehit' | 'bboost' | '3xc', gameweek: number): boolean {
  return state.chipsAvailable.includes(chip) && isChipAvailableInGameweek(chip, gameweek);
}

function projectedHitCost(decision: BacktestDecision, state: ManagerState): number {
  if (decision.chip === 'wildcard' || decision.chip === 'freehit') return 0;
  return Math.max(0, decision.transfers.length - state.freeTransfers) * FPL_RULES.hitCost;
}

function projectAcrossHorizon(
  player: BacktestPlayer,
  gameweek: number,
  horizon: number,
  fixturesByGameweek: Map<number, BacktestFixture[]>
): number {
  const currentFixtureWeight = fixtureWeight(player.team, fixturesByGameweek.get(gameweek) ?? []);
  const baselineWeight = currentFixtureWeight > 0 ? currentFixtureWeight : 1;
  let projection = 0;

  for (let offset = 0; offset < horizon; offset++) {
    const weight = fixtureWeight(player.team, fixturesByGameweek.get(gameweek + offset) ?? []);
    if (weight === 0) continue;
    projection += player.expectedPoints * (weight / baselineWeight) * Math.pow(0.92, offset);
  }

  return Math.max(0, Math.round(projection * 100) / 100);
}

function fixtureWeight(team: number, fixtures: BacktestFixture[]): number {
  return fixtures.reduce((total, fixture) => {
    if (fixture.teamHome === team) return total + (FDR_WEIGHTS[fixture.teamHomeDifficulty] ?? 1);
    if (fixture.teamAway === team) return total + (FDR_WEIGHTS[fixture.teamAwayDifficulty] ?? 1);
    return total;
  }, 0);
}

function scoreProjectedTeam(playerIds: number[], playersById: Map<number, BacktestPlayer>): number {
  const lineup = selectLineup(playerIds, playersById);
  const captaincy = selectCaptaincy(lineup.startingXi, playersById);
  return lineup.startingXi.reduce((total, playerId) => total + (playersById.get(playerId)?.expectedPoints ?? 0), 0)
    + (playersById.get(captaincy.captain)?.expectedPoints ?? 0);
}

function applyTransferIds(playerIds: number[], transfers: BacktestDecision['transfers']): number[] {
  let result = [...playerIds];
  for (const transfer of transfers) result = [...result.filter(playerId => playerId !== transfer.out), transfer.in];
  return result;
}

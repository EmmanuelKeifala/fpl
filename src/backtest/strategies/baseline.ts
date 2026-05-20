import { FPL_RULES, POSITION_BY_ELEMENT_TYPE, type PositionKey } from '../../strategy/rules.js';
import type { BacktestPlayer, BacktestStrategy } from '../types.js';
import { rankPlayers, selectCaptaincy, selectLineup } from './lineup.js';

export function deterministicStrategy(): BacktestStrategy {
  return ({ state, snapshot }) => {
    const playersById = new Map(snapshot.knownBeforeDeadline.players.map(player => [player.id, player]));
    const squad = snapshot.gameweek === 1 ? buildInitialSquad(snapshot.knownBeforeDeadline.players) : undefined;
    const lineupPool = squad ?? state.squad.map(pick => pick.playerId);
    const { startingXi, bench } = selectLineup(lineupPool, playersById);
    const { captain, viceCaptain } = selectCaptaincy(startingXi, playersById);

    return {
      gameweek: snapshot.gameweek,
      squad,
      transfers: [],
      startingXi,
      bench,
      captain,
      viceCaptain,
      notes: ['Deterministic baseline strategy for replay plumbing'],
    };
  };
}

export function buildInitialSquad(players: BacktestPlayer[]): number[] {
  const ranked = rankPlayers(players);
  const selected: BacktestPlayer[] = [];
  let spent = 0;

  while (selected.length < FPL_RULES.squadSize) {
    const remaining = ranked.filter(player => !selected.some(selectedPlayer => selectedPlayer.id === player.id));
    const candidate = remaining.find(player => {
      const minimumRemainingCost = minimumCostToCompleteSquad([...selected, player], remaining.filter(otherPlayer => otherPlayer.id !== player.id));
      if (minimumRemainingCost === undefined) return false;
      return spent + player.price + minimumRemainingCost <= FPL_RULES.initialBudget;
    });

    if (!candidate) {
      throw new Error(`No deterministic ${FPL_RULES.squadSize}-player squad fits the ${FPL_RULES.initialBudget} budget`);
    }

    selected.push(candidate);
    spent += candidate.price;
  }

  return selected.map(player => player.id);
}

function minimumCostToCompleteSquad(selected: BacktestPlayer[], remaining: BacktestPlayer[]): number | undefined {
  const selectedPositionCounts = countSelectedByPosition(selected);
  const selectedTeamCounts = countSelectedByTeam(selected);
  for (const [position, expected] of Object.entries(FPL_RULES.squadComposition)) {
    if (selectedPositionCounts[position as PositionKey] > expected) return undefined;
  }
  if ([...selectedTeamCounts.values()].some(count => count > FPL_RULES.maxPlayersPerClub)) return undefined;

  let cost = 0;
  const teamCounts = new Map(selectedTeamCounts);

  for (const [position, expected] of Object.entries(FPL_RULES.squadComposition)) {
    const positionKey = position as PositionKey;
    const required = expected - selectedPositionCounts[positionKey];
    const cheapest = remaining
      .filter(player => POSITION_BY_ELEMENT_TYPE[player.elementType] === positionKey)
      .sort((a, b) => a.price - b.price || a.id - b.id);

    for (let index = 0; index < required; index++) {
      const player = cheapest.find(candidate => (teamCounts.get(candidate.team) ?? 0) < FPL_RULES.maxPlayersPerClub);
      if (!player) return undefined;
      cost += player.price;
      teamCounts.set(player.team, (teamCounts.get(player.team) ?? 0) + 1);
      cheapest.splice(cheapest.indexOf(player), 1);
    }
  }

  return cost;
}

function countSelectedByPosition(players: BacktestPlayer[]): Record<PositionKey, number> {
  const counts: Record<PositionKey, number> = { goalkeeper: 0, defender: 0, midfielder: 0, forward: 0 };
  for (const player of players) {
    const position = POSITION_BY_ELEMENT_TYPE[player.elementType];
    if (position) counts[position]++;
  }
  return counts;
}

function countSelectedByTeam(players: BacktestPlayer[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const player of players) {
    counts.set(player.team, (counts.get(player.team) ?? 0) + 1);
  }
  return counts;
}

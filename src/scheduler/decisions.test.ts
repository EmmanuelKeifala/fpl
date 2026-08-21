import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { MyTeam, Player } from '../api/types.js';
import {
  buildUnlimitedSquad,
  calculateProtectTemplateBonus,
  getAtomicTransferConfidence,
  getActiveLineupChip,
  getFreeTransfers,
  getTransferPlanningHorizon,
  getUnlimitedTransferReason,
  isUnlimitedRebuildImprovement,
  parseOfficialOwnership,
  selectStableCaptaincy,
  shouldEnforceUnlimitedMarketFloor,
  type UnlimitedSquadCandidate,
} from './decisions.js';
import { deriveRankPolicy } from '../strategy/rank-policy.js';

function team(): MyTeam {
  return {
    picks: [],
    chips: [],
    transfers: { cost: 0, status: 'available', limit: 2, made: 1, bank: 0, value: 1000 },
  };
}

test('preseason unlimited transfers never create synthetic hit costs', () => {
  const value = team();
  value.transfers.status = 'unlimited';
  value.transfers.limit = null;
  value.transfers.made = 12;
  const reason = getUnlimitedTransferReason(value, [{ finished: false }]);
  assert.equal(getFreeTransfers(value), Number.POSITIVE_INFINITY);
  assert.equal(reason, 'preseason');
  assert.equal(getTransferPlanningHorizon(value, 6, reason), 3);
});

test('unlimited reason gives Free Hit one week and Wildcard the permanent horizon', () => {
  const value = team();
  value.transfers.status = 'unlimited';
  value.transfers.limit = null;
  const activeChip = (name: 'freehit' | 'wildcard') => ({
    name,
    number: 1,
    status_for_entry: 'active' as const,
    is_pending: true,
    played_by_entry: [],
    start_event: 1,
    stop_event: 19,
    chip_type: 'transfer',
  });

  value.chips = [activeChip('freehit')];
  const freeHit = getUnlimitedTransferReason(value, [{ finished: true }]);
  assert.equal(freeHit, 'freehit');
  assert.equal(getTransferPlanningHorizon(value, 6, freeHit), 1);

  value.chips = [activeChip('wildcard')];
  const wildcard = getUnlimitedTransferReason(value, [{ finished: true }]);
  assert.equal(wildcard, 'wildcard');
  assert.equal(getTransferPlanningHorizon(value, 6, wildcard), 6);
});

test('unexplained unlimited status fails to a one-week planning horizon', () => {
  const value = team();
  value.transfers.status = 'unlimited';
  const reason = getUnlimitedTransferReason(value, [{ finished: true }]);
  assert.equal(reason, 'unknown');
  assert.equal(getTransferPlanningHorizon(value, 6, reason), 1);
});

test('a null limit without explicit unlimited status fails closed', () => {
  const value = team();
  value.transfers.limit = null;
  value.transfers.status = 'available';
  assert.equal(getFreeTransfers(value), 0);
  assert.equal(getTransferPlanningHorizon(value, 6), 6);
});

test('active lineup chip is detected so later lineup updates preserve it', () => {
  const value = team();
  value.chips.push({
    name: 'bboost',
    number: 1,
    status_for_entry: 'active',
    is_pending: true,
    played_by_entry: [],
    start_event: 1,
    stop_event: 19,
    chip_type: 'team',
  });
  assert.equal(getActiveLineupChip(value), 'bboost');
});

test('captaincy avoids goalkeepers and retains a close attacking incumbent', () => {
  const candidate = (id: number, elementType: number, xp: number, xg: number): { player: Player; xp: number } => ({
    player: {
      id,
      element_type: elementType,
      expected_goals_per_90: xg,
      expected_assists_per_90: 0,
      penalties_order: null,
    } as Player,
    xp,
  });
  const starters = [candidate(1, 1, 4.2, 0), candidate(2, 3, 3.8, 0.3), candidate(3, 4, 3.5, 0.5)];
  const fromGoalkeeper = selectStableCaptaincy(starters, {
    picks: [
      { element: 1, position: 1, multiplier: 2, is_captain: true, is_vice_captain: false },
      { element: 3, position: 2, multiplier: 1, is_captain: false, is_vice_captain: true },
    ],
  });
  assert.notEqual(fromGoalkeeper.captain.player.element_type, 1);

  const stable = selectStableCaptaincy(starters, {
    picks: [
      { element: 3, position: 1, multiplier: 2, is_captain: true, is_vice_captain: false },
      { element: 2, position: 2, multiplier: 1, is_captain: false, is_vice_captain: true },
    ],
  });
  assert.equal(stable.captain.player.id, 3);
});

test('unlimited rebuild can fund a premium through multiple atomic enabler moves', () => {
  const costs = new Map([[1, 50], [2, 60], [3, 75], [4, 75]]);
  const candidates: UnlimitedSquadCandidate[] = [];
  let id = 1;
  for (const [position, count] of [[1, 2], [2, 5], [3, 5], [4, 3]] as const) {
    for (let index = 0; index < count; index++) {
      candidates.push(squadCandidate(id++, position, (index % 5) + 1, costs.get(position)!, 10, 5, true));
    }
  }
  const currentForward = candidates.find(candidate => candidate.player.element_type === 4)!;
  const premium = squadCandidate(100, 4, 10, 155, 30, 70, false);
  candidates.push(premium);
  for (let index = 0; index < 5; index++) {
    candidates.push(squadCandidate(110 + index, 2, 11 + index, 40, 9, 10, false));
  }

  assert.ok(premium.cost > currentForward.cost);
  const target = buildUnlimitedSquad(candidates, 1000);

  assert.ok(target);
  assert.ok(target.some(candidate => candidate.player.id === premium.player.id));
  assert.ok(target.filter(candidate => !candidate.currentlyOwned).length >= 2);
  assert.ok(target.reduce((sum, candidate) => sum + candidate.cost, 0) <= 1000);
  assert.deepEqual(positionCounts(target), { 1: 2, 2: 5, 3: 5, 4: 3 });
  assert.ok(Math.max(...clubCounts(target).values()) <= 3);
});

test('a bounded rank utility changes only a near-equal squad choice', () => {
  const baseline = exactSquadCandidates();
  const lowOwned = baseline.find(candidate => candidate.player.element_type === 3)!;
  lowOwned.projectedValue = 10;
  lowOwned.ownership = 0;
  const templateAlternative = squadCandidate(999, 3, 20, lowOwned.cost, 9.9, 64, false);
  const pure = buildUnlimitedSquad(
    [...baseline, { ...templateAlternative, ownershipUtility: 0 }],
    baseline.reduce((sum, candidate) => sum + candidate.cost, 0)
  );
  const weighted = buildUnlimitedSquad(
    baseline.map(candidate => ({ ...candidate, ownershipUtility: 0 })).concat({
      ...templateAlternative,
      ownershipUtility: 0.2,
    }),
    baseline.reduce((sum, candidate) => sum + candidate.cost, 0)
  );

  assert.ok(pure?.some(candidate => candidate.player.id === lowOwned.player.id));
  assert.ok(!pure?.some(candidate => candidate.player.id === templateAlternative.player.id));
  assert.ok(weighted?.some(candidate => candidate.player.id === templateAlternative.player.id));
  assert.equal(lowOwned.projectedValue, 10);
  assert.equal(templateAlternative.projectedValue, 9.9);
});

test('protect template weight changes a near tie without replacing rank utility', () => {
  const baseline = exactSquadCandidates();
  const lowOwned = baseline.find(candidate => candidate.player.element_type === 3)!;
  lowOwned.projectedValue = 10;
  lowOwned.ownership = 0;
  lowOwned.ownershipUtility = 0.07;
  const templateAlternative = {
    ...squadCandidate(1_000, 3, 20, lowOwned.cost, 9.9, 64, false),
    ownershipUtility: 0.07,
  };
  const budget = baseline.reduce((sum, candidate) => sum + candidate.cost, 0);
  const unweighted = buildUnlimitedSquad([...baseline, templateAlternative], budget);
  const weighted = buildUnlimitedSquad([
    ...baseline,
    {
      ...templateAlternative,
      templateProtectionBonus: calculateProtectTemplateBonus(templateAlternative.ownership, 3, 0.2),
    },
  ], budget);

  assert.ok(unweighted?.some(candidate => candidate.player.id === lowOwned.player.id));
  assert.ok(!unweighted?.some(candidate => candidate.player.id === templateAlternative.player.id));
  assert.ok(weighted?.some(candidate => candidate.player.id === templateAlternative.player.id));
  assert.equal(templateAlternative.ownershipUtility, lowOwned.ownershipUtility);
});

test('protect-mode unlimited constraints enforce core coverage and an anchor atomically', () => {
  const baseline = exactSquadCandidates();
  baseline[0]!.templateCore = true;
  baseline[1]!.templateCore = true;
  const replaceableMidfielder = baseline.find(candidate => candidate.player.element_type === 3)!;
  const anchor = {
    ...squadCandidate(1_001, 3, 20, replaceableMidfielder.cost, 8, 70, false),
    templateCore: true,
    requiredAnchor: true,
  };

  const target = buildUnlimitedSquad(
    [...baseline, anchor],
    baseline.reduce((sum, candidate) => sum + candidate.cost, 0),
    3,
    undefined,
    { minimumTemplateCorePlayers: 3, requireTemplateAnchor: true }
  );

  assert.ok(target?.some(candidate => candidate.player.id === anchor.player.id));
  assert.ok((target?.filter(candidate => candidate.templateCore).length ?? 0) >= 3);
});

test('configured unlimited market floor fails closed when core or anchor candidates are missing', () => {
  const baseline = exactSquadCandidates();
  const budget = baseline.reduce((sum, candidate) => sum + candidate.cost, 0);

  assert.equal(buildUnlimitedSquad(
    baseline,
    budget,
    3,
    undefined,
    { minimumTemplateCorePlayers: 1 }
  ), null);

  baseline[0]!.templateCore = true;
  assert.equal(buildUnlimitedSquad(
    baseline,
    budget,
    3,
    undefined,
    { minimumTemplateCorePlayers: 1, requireTemplateAnchor: true }
  ), null);
});

test('market floor protects early-season balanced squads but not push squads', () => {
  const earlyBalanced = deriveRankPolicy({
    gameweek: 1,
    overallRank: 5_000_000,
    targetRank: 100_000,
  });
  const protect = deriveRankPolicy({
    gameweek: 20,
    overallRank: 25_000,
    targetRank: 100_000,
  });
  const push = deriveRankPolicy({
    gameweek: 20,
    overallRank: 500_000,
    targetRank: 100_000,
  });

  assert.equal(shouldEnforceUnlimitedMarketFloor(earlyBalanced), true);
  assert.equal(shouldEnforceUnlimitedMarketFloor(protect), true);
  assert.equal(shouldEnforceUnlimitedMarketFloor(push), false);
});

test('atomic unlimited safety rejects any negative pure xP and uses weakest confidence', () => {
  assert.equal(isUnlimitedRebuildImprovement(-Number.EPSILON, 1), false);
  assert.equal(isUnlimitedRebuildImprovement(0, 0.1), true);
  assert.equal(isUnlimitedRebuildImprovement(1, 0), false);
  assert.equal(isUnlimitedRebuildImprovement(Number.NaN, 1), false);
  assert.equal(getAtomicTransferConfidence([
    { confidence: 0.91 },
    { confidence: 0.63 },
    { confidence: 0.82 },
  ]), 0.63);
  assert.equal(getAtomicTransferConfidence([]), 1);
});

test('ownership parsing and protect template bonus are bounded and deterministic', () => {
  assert.equal(parseOfficialOwnership('not-a-number'), 0);
  assert.equal(parseOfficialOwnership('120'), 100);
  assert.equal(parseOfficialOwnership('-4'), 0);
  assert.ok(Math.abs(calculateProtectTemplateBonus(64, 3, 0.2) - 0.48) < 1e-12);
  assert.equal(calculateProtectTemplateBonus(Number.NaN, 3, 0.2), 0);
  assert.equal(calculateProtectTemplateBonus(50, -3, 0.2), 0);
});

test('a clearly superior defender can captain ahead of attackers', () => {
  const candidate = (id: number, elementType: number, xp: number) => ({
    player: { id, element_type: elementType, selected_by_percent: '20' } as Player,
    xp,
    p90: xp + 3,
    startProbability: 1,
  });
  const result = selectStableCaptaincy([
    candidate(1, 2, 12),
    candidate(2, 3, 6),
    candidate(3, 4, 5),
  ], { picks: [] });

  assert.equal(result.captain.player.id, 1);
});

test('push mode permits a calculated captain differential but balanced mode holds the mean leader', () => {
  const template = {
    player: { id: 1, element_type: 3, selected_by_percent: '80' } as Player,
    xp: 10,
    p90: 12,
    startProbability: 0.95,
  };
  const differential = {
    player: { id: 2, element_type: 4, selected_by_percent: '5' } as Player,
    xp: 9.2,
    p90: 20,
    startProbability: 0.9,
  };
  const balanced = deriveRankPolicy({
    gameweek: 20,
    overallRank: 120_000,
    targetRank: 100_000,
  });
  const push = deriveRankPolicy({
    gameweek: 25,
    overallRank: 500_000,
    targetRank: 100_000,
  });

  assert.equal(selectStableCaptaincy([template, differential], { picks: [] }, balanced).captain.player.id, 1);
  assert.equal(selectStableCaptaincy([template, differential], { picks: [] }, push).captain.player.id, 2);
});

function squadCandidate(
  id: number,
  elementType: number,
  club: number,
  cost: number,
  projectedValue: number,
  ownership: number,
  currentlyOwned: boolean
): UnlimitedSquadCandidate {
  return {
    player: { id, element_type: elementType, team: club, selected_by_percent: String(ownership) } as Player,
    cost,
    projectedValue,
    ownership,
    ownershipUtility: 0,
    currentlyOwned,
  };
}

function exactSquadCandidates(): UnlimitedSquadCandidate[] {
  const candidates: UnlimitedSquadCandidate[] = [];
  let id = 200;
  for (const [position, count] of [[1, 2], [2, 5], [3, 5], [4, 3]] as const) {
    for (let index = 0; index < count; index++) {
      candidates.push(squadCandidate(id++, position, (candidates.length % 5) + 1, 50, 10, 5, true));
    }
  }
  return candidates;
}

function positionCounts(candidates: UnlimitedSquadCandidate[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const candidate of candidates) {
    counts[candidate.player.element_type] = (counts[candidate.player.element_type] ?? 0) + 1;
  }
  return counts;
}

function clubCounts(candidates: UnlimitedSquadCandidate[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const candidate of candidates) {
    counts.set(candidate.player.team, (counts.get(candidate.player.team) ?? 0) + 1);
  }
  return counts;
}

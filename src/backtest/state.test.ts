import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createInitialState, applyGameweekDecision } from './state.js';
import type { BacktestDecision, GameweekSnapshot } from './types.js';

function snapshot(gameweek: number): GameweekSnapshot {
  return {
    season: '2024-2025',
    gameweek,
    deadline: `2024-08-${15 + gameweek}T17:30:00Z`,
    knownBeforeDeadline: {
      players: [
        { id: 1, webName: 'Keeper', elementType: 1, team: 1, price: 45, status: 'a', selectedByPercent: 10, expectedPoints: 3 },
        { id: 2, webName: 'Defender', elementType: 2, team: 2, price: 55, status: 'a', selectedByPercent: 20, expectedPoints: 4 },
        { id: 3, webName: 'Midfielder', elementType: 3, team: 3, price: 95, status: 'a', selectedByPercent: 35, expectedPoints: 7 },
        { id: 4, webName: 'Forward', elementType: 4, team: 4, price: 80, status: 'a', selectedByPercent: 18, expectedPoints: 5 },
        { id: 5, webName: 'Bench', elementType: 2, team: 5, price: 40, status: 'a', selectedByPercent: 5, expectedPoints: 2 },
        { id: 6, webName: 'New Midfielder', elementType: 3, team: 6, price: 100, status: 'a', selectedByPercent: 30, expectedPoints: 8 },
      ],
      fixtures: [],
      unavailableFields: [],
    },
    actualResults: {
      playerResults: [
        { playerId: 1, minutes: 90, totalPoints: 3 },
        { playerId: 2, minutes: 90, totalPoints: 6 },
        { playerId: 3, minutes: 90, totalPoints: 10 },
        { playerId: 4, minutes: 90, totalPoints: 2 },
        { playerId: 5, minutes: 90, totalPoints: 4 },
        { playerId: 6, minutes: 90, totalPoints: 12 },
      ],
      averageEntryScore: 50,
      highestScore: 100,
    },
    provenance: { sourceUrls: ['https://example.test'], downloadedAt: '2026-05-18T00:00:00.000Z', snapshotVersion: '2024-2025-v1', knownLimitations: [] },
  };
}

test('createInitialState sets starting bank, chips, and empty logs', () => {
  const state = createInitialState('2024-2025');
  assert.equal(state.bank, 1000);
  assert.equal(state.freeTransfers, 1);
  assert.deepEqual(state.chipsAvailable, ['wildcard', 'freehit', 'bboost', '3xc']);
  assert.equal(state.totalPoints, 0);
});

test('applyGameweekDecision creates GW1 squad and scores captain and bench', () => {
  const state = createInitialState('2024-2025');
  const decision: BacktestDecision = {
    gameweek: 1,
    squad: [1, 2, 3, 4, 5],
    transfers: [],
    startingXi: [1, 2, 3, 4],
    bench: [5],
    captain: 3,
    viceCaptain: 4,
    notes: ['fixture test'],
  };

  const next = applyGameweekDecision(state, decision, snapshot(1));

  assert.equal(next.totalPoints, 31);
  assert.equal(next.bank, 685);
  assert.equal(next.weeklyResults[0].grossPoints, 31);
  assert.equal(next.weeklyResults[0].captainPoints, 10);
  assert.equal(next.weeklyResults[0].benchPoints, 4);
});

test('applyGameweekDecision accounts for transfers, hits, chip use, and selling prices', () => {
  const afterGw1 = applyGameweekDecision(createInitialState('2024-2025'), {
    gameweek: 1,
    squad: [1, 2, 3, 4, 5],
    transfers: [],
    startingXi: [1, 2, 3, 4],
    bench: [5],
    captain: 3,
    viceCaptain: 4,
    notes: [],
  }, snapshot(1));

  const gw2 = snapshot(2);
  gw2.knownBeforeDeadline.players = gw2.knownBeforeDeadline.players.map(player => player.id === 3 ? { ...player, price: 97 } : player);
  const next = applyGameweekDecision(afterGw1, {
    gameweek: 2,
    transfers: [{ out: 3, in: 6 }, { out: 5, in: 3 }],
    startingXi: [1, 2, 4, 6],
    bench: [3],
    captain: 6,
    viceCaptain: 4,
    chip: '3xc',
    notes: [],
  }, gw2);

  assert.equal(next.weeklyResults[1].transferCost, 4);
  assert.equal(next.weeklyResults[1].grossPoints, 47);
  assert.equal(next.weeklyResults[1].points, 43);
  assert.equal(next.weeklyResults[1].captainPoints, 24);
  assert.equal(next.chipsAvailable.includes('3xc'), false);
  assert.equal(next.freeTransfers, 1);
});

test('applyGameweekDecision rejects gameweek and snapshot mismatches', () => {
  assert.throws(() => applyGameweekDecision(createInitialState('2024-2025'), {
    gameweek: 1,
    squad: [1, 2, 3, 4, 5],
    transfers: [],
    startingXi: [1, 2, 3, 4],
    bench: [5],
    captain: 3,
    viceCaptain: 4,
    notes: [],
  }, snapshot(2)), /snapshot gameweek/i);
});

test('applyGameweekDecision waives transfer hits for wildcard and freehit', () => {
  const afterGw1 = applyGameweekDecision(createInitialState('2024-2025'), {
    gameweek: 1,
    squad: [1, 2, 3, 4, 5],
    transfers: [],
    startingXi: [1, 2, 3, 4],
    bench: [5],
    captain: 3,
    viceCaptain: 4,
    notes: [],
  }, snapshot(1));

  const wildcard = applyGameweekDecision(afterGw1, {
    gameweek: 2,
    transfers: [{ out: 3, in: 6 }, { out: 5, in: 3 }],
    startingXi: [1, 2, 4, 6],
    bench: [3],
    captain: 6,
    viceCaptain: 4,
    chip: 'wildcard',
    notes: [],
  }, snapshot(2));

  const freehit = applyGameweekDecision(afterGw1, {
    gameweek: 2,
    transfers: [{ out: 3, in: 6 }, { out: 5, in: 3 }],
    startingXi: [1, 2, 4, 6],
    bench: [3],
    captain: 6,
    viceCaptain: 4,
    chip: 'freehit',
    notes: [],
  }, snapshot(2));

  assert.equal(wildcard.weeklyResults[1].transferCost, 0);
  assert.equal(freehit.weeklyResults[1].transferCost, 0);
});

test('applyGameweekDecision includes bench points in score when bench boost is active', () => {
  const next = applyGameweekDecision(createInitialState('2024-2025'), {
    gameweek: 1,
    squad: [1, 2, 3, 4, 5],
    transfers: [],
    startingXi: [1, 2, 3, 4],
    bench: [5],
    captain: 3,
    viceCaptain: 4,
    chip: 'bboost',
    notes: [],
  }, snapshot(1));

  assert.equal(next.weeklyResults[0].grossPoints, 35);
  assert.equal(next.weeklyResults[0].points, 35);
  assert.equal(next.totalPoints, 35);
});

test('applyGameweekDecision rejects unavailable chips', () => {
  const afterChip = applyGameweekDecision(createInitialState('2024-2025'), {
    gameweek: 1,
    squad: [1, 2, 3, 4, 5],
    transfers: [],
    startingXi: [1, 2, 3, 4],
    bench: [5],
    captain: 3,
    viceCaptain: 4,
    chip: '3xc',
    notes: [],
  }, snapshot(1));

  assert.throws(() => applyGameweekDecision(afterChip, {
    gameweek: 2,
    transfers: [],
    startingXi: [1, 2, 3, 4],
    bench: [5],
    captain: 3,
    viceCaptain: 4,
    chip: '3xc',
    notes: [],
  }, snapshot(2)), /chip .*available/i);
});

test('applyGameweekDecision rejects transfers out of non-squad players', () => {
  const afterGw1 = applyGameweekDecision(createInitialState('2024-2025'), {
    gameweek: 1,
    squad: [1, 2, 3, 4, 5],
    transfers: [],
    startingXi: [1, 2, 3, 4],
    bench: [5],
    captain: 3,
    viceCaptain: 4,
    notes: [],
  }, snapshot(1));

  assert.throws(() => applyGameweekDecision(afterGw1, {
    gameweek: 2,
    transfers: [{ out: 6, in: 3 }],
    startingXi: [1, 2, 3, 4],
    bench: [5],
    captain: 3,
    viceCaptain: 4,
    notes: [],
  }, snapshot(2)), /not in squad/i);
});

test('applyGameweekDecision rejects over-budget squads and transfers', () => {
  const expensiveGw1 = snapshot(1);
  expensiveGw1.knownBeforeDeadline.players = expensiveGw1.knownBeforeDeadline.players.map(player => ({ ...player, price: 250 }));

  assert.throws(() => applyGameweekDecision(createInitialState('2024-2025'), {
    gameweek: 1,
    squad: [1, 2, 3, 4, 5],
    transfers: [],
    startingXi: [1, 2, 3, 4],
    bench: [5],
    captain: 3,
    viceCaptain: 4,
    notes: [],
  }, expensiveGw1), /over budget/i);

  const afterGw1 = applyGameweekDecision(createInitialState('2024-2025'), {
    gameweek: 1,
    squad: [1, 2, 3, 4, 5],
    transfers: [],
    startingXi: [1, 2, 3, 4],
    bench: [5],
    captain: 3,
    viceCaptain: 4,
    notes: [],
  }, snapshot(1));
  const expensiveGw2 = snapshot(2);
  expensiveGw2.knownBeforeDeadline.players = expensiveGw2.knownBeforeDeadline.players.map(player => player.id === 6 ? { ...player, price: 1000 } : player);

  assert.throws(() => applyGameweekDecision(afterGw1, {
    gameweek: 2,
    transfers: [{ out: 5, in: 6 }],
    startingXi: [1, 2, 3, 4],
    bench: [6],
    captain: 3,
    viceCaptain: 4,
    notes: [],
  }, expensiveGw2), /over budget/i);
});

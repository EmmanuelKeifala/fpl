import { strict as assert } from 'node:assert';
import test from 'node:test';
import { FPL_RULES } from '../strategy/rules.js';
import { createInitialState, applyGameweekDecision } from './state.js';
import type { BacktestDecision, BacktestPlayer, GameweekSnapshot } from './types.js';

const LEGAL_SQUAD = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const STARTING_XI = [1, 3, 4, 5, 8, 9, 10, 11, 13, 14, 15];
const BENCH = [2, 6, 7, 12];

function player(id: number, webName: string, elementType: number, team: number, price: number, expectedPoints: number): BacktestPlayer {
  return { id, webName, elementType, team, price, status: 'a', selectedByPercent: 10, expectedPoints };
}

function snapshot(gameweek: number): GameweekSnapshot {
  const players = [
    player(1, 'Keeper One', 1, 1, 45, 3),
    player(2, 'Keeper Two', 1, 2, 40, 2),
    player(3, 'Defender One', 2, 1, 55, 6),
    player(4, 'Defender Two', 2, 2, 50, 5),
    player(5, 'Defender Three', 2, 3, 45, 4),
    player(6, 'Defender Four', 2, 4, 45, 3),
    player(7, 'Defender Five', 2, 5, 40, 2),
    player(8, 'Midfielder One', 3, 1, 95, 10),
    player(9, 'Midfielder Two', 3, 2, 85, 8),
    player(10, 'Midfielder Three', 3, 3, 75, 7),
    player(11, 'Midfielder Four', 3, 4, 65, 6),
    player(12, 'Midfielder Five', 3, 5, 55, 5),
    player(13, 'Forward One', 4, 6, 80, 4),
    player(14, 'Forward Two', 4, 7, 75, 3),
    player(15, 'Forward Three', 4, 8, 70, 2),
    player(16, 'New Midfielder', 3, 6, 100, 12),
    player(17, 'Extra Defender', 2, 9, 50, 1),
  ];

  return {
    season: '2024-2025',
    gameweek,
    deadline: `2024-08-${15 + gameweek}T17:30:00Z`,
    knownBeforeDeadline: { players, fixtures: [], unavailableFields: [] },
    actualResults: {
      playerResults: players.map(candidate => ({ playerId: candidate.id, minutes: 90, totalPoints: candidate.expectedPoints })),
      averageEntryScore: 50,
      highestScore: 100,
    },
    provenance: { sourceUrls: ['https://example.test'], downloadedAt: '2026-05-18T00:00:00.000Z', snapshotVersion: '2024-2025-v1', knownLimitations: [] },
  };
}

function validDecision(overrides: Partial<BacktestDecision> = {}): BacktestDecision {
  return {
    gameweek: 1,
    squad: LEGAL_SQUAD,
    transfers: [],
    startingXi: STARTING_XI,
    bench: BENCH,
    captain: 8,
    viceCaptain: 13,
    notes: [],
    ...overrides,
  };
}

function stateAfterGw1() {
  return applyGameweekDecision(createInitialState('2024-2025'), validDecision(), snapshot(1));
}

test('createInitialState sets starting bank, chips, and empty logs', () => {
  const state = createInitialState('2024-2025');
  assert.equal(state.bank, 1000);
  assert.equal(state.freeTransfers, 1);
  assert.deepEqual(state.chipsAvailable, ['wildcard', 'freehit', 'bboost', '3xc']);
  assert.equal(state.totalPoints, 0);
});

test('applyGameweekDecision creates GW1 squad and scores captain and bench', () => {
  const next = applyGameweekDecision(createInitialState('2024-2025'), validDecision({ notes: ['fixture test'] }), snapshot(1));

  assert.equal(next.totalPoints, 68);
  assert.equal(next.bank, 80);
  assert.equal(next.weeklyResults[0].grossPoints, 68);
  assert.equal(next.weeklyResults[0].captainPoints, 10);
  assert.equal(next.weeklyResults[0].benchPoints, 12);
  assert.equal(next.weeklyResults[0].squadValue, 1000);
  assert.equal(next.decisions.length, 1);
  assert.equal(next.decisions[0].gameweek, 1);
});

test('applyGameweekDecision accounts for transfers, hits, chip use, and selling prices', () => {
  const afterGw1 = stateAfterGw1();
  const gw2 = snapshot(2);
  gw2.knownBeforeDeadline.players = gw2.knownBeforeDeadline.players.map(player => player.id === 8 ? { ...player, price: 97 } : player);
  const next = applyGameweekDecision(afterGw1, validDecision({
    gameweek: 2,
    squad: undefined,
    transfers: [{ out: 8, in: 16 }, { out: 12, in: 8 }],
    startingXi: [1, 3, 4, 5, 16, 9, 10, 11, 13, 14, 15],
    bench: [2, 6, 7, 8],
    captain: 16,
    viceCaptain: 13,
    chip: '3xc',
  }), gw2);

  assert.equal(next.weeklyResults[1].transferCost, 4);
  assert.equal(next.weeklyResults[1].grossPoints, 84);
  assert.equal(next.weeklyResults[1].points, 80);
  assert.equal(next.weeklyResults[1].captainPoints, 24);
  assert.equal(next.weeklyResults[1].squadValue, 1001);
  assert.equal(next.chipsAvailable.includes('3xc'), false);
  assert.equal(next.freeTransfers, 1);
  assert.equal(next.decisions.length, 2);
  assert.equal(next.decisions[1].gameweek, 2);
});

test('applyGameweekDecision rejects gameweek and snapshot mismatches', () => {
  assert.throws(() => applyGameweekDecision(createInitialState('2024-2025'), validDecision(), snapshot(2)), /snapshot gameweek/i);
});

test('applyGameweekDecision rejects squad reset after initial squad creation', () => {
  const afterGw1 = stateAfterGw1();

  assert.throws(() => applyGameweekDecision(afterGw1, validDecision({
    gameweek: 2,
    squad: LEGAL_SQUAD,
  }), snapshot(2)), /squad.*initial/i);
});

test('applyGameweekDecision enforces max transfers unless wildcard or freehit is active', () => {
  const afterGw1 = stateAfterGw1();
  const transfers = Array.from({ length: FPL_RULES.maxTransfersPerGameweek + 1 }, (_, index) => ({
    out: index % 2 === 0 ? 12 : 16,
    in: index % 2 === 0 ? 16 : 12,
  }));
  const decision = validDecision({
    gameweek: 2,
    squad: undefined,
    transfers,
    startingXi: [1, 3, 4, 5, 16, 8, 9, 10, 13, 14, 15],
    bench: [2, 6, 7, 11],
    captain: 16,
    viceCaptain: 13,
  });

  assert.throws(
    () => applyGameweekDecision(afterGw1, decision, snapshot(2)),
    new RegExp(`more than.*${FPL_RULES.maxTransfersPerGameweek} transfers`, 'i'),
  );

  const wildcard = applyGameweekDecision(afterGw1, { ...decision, chip: 'wildcard' }, snapshot(2));
  const freehit = applyGameweekDecision(afterGw1, { ...decision, chip: 'freehit' }, snapshot(2));

  assert.deepEqual(
    wildcard.squad.map(pick => pick.playerId).sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16],
  );
  assert.deepEqual(freehit.squad.map(pick => pick.playerId), LEGAL_SQUAD);
});

test('applyGameweekDecision waives transfer hits for wildcard and freehit', () => {
  const afterGw1 = stateAfterGw1();
  const transferDecision = {
    gameweek: 2,
    squad: undefined,
    transfers: [{ out: 8, in: 16 }, { out: 12, in: 8 }],
    startingXi: [1, 3, 4, 5, 16, 9, 10, 11, 13, 14, 15],
    bench: [2, 6, 7, 8],
    captain: 16,
    viceCaptain: 13,
  };

  const wildcard = applyGameweekDecision(afterGw1, validDecision({ ...transferDecision, chip: 'wildcard' }), snapshot(2));
  const freehit = applyGameweekDecision(afterGw1, validDecision({ ...transferDecision, chip: 'freehit' }), snapshot(2));

  assert.equal(wildcard.weeklyResults[1].transferCost, 0);
  assert.equal(freehit.weeklyResults[1].transferCost, 0);
});

test('applyGameweekDecision scores free hit squad but restores original squad and bank', () => {
  const afterGw1 = stateAfterGw1();
  const next = applyGameweekDecision(afterGw1, validDecision({
    gameweek: 2,
    squad: undefined,
    transfers: [{ out: 12, in: 16 }],
    startingXi: [1, 3, 4, 5, 16, 8, 9, 10, 13, 14, 15],
    bench: [2, 6, 7, 11],
    captain: 16,
    viceCaptain: 13,
    chip: 'freehit',
  }), snapshot(2));

  assert.deepEqual(next.squad.map(pick => pick.playerId), LEGAL_SQUAD);
  assert.equal(next.bank, 80);
  assert.equal(next.weeklyResults[1].grossPoints, 76);
  assert.equal(next.weeklyResults[1].squadValue, 1000);
});

test('applyGameweekDecision refreshes restored free hit squad selling prices', () => {
  const afterGw1 = stateAfterGw1();
  const gw2 = snapshot(2);
  gw2.knownBeforeDeadline.players = gw2.knownBeforeDeadline.players.map(candidate => candidate.id === 8
    ? { ...candidate, price: 97 }
    : candidate);

  const next = applyGameweekDecision(afterGw1, validDecision({
    gameweek: 2,
    squad: undefined,
    transfers: [{ out: 12, in: 16 }],
    startingXi: [1, 3, 4, 5, 16, 8, 9, 10, 13, 14, 15],
    bench: [2, 6, 7, 11],
    captain: 16,
    viceCaptain: 13,
    chip: 'freehit',
  }), gw2);

  assert.equal(next.squad.find(pick => pick.playerId === 8)?.sellingPrice, 96);
});

test('applyGameweekDecision does not consume saved transfers for wildcard and freehit', () => {
  const afterGw1 = stateAfterGw1();
  const transferDecision = {
    gameweek: 2,
    squad: undefined,
    transfers: [{ out: 8, in: 16 }, { out: 12, in: 8 }],
    startingXi: [1, 3, 4, 5, 16, 9, 10, 11, 13, 14, 15],
    bench: [2, 6, 7, 8],
    captain: 16,
    viceCaptain: 13,
  };

  const wildcard = applyGameweekDecision(afterGw1, validDecision({ ...transferDecision, chip: 'wildcard' }), snapshot(2));
  const freehit = applyGameweekDecision(afterGw1, validDecision({ ...transferDecision, chip: 'freehit' }), snapshot(2));

  assert.equal(wildcard.freeTransfers, 2);
  assert.equal(freehit.freeTransfers, 2);
});

test('applyGameweekDecision rejects scoring players not owned by final squad', () => {
  const afterGw1 = stateAfterGw1();

  assert.throws(() => applyGameweekDecision(afterGw1, validDecision({
    gameweek: 2,
    squad: undefined,
    transfers: [],
    startingXi: [1, 3, 4, 5, 16, 8, 9, 10, 13, 14, 15],
    bench: BENCH,
    captain: 8,
    viceCaptain: 13,
  }), snapshot(2)), /not in squad/i);

  assert.throws(() => applyGameweekDecision(afterGw1, validDecision({
    gameweek: 2,
    squad: undefined,
    transfers: [],
    captain: 16,
  }), snapshot(2)), /not in squad/i);
});

test('applyGameweekDecision rejects duplicate incoming transfers and final squads', () => {
  const afterGw1 = stateAfterGw1();

  assert.throws(() => applyGameweekDecision(afterGw1, validDecision({
    gameweek: 2,
    squad: undefined,
    transfers: [{ out: 12, in: 8 }],
  }), snapshot(2)), /duplicate/i);

  assert.throws(() => applyGameweekDecision(afterGw1, validDecision({
    gameweek: 2,
    squad: undefined,
    transfers: [{ out: 8, in: 16 }, { out: 12, in: 16 }],
    startingXi: [1, 3, 4, 5, 16, 9, 10, 11, 13, 14, 15],
    bench: [2, 6, 7, 16],
    captain: 16,
  }), snapshot(2)), /duplicate/i);
});

test('applyGameweekDecision rejects duplicate lineup selections', () => {
  const afterGw1 = stateAfterGw1();

  assert.throws(() => applyGameweekDecision(afterGw1, validDecision({
    gameweek: 2,
    squad: undefined,
    startingXi: [1, 3, 4, 5, 8, 8, 10, 11, 13, 14, 15],
  }), snapshot(2)), /duplicate/i);

  assert.throws(() => applyGameweekDecision(afterGw1, validDecision({
    gameweek: 2,
    squad: undefined,
    bench: [2, 6, 7, 15],
  }), snapshot(2)), /duplicate/i);
});

test('applyGameweekDecision includes bench points in score when bench boost is active', () => {
  const next = applyGameweekDecision(createInitialState('2024-2025'), validDecision({ chip: 'bboost' }), snapshot(1));

  assert.equal(next.weeklyResults[0].grossPoints, 80);
  assert.equal(next.weeklyResults[0].points, 80);
  assert.equal(next.totalPoints, 80);
});

test('applyGameweekDecision rejects unavailable chips', () => {
  const afterChip = applyGameweekDecision(createInitialState('2024-2025'), validDecision({ chip: '3xc' }), snapshot(1));

  assert.throws(() => applyGameweekDecision(afterChip, validDecision({
    gameweek: 2,
    squad: undefined,
    chip: '3xc',
  }), snapshot(2)), /chip .*available/i);
});

test('applyGameweekDecision rejects GW1 free hit', () => {
  assert.throws(() => applyGameweekDecision(createInitialState('2024-2025'), validDecision({
    chip: 'freehit',
  }), snapshot(1)), /chip .*not available.*gameweek 1/i);
});

test('applyGameweekDecision rejects GW1 wildcard', () => {
  assert.throws(() => applyGameweekDecision(createInitialState('2024-2025'), validDecision({
    chip: 'wildcard',
  }), snapshot(1)), /chip .*not available.*gameweek 1/i);
});

test('applyGameweekDecision rejects transfers out of non-squad players', () => {
  const afterGw1 = stateAfterGw1();

  assert.throws(() => applyGameweekDecision(afterGw1, validDecision({
    gameweek: 2,
    squad: undefined,
    transfers: [{ out: 16, in: 8 }],
  }), snapshot(2)), /not in squad/i);
});

test('applyGameweekDecision rejects over-budget squads and transfers', () => {
  const expensiveGw1 = snapshot(1);
  expensiveGw1.knownBeforeDeadline.players = expensiveGw1.knownBeforeDeadline.players.map(candidate => ({ ...candidate, price: 250 }));

  assert.throws(() => applyGameweekDecision(createInitialState('2024-2025'), validDecision(), expensiveGw1), /over budget/i);

  const afterGw1 = stateAfterGw1();
  const expensiveGw2 = snapshot(2);
  expensiveGw2.knownBeforeDeadline.players = expensiveGw2.knownBeforeDeadline.players.map(candidate => candidate.id === 16 ? { ...candidate, price: 1000 } : candidate);

  assert.throws(() => applyGameweekDecision(afterGw1, validDecision({
    gameweek: 2,
    squad: undefined,
    transfers: [{ out: 12, in: 16 }],
    startingXi: [1, 3, 4, 5, 16, 8, 9, 10, 13, 14, 15],
    bench: [2, 6, 7, 11],
    captain: 16,
  }), expensiveGw2), /over budget/i);
});

test('applyGameweekDecision rejects invalid squad composition', () => {
  assert.throws(() => applyGameweekDecision(createInitialState('2024-2025'), validDecision({
    squad: [1, 3, 4, 5, 6, 7, 17, 8, 9, 10, 11, 12, 13, 14, 15],
    startingXi: [1, 3, 4, 5, 8, 9, 10, 11, 13, 14, 15],
    bench: [6, 7, 12, 17],
  }), snapshot(1)), /goalkeeper count 1 must equal 2/i);
});

test('applyGameweekDecision rejects club-limit breaches', () => {
  const clubBreach = snapshot(1);
  clubBreach.knownBeforeDeadline.players = clubBreach.knownBeforeDeadline.players.map(candidate => candidate.id === 17
    ? { ...candidate, team: 1 }
    : candidate);

  assert.throws(() => applyGameweekDecision(createInitialState('2024-2025'), validDecision({
    squad: [1, 2, 3, 4, 5, 6, 17, 8, 9, 10, 11, 12, 13, 14, 15],
    startingXi: [1, 3, 4, 5, 8, 9, 10, 11, 13, 14, 15],
    bench: [2, 6, 12, 17],
  }), clubBreach), /maximum is 3/i);
});

test('applyGameweekDecision rejects invalid formation and lineup size', () => {
  const afterGw1 = stateAfterGw1();

  assert.throws(() => applyGameweekDecision(afterGw1, validDecision({
    gameweek: 2,
    squad: undefined,
    startingXi: [1, 3, 8, 9, 10, 11, 12, 13, 14, 15, 5],
    bench: [2, 4, 6, 7],
  }), snapshot(2)), /defender count 2 is outside allowed range 3-5/i);

  assert.throws(() => applyGameweekDecision(afterGw1, validDecision({
    gameweek: 2,
    squad: undefined,
    startingXi: STARTING_XI.slice(0, 10),
    bench: [2, 6, 7, 12, 15],
  }), snapshot(2)), /starting xi must contain exactly 11 players/i);
});

test('applyGameweekDecision rejects incomplete bench coverage', () => {
  const afterGw1 = stateAfterGw1();

  assert.throws(() => applyGameweekDecision(afterGw1, validDecision({
    gameweek: 2,
    squad: undefined,
    bench: [2, 6, 7],
  }), snapshot(2)), /lineup must cover all 15 squad players/i);
});

test('applyGameweekDecision rejects same captain and vice captain', () => {
  assert.throws(() => applyGameweekDecision(createInitialState('2024-2025'), validDecision({
    viceCaptain: 8,
  }), snapshot(1)), /captain and vice captain must be different/i);
});

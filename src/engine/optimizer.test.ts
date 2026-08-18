import { strict as assert } from 'node:assert';
import test from 'node:test';
import { OptimizationEngine } from './optimizer.js';

test('getUpcomingFixtures returns all fixtures across the requested gameweek horizon', () => {
  const engine = new OptimizationEngine() as any;
  engine.currentGW = 10;
  engine.fixtures = [
    { id: 1, event: 10, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 3 },
    { id: 2, event: 10, team_h: 3, team_a: 1, team_h_difficulty: 4, team_a_difficulty: 2 },
    { id: 3, event: 11, team_h: 1, team_a: 4, team_h_difficulty: 3, team_a_difficulty: 3 },
  ];

  const fixtures = engine.getUpcomingFixtures(1, 1);

  assert.equal(fixtures.length, 2);
  assert.deepEqual(fixtures.map((fixture: { id: number }) => fixture.id), [1, 2]);
});

test('calculateExpectedPoints includes defensive contribution in player projection', () => {
  const engine = new OptimizationEngine() as any;
  engine.currentGW = 10;
  engine.gameweeks = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, finished: true }));
  engine.teams = new Map([[1, { id: 1, short_name: 'ARS' }]]);
  engine.players = new Map([[
    10,
    {
      id: 10,
      web_name: 'Rice',
      first_name: 'Declan',
      second_name: 'Rice',
      team: 1,
      element_type: 3,
      form: '5.0',
      minutes: 900,
      starts: 12,
      total_points: 50,
      points_per_game: '5.0',
      ep_next: '3.5',
      penalties_order: null,
      corners_and_indirect_freekicks_order: null,
      direct_freekicks_order: null,
      expected_goals_per_90: 0.1,
      expected_assists_per_90: 0.1,
      expected_goals_conceded_per_90: 1,
      defensive_contribution_per_90: 12,
      saves_per_90: 0,
      goals_conceded_per_90: 1,
      chance_of_playing_next_round: 100,
      status: 'a',
    },
  ]]);
  engine.fixtures = [{ id: 1, event: 10, team_h: 1, team_a: 2, team_h_difficulty: 3, team_a_difficulty: 3 }];

  const xp = engine.calculateExpectedPoints(10, 1);

  assert.ok(xp.nextGW > 0);
  assert.ok(xp.breakdown.defensiveContribution > 0);
});

test('live defensive-action rates distinguish high and low contribution players', () => {
  const engine = new OptimizationEngine() as any;
  engine.currentGW = 10;
  engine.gameweeks = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, finished: true }));
  engine.teams = new Map([
    [1, { id: 1, short_name: 'ONE' }],
    [2, { id: 2, short_name: 'TWO' }],
  ]);
  const base = {
    first_name: 'Test', second_name: 'Player', team: 1, element_type: 2,
    form: '0', minutes: 1800, penalties_order: null,
    corners_and_indirect_freekicks_order: null, direct_freekicks_order: null,
    expected_goals_per_90: 0, expected_assists_per_90: 0,
    expected_goals_conceded_per_90: 1, goals_conceded_per_90: 1,
    saves_per_90: 0, chance_of_playing_next_round: 100, status: 'a',
  };
  engine.players = new Map([
    [10, { ...base, id: 10, web_name: 'High', defensive_contribution_per_90: 14 }],
    [11, { ...base, id: 11, web_name: 'Low', defensive_contribution_per_90: 2 }],
  ]);
  engine.fixtures = [{ id: 1, event: 10, team_h: 1, team_a: 2, team_h_difficulty: 3, team_a_difficulty: 3 }];

  const high = engine.calculateExpectedPoints(10, 1);
  const low = engine.calculateExpectedPoints(11, 1);
  assert.ok(high.breakdown.defensiveContribution > low.breakdown.defensiveContribution);
});

test('preseason price prediction remains stable despite transfer activity', () => {
  const engine = new OptimizationEngine() as any;
  engine.gameweeks = [{ id: 1, finished: false }];
  engine.players = new Map([[10, {
    id: 10,
    web_name: 'Preseason',
    now_cost: 100,
    transfers_in_event: 500_000,
    transfers_out_event: 0,
    selected_by_percent: '50',
    price_change_percent: '20',
  }]]);
  const prediction = engine.predictPriceChange(10);
  assert.equal(prediction.prediction, 'stable');
  assert.equal(prediction.confidence, 1);
  assert.match(prediction.reasoning, /frozen/i);
});

test('triple captain is not recommended for an unrelated club double', () => {
  const engine = new OptimizationEngine() as any;
  engine.currentGW = 10;
  engine.gameweeks = [{ id: 10, finished: false }];
  engine.seasonConfig = {
    chipWindows: [{ name: '3xc', number: 1, startEvent: 1, stopEvent: 19, chipType: 'team' }],
  };
  engine.teams = new Map([[1, { id: 1, short_name: 'ONE' }], [2, { id: 2 }], [3, { id: 3 }], [4, { id: 4 }]]);
  engine.players = new Map([[10, {
    id: 10, web_name: 'Single', first_name: 'Single', second_name: 'Player', team: 1,
    element_type: 3, form: '0', minutes: 0, penalties_order: null,
    corners_and_indirect_freekicks_order: null, direct_freekicks_order: null,
    expected_goals_per_90: 0.2, expected_assists_per_90: 0.2,
    expected_goals_conceded_per_90: 1, goals_conceded_per_90: 1, saves_per_90: 0,
    chance_of_playing_next_round: 100, status: 'a', transfers_in_event: 0,
    transfers_out_event: 0, selected_by_percent: '1', now_cost: 70,
  }]]);
  engine.fixtures = [
    { id: 1, event: 10, team_h: 1, team_a: 2, team_h_difficulty: 3, team_a_difficulty: 3 },
    { id: 2, event: 10, team_h: 3, team_a: 4, team_h_difficulty: 3, team_a_difficulty: 3 },
    { id: 3, event: 10, team_h: 2, team_a: 3, team_h_difficulty: 3, team_a_difficulty: 3 },
  ];
  const recommendation = engine.evaluateChip('3xc', 10, [10], []);
  assert.equal(recommendation.recommended, false);
  assert.equal(recommendation.expectedGain, 0);
  assert.match(recommendation.reasoning, /No proposed starter/);
});

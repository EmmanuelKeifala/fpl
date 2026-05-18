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
      points_per_game: '5.0',
      penalties_order: null,
      corners_and_indirect_freekicks_order: null,
      direct_freekicks_order: null,
      expected_goals_per_90: 0.1,
      expected_assists_per_90: 0.1,
      expected_goals_conceded_per_90: 1,
      saves_per_90: 0,
      goals_conceded_per_90: 1,
      chance_of_playing_next_round: 100,
      status: 'a',
    },
  ]]);
  engine.fixtures = [{ id: 1, event: 10, team_h: 1, team_a: 2, team_h_difficulty: 3, team_a_difficulty: 3, kickoff_time: '2026-01-01T12:00:00Z' }];

  const xp = engine.calculateExpectedPoints(10, 1);

  assert.ok(xp.nextGW >= 3);
  assert.ok(xp.breakdown.defensiveContribution >= 0);
});

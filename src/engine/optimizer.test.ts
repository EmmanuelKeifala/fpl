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

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { projectPlayerPoints, type ProjectionInput } from './projections.js';

const baseInput: ProjectionInput = {
  elementType: 3,
  expectedMinutes: 90,
  appearanceProbability: 1,
  expectedGoals: 0.2,
  expectedAssists: 0.2,
  cleanSheetProbability: 0.3,
  expectedSaves: 0,
  penaltySaveProbability: 0,
  penaltyMissProbability: 0,
  yellowCardProbability: 0.1,
  redCardProbability: 0.01,
  ownGoalProbability: 0.01,
  expectedGoalsConceded: 1,
  defensiveContributionProbability: 0.25,
  expectedBonus: 0.4,
  fixtures: [{ difficulty: 3 }, { difficulty: 3 }],
};

test('projectPlayerPoints scales expected points across double gameweek fixtures', () => {
  const single = projectPlayerPoints({ ...baseInput, fixtures: [{ difficulty: 3 }] });
  const double = projectPlayerPoints(baseInput);

  assert.ok(double.expectedPoints > single.expectedPoints * 1.8);
});

test('projectPlayerPoints applies minutes and appearance uncertainty', () => {
  const full = projectPlayerPoints(baseInput);
  const doubt = projectPlayerPoints({ ...baseInput, expectedMinutes: 45, appearanceProbability: 0.5 });

  assert.ok(doubt.expectedPoints < full.expectedPoints * 0.5);
  assert.ok(doubt.confidence < full.confidence);
});

test('projectPlayerPoints includes defensive contribution for outfield players', () => {
  const withoutDefCon = projectPlayerPoints({ ...baseInput, defensiveContributionProbability: 0 });
  const withDefCon = projectPlayerPoints({ ...baseInput, defensiveContributionProbability: 1 });

  assert.equal(Math.round((withDefCon.expectedPoints - withoutDefCon.expectedPoints) * 10) / 10, 2);
});

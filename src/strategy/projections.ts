import { POSITION_BY_ELEMENT_TYPE, SCORING_RULES } from './rules.js';

export interface ProjectionFixtureInput {
  difficulty: number;
  attackMultiplier?: number;
  cleanSheetProbability?: number;
  expectedGoalsConceded?: number;
}

export interface ProjectionInput {
  elementType: number;
  expectedMinutes: number;
  appearanceProbability: number;
  expectedGoals: number;
  expectedAssists: number;
  cleanSheetProbability: number;
  expectedSaves: number;
  penaltySaveProbability: number;
  penaltyMissProbability: number;
  yellowCardProbability: number;
  redCardProbability: number;
  ownGoalProbability: number;
  expectedGoalsConceded: number;
  defensiveContributionProbability: number;
  expectedBonus: number;
  rateReliability?: number;
  fixtures: ProjectionFixtureInput[];
}

export interface ProjectionResult {
  expectedPoints: number;
  confidence: number;
  breakdown: {
    minutes: number;
    goals: number;
    assists: number;
    cleanSheets: number;
    saves: number;
    penalties: number;
    cards: number;
    ownGoals: number;
    goalsConceded: number;
    defensiveContribution: number;
    bonus: number;
    fixtureMultiplier: number;
  };
}

const FDR_WEIGHTS: Record<number, number> = {
  1: 1.3,
  2: 1.15,
  3: 1,
  4: 0.85,
  5: 0.7,
};

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function projectPlayerPoints(input: ProjectionInput): ProjectionResult {
  const position = POSITION_BY_ELEMENT_TYPE[input.elementType] || 'midfielder';
  const fixtures = input.fixtures;
  const fixtureCount = fixtures.length;
  const fixtureMultiplier = fixtureCount > 0
    ? fixtures.reduce(
      (sum, fixture) => sum + (fixture.attackMultiplier ?? FDR_WEIGHTS[fixture.difficulty] ?? 1),
      0
    ) / fixtureCount
    : 0;
  const minutesRatio = Math.max(0, Math.min(1, input.expectedMinutes / 90));
  const appearance = Math.max(0, Math.min(1, input.appearanceProbability));
  const playPoints = input.expectedMinutes >= SCORING_RULES.minutes.longPlayThreshold
    ? SCORING_RULES.minutes.longPlayPoints
    : input.expectedMinutes > 0
      ? SCORING_RULES.minutes.shortPlayPoints
      : 0;

  const minutes = playPoints * appearance * fixtureCount;
  const goals = fixtures.reduce((sum, fixture) => sum +
    input.expectedGoals * minutesRatio * appearance * (fixture.attackMultiplier ?? FDR_WEIGHTS[fixture.difficulty] ?? 1) * SCORING_RULES.goals[position], 0);
  const assists = fixtures.reduce((sum, fixture) => sum +
    input.expectedAssists * minutesRatio * appearance * (fixture.attackMultiplier ?? FDR_WEIGHTS[fixture.difficulty] ?? 1) * SCORING_RULES.assist, 0);
  const cleanSheets = fixtures.reduce((sum, fixture) => sum +
    (fixture.cleanSheetProbability ?? input.cleanSheetProbability) * SCORING_RULES.cleanSheet[position] * appearance * minutesRatio, 0);
  const saves = input.expectedSaves * minutesRatio / SCORING_RULES.saves.savesPerBlock * SCORING_RULES.saves.pointsPerSaveBlock * appearance * fixtureCount;
  const penalties = ((input.penaltySaveProbability * SCORING_RULES.penaltiesSaved) + (input.penaltyMissProbability * SCORING_RULES.penaltiesMissed)) * minutesRatio * fixtureCount;
  const cards = ((input.yellowCardProbability * SCORING_RULES.yellowCard) + (input.redCardProbability * SCORING_RULES.redCard)) * minutesRatio * fixtureCount;
  const ownGoals = input.ownGoalProbability * SCORING_RULES.ownGoal * minutesRatio * fixtureCount;
  const goalsConceded = (position === 'goalkeeper' || position === 'defender')
    ? fixtures.reduce((sum, fixture) => sum +
      (fixture.expectedGoalsConceded ?? input.expectedGoalsConceded) /
      SCORING_RULES.goalsConceded.goalsPerBlock *
      SCORING_RULES.goalsConceded.goalkeeperDefenderPenalty * appearance * minutesRatio, 0)
    : 0;
  const defensiveContribution = position === 'goalkeeper'
    ? 0
    : input.defensiveContributionProbability * SCORING_RULES.defensiveContribution.points * appearance * minutesRatio * fixtureCount;
  const bonus = input.expectedBonus * appearance * minutesRatio * fixtureCount;

  const expectedPoints = minutes + goals + assists + cleanSheets + saves + penalties + cards + ownGoals + goalsConceded + defensiveContribution + bonus;
  const reliability = Math.max(0, Math.min(1, input.rateReliability ?? 0.5));
  const confidence = Math.max(0.1, Math.min(1, appearance * (0.35 + minutesRatio * 0.45 + reliability * 0.2)));

  return {
    expectedPoints: round(expectedPoints),
    confidence: round(confidence),
    breakdown: {
      minutes: round(minutes),
      goals: round(goals),
      assists: round(assists),
      cleanSheets: round(cleanSheets),
      saves: round(saves),
      penalties: round(penalties),
      cards: round(cards),
      ownGoals: round(ownGoals),
      goalsConceded: round(goalsConceded),
      defensiveContribution: round(defensiveContribution),
      bonus: round(bonus),
      fixtureMultiplier: round(fixtureMultiplier),
    },
  };
}

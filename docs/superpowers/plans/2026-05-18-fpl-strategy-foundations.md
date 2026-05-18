# FPL Strategy Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the rules, state, and projection foundation required by the FPL Strategy Engine design before expanding live automation.

**Architecture:** Add a deterministic rules layer and projection layer underneath the existing optimizer. Existing tools and scheduler continue to work, but official rules, squad validation, scoring constants, selling-price behavior, and expected-points calculations move into focused, testable modules.

**Tech Stack:** TypeScript, Node.js test runner via `tsx --test`, existing FPL API types, existing `OptimizationEngine`.

---

## Scope

This plan implements the first increment from `docs/superpowers/specs/2026-05-18-fpl-strategy-engine-design.md`: rules, state, and projection foundations. It does not implement full scenario simulation, rival modelling, X scraping expansion, calibration, or expanded live API mutations. Those should be separate plans after this foundation is merged.

## File Structure

- Create: `src/strategy/rules.ts`
  Owns official FPL constants, scoring constants, chip constants, and deadline/transfer helper functions.
- Create: `src/strategy/rules.test.ts`
  Tests official rules, scoring constants, selling price, chip windows, and transfer rules.
- Create: `src/strategy/squad.ts`
  Owns squad shape, formation, budget, club limit, bench/autosub validation helpers.
- Create: `src/strategy/squad.test.ts`
  Tests squad legality and formation validation.
- Create: `src/strategy/projections.ts`
  Owns expected-points calculation using rules constants, expected minutes, fixtures, defensive contribution, and confidence.
- Create: `src/strategy/projections.test.ts`
  Tests points projection behavior, DGW handling, minutes uncertainty, and defensive contribution.
- Create: `src/strategy/index.ts`
  Barrel export for strategy modules.
- Modify: `src/engine/optimizer.ts`
  Replace embedded rule constants and ad-hoc xP logic with `src/strategy` helpers while preserving public methods.
- Modify: `src/engine/optimizer.test.ts`
  Keep existing DGW test and add one integration test proving optimizer uses projection helpers.
- Modify: `src/agent.ts`
  Update embedded rules text to remove stale assumptions and reflect the strategy rules module.
- Modify: `README.md`
  Update rules/strategy notes to match official 2025/26 rules and new foundation.

---

### Task 1: Add Official Rules Module

**Files:**
- Create: `src/strategy/rules.ts`
- Create: `src/strategy/rules.test.ts`
- Create: `src/strategy/index.ts`

- [ ] **Step 1: Write the failing rules tests**

Create `src/strategy/rules.test.ts`:

```ts
import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  FPL_RULES,
  SCORING_RULES,
  calculateSellingPrice,
  getFreeTransfersAfterGameweek,
  isChipAvailableInGameweek,
} from './rules.js';

test('FPL_RULES captures official squad and transfer limits', () => {
  assert.equal(FPL_RULES.squadSize, 15);
  assert.deepEqual(FPL_RULES.squadComposition, {
    goalkeeper: 2,
    defender: 5,
    midfielder: 5,
    forward: 3,
  });
  assert.equal(FPL_RULES.maxPlayersPerClub, 3);
  assert.equal(FPL_RULES.initialBudget, 1000);
  assert.equal(FPL_RULES.maxFreeTransfers, 5);
  assert.equal(FPL_RULES.maxTransfersPerGameweek, 20);
  assert.equal(FPL_RULES.hitCost, 4);
});

test('SCORING_RULES captures official points values', () => {
  assert.equal(SCORING_RULES.minutes.shortPlayPoints, 1);
  assert.equal(SCORING_RULES.minutes.longPlayPoints, 2);
  assert.equal(SCORING_RULES.goals.goalkeeper, 10);
  assert.equal(SCORING_RULES.goals.defender, 6);
  assert.equal(SCORING_RULES.goals.midfielder, 5);
  assert.equal(SCORING_RULES.goals.forward, 4);
  assert.equal(SCORING_RULES.assist, 3);
  assert.equal(SCORING_RULES.cleanSheet.goalkeeper, 4);
  assert.equal(SCORING_RULES.cleanSheet.defender, 4);
  assert.equal(SCORING_RULES.cleanSheet.midfielder, 1);
  assert.equal(SCORING_RULES.saves.pointsPerSaveBlock, 1);
  assert.equal(SCORING_RULES.saves.savesPerBlock, 3);
  assert.equal(SCORING_RULES.defensiveContribution.points, 2);
  assert.equal(SCORING_RULES.defensiveContribution.defenderThreshold, 10);
  assert.equal(SCORING_RULES.defensiveContribution.midfielderForwardThreshold, 12);
});

test('calculateSellingPrice keeps half of profit rounded down to 0.1m', () => {
  assert.equal(calculateSellingPrice(75, 78), 76);
  assert.equal(calculateSellingPrice(75, 77), 76);
  assert.equal(calculateSellingPrice(75, 76), 75);
  assert.equal(calculateSellingPrice(75, 74), 74);
});

test('getFreeTransfersAfterGameweek handles regular and AFCON top-up rules', () => {
  assert.equal(getFreeTransfersAfterGameweek({ previousFreeTransfers: 1, transfersMade: 0, nextGameweek: 10 }), 2);
  assert.equal(getFreeTransfersAfterGameweek({ previousFreeTransfers: 5, transfersMade: 0, nextGameweek: 10 }), 5);
  assert.equal(getFreeTransfersAfterGameweek({ previousFreeTransfers: 2, transfersMade: 1, nextGameweek: 10 }), 1);
  assert.equal(getFreeTransfersAfterGameweek({ previousFreeTransfers: 1, transfersMade: 3, nextGameweek: 10 }), 1);
  assert.equal(getFreeTransfersAfterGameweek({ previousFreeTransfers: 1, transfersMade: 0, nextGameweek: 16 }), 5);
});

test('chip availability is split around the GW19 deadline', () => {
  assert.equal(isChipAvailableInGameweek('bboost', 1), true);
  assert.equal(isChipAvailableInGameweek('3xc', 19), true);
  assert.equal(isChipAvailableInGameweek('freehit', 1), false);
  assert.equal(isChipAvailableInGameweek('freehit', 2), true);
  assert.equal(isChipAvailableInGameweek('wildcard', 1), false);
  assert.equal(isChipAvailableInGameweek('wildcard', 2), true);
  assert.equal(isChipAvailableInGameweek('wildcard', 20), true);
});
```

Create `src/strategy/index.ts`:

```ts
export * from './rules.js';
```

- [ ] **Step 2: Run rules tests to verify they fail**

Run: `npm test -- src/strategy/rules.test.ts`

Expected: FAIL with module-not-found or missing export errors for `./rules.js`.

- [ ] **Step 3: Implement the rules module**

Create `src/strategy/rules.ts`:

```ts
export type PositionKey = 'goalkeeper' | 'defender' | 'midfielder' | 'forward';
export type ChipName = 'wildcard' | 'freehit' | 'bboost' | '3xc';

export const POSITION_BY_ELEMENT_TYPE: Record<number, PositionKey> = {
  1: 'goalkeeper',
  2: 'defender',
  3: 'midfielder',
  4: 'forward',
};

export const ELEMENT_TYPE_BY_POSITION: Record<PositionKey, number> = {
  goalkeeper: 1,
  defender: 2,
  midfielder: 3,
  forward: 4,
};

export const FPL_RULES = {
  squadSize: 15,
  startingSize: 11,
  initialBudget: 1000,
  maxPlayersPerClub: 3,
  maxFreeTransfers: 5,
  maxTransfersPerGameweek: 20,
  hitCost: 4,
  afconTopUpGameweek: 16,
  firstHalfFinalGameweek: 19,
  squadComposition: {
    goalkeeper: 2,
    defender: 5,
    midfielder: 5,
    forward: 3,
  },
  formation: {
    goalkeeper: { min: 1, max: 1 },
    defender: { min: 3, max: 5 },
    midfielder: { min: 2, max: 5 },
    forward: { min: 1, max: 3 },
  },
} as const;

export const SCORING_RULES = {
  minutes: {
    longPlayThreshold: 60,
    shortPlayPoints: 1,
    longPlayPoints: 2,
  },
  goals: {
    goalkeeper: 10,
    defender: 6,
    midfielder: 5,
    forward: 4,
  },
  assist: 3,
  cleanSheet: {
    goalkeeper: 4,
    defender: 4,
    midfielder: 1,
    forward: 0,
  },
  saves: {
    savesPerBlock: 3,
    pointsPerSaveBlock: 1,
  },
  penaltiesSaved: 5,
  penaltiesMissed: -2,
  goalsConceded: {
    goalsPerBlock: 2,
    goalkeeperDefenderPenalty: -1,
  },
  yellowCard: -1,
  redCard: -3,
  ownGoal: -2,
  defensiveContribution: {
    points: 2,
    defenderThreshold: 10,
    midfielderForwardThreshold: 12,
  },
  bonus: {
    min: 1,
    max: 3,
  },
} as const;

export function calculateSellingPrice(purchasePrice: number, currentPrice: number): number {
  if (currentPrice <= purchasePrice) {
    return currentPrice;
  }

  return purchasePrice + Math.floor((currentPrice - purchasePrice) / 2);
}

export function getTransferHitCost(transfersMade: number, freeTransfers: number): number {
  return Math.max(0, transfersMade - freeTransfers) * FPL_RULES.hitCost;
}

export function getFreeTransfersAfterGameweek(input: {
  previousFreeTransfers: number;
  transfersMade: number;
  nextGameweek: number;
}): number {
  if (input.nextGameweek === FPL_RULES.afconTopUpGameweek) {
    return FPL_RULES.maxFreeTransfers;
  }

  const remaining = Math.max(0, input.previousFreeTransfers - input.transfersMade);
  return Math.max(1, Math.min(FPL_RULES.maxFreeTransfers, remaining + 1));
}

export function isChipAvailableInGameweek(chip: ChipName, gameweek: number): boolean {
  if (chip === 'bboost' || chip === '3xc') {
    return gameweek >= 1 && gameweek <= 38;
  }

  return gameweek >= 2 && gameweek <= 38;
}
```

- [ ] **Step 4: Run rules tests to verify they pass**

Run: `npm test -- src/strategy/rules.test.ts`

Expected: PASS for all rules tests.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/strategy/rules.ts src/strategy/rules.test.ts src/strategy/index.ts
git commit -m "Add FPL rules foundation"
```

---

### Task 2: Add Squad And Formation Validation

**Files:**
- Create: `src/strategy/squad.ts`
- Create: `src/strategy/squad.test.ts`
- Modify: `src/strategy/index.ts`

- [ ] **Step 1: Write failing squad tests**

Create `src/strategy/squad.test.ts`:

```ts
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { validateFormation, validateSquad, type SquadPlayer } from './squad.js';

function player(id: number, elementType: number, team: number, price = 50): SquadPlayer {
  return { id, elementType, team, price };
}

const legalSquad: SquadPlayer[] = [
  player(1, 1, 1), player(2, 1, 2),
  player(3, 2, 1), player(4, 2, 2), player(5, 2, 3), player(6, 2, 4), player(7, 2, 5),
  player(8, 3, 1), player(9, 3, 2), player(10, 3, 3), player(11, 3, 4), player(12, 3, 5),
  player(13, 4, 6), player(14, 4, 7), player(15, 4, 8),
];

test('validateSquad accepts a legal 15-player squad', () => {
  const result = validateSquad(legalSquad, 1000);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateSquad rejects wrong squad composition', () => {
  const invalid = legalSquad.filter(p => p.id !== 15);
  const result = validateSquad(invalid, 1000);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('Squad must contain exactly 15 players'));
});

test('validateSquad rejects over-budget and club-limit breaches', () => {
  const expensive = legalSquad.map(p => ({ ...p, price: 80 }));
  const budgetResult = validateSquad(expensive, 1000);
  assert.equal(budgetResult.valid, false);
  assert.ok(budgetResult.errors.includes('Squad cost 1200 exceeds budget 1000'));

  const tooManyFromClub = legalSquad.map((p, index) => index < 4 ? { ...p, team: 99 } : p);
  const clubResult = validateSquad(tooManyFromClub, 1000);
  assert.equal(clubResult.valid, false);
  assert.ok(clubResult.errors.includes('Team 99 has 4 players; maximum is 3'));
});

test('validateFormation accepts valid formations and rejects invalid ones', () => {
  assert.equal(validateFormation([1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4]).valid, true);
  assert.equal(validateFormation([1, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4]).valid, false);
  assert.equal(validateFormation([2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4]).valid, false);
});
```

- [ ] **Step 2: Run squad tests to verify they fail**

Run: `npm test -- src/strategy/squad.test.ts`

Expected: FAIL with module-not-found errors for `./squad.js`.

- [ ] **Step 3: Implement squad validation**

Create `src/strategy/squad.ts`:

```ts
import { FPL_RULES, POSITION_BY_ELEMENT_TYPE, type PositionKey } from './rules.js';

export interface SquadPlayer {
  id: number;
  elementType: number;
  team: number;
  price: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function countByPosition(elementTypes: number[]): Record<PositionKey, number> {
  const counts: Record<PositionKey, number> = {
    goalkeeper: 0,
    defender: 0,
    midfielder: 0,
    forward: 0,
  };

  for (const elementType of elementTypes) {
    const position = POSITION_BY_ELEMENT_TYPE[elementType];
    if (position) counts[position]++;
  }

  return counts;
}

export function validateFormation(elementTypes: number[]): ValidationResult {
  const errors: string[] = [];
  const counts = countByPosition(elementTypes);

  if (elementTypes.length !== FPL_RULES.startingSize) {
    errors.push(`Starting XI must contain exactly ${FPL_RULES.startingSize} players`);
  }

  for (const [position, limits] of Object.entries(FPL_RULES.formation)) {
    const count = counts[position as PositionKey];
    if (count < limits.min || count > limits.max) {
      errors.push(`${position} count ${count} is outside allowed range ${limits.min}-${limits.max}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateSquad(players: SquadPlayer[], budget: number): ValidationResult {
  const errors: string[] = [];

  if (players.length !== FPL_RULES.squadSize) {
    errors.push(`Squad must contain exactly ${FPL_RULES.squadSize} players`);
  }

  const counts = countByPosition(players.map(p => p.elementType));
  for (const [position, expected] of Object.entries(FPL_RULES.squadComposition)) {
    const actual = counts[position as PositionKey];
    if (actual !== expected) {
      errors.push(`${position} count ${actual} must equal ${expected}`);
    }
  }

  const cost = players.reduce((sum, p) => sum + p.price, 0);
  if (cost > budget) {
    errors.push(`Squad cost ${cost} exceeds budget ${budget}`);
  }

  const teamCounts = new Map<number, number>();
  for (const player of players) {
    teamCounts.set(player.team, (teamCounts.get(player.team) || 0) + 1);
  }
  for (const [team, count] of teamCounts) {
    if (count > FPL_RULES.maxPlayersPerClub) {
      errors.push(`Team ${team} has ${count} players; maximum is ${FPL_RULES.maxPlayersPerClub}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
```

Modify `src/strategy/index.ts`:

```ts
export * from './rules.js';
export * from './squad.js';
```

- [ ] **Step 4: Run squad tests to verify they pass**

Run: `npm test -- src/strategy/squad.test.ts`

Expected: PASS for all squad tests.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/strategy/squad.ts src/strategy/squad.test.ts src/strategy/index.ts
git commit -m "Add squad validation foundation"
```

---

### Task 3: Add Projection Engine Foundation

**Files:**
- Create: `src/strategy/projections.ts`
- Create: `src/strategy/projections.test.ts`
- Modify: `src/strategy/index.ts`

- [ ] **Step 1: Write failing projection tests**

Create `src/strategy/projections.test.ts`:

```ts
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
```

- [ ] **Step 2: Run projection tests to verify they fail**

Run: `npm test -- src/strategy/projections.test.ts`

Expected: FAIL with module-not-found errors for `./projections.js`.

- [ ] **Step 3: Implement projection helper**

Create `src/strategy/projections.ts`:

```ts
import { POSITION_BY_ELEMENT_TYPE, SCORING_RULES } from './rules.js';

export interface ProjectionFixtureInput {
  difficulty: number;
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
  const fixtureCount = Math.max(1, input.fixtures.length);
  const fixtureMultiplier = input.fixtures.length > 0
    ? input.fixtures.reduce((sum, fixture) => sum + (FDR_WEIGHTS[fixture.difficulty] || 1), 0) / input.fixtures.length
    : 1;
  const minutesRatio = Math.max(0, Math.min(1, input.expectedMinutes / 90));
  const appearance = Math.max(0, Math.min(1, input.appearanceProbability));
  const playPoints = input.expectedMinutes >= SCORING_RULES.minutes.longPlayThreshold
    ? SCORING_RULES.minutes.longPlayPoints
    : input.expectedMinutes > 0
      ? SCORING_RULES.minutes.shortPlayPoints
      : 0;

  const minutes = playPoints * appearance * fixtureCount;
  const goals = input.expectedGoals * SCORING_RULES.goals[position] * appearance * fixtureMultiplier;
  const assists = input.expectedAssists * SCORING_RULES.assist * appearance * fixtureMultiplier;
  const cleanSheets = input.cleanSheetProbability * SCORING_RULES.cleanSheet[position] * appearance * minutesRatio * fixtureCount;
  const saves = Math.floor(input.expectedSaves / SCORING_RULES.saves.savesPerBlock) * SCORING_RULES.saves.pointsPerSaveBlock * appearance;
  const penalties = (input.penaltySaveProbability * SCORING_RULES.penaltiesSaved) + (input.penaltyMissProbability * SCORING_RULES.penaltiesMissed);
  const cards = (input.yellowCardProbability * SCORING_RULES.yellowCard) + (input.redCardProbability * SCORING_RULES.redCard);
  const ownGoals = input.ownGoalProbability * SCORING_RULES.ownGoal;
  const goalsConceded = (position === 'goalkeeper' || position === 'defender')
    ? Math.floor(input.expectedGoalsConceded / SCORING_RULES.goalsConceded.goalsPerBlock) * SCORING_RULES.goalsConceded.goalkeeperDefenderPenalty * appearance
    : 0;
  const defensiveContribution = position === 'goalkeeper'
    ? 0
    : input.defensiveContributionProbability * SCORING_RULES.defensiveContribution.points * appearance;
  const bonus = input.expectedBonus * appearance;

  const expectedPoints = minutes + goals + assists + cleanSheets + saves + penalties + cards + ownGoals + goalsConceded + defensiveContribution + bonus;
  const confidence = Math.max(0.1, Math.min(1, appearance * (0.5 + minutesRatio * 0.5)));

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
```

Modify `src/strategy/index.ts`:

```ts
export * from './rules.js';
export * from './squad.js';
export * from './projections.js';
```

- [ ] **Step 4: Run projection tests to verify they pass**

Run: `npm test -- src/strategy/projections.test.ts`

Expected: PASS for all projection tests.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/strategy/projections.ts src/strategy/projections.test.ts src/strategy/index.ts
git commit -m "Add projection engine foundation"
```

---

### Task 4: Integrate Projection Helper Into Optimizer

**Files:**
- Modify: `src/engine/optimizer.ts`
- Modify: `src/engine/optimizer.test.ts`

- [ ] **Step 1: Add failing optimizer integration test**

Append this test to `src/engine/optimizer.test.ts`:

```ts
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
```

- [ ] **Step 2: Run optimizer tests to verify they fail**

Run: `npm test -- src/engine/optimizer.test.ts`

Expected: FAIL because `ExpectedPoints.breakdown` does not yet expose `defensiveContribution`.

- [ ] **Step 3: Update optimizer types and calculation**

Modify `src/engine/optimizer.ts`:

1. Add import:

```ts
import { projectPlayerPoints } from '../strategy/projections.js';
```

2. Extend `ExpectedPoints.breakdown`:

```ts
  breakdown: {
    formFactor: number;
    fixtureFactor: number;
    minutesFactor: number;
    setpieceFactor: number;
    defensiveContribution: number;
  };
```

3. Inside `calculateExpectedPoints`, after `fixtureFactor` is calculated, add this helper and projection code:

```ts
    const nextFixtures = this.getUpcomingFixtures(player.team, 1);

    const toProjectionInput = (fixturesForProjection: Fixture[]) => ({
      elementType: player.element_type,
      expectedMinutes: Math.min(90, player.minutes / Math.max(1, this.currentGW)),
      appearanceProbability: player.status === 'a'
        ? ((player.chance_of_playing_next_round ?? 100) / 100)
        : ((player.chance_of_playing_next_round ?? 0) / 100),
      expectedGoals: (player.expected_goals_per_90 || 0) * fixturesForProjection.length,
      expectedAssists: (player.expected_assists_per_90 || 0) * fixturesForProjection.length,
      cleanSheetProbability: player.element_type <= 3 ? Math.max(0, Math.min(1, 0.45 * fixtureFactor)) : 0,
      expectedSaves: player.element_type === 1 ? (player.saves_per_90 || 0) * fixturesForProjection.length : 0,
      penaltySaveProbability: player.element_type === 1 ? 0.02 * fixturesForProjection.length : 0,
      penaltyMissProbability: 0.01 * fixturesForProjection.length,
      yellowCardProbability: 0.12 * fixturesForProjection.length,
      redCardProbability: 0.01 * fixturesForProjection.length,
      ownGoalProbability: 0.005 * fixturesForProjection.length,
      expectedGoalsConceded: (player.expected_goals_conceded_per_90 || player.goals_conceded_per_90 || 1) * fixturesForProjection.length,
      defensiveContributionProbability: player.element_type === 1 ? 0 : Math.min(0.8, 0.2 + minutesFactor * 0.3),
      expectedBonus: Math.max(0, Math.min(1.5, parseFloat(player.form) / 6)),
      fixtures: fixturesForProjection.map(f => ({ difficulty: this.getNextFDR(f, player.team) })),
    });

    const projection = projectPlayerPoints(toProjectionInput(upcomingFixtures));
    const nextProjection = projectPlayerPoints(toProjectionInput(nextFixtures));
```

4. Replace the return object's projection fields with:

```ts
      nextGW: nextProjection.expectedPoints,
      next5GW: projection.expectedPoints,
      confidence: projection.confidence,
      breakdown: {
        formFactor: Math.round(formFactor * 100) / 100,
        fixtureFactor: Math.round(fixtureFactor * 100) / 100,
        minutesFactor: Math.round(minutesFactor * 100) / 100,
        setpieceFactor: Math.round(setpieceFactor * 100) / 100,
        defensiveContribution: projection.breakdown.defensiveContribution,
      },
```

- [ ] **Step 4: Run optimizer tests to verify they pass**

Run: `npm test -- src/engine/optimizer.test.ts`

Expected: PASS for all optimizer tests.

- [ ] **Step 5: Run all tests and build**

Run: `npm test && npm run build`

Expected: all tests pass and TypeScript compilation succeeds.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/engine/optimizer.ts src/engine/optimizer.test.ts
git commit -m "Use strategy projections in optimizer"
```

---

### Task 5: Update Agent Rules Text And README

**Files:**
- Modify: `src/agent.ts`
- Modify: `README.md`

- [ ] **Step 1: Update `src/agent.ts` rules text**

Replace the existing `FPL_RULES_2025_26` string with:

```ts
const FPL_RULES_2025_26 = `
## FPL 2025/26 Season Rules

### Squad Rules
- 15 players: 2 GKP, 5 DEF, 5 MID, 3 FWD
- Max 3 players from a Premier League club
- Initial budget: £100.0m
- Starting XI must include 1 GKP, at least 3 DEF, at least 2 MID, and at least 1 FWD
- Autosubs must preserve formation rules

### Captaincy
- Captain scores double
- Vice-captain receives captaincy only if captain plays 0 minutes
- If captain and vice-captain both play 0 minutes, no player score is doubled

### Transfers
- 1 free transfer per gameweek after the first deadline
- Can bank up to 5 free transfers
- Extra transfers cost -4 points each
- Max 20 transfers in a gameweek unless using Wildcard or Free Hit
- After the GW15 deadline and before GW16, free transfers top up to 5
- Selling price keeps half of player price profit, rounded down to £0.1m
- Wildcard and Free Hit retain saved free transfers for the following gameweek

### Chips
- Only one chip can be played per gameweek
- Two Bench Boosts, two Triple Captains, two Free Hits, and two Wildcards are available across the season, split around the GW19 deadline
- Bench Boost: bench points count
- Triple Captain: captain scores triple instead of double
- Free Hit: unlimited free transfers for one gameweek, squad reverts next deadline
- Wildcard: all transfers in the gameweek are free

### Scoring Highlights
- Appearance: 1 point under 60 minutes, 2 points at 60+ minutes
- Goals: GKP 10, DEF 6, MID 5, FWD 4
- Assist: 3
- Clean sheet: GKP/DEF 4, MID 1
- Defensive contribution: DEF 2 points for 10+ CBI+tackles; MID/FWD 2 points for 12+ CBI+tackles+recoveries
- Saves: 1 per 3 saves
- Penalty save: 5; penalty miss: -2
- Yellow: -1; red: -3; own goal: -2
`;
```

- [ ] **Step 2: Update `README.md` rules section**

Replace lines under `## FPL Rules (2025/26)` with:

```md
- Squad: 15 players, 2 GKP / 5 DEF / 5 MID / 3 FWD
- Starting XI: 1 GKP, at least 3 DEF, at least 2 MID, at least 1 FWD
- Save up to 5 free transfers
- -4 points per transfer beyond available free transfers
- Max 20 transfers in a GW unless using Wildcard or Free Hit
- Chips are split around the GW19 deadline: 2 Bench Boosts, 2 Triple Captains, 2 Free Hits, 2 Wildcards
- Only one chip can be played per GW
- Defensive contribution points are included in projections
- Price selling keeps half of profit rounded down to £0.1m
```

- [ ] **Step 3: Run build**

Run: `npm run build`

Expected: TypeScript compilation succeeds.

- [ ] **Step 4: Commit Task 5**

```bash
git add src/agent.ts README.md
git commit -m "Update documented FPL rules"
```

---

### Task 6: Final Verification

**Files:**
- No code changes expected.

- [ ] **Step 1: Run full verification**

Run: `npm test && npm run build`

Expected: all tests pass and TypeScript compilation succeeds.

- [ ] **Step 2: Inspect final status**

Run: `git status --short`

Expected: no unstaged or untracked implementation files. If only intentional files remain, commit them. If no files remain, continue.

- [ ] **Step 3: Review final diff if there are uncommitted changes**

Run: `git diff --stat`

Expected: no output if all task commits were made. If output exists, inspect and commit only intended files.

---

## Self-Review

Spec coverage:

- Official rule inputs: covered by Task 1 and Task 2.
- Rules/state/projection foundations: covered by Task 1, Task 2, Task 3, and Task 4.
- DGW/BGW projection groundwork: covered by Task 3 and existing optimizer fixture tests.
- Automation expansion: intentionally out of scope for this first implementation increment.
- News/social, scenario simulator, utility engine, calibration: intentionally deferred to later plans after rules/state/projection foundations exist.

Placeholder scan:

- No TBD/TODO placeholders are present.
- Deferred scope is explicitly named and excluded from this increment.

Type consistency:

- `PositionKey`, `ChipName`, `SquadPlayer`, `ProjectionInput`, and `ProjectionResult` are defined before use.
- Barrel exports in `src/strategy/index.ts` are updated in each task that adds a module.

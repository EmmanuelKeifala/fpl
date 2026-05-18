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
  assert.equal(getFreeTransfersAfterGameweek({ previousFreeTransfers: 2, transfersMade: 1, nextGameweek: 10 }), 2);
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

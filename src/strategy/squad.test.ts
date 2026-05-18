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

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { validateFormation } from '../../strategy/squad.js';
import { selectCaptaincy, selectLineup } from './lineup.js';
import type { BacktestPlayer } from '../types.js';

function player(id: number, expectedPoints: number, elementType: number): BacktestPlayer {
  return { id, webName: `P${id}`, elementType, team: id, price: 50, status: 'a', selectedByPercent: 0, expectedPoints };
}

test('selectLineup chooses one goalkeeper even when both goalkeepers rank highly', () => {
  const players = [
    player(1, 12, 1), player(2, 11, 1),
    ...Array.from({ length: 5 }, (_, index) => player(index + 3, 10 - index, 2)),
    ...Array.from({ length: 5 }, (_, index) => player(index + 8, 8 - index, 3)),
    ...Array.from({ length: 3 }, (_, index) => player(index + 13, 6 - index, 4)),
  ];

  const lineup = selectLineup(players.map(candidate => candidate.id), new Map(players.map(candidate => [candidate.id, candidate])));
  const starters = lineup.startingXi.map(id => players.find(candidate => candidate.id === id)!);

  assert.equal(starters.filter(candidate => candidate.elementType === 1).length, 1);
  assert.deepEqual(validateFormation(starters.map(candidate => candidate.elementType)).errors, []);
  assert.equal(lineup.bench.length, 4);
});

test('selectCaptaincy picks the two highest projected starters', () => {
  const players = [player(1, 3, 1), player(2, 9, 2), player(3, 8, 3)];
  assert.deepEqual(selectCaptaincy([1, 2, 3], new Map(players.map(candidate => [candidate.id, candidate]))), {
    captain: 2,
    viceCaptain: 3,
  });
});

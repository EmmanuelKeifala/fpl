import { strict as assert } from 'node:assert';
import test from 'node:test';
import { chooseBestTransfers } from './transfers.js';
import type { BacktestPlayer, SquadPick } from '../types.js';

function player(id: number, expectedPoints: number, price: number, elementType = 3, team = id): BacktestPlayer {
  return { id, webName: `P${id}`, elementType, team, price, status: 'a', selectedByPercent: 0, expectedPoints };
}

function pick(playerId: number, price = 50): SquadPick {
  return { playerId, purchasePrice: price, sellingPrice: price };
}

test('chooseBestTransfers makes one beneficial free transfer', () => {
  const players = [
    player(1, 4, 45, 1), player(2, 4, 45, 1),
    ...Array.from({ length: 5 }, (_, index) => player(index + 3, 4, 45, 2)),
    ...Array.from({ length: 5 }, (_, index) => player(index + 8, index === 4 ? 2 : 4, 45, 3)),
    ...Array.from({ length: 3 }, (_, index) => player(index + 13, 4, 45, 4)),
    player(99, 12, 45, 3, 99),
  ];
  const squad = players.filter(candidate => candidate.id <= 15).map(candidate => pick(candidate.id));
  const result = chooseBestTransfers({ squad, bank: 0, freeTransfers: 1, players, maxCandidatesPerPosition: 10, hitThreshold: 4.5 });

  assert.deepEqual(result.transfers, [{ out: 12, in: 99 }]);
  assert.equal(result.projectedGain > 0, true);
});

test('chooseBestTransfers refuses a hit below threshold', () => {
  const players = [
    player(1, 4, 45, 1), player(2, 4, 45, 1),
    ...Array.from({ length: 5 }, (_, index) => player(index + 3, 4, 45, 2)),
    ...Array.from({ length: 5 }, (_, index) => player(index + 8, index === 4 ? 2 : 4, 45, 3)),
    ...Array.from({ length: 3 }, (_, index) => player(index + 13, 4, 45, 4)),
    player(99, 5, 45, 3, 99),
  ];
  const squad = players.filter(candidate => candidate.id <= 15).map(candidate => pick(candidate.id));
  const result = chooseBestTransfers({ squad, bank: 0, freeTransfers: 0, players, maxCandidatesPerPosition: 10, hitThreshold: 4.5 });

  assert.deepEqual(result.transfers, []);
});

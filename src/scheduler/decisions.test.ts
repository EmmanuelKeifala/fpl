import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { MyTeam, Player } from '../api/types.js';
import { getActiveLineupChip, getFreeTransfers, selectStableCaptaincy } from './decisions.js';

function team(): MyTeam {
  return {
    picks: [],
    chips: [],
    transfers: { cost: 0, status: 'available', limit: 2, made: 1, bank: 0, value: 1000 },
  };
}

test('preseason unlimited transfers never create synthetic hit costs', () => {
  const value = team();
  value.transfers.status = 'unlimited';
  value.transfers.limit = null;
  value.transfers.made = 12;
  assert.equal(getFreeTransfers(value), Number.POSITIVE_INFINITY);
});

test('active lineup chip is detected so later lineup updates preserve it', () => {
  const value = team();
  value.chips.push({
    name: 'bboost',
    number: 1,
    status_for_entry: 'active',
    is_pending: true,
    played_by_entry: [],
    start_event: 1,
    stop_event: 19,
    chip_type: 'team',
  });
  assert.equal(getActiveLineupChip(value), 'bboost');
});

test('captaincy avoids goalkeepers and retains a close attacking incumbent', () => {
  const candidate = (id: number, elementType: number, xp: number, xg: number): { player: Player; xp: number } => ({
    player: {
      id,
      element_type: elementType,
      expected_goals_per_90: xg,
      expected_assists_per_90: 0,
      penalties_order: null,
    } as Player,
    xp,
  });
  const starters = [candidate(1, 1, 4.2, 0), candidate(2, 3, 3.8, 0.3), candidate(3, 4, 3.5, 0.5)];
  const fromGoalkeeper = selectStableCaptaincy(starters, {
    picks: [
      { element: 1, position: 1, multiplier: 2, is_captain: true, is_vice_captain: false },
      { element: 3, position: 2, multiplier: 1, is_captain: false, is_vice_captain: true },
    ],
  });
  assert.notEqual(fromGoalkeeper.captain.player.element_type, 1);

  const stable = selectStableCaptaincy(starters, {
    picks: [
      { element: 3, position: 1, multiplier: 2, is_captain: true, is_vice_captain: false },
      { element: 2, position: 2, multiplier: 1, is_captain: false, is_vice_captain: true },
    ],
  });
  assert.equal(stable.captain.player.id, 3);
});

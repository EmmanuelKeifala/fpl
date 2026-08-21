import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { Player } from '../api/types.js';
import type { NewsItem } from './news.js';
import {
  buildExternalNewsSignals,
  buildOfficialNewsSignals,
  mergePlayerNewsSignals,
} from './news-signals.js';

const deadline = new Date('2026-08-22T10:00:00.000Z');

function player(overrides: Partial<Player> = {}): Player {
  return {
    id: 10,
    web_name: 'Salah',
    first_name: 'Mohamed',
    second_name: 'Salah',
    status: 'a',
    chance_of_playing_next_round: 100,
    news: '',
    news_added: null,
    ...overrides,
  } as Player;
}

function item(content: string, overrides: Partial<NewsItem> = {}): NewsItem {
  return {
    source: 'Twitter/@LiveFPL',
    title: content,
    content,
    timestamp: new Date('2026-08-22T09:55:00.000Z'),
    timestampVerified: true,
    priority: 'high',
    ...overrides,
  };
}

test('official 50 percent doubt changes availability once, not conditional minutes', () => {
  const [signal] = buildOfficialNewsSignals([
    player({ status: 'd', chance_of_playing_next_round: 50, news: '50% chance of playing' }),
  ], 1, deadline);

  assert.equal(signal?.type, 'doubtful');
  assert.equal(signal?.availabilityProbability, 0.5);
  assert.equal(signal?.minutesMultiplier, 1);
  assert.equal(signal?.confirmedLineup, false);
});

test('fresh verified single-name lineup leak overrides a generic official doubt', () => {
  const flagged = player({
    status: 'd',
    chance_of_playing_next_round: 50,
    news: '50% chance of playing',
    news_added: '2026-08-20T09:00:00.000Z',
  });
  const official = buildOfficialNewsSignals([flagged], 1, deadline);
  const external = buildExternalNewsSignals({
    items: [item('Salah starts for Liverpool')],
    players: [flagged],
    gameweek: 1,
    deadline,
    retrievedAt: new Date('2026-08-22T09:56:00.000Z'),
  });

  const [merged] = mergePlayerNewsSignals([...official, ...external]);

  assert.equal(external.length, 1);
  assert.equal(merged?.type, 'expected-start');
  assert.equal(merged?.confirmedLineup, true);
  assert.equal(merged?.availabilityProbability, 1);
  assert.equal(merged?.expectedMinutesFloor, 60);
});

test('common starting-XI wording is classified as a confirmed start', () => {
  const [signal] = buildExternalNewsSignals({
    items: [item('Salah named in the starting XI')],
    players: [player()],
    gameweek: 1,
    deadline,
    retrievedAt: new Date('2026-08-22T09:56:00.000Z'),
  });

  assert.equal(signal?.type, 'expected-start');
  assert.equal(signal?.confirmedLineup, true);
});

test('contradictory fresh lineup reports produce an explicit hold-worthy conflict', () => {
  const squadPlayer = player();
  const signals = buildExternalNewsSignals({
    items: [
      item('Salah starts for Liverpool', { source: 'Twitter/@LiveFPL' }),
      item('Salah benched for Liverpool', { source: 'Twitter/@BenCrellin' }),
    ],
    players: [squadPlayer],
    gameweek: 1,
    deadline,
    retrievedAt: new Date('2026-08-22T09:56:00.000Z'),
  });

  const [merged] = mergePlayerNewsSignals(signals);

  assert.equal(merged?.conflicted, true);
  assert.equal(merged?.confirmedLineup, false);
  assert.equal(merged?.type, 'doubtful');
});

test('verified reports published after the deadline are ignored', () => {
  const signals = buildExternalNewsSignals({
    items: [item('Salah starts', { timestamp: new Date('2026-08-22T10:01:00.000Z') })],
    players: [player()],
    gameweek: 1,
    deadline,
  });

  assert.deepEqual(signals, []);
});

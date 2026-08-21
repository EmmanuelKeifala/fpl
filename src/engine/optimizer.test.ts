import { strict as assert } from 'node:assert';
import test from 'node:test';
import { OptimizationEngine } from './optimizer.js';
import { buildOfficialNewsSignals } from '../scheduler/news-signals.js';

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

test('calculateExpectedPoints includes defensive contribution in player projection', () => {
  const engine = new OptimizationEngine() as any;
  engine.currentGW = 10;
  engine.gameweeks = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, finished: true }));
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
      starts: 12,
      total_points: 50,
      points_per_game: '5.0',
      ep_next: '3.5',
      penalties_order: null,
      corners_and_indirect_freekicks_order: null,
      direct_freekicks_order: null,
      expected_goals_per_90: 0.1,
      expected_assists_per_90: 0.1,
      expected_goals_conceded_per_90: 1,
      defensive_contribution_per_90: 12,
      saves_per_90: 0,
      goals_conceded_per_90: 1,
      chance_of_playing_next_round: 100,
      status: 'a',
    },
  ]]);
  engine.fixtures = [{ id: 1, event: 10, team_h: 1, team_a: 2, team_h_difficulty: 3, team_a_difficulty: 3 }];

  const xp = engine.calculateExpectedPoints(10, 1);

  assert.ok(xp.nextGW > 0);
  assert.ok(xp.breakdown.defensiveContribution > 0);
});

test('live defensive-action rates distinguish high and low contribution players', () => {
  const engine = new OptimizationEngine() as any;
  engine.currentGW = 10;
  engine.gameweeks = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, finished: true }));
  engine.teams = new Map([
    [1, { id: 1, short_name: 'ONE' }],
    [2, { id: 2, short_name: 'TWO' }],
  ]);
  const base = {
    first_name: 'Test', second_name: 'Player', team: 1, element_type: 2,
    form: '0', minutes: 1800, penalties_order: null,
    corners_and_indirect_freekicks_order: null, direct_freekicks_order: null,
    expected_goals_per_90: 0, expected_assists_per_90: 0,
    expected_goals_conceded_per_90: 1, goals_conceded_per_90: 1,
    saves_per_90: 0, chance_of_playing_next_round: 100, status: 'a',
  };
  engine.players = new Map([
    [10, { ...base, id: 10, web_name: 'High', defensive_contribution_per_90: 14 }],
    [11, { ...base, id: 11, web_name: 'Low', defensive_contribution_per_90: 2 }],
  ]);
  engine.fixtures = [{ id: 1, event: 10, team_h: 1, team_a: 2, team_h_difficulty: 3, team_a_difficulty: 3 }];

  const high = engine.calculateExpectedPoints(10, 1);
  const low = engine.calculateExpectedPoints(11, 1);
  assert.ok(high.breakdown.defensiveContribution > low.breakdown.defensiveContribution);
});

test('preseason role inference keeps official current-season evidence in the blend', () => {
  const engine = new OptimizationEngine() as any;
  engine.currentGW = 1;
  engine.gameweeks = [{ id: 1, finished: false }];
  engine.teams = new Map([[1, { id: 1, short_name: 'ONE' }], [2, { id: 2, short_name: 'TWO' }]]);
  const base = {
    first_name: 'Test', second_name: 'Player', team: 1, element_type: 2,
    form: '0', total_points: 0, points_per_game: '0', ep_next: '2.5',
    penalties_order: null, corners_and_indirect_freekicks_order: null,
    direct_freekicks_order: null, expected_goals_per_90: 0,
    expected_assists_per_90: 0, expected_goals_conceded_per_90: 1,
    defensive_contribution_per_90: 0, saves_per_90: 0,
    goals_conceded_per_90: 1, chance_of_playing_next_round: 100, status: 'a',
  };
  engine.players = new Map([
    [10, { ...base, id: 10, web_name: 'PriorEverPresent', minutes: 3378, starts: 38 }],
    [11, { ...base, id: 11, web_name: 'PriorRotation', minutes: 986, starts: 10 }],
  ]);
  engine.fixtures = [{ id: 1, event: 1, team_h: 1, team_a: 2, team_h_difficulty: 3, team_a_difficulty: 3 }];

  const everPresent = engine.calculateExpectedPoints(10, 1);
  const rotation = engine.calculateExpectedPoints(11, 1);

  assert.ok(everPresent.breakdown.expectedMinutes < 82);
  assert.ok(everPresent.breakdown.expectedMinutes - rotation.breakdown.expectedMinutes < 22);
});

test('a 50 percent availability flag is applied once to the next gameweek only', () => {
  const engine = new OptimizationEngine() as any;
  engine.currentGW = 10;
  engine.gameweeks = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    finished: index < 9,
    deadline_time: index === 9 ? '2099-08-22T10:00:00.000Z' : '2000-01-01T00:00:00.000Z',
  }));
  engine.teams = new Map([
    [1, { id: 1, short_name: 'ONE' }],
    [2, { id: 2, short_name: 'TWO' }],
  ]);
  const base = {
    first_name: 'Test', second_name: 'Player', team: 1, element_type: 3,
    form: '5', minutes: 810, starts: 9, total_points: 45,
    points_per_game: '5', ep_next: '5', penalties_order: null,
    corners_and_indirect_freekicks_order: null, direct_freekicks_order: null,
    expected_goals_per_90: 0.25, expected_assists_per_90: 0.2,
    expected_goals_conceded_per_90: 1, goals_conceded_per_90: 1,
    defensive_contribution_per_90: 6, saves_per_90: 0, status: 'a',
    chance_of_playing_next_round: 100, news: '', news_added: null,
  };
  const available = { ...base, id: 10, web_name: 'Available' };
  const doubtful = {
    ...base,
    id: 11,
    web_name: 'Doubtful',
    status: 'd',
    chance_of_playing_next_round: 50,
    news: '50% chance of playing',
  };
  engine.players = new Map([[10, available], [11, doubtful]]);
  engine.fixtures = [10, 11, 12].map(event => ({
    id: event,
    event,
    team_h: 1,
    team_a: 2,
    team_h_difficulty: 3,
    team_a_difficulty: 3,
  }));
  engine.setNewsSignals(buildOfficialNewsSignals(
    [doubtful] as any,
    10,
    new Date('2099-08-22T10:00:00.000Z')
  ));

  const fit = engine.calculateExpectedPoints(10, 3);
  const flagged = engine.calculateExpectedPoints(11, 3);
  const nextRatio = flagged.nextGW / fit.nextGW;
  const horizonRatio = flagged.next5GW / fit.next5GW;

  assert.equal(flagged.breakdown.expectedMinutes, fit.breakdown.expectedMinutes);
  assert.ok(nextRatio >= 0.4 && nextRatio <= 0.65, `unexpected next-GW ratio ${nextRatio}`);
  assert.ok(horizonRatio > nextRatio + 0.15, `future recovery not reflected: ${horizonRatio}`);
});

test('alternative captain ranking excludes goalkeepers and never trades xP for low ownership', () => {
  const engine = new OptimizationEngine() as any;
  engine.currentGW = 1;
  engine.players = new Map([
    [1, { id: 1, web_name: 'Keeper', team: 1, element_type: 1 }],
    [2, { id: 2, web_name: 'TemplateMid', team: 2, element_type: 3 }],
    [3, { id: 3, web_name: 'DifferentialForward', team: 3, element_type: 4 }],
  ]);
  engine.teams = new Map([[1, { short_name: 'ONE' }], [2, { short_name: 'TWO' }], [3, { short_name: 'THR' }]]);
  engine.fixtures = [];
  engine.calculateExpectedPoints = (id: number) => ({ nextGW: id === 1 ? 4.2 : id === 2 ? 3.3 : 3.0 });
  engine.calculateEffectiveOwnership = (id: number) => ({
    ownership: id === 2 ? 50 : 1,
    effectiveOwnership: id === 2 ? 60 : 1,
  });

  const alternatives = engine.getAlternativeCaptains([1, 2, 3], 3);

  assert.deepEqual(alternatives.map((candidate: { player: string }) => candidate.player), [
    'TemplateMid',
    'DifferentialForward',
  ]);
});

test('preseason price prediction remains stable despite transfer activity', () => {
  const engine = new OptimizationEngine() as any;
  engine.gameweeks = [{ id: 1, finished: false }];
  engine.players = new Map([[10, {
    id: 10,
    web_name: 'Preseason',
    now_cost: 100,
    transfers_in_event: 500_000,
    transfers_out_event: 0,
    selected_by_percent: '50',
    price_change_percent: '20',
  }]]);
  const prediction = engine.predictPriceChange(10);
  assert.equal(prediction.prediction, 'stable');
  assert.equal(prediction.confidence, 1);
  assert.equal(prediction.source, 'frozen');
  assert.match(prediction.reasoning, /frozen/i);
});

test('price prediction distinguishes official indicators from heuristic estimates', () => {
  const engine = new OptimizationEngine() as any;
  engine.gameweeks = [{ id: 1, finished: true }];
  const base = {
    web_name: 'Mover',
    now_cost: 80,
    transfers_in_event: 100_000,
    transfers_out_event: 0,
    selected_by_percent: '10',
  };
  engine.players = new Map([[10, { ...base, id: 10, price_change_percent: '75' }]]);
  assert.equal(engine.predictPriceChange(10).source, 'official');
  assert.equal(engine.predictPriceChange(10).prediction, 'stable');

  engine.players = new Map([[11, { ...base, id: 11 }]]);
  assert.equal(engine.predictPriceChange(11).source, 'heuristic');
});

test('price signals become actionable after the GW1 deadline even before GW1 finishes', () => {
  const engine = new OptimizationEngine() as any;
  engine.gameweeks = [{
    id: 1,
    finished: false,
    deadline_time: new Date(Date.now() - 60_000).toISOString(),
  }];
  engine.players = new Map([[10, {
    id: 10,
    web_name: 'PostDeadlineMover',
    now_cost: 80,
    transfers_in_event: 100_000,
    transfers_out_event: 0,
    selected_by_percent: '10',
    price_change_percent: '105',
  }]]);

  const prediction = engine.predictPriceChange(10);
  assert.equal(prediction.source, 'official');
  assert.equal(prediction.prediction, 'rise');
});

test('official projected progress supports falling prices and calibration holds', () => {
  const engine = new OptimizationEngine() as any;
  engine.gameweeks = [{
    id: 1,
    finished: true,
    deadline_time: new Date(Date.now() - 60_000).toISOString(),
  }];
  const base = {
    web_name: 'Mover',
    now_cost: 80,
    transfers_in_event: 0,
    transfers_out_event: 100_000,
    selected_by_percent: '10',
    price_change_percent: '-80',
    price_change_projections: [{ offset: 0, projected_percent: '-110', likelihood: 90 }],
  };
  engine.players = new Map([[10, { ...base, id: 10 }]]);
  assert.equal(engine.predictPriceChange(10).prediction, 'fall');
  assert.ok(engine.predictPriceChange(10).confidence >= 0.9);

  engine.players = new Map([[11, { ...base, id: 11, price_change_calibrating: true }]]);
  assert.equal(engine.predictPriceChange(11).prediction, 'stable');
  assert.match(engine.predictPriceChange(11).reasoning, /calibrating/);
});

test('getMostOwnedPlayersByPosition ranks template picks by official ownership', () => {
  const engine = new OptimizationEngine() as any;
  engine.players = new Map([
    [10, { id: 10, web_name: 'Past points leader', element_type: 3, status: 'a', selected_by_percent: '9.9', total_points: 250 }],
    [11, { id: 11, web_name: 'Ownership leader', element_type: 3, status: 'a', selected_by_percent: '50.3', total_points: 100 }],
    [12, { id: 12, web_name: 'Second most owned', element_type: 3, status: 'a', selected_by_percent: '10.0', total_points: 50 }],
    [13, { id: 13, web_name: 'Different position', element_type: 4, status: 'a', selected_by_percent: '80.0', total_points: 300 }],
    [14, { id: 14, web_name: 'Unavailable', element_type: 3, status: 'i', selected_by_percent: '90.0', total_points: 300 }],
  ]);

  const template = engine.getMostOwnedPlayersByPosition(3, 3);

  assert.deepEqual(template.map((player: { id: number }) => player.id), [11, 12, 10]);
});

test('getMostOwnedPlayersByPosition handles malformed ownership deterministically', () => {
  const engine = new OptimizationEngine() as any;
  engine.players = new Map([
    [20, { id: 20, element_type: 2, status: 'a', selected_by_percent: '', total_points: 200 }],
    [19, { id: 19, element_type: 2, status: 'a', selected_by_percent: 'not-a-number', total_points: 100 }],
    [21, { id: 21, element_type: 2, status: 'a', selected_by_percent: '1.0', total_points: 0 }],
  ]);

  const template = engine.getMostOwnedPlayersByPosition(2);

  assert.deepEqual(template.map((player: { id: number }) => player.id), [21, 19, 20]);
});

test('triple captain is not recommended for an unrelated club double', () => {
  const engine = new OptimizationEngine() as any;
  engine.currentGW = 10;
  engine.gameweeks = [{ id: 10, finished: false }];
  engine.seasonConfig = {
    chipWindows: [{ name: '3xc', number: 1, startEvent: 1, stopEvent: 19, chipType: 'team' }],
  };
  engine.teams = new Map([[1, { id: 1, short_name: 'ONE' }], [2, { id: 2 }], [3, { id: 3 }], [4, { id: 4 }]]);
  engine.players = new Map([[10, {
    id: 10, web_name: 'Single', first_name: 'Single', second_name: 'Player', team: 1,
    element_type: 3, form: '0', minutes: 0, penalties_order: null,
    corners_and_indirect_freekicks_order: null, direct_freekicks_order: null,
    expected_goals_per_90: 0.2, expected_assists_per_90: 0.2,
    expected_goals_conceded_per_90: 1, goals_conceded_per_90: 1, saves_per_90: 0,
    chance_of_playing_next_round: 100, status: 'a', transfers_in_event: 0,
    transfers_out_event: 0, selected_by_percent: '1', now_cost: 70,
  }]]);
  engine.fixtures = [
    { id: 1, event: 10, team_h: 1, team_a: 2, team_h_difficulty: 3, team_a_difficulty: 3 },
    { id: 2, event: 10, team_h: 3, team_a: 4, team_h_difficulty: 3, team_a_difficulty: 3 },
    { id: 3, event: 10, team_h: 2, team_a: 3, team_h_difficulty: 3, team_a_difficulty: 3 },
  ];
  const recommendation = engine.evaluateChip('3xc', 10, [10], []);
  assert.equal(recommendation.recommended, false);
  assert.equal(recommendation.expectedGain, 0);
  assert.match(recommendation.reasoning, /No proposed starter/);
});

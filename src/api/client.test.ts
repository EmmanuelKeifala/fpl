import { strict as assert } from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { MyTeam } from './types.js';

const directory = await mkdtemp(join(tmpdir(), 'fpl-api-safety-'));
process.env.FPL_DB_PATH = join(directory, 'operations.db');
process.env.FPL_MUTATION_LOCK_PATH = join(directory, 'mutation.lock');
process.env.FPL_RUNNER_LOCK_PATH = join(directory, 'runner.lock');
process.env.FPL_RUN_MODE = 'live';
process.env.FPL_EXPECTED_MANAGER_ID = '123';
process.env.AUTO_EXECUTE_TRANSFERS = 'true';
process.env.EMERGENCY_STOP = 'false';
process.env.FPL_EMERGENCY_STOP_FILE = join(directory, 'EMERGENCY_STOP');

const { FPLClient, fingerprintMyTeam } = await import('./client.js');

function team(elements = Array.from({ length: 15 }, (_, index) => index + 1)): MyTeam {
  return {
    picks: elements.map((element, index) => ({
      element,
      position: index + 1,
      multiplier: index < 11 ? 1 : 0,
      is_captain: index === 0,
      is_vice_captain: index === 1,
      purchase_price: 50,
      selling_price: 50,
    })),
    chips: [
      {
        name: 'bboost',
        number: 1,
        status_for_entry: 'available',
        played_by_entry: [],
        start_event: 1,
        stop_event: 19,
        chip_type: 'team',
      },
    ],
    transfers: { cost: 0, status: 'available', limit: 1, made: 0, bank: 0, value: 1000 },
  };
}

function player(id: number) {
  return {
    id,
    element_type: id <= 2 ? 1 : id <= 7 ? 2 : id <= 12 ? 3 : 4,
    team: Math.ceil(id / 3),
    now_cost: 50,
    can_select: true,
    can_transact: true,
    removed: false,
  };
}

function changedSelection() {
  return [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 2, 12, 14, 15].map((element, index) => ({
    element,
    position: index + 1,
    isCaptain: element === 8,
    isViceCaptain: element === 13,
  }));
}

function seasonFor(deadline: Date): string {
  const year = deadline.getUTCFullYear();
  return `${year}-${year + 1}`;
}

test('authentication fails closed when the token belongs to another manager', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ player: { entry: 456 } });
  try {
    const client = new FPLClient(undefined, 'token', 123, 123);
    const auth = await client.authenticate();
    assert.equal(auth.authenticated, false);
    assert.match(auth.authenticated ? '' : auth.reason, /does not match expected manager 123/);
    assert.equal(client.isAuthenticated(), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('transfer mutation is deadline fenced, uses current chip contract, and confirms post-state', async () => {
  const originalFetch = globalThis.fetch;
  const deadline = new Date(Date.now() + 24 * 60 * 60_000);
  const before = team();
  const after = team([...Array.from({ length: 14 }, (_, index) => index + 1), 16]);
  after.transfers.made = 1;
  let postedBody: Record<string, unknown> | null = null;
  let teamReads = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/me/')) return Response.json({ player: { entry: 123 } });
    if (url.endsWith('/bootstrap-static/')) {
      return Response.json({
        events: [{ id: 1, deadline_time: deadline.toISOString(), can_manage: true }],
        elements: Array.from({ length: 16 }, (_, index) => player(index + 1)),
      });
    }
    if (url.endsWith('/my-team/123/')) return Response.json(teamReads++ === 0 ? before : after);
    if (url.endsWith('/transfers/') && init?.method === 'POST') {
      postedBody = JSON.parse(String(init.body));
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request ${url}`);
  };

  try {
    const client = new FPLClient(undefined, 'token', 123, 123);
    assert.equal((await client.authenticate()).authenticated, true);
    const result = await client.makeTransfers([
      { playerOut: 15, playerIn: 16, purchasePrice: 50, sellingPrice: 50 },
    ], {
      season: seasonFor(deadline),
      gameweek: 1,
      deadlineAt: deadline,
      safetyMarginMs: 15 * 60_000,
      expectedManagerId: 123,
      expectedTeamFingerprint: fingerprintMyTeam(before),
    });
    assert.deepEqual(result, {
      success: true,
      outcome: 'confirmed',
      message: 'Transfer completed successfully',
    });
    assert.equal(postedBody?.['chip'], null);
    assert.equal('wildcard' in (postedBody ?? {}), false);
    assert.equal('freehit' in (postedBody ?? {}), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('transfer reconciliation quarantines a correct squad with the wrong economic state', async () => {
  const originalFetch = globalThis.fetch;
  const deadline = new Date(Date.now() + 24 * 60 * 60_000);
  const before = team();
  const after = team([...Array.from({ length: 14 }, (_, index) => index + 1), 16]);
  after.transfers.made = 1;
  after.transfers.bank = 1;
  let teamReads = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/me/')) return Response.json({ player: { entry: 129 } });
    if (url.endsWith('/bootstrap-static/')) {
      return Response.json({
        events: [{ id: 1, deadline_time: deadline.toISOString(), can_manage: true }],
        elements: Array.from({ length: 16 }, (_, index) => player(index + 1)),
      });
    }
    if (url.endsWith('/my-team/129/')) return Response.json(teamReads++ === 0 ? before : after);
    if (url.endsWith('/transfers/') && init?.method === 'POST') return new Response(null, { status: 204 });
    throw new Error(`Unexpected request ${url}`);
  };

  try {
    process.env.FPL_EXPECTED_MANAGER_ID = '129';
    const client = new FPLClient(undefined, 'token', 129, 129);
    assert.equal((await client.authenticate()).authenticated, true);
    const result = await client.makeTransfers([
      { playerOut: 15, playerIn: 16, purchasePrice: 50, sellingPrice: 50 },
    ], {
      season: seasonFor(deadline),
      gameweek: 1,
      deadlineAt: deadline,
      safetyMarginMs: 15 * 60_000,
      expectedManagerId: 129,
      expectedTeamFingerprint: fingerprintMyTeam(before),
    });
    assert.equal(result.success, false);
    assert.equal(result.outcome, 'unknown');
    assert.match(result.message, /does not match/i);
    assert.equal(client.isMutationQuarantined(), true);
  } finally {
    process.env.FPL_EXPECTED_MANAGER_ID = '123';
    globalThis.fetch = originalFetch;
  }
});

test('mutation guard rejects deadline drift before any POST', async () => {
  const originalFetch = globalThis.fetch;
  const plannedDeadline = new Date(Date.now() + 24 * 60 * 60_000);
  const current = team();
  let posts = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/me/')) return Response.json({ player: { entry: 124 } });
    if (url.endsWith('/bootstrap-static/')) {
      return Response.json({
        events: [{ id: 1, deadline_time: new Date(plannedDeadline.getTime() + 60_000).toISOString(), can_manage: true }],
      });
    }
    if (url.endsWith('/my-team/124/')) return Response.json(current);
    if (init?.method === 'POST') posts += 1;
    throw new Error(`Unexpected request ${url}`);
  };

  try {
    process.env.FPL_EXPECTED_MANAGER_ID = '124';
    const client = new FPLClient(undefined, 'token', 124, 124);
    assert.equal((await client.authenticate()).authenticated, true);
    const result = await client.makeTransfers([
      { playerOut: 15, playerIn: 16, purchasePrice: 50, sellingPrice: 50 },
    ], {
      season: seasonFor(plannedDeadline),
      gameweek: 1,
      deadlineAt: plannedDeadline,
      safetyMarginMs: 15 * 60_000,
      expectedManagerId: 124,
      expectedTeamFingerprint: fingerprintMyTeam(current),
    });
    assert.equal(result.success, false);
    assert.equal(result.outcome, 'rejected');
    assert.match(result.message, /deadline changed/);
    assert.equal(posts, 0);
  } finally {
    process.env.FPL_EXPECTED_MANAGER_ID = '123';
    globalThis.fetch = originalFetch;
  }
});

test('team update cannot silently cancel an active chip', async () => {
  const originalFetch = globalThis.fetch;
  const deadline = new Date(Date.now() + 24 * 60 * 60_000);
  const current = team();
  current.chips[0]!.status_for_entry = 'active';
  current.chips[0]!.is_pending = true;
  const selection = changedSelection();
  let posts = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/me/')) return Response.json({ player: { entry: 125 } });
    if (url.endsWith('/bootstrap-static/')) {
      return Response.json({
        events: [{ id: 1, deadline_time: deadline.toISOString(), can_manage: true }],
        elements: Array.from({ length: 16 }, (_, index) => player(index + 1)),
      });
    }
    if (url.endsWith('/my-team/125/')) return Response.json(current);
    if (init?.method === 'POST') posts += 1;
    throw new Error(`Unexpected request ${url}`);
  };

  try {
    process.env.FPL_EXPECTED_MANAGER_ID = '125';
    process.env.AUTO_SET_LINEUP = 'true';
    const client = new FPLClient(undefined, 'token', 125, 125);
    assert.equal((await client.authenticate()).authenticated, true);
    const result = await client.updateTeam(selection, {
      season: seasonFor(deadline),
      gameweek: 1,
      deadlineAt: deadline,
      safetyMarginMs: 15 * 60_000,
      expectedManagerId: 125,
      expectedTeamFingerprint: fingerprintMyTeam(current),
    }, null);
    assert.equal(result.success, false);
    assert.match(result.message, /must be preserved/);
    assert.equal(posts, 0);
  } finally {
    process.env.FPL_EXPECTED_MANAGER_ID = '123';
    delete process.env.AUTO_SET_LINEUP;
    globalThis.fetch = originalFetch;
  }
});

test('lineup updates preserve an already-active wildcard without resubmitting it', async () => {
  const originalFetch = globalThis.fetch;
  const deadline = new Date(Date.now() + 24 * 60 * 60_000);
  const current = team();
  current.chips = [{
    name: 'wildcard',
    number: 1,
    status_for_entry: 'active',
    is_pending: true,
    played_by_entry: [],
    start_event: 1,
    stop_event: 19,
    chip_type: 'transfer',
  }];
  current.transfers.status = 'unlimited';
  const selection = changedSelection();
  const after = team(selection.map(pick => pick.element));
  after.picks = selection.map(pick => ({
    element: pick.element,
    position: pick.position,
    multiplier: pick.position <= 11 ? 1 : 0,
    is_captain: pick.isCaptain,
    is_vice_captain: pick.isViceCaptain,
    purchase_price: 50,
    selling_price: 50,
  }));
  after.chips = current.chips;
  after.transfers = current.transfers;
  let teamReads = 0;
  let postedChip: unknown = 'not-posted';
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/me/')) return Response.json({ player: { entry: 130 } });
    if (url.endsWith('/bootstrap-static/')) {
      return Response.json({
        events: [{ id: 1, deadline_time: deadline.toISOString(), can_manage: true }],
        elements: Array.from({ length: 16 }, (_, index) => player(index + 1)),
      });
    }
    if (url.endsWith('/my-team/130/') && init?.method === 'POST') {
      postedChip = JSON.parse(String(init.body)).chip;
      return new Response(null, { status: 204 });
    }
    if (url.endsWith('/my-team/130/')) return Response.json(teamReads++ === 0 ? current : after);
    throw new Error(`Unexpected request ${url}`);
  };

  try {
    process.env.FPL_EXPECTED_MANAGER_ID = '130';
    process.env.AUTO_SET_LINEUP = 'true';
    const client = new FPLClient(undefined, 'token', 130, 130);
    assert.equal((await client.authenticate()).authenticated, true);
    const result = await client.updateTeam(selection, {
      season: seasonFor(deadline),
      gameweek: 1,
      deadlineAt: deadline,
      safetyMarginMs: 15 * 60_000,
      expectedManagerId: 130,
      expectedTeamFingerprint: fingerprintMyTeam(current),
    }, null);
    assert.equal(result.success, true);
    assert.equal(postedChip, null);
  } finally {
    process.env.FPL_EXPECTED_MANAGER_ID = '123';
    delete process.env.AUTO_SET_LINEUP;
    globalThis.fetch = originalFetch;
  }
});

test('chip permission cannot authorize a lineup change', async () => {
  const originalFetch = globalThis.fetch;
  const deadline = new Date(Date.now() + 24 * 60 * 60_000);
  const current = team();
  const selection = changedSelection();
  let posts = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/me/')) return Response.json({ player: { entry: 126 } });
    if (url.endsWith('/bootstrap-static/')) {
      return Response.json({
        events: [{ id: 1, deadline_time: deadline.toISOString(), can_manage: true }],
        elements: Array.from({ length: 16 }, (_, index) => player(index + 1)),
      });
    }
    if (url.endsWith('/my-team/126/')) return Response.json(current);
    if (init?.method === 'POST') posts += 1;
    throw new Error(`Unexpected request ${url}`);
  };

  try {
    process.env.FPL_EXPECTED_MANAGER_ID = '126';
    process.env.AUTO_PLAY_CHIPS = 'true';
    delete process.env.AUTO_SET_LINEUP;
    const client = new FPLClient(undefined, 'token', 126, 126);
    assert.equal((await client.authenticate()).authenticated, true);
    const result = await client.updateTeam(selection, {
      season: seasonFor(deadline),
      gameweek: 1,
      deadlineAt: deadline,
      safetyMarginMs: 15 * 60_000,
      expectedManagerId: 126,
      expectedTeamFingerprint: fingerprintMyTeam(current),
    }, 'bboost');
    assert.equal(result.success, false);
    assert.equal(result.outcome, 'rejected');
    assert.match(result.message, /lineup mutations are disabled/);
    assert.equal(client.isMutationQuarantined(), false);
    assert.equal(posts, 0);
  } finally {
    process.env.FPL_EXPECTED_MANAGER_ID = '123';
    delete process.env.AUTO_PLAY_CHIPS;
    globalThis.fetch = originalFetch;
  }
});

test('emergency stop is rechecked immediately before a team POST', async () => {
  const originalFetch = globalThis.fetch;
  const deadline = new Date(Date.now() + 24 * 60 * 60_000);
  const current = team();
  const selection = changedSelection();
  let teamReads = 0;
  let posts = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/me/')) return Response.json({ player: { entry: 127 } });
    if (url.endsWith('/bootstrap-static/')) {
      return Response.json({
        events: [{ id: 1, deadline_time: deadline.toISOString(), can_manage: true }],
        elements: Array.from({ length: 16 }, (_, index) => player(index + 1)),
      });
    }
    if (url.endsWith('/my-team/127/')) {
      if (teamReads++ === 0) process.env.EMERGENCY_STOP = 'true';
      return Response.json(current);
    }
    if (init?.method === 'POST') posts += 1;
    throw new Error(`Unexpected request ${url}`);
  };

  try {
    process.env.FPL_EXPECTED_MANAGER_ID = '127';
    process.env.AUTO_SET_LINEUP = 'true';
    process.env.EMERGENCY_STOP = 'false';
    const client = new FPLClient(undefined, 'token', 127, 127);
    assert.equal((await client.authenticate()).authenticated, true);
    const result = await client.updateTeam(selection, {
      season: seasonFor(deadline),
      gameweek: 1,
      deadlineAt: deadline,
      safetyMarginMs: 15 * 60_000,
      expectedManagerId: 127,
      expectedTeamFingerprint: fingerprintMyTeam(current),
    });
    assert.equal(result.success, false);
    assert.equal(result.outcome, 'rejected');
    assert.match(result.message, /Emergency stop enabled/);
    assert.equal(client.isMutationQuarantined(), false);
    assert.equal(posts, 0);
  } finally {
    process.env.FPL_EXPECTED_MANAGER_ID = '123';
    process.env.EMERGENCY_STOP = 'false';
    delete process.env.AUTO_SET_LINEUP;
    globalThis.fetch = originalFetch;
  }
});

test('second-half mutations use the season start rather than the target deadline year', async () => {
  const originalFetch = globalThis.fetch;
  const startYear = new Date().getUTCFullYear() + 1;
  const firstDeadline = new Date(`${startYear}-08-15T17:30:00Z`);
  const targetDeadline = new Date(`${startYear + 1}-01-15T17:30:00Z`);
  const before = team();
  const after = team([...Array.from({ length: 14 }, (_, index) => index + 1), 16]);
  after.transfers.made = 1;
  let teamReads = 0;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith('/me/')) return Response.json({ player: { entry: 128 } });
    if (url.endsWith('/bootstrap-static/')) {
      return Response.json({
        events: [
          { id: 1, deadline_time: firstDeadline.toISOString(), can_manage: false, finished: true },
          { id: 20, deadline_time: targetDeadline.toISOString(), can_manage: true },
        ],
        elements: Array.from({ length: 16 }, (_, index) => player(index + 1)),
      });
    }
    if (url.endsWith('/my-team/128/')) return Response.json(teamReads++ === 0 ? before : after);
    if (url.endsWith('/transfers/')) return new Response(null, { status: 204 });
    throw new Error(`Unexpected request ${url}`);
  };

  try {
    process.env.FPL_EXPECTED_MANAGER_ID = '128';
    const client = new FPLClient(undefined, 'token', 128, 128);
    assert.equal((await client.authenticate()).authenticated, true);
    const result = await client.makeTransfers([
      { playerOut: 15, playerIn: 16, purchasePrice: 50, sellingPrice: 50 },
    ], {
      season: `${startYear}-${startYear + 1}`,
      gameweek: 20,
      deadlineAt: targetDeadline,
      safetyMarginMs: 15 * 60_000,
      expectedManagerId: 128,
      expectedTeamFingerprint: fingerprintMyTeam(before),
    });
    assert.equal(result.success, true);
    assert.equal(result.outcome, 'confirmed');
  } finally {
    process.env.FPL_EXPECTED_MANAGER_ID = '123';
    globalThis.fetch = originalFetch;
  }
});

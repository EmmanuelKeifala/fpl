import { strict as assert } from 'node:assert';
import test from 'node:test';
import { getMutationPermission, getRunnerTimingConfig, getSafetyLimits } from './limits.js';

test('mutation safety defaults to an emergency-stopped shadow observer', () => {
  const limits = getSafetyLimits({});
  assert.equal(limits.runMode, 'shadow');
  assert.equal(limits.autoExecuteTransfers, false);
  assert.equal(limits.autoSetLineup, false);
  assert.equal(limits.autoPlayChips, false);
  assert.equal(limits.emergencyStop, true);
  assert.equal(limits.maxTransferHitCost, 0);
});

test('live mode requires an explicit expected manager and per-action opt-in', () => {
  assert.throws(
    () => getSafetyLimits({ FPL_RUN_MODE: 'live' }),
    /FPL_EXPECTED_MANAGER_ID/
  );

  const base = {
    FPL_RUN_MODE: 'live',
    FPL_EXPECTED_MANAGER_ID: '123',
    EMERGENCY_STOP: 'false',
  };
  assert.equal(getMutationPermission('transfer', base, () => false).allowed, false);
  assert.equal(
    getMutationPermission('transfer', { ...base, AUTO_EXECUTE_TRANSFERS: 'true' }, () => false).allowed,
    true
  );
  assert.equal(
    getMutationPermission('lineup', { ...base, AUTO_SET_LINEUP: 'true' }, () => false).allowed,
    true
  );
});

test('emergency stop file overrides otherwise valid live configuration', () => {
  const permission = getMutationPermission('chip', {
    FPL_RUN_MODE: 'live',
    FPL_EXPECTED_MANAGER_ID: '123',
    AUTO_PLAY_CHIPS: 'true',
    EMERGENCY_STOP: 'false',
  }, () => true);
  assert.equal(permission.allowed, false);
  assert.match(permission.reason, /Emergency stop/);
});

test('malformed deployment configuration fails instead of silently changing behavior', () => {
  assert.throws(() => getSafetyLimits({ AUTO_SET_LINEUP: 'TRUE' }), /exactly true or false/);
  assert.throws(() => getSafetyLimits({ MAX_TRANSFERS_PER_WEEK: '10' }), /between 1 and 5/);
  assert.throws(() => getRunnerTimingConfig({ POLL_INTERVAL_MINUTES: '0' }), /POLL_INTERVAL_MINUTES/);
  assert.throws(
    () => getRunnerTimingConfig({ MAX_CONSECUTIVE_CYCLE_FAILURES: '0' }),
    /MAX_CONSECUTIVE_CYCLE_FAILURES/
  );
  assert.equal(getRunnerTimingConfig({}).maxConsecutiveCycleFailures, 3);
});

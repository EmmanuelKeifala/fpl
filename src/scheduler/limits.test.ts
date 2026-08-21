import { strict as assert } from 'node:assert';
import test from 'node:test';
import { getMutationPermission, getRunnerTimingConfig, getSafetyLimits, validateTransfer } from './limits.js';

test('mutation safety defaults to an emergency-stopped shadow observer', () => {
  const limits = getSafetyLimits({});
  assert.equal(limits.runMode, 'shadow');
  assert.equal(limits.autoExecuteTransfers, false);
  assert.equal(limits.autoSetLineup, false);
  assert.equal(limits.autoPlayChips, false);
  assert.equal(limits.emergencyStop, true);
  assert.equal(limits.maxTransferHitCost, 0);
  assert.equal(limits.deadlineSafetyMinutes, 3);
  const timing = getRunnerTimingConfig({});
  assert.equal(timing.deadlineNewsPollIntervalMs, 60_000);
  assert.equal(timing.finalizationWindowMs, 5 * 60_000);
  assert.equal(limits.protectTemplateWeight, 0.2);
  assert.equal(limits.templateCoreOwnershipThreshold, 25);
  assert.equal(limits.minimumTemplateCorePlayers, 6);
  assert.equal(limits.templateAnchorOwnershipThreshold, 60);
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
  assert.throws(() => getSafetyLimits({ MAX_UNLIMITED_TRANSFERS: '16' }), /between 1 and 15/);
  assert.throws(() => getSafetyLimits({ PROTECT_TEMPLATE_WEIGHT: '1.1' }), /between 0 and 1/);
  assert.throws(() => getSafetyLimits({ TEMPLATE_CORE_OWNERSHIP_THRESHOLD: '101' }), /between 0 and 100/);
  assert.throws(() => getSafetyLimits({ MIN_TEMPLATE_CORE_PLAYERS: '16' }), /between 0 and 15/);
  assert.throws(() => getRunnerTimingConfig({ POLL_INTERVAL_MINUTES: '0' }), /POLL_INTERVAL_MINUTES/);
  assert.throws(
    () => getRunnerTimingConfig({ FINALIZATION_WINDOW_MINUTES: '3', DEADLINE_SAFETY_MINUTES: '3' }),
    /must be greater/
  );
  assert.throws(
    () => getRunnerTimingConfig({ MAX_CONSECUTIVE_CYCLE_FAILURES: '0' }),
    /MAX_CONSECUTIVE_CYCLE_FAILURES/
  );
  assert.equal(getRunnerTimingConfig({}).maxConsecutiveCycleFailures, 3);
});

test('explicit unlimited periods allow one atomic zero-hit rebuild while normal caps remain', () => {
  const env = {
    FPL_RUN_MODE: 'live',
    FPL_EXPECTED_MANAGER_ID: '123',
    AUTO_EXECUTE_TRANSFERS: 'true',
    EMERGENCY_STOP: 'false',
    MAX_TRANSFERS_PER_WEEK: '1',
    MAX_UNLIMITED_TRANSFERS: '15',
    MIN_TRANSFER_CONFIDENCE: '0.8',
  };
  const noStopFile = () => false;

  assert.equal(validateTransfer(20, 0, Number.POSITIVE_INFINITY, 15, 0.9, true, env, noStopFile).allowed, true);
  assert.equal(validateTransfer(0, 0, Number.POSITIVE_INFINITY, 15, 0.9, true, env, noStopFile).allowed, true);
  assert.match(
    validateTransfer(20, 4, Number.POSITIVE_INFINITY, 15, 0.9, true, env, noStopFile).reason,
    /zero hit cost/
  );
  assert.match(
    validateTransfer(20, 0, 1, 15, 0.9, true, env, noStopFile).reason,
    /explicit unlimited/
  );
  assert.match(
    validateTransfer(20, 0, Number.POSITIVE_INFINITY, 16, 0.9, true, env, noStopFile).reason,
    /maximum is 15/
  );
  assert.match(
    validateTransfer(20, 0, 2, 2, 0.9, false, env, noStopFile).reason,
    /Weekly transfer limit/
  );
});

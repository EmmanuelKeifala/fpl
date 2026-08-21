// Fail-closed safety policy shared by the worker and every mutating tool.
import { existsSync } from 'node:fs';

export type FplRunMode = 'shadow' | 'live';
export type MutationKind = 'transfer' | 'lineup' | 'chip';

export interface SafetyLimits {
  runMode: FplRunMode;
  expectedManagerId: number | null;
  maxTransfersPerWeek: number;
  maxUnlimitedTransfers: number;
  protectTemplateWeight: number;
  templateCoreOwnershipThreshold: number;
  minimumTemplateCorePlayers: number;
  templateAnchorOwnershipThreshold: number;
  minXPGainForHit: number;
  maxTransferHitCost: number;
  minTransferConfidence: number;
  minLineupGain: number;
  minLineupConfidence: number;
  deadlineSafetyMinutes: number;
  autoExecuteTransfers: boolean;
  autoSetLineup: boolean;
  autoPlayChips: boolean;
  emergencyStop: boolean;
  emergencyStopFile: string;
}

export interface RunnerTimingConfig {
  pollIntervalMs: number;
  preDeadlineHours: number;
  deadlineNewsWindowMs: number;
  deadlineNewsPollIntervalMs: number;
  finalizationWindowMs: number;
  intelligenceMaximumAgeMs: number;
  minimumEarlyPriceConfidence: number;
  minimumEarlyPriceValueLossTenths: number;
  maxConsecutiveCycleFailures: number;
}

export function getSafetyLimits(env: NodeJS.ProcessEnv = process.env): SafetyLimits {
  const runMode = optionalEnum(env, 'FPL_RUN_MODE', ['shadow', 'live'] as const, 'shadow');
  const expectedManagerId = optionalInteger(env, 'FPL_EXPECTED_MANAGER_ID', 1, Number.MAX_SAFE_INTEGER);
  if (runMode === 'live' && expectedManagerId === null) {
    throw new Error('FPL_EXPECTED_MANAGER_ID is required when FPL_RUN_MODE=live');
  }

  const maxTransferHitCost = optionalInteger(env, 'MAX_TRANSFER_HIT_COST', 0, 16, 0);
  if (maxTransferHitCost % 4 !== 0) throw new Error('MAX_TRANSFER_HIT_COST must be a multiple of 4');

  return {
    runMode,
    expectedManagerId,
    maxTransfersPerWeek: optionalInteger(env, 'MAX_TRANSFERS_PER_WEEK', 1, 5, 1),
    maxUnlimitedTransfers: optionalInteger(env, 'MAX_UNLIMITED_TRANSFERS', 1, 15, 15),
    protectTemplateWeight: optionalNumber(env, 'PROTECT_TEMPLATE_WEIGHT', 0, 1, 0.2),
    templateCoreOwnershipThreshold: optionalNumber(env, 'TEMPLATE_CORE_OWNERSHIP_THRESHOLD', 0, 100, 25),
    minimumTemplateCorePlayers: optionalInteger(env, 'MIN_TEMPLATE_CORE_PLAYERS', 0, 15, 6),
    templateAnchorOwnershipThreshold: optionalNumber(env, 'TEMPLATE_ANCHOR_OWNERSHIP_THRESHOLD', 0, 100, 60),
    minXPGainForHit: optionalNumber(env, 'MIN_XP_GAIN_FOR_HIT', 0, 50, 8),
    maxTransferHitCost,
    minTransferConfidence: optionalNumber(env, 'MIN_TRANSFER_CONFIDENCE', 0.5, 1, 0.8),
    minLineupGain: optionalNumber(env, 'MIN_LINEUP_GAIN', 0, 10, 0.5),
    minLineupConfidence: optionalNumber(env, 'MIN_LINEUP_CONFIDENCE', 0.5, 1, 0.7),
    deadlineSafetyMinutes: optionalInteger(env, 'DEADLINE_SAFETY_MINUTES', 2, 60, 3),
    autoExecuteTransfers: optionalBoolean(env, 'AUTO_EXECUTE_TRANSFERS', false),
    autoSetLineup: optionalBoolean(env, 'AUTO_SET_LINEUP', false),
    autoPlayChips: optionalBoolean(env, 'AUTO_PLAY_CHIPS', false),
    emergencyStop: optionalBoolean(env, 'EMERGENCY_STOP', true),
    emergencyStopFile: env.FPL_EMERGENCY_STOP_FILE?.trim() || 'data/EMERGENCY_STOP',
  };
}

export function getRunnerTimingConfig(env: NodeJS.ProcessEnv = process.env): RunnerTimingConfig {
  const pollMinutes = optionalInteger(env, 'POLL_INTERVAL_MINUTES', 1, 180, 30);
  const preDeadlineHours = optionalInteger(env, 'PRE_DEADLINE_HOURS', 1, 24, 2);
  const newsWindowMinutes = optionalInteger(env, 'DEADLINE_NEWS_WINDOW_MINUTES', 15, 360, 90);
  const newsPollMinutes = optionalInteger(env, 'DEADLINE_NEWS_POLL_MINUTES', 1, 60, 1);
  const finalizationMinutes = optionalInteger(env, 'FINALIZATION_WINDOW_MINUTES', 3, 30, 5);
  const safetyMinutes = optionalInteger(env, 'DEADLINE_SAFETY_MINUTES', 2, 60, 3);
  if (newsPollMinutes >= newsWindowMinutes) {
    throw new Error('DEADLINE_NEWS_POLL_MINUTES must be shorter than DEADLINE_NEWS_WINDOW_MINUTES');
  }
  if (finalizationMinutes <= safetyMinutes) {
    throw new Error('FINALIZATION_WINDOW_MINUTES must be greater than DEADLINE_SAFETY_MINUTES');
  }
  return {
    pollIntervalMs: pollMinutes * 60_000,
    preDeadlineHours,
    deadlineNewsWindowMs: newsWindowMinutes * 60_000,
    deadlineNewsPollIntervalMs: newsPollMinutes * 60_000,
    finalizationWindowMs: finalizationMinutes * 60_000,
    intelligenceMaximumAgeMs: optionalInteger(env, 'INTELLIGENCE_MAX_AGE_MINUTES', 1, 15, 2) * 60_000,
    minimumEarlyPriceConfidence: optionalNumber(env, 'MIN_EARLY_PRICE_CONFIDENCE', 0.5, 1, 0.8),
    minimumEarlyPriceValueLossTenths: optionalInteger(
      env,
      'MIN_EARLY_PRICE_VALUE_LOSS_TENTHS',
      1,
      5,
      1
    ),
    maxConsecutiveCycleFailures: optionalInteger(
      env,
      'MAX_CONSECUTIVE_CYCLE_FAILURES',
      1,
      20,
      3
    ),
  };
}

export function getMutationPermission(
  kind: MutationKind,
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync
): { allowed: boolean; reason: string; limits: SafetyLimits } {
  const limits = getSafetyLimits(env);
  if (limits.emergencyStop || fileExists(limits.emergencyStopFile)) {
    return { allowed: false, reason: 'Emergency stop enabled', limits };
  }
  if (limits.runMode !== 'live') {
    return { allowed: false, reason: 'FPL_RUN_MODE is shadow', limits };
  }
  if (limits.expectedManagerId === null) {
    return { allowed: false, reason: 'Expected manager is not configured', limits };
  }
  const enabled = kind === 'transfer'
    ? limits.autoExecuteTransfers
    : kind === 'lineup'
      ? limits.autoSetLineup
      : limits.autoPlayChips;
  return enabled
    ? { allowed: true, reason: `${kind} mutation enabled`, limits }
    : { allowed: false, reason: `Automatic ${kind} mutations are disabled`, limits };
}

export function checkEmergencyStop(): boolean {
  const permission = getMutationPermission('lineup');
  const stopped = permission.reason === 'Emergency stop enabled';
  if (stopped) console.log('[SAFETY] Emergency stop is enabled. No actions will be taken.');
  return stopped;
}

// This counter is a same-process secondary guard. Durable operation state and a
// process lock provide the authoritative cross-cycle protection.
let transfersThisWeek = 0;
let lastResetGameweek = 0;

export function resetWeeklyTransfers(currentGameweek: number): void {
  if (currentGameweek !== lastResetGameweek) {
    transfersThisWeek = 0;
    lastResetGameweek = currentGameweek;
    console.log(`[SAFETY] Reset weekly transfer counter for GW${currentGameweek}`);
  }
}

export function canMakeTransfers(count = 1, env: NodeJS.ProcessEnv = process.env): boolean {
  const limits = getSafetyLimits(env);
  if (!Number.isInteger(count) || count < 1) return false;
  if (transfersThisWeek + count > limits.maxTransfersPerWeek) {
    console.log(
      `[SAFETY] Weekly transfer limit reached (${transfersThisWeek}+${count}/${limits.maxTransfersPerWeek})`
    );
    return false;
  }
  return true;
}

export function canMakeTransfer(): boolean {
  return canMakeTransfers(1);
}

export function recordTransfers(count: number): void {
  if (!Number.isInteger(count) || count < 1) throw new Error(`Invalid recorded transfer count ${count}`);
  transfersThisWeek += count;
  console.log(`[SAFETY] ${count} transfer(s) recorded. Total this week: ${transfersThisWeek}`);
}

export function recordTransfer(): void {
  recordTransfers(1);
}

export function validateTransfer(
  xpGain: number,
  hitCost: number,
  freeTransfers: number,
  plannedTransfers = 1,
  confidence = 1,
  unlimitedTransfers = false,
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync
): { allowed: boolean; reason: string } {
  const permission = getMutationPermission('transfer', env, fileExists);
  const limits = permission.limits;
  if (!permission.allowed) return { allowed: false, reason: permission.reason };
  if (![xpGain, hitCost, confidence].every(Number.isFinite)
    || freeTransfers < 0
    || (!unlimitedTransfers && !Number.isFinite(freeTransfers))) {
    return { allowed: false, reason: 'Transfer plan contains non-finite safety inputs' };
  }
  if (!Number.isInteger(plannedTransfers) || plannedTransfers < 1) {
    return { allowed: false, reason: 'Weekly transfer limit reached' };
  }
  if (unlimitedTransfers) {
    if (freeTransfers !== Number.POSITIVE_INFINITY) {
      return { allowed: false, reason: 'Unlimited transfer plan requires explicit unlimited FPL status' };
    }
    if (plannedTransfers > limits.maxUnlimitedTransfers) {
      return {
        allowed: false,
        reason: `Unlimited transfer plan has ${plannedTransfers} moves; maximum is ${limits.maxUnlimitedTransfers}`,
      };
    }
    if (hitCost !== 0) return { allowed: false, reason: 'Unlimited transfer plan must have zero hit cost' };
  } else if (!canMakeTransfers(plannedTransfers, env)) {
    return { allowed: false, reason: 'Weekly transfer limit reached' };
  }
  if (confidence < limits.minTransferConfidence) {
    return {
      allowed: false,
      reason: `Plan confidence ${(confidence * 100).toFixed(0)}% is below ${(limits.minTransferConfidence * 100).toFixed(0)}%`,
    };
  }
  if (hitCost < 0 || hitCost > limits.maxTransferHitCost || hitCost % 4 !== 0) {
    return { allowed: false, reason: `Transfer hit cost ${hitCost} exceeds allowed ${limits.maxTransferHitCost}` };
  }

  const netGain = xpGain - hitCost;
  if (netGain < 0 || (!unlimitedTransfers && netGain === 0)) {
    return { allowed: false, reason: `Non-positive net gain: ${netGain.toFixed(1)}` };
  }
  if (hitCost > 0 && netGain < limits.minXPGainForHit) {
    return {
      allowed: false,
      reason: `Net xP gain (${netGain.toFixed(1)}) below hit threshold (${limits.minXPGainForHit})`,
    };
  }
  return { allowed: true, reason: 'Transfer approved' };
}

export function validateLineup(projectedGain: number, confidence: number): { allowed: boolean; reason: string } {
  const permission = getMutationPermission('lineup');
  if (!permission.allowed) return { allowed: false, reason: permission.reason };
  if (!Number.isFinite(projectedGain) || projectedGain < permission.limits.minLineupGain) {
    return {
      allowed: false,
      reason: `Lineup gain ${projectedGain.toFixed(1)} is below ${permission.limits.minLineupGain}`,
    };
  }
  if (!Number.isFinite(confidence) || confidence < permission.limits.minLineupConfidence) {
    return {
      allowed: false,
      reason: `Lineup confidence ${(confidence * 100).toFixed(0)}% is below ${(permission.limits.minLineupConfidence * 100).toFixed(0)}%`,
    };
  }
  return { allowed: true, reason: 'Lineup mutation approved' };
}

export function validateChip(
  chip: string,
  recommended: boolean,
  confidence: number
): { allowed: boolean; reason: string } {
  const permission = getMutationPermission('chip');
  if (!permission.allowed) return { allowed: false, reason: permission.reason };
  if (!recommended) return { allowed: false, reason: 'Chip not recommended by optimizer' };
  if (!Number.isFinite(confidence) || confidence < 0.8) {
    return { allowed: false, reason: `Confidence too low: ${(confidence * 100).toFixed(0)}%` };
  }
  return { allowed: true, reason: `${chip} play approved` };
}

function optionalBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (raw !== 'true' && raw !== 'false') throw new Error(`${name} must be exactly true or false`);
  return raw === 'true';
}

function optionalInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number
): number;
function optionalInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number
): number | null;
function optionalInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number | null = null
): number | null {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^(?:\d+|\d*\.\d+)$/.test(raw)) throw new Error(`${name} must be a number`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalEnum<const T extends readonly string[]>(
  env: NodeJS.ProcessEnv,
  name: string,
  values: T,
  fallback: T[number]
): T[number] {
  const raw = env[name]?.trim() || fallback;
  if (!(values as readonly string[]).includes(raw)) {
    throw new Error(`${name} must be one of ${values.join(', ')}`);
  }
  return raw as T[number];
}

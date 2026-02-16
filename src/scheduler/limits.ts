// Safety Limits for Autonomous Mode
export interface SafetyLimits {
  maxTransfersPerWeek: number;
  minXPGainForHit: number;
  autoExecuteTransfers: boolean;
  autoPlayChips: boolean;
  emergencyStop: boolean;
}

export function getSafetyLimits(): SafetyLimits {
  return {
    maxTransfersPerWeek: parseInt(process.env.MAX_TRANSFERS_PER_WEEK || '2'),
    minXPGainForHit: parseInt(process.env.MIN_XP_GAIN_FOR_HIT || '8'),
    autoExecuteTransfers: process.env.AUTO_EXECUTE_TRANSFERS === 'true',
    autoPlayChips: process.env.AUTO_PLAY_CHIPS === 'true',
    emergencyStop: process.env.EMERGENCY_STOP === 'true',
  };
}

export function checkEmergencyStop(): boolean {
  const limits = getSafetyLimits();
  if (limits.emergencyStop) {
    console.log('[SAFETY] Emergency stop is enabled. No actions will be taken.');
    return true;
  }
  return false;
}

// Track transfers made this week
let transfersThisWeek = 0;
let lastResetGameweek = 0;

export function resetWeeklyTransfers(currentGameweek: number): void {
  if (currentGameweek !== lastResetGameweek) {
    transfersThisWeek = 0;
    lastResetGameweek = currentGameweek;
    console.log(`[SAFETY] Reset weekly transfer counter for GW${currentGameweek}`);
  }
}

export function canMakeTransfer(): boolean {
  const limits = getSafetyLimits();
  if (transfersThisWeek >= limits.maxTransfersPerWeek) {
    console.log(`[SAFETY] Weekly transfer limit reached (${transfersThisWeek}/${limits.maxTransfersPerWeek})`);
    return false;
  }
  return true;
}

export function recordTransfer(): void {
  transfersThisWeek++;
  console.log(`[SAFETY] Transfer recorded. Total this week: ${transfersThisWeek}`);
}

export function validateTransfer(
  xpGain: number,
  hitCost: number,
  freeTransfers: number
): { allowed: boolean; reason: string } {
  const limits = getSafetyLimits();
  
  // Check emergency stop
  if (limits.emergencyStop) {
    return { allowed: false, reason: 'Emergency stop enabled' };
  }
  
  // Check weekly limit
  if (!canMakeTransfer()) {
    return { allowed: false, reason: 'Weekly transfer limit reached' };
  }
  
  // Check auto-execute
  if (!limits.autoExecuteTransfers) {
    return { allowed: false, reason: 'Auto-execute transfers disabled' };
  }
  
  // Check hit threshold
  if (hitCost > 0) {
    if (xpGain < limits.minXPGainForHit) {
      return { 
        allowed: false, 
        reason: `xP gain (${xpGain.toFixed(1)}) below hit threshold (${limits.minXPGainForHit})` 
      };
    }
  }
  
  // Net gain must be positive
  const netGain = xpGain - hitCost;
  if (netGain <= 0) {
    return { allowed: false, reason: `Negative net gain: ${netGain.toFixed(1)}` };
  }
  
  return { allowed: true, reason: 'Transfer approved' };
}

export function validateChip(
  chip: string,
  recommended: boolean,
  confidence: number
): { allowed: boolean; reason: string } {
  const limits = getSafetyLimits();
  
  if (limits.emergencyStop) {
    return { allowed: false, reason: 'Emergency stop enabled' };
  }
  
  if (!limits.autoPlayChips) {
    return { allowed: false, reason: 'Auto-play chips disabled (logged only)' };
  }
  
  if (!recommended) {
    return { allowed: false, reason: 'Chip not recommended by optimizer' };
  }
  
  if (confidence < 0.7) {
    return { allowed: false, reason: `Confidence too low: ${(confidence * 100).toFixed(0)}%` };
  }
  
  return { allowed: true, reason: 'Chip play approved' };
}

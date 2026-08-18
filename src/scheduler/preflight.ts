import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { getFPLClientFromEnv } from '../api/client.js';
import { getMutationOperations } from '../db/client.js';
import { getOptimizationEngine } from '../engine/optimizer.js';
import { getMutationPermission, getRunnerTimingConfig, getSafetyLimits } from './limits.js';
import { hasRemoteNotificationConfig } from './notify.js';
import { getLlmDecisionConfig } from '../llm/config.js';
import { getKapsoWhatsAppConfig } from '../notifications/kapso-config.js';
import {
  calculateCurrentLineupExpectedPoints,
  optimizeTransferPlan,
  selectOptimalLineup,
} from './decisions.js';

export interface DeploymentPreflightReport {
  checkedAt: string;
  observerReady: boolean;
  liveReady: boolean;
  mode: 'shadow' | 'live';
  season: string | null;
  nextGameweek: number | null;
  deadline: string | null;
  authenticatedManagerId: number | null;
  squadPlayers: number | null;
  transferStatus: string | null;
  proposedTransfer: string | null;
  transferConfidence: number | null;
  proposedCaptain: string | null;
  lineupGain: number | null;
  lineupConfidence: number | null;
  blockers: string[];
  warnings: string[];
}

export async function runDeploymentPreflight(): Promise<DeploymentPreflightReport> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const limits = getSafetyLimits();
  const llmConfig = getLlmDecisionConfig();
  let kapsoConfigured = false;
  try {
    kapsoConfigured = getKapsoWhatsAppConfig().enabled;
  } catch (error) {
    const detail = `Kapso WhatsApp configuration is invalid: ${errorMessage(error)}`;
    if (limits.runMode === 'live') blockers.push(detail);
    else warnings.push(detail);
  }
  getRunnerTimingConfig();
  const client = getFPLClientFromEnv();
  let observerReady = false;
  let season: string | null = null;
  let nextGameweek: number | null = null;
  let deadline: string | null = null;
  let authenticatedManagerId: number | null = null;
  let squadPlayers: number | null = null;
  let transferStatus: string | null = null;
  let proposedTransfer: string | null = null;
  let transferConfidence: number | null = null;
  let proposedCaptain: string | null = null;
  let lineupGain: number | null = null;
  let lineupConfidence: number | null = null;
  let engine: Awaited<ReturnType<typeof getOptimizationEngine>> | null = null;

  try {
    engine = await getOptimizationEngine();
    observerReady = true;
    season = engine.getSeasonConfig().season;
    const next = engine.getNextDeadline();
    nextGameweek = next?.gameweek ?? null;
    deadline = next?.deadline.toISOString() ?? null;
    if (!next) blockers.push('No future FPL deadline is available');
    else if (Date.now() + limits.deadlineSafetyMinutes * 60_000 >= next.deadline.getTime()) {
      blockers.push(`GW${next.gameweek} is inside the ${limits.deadlineSafetyMinutes}-minute mutation safety margin`);
    }
  } catch (error) {
    blockers.push(`Public FPL data is unavailable: ${errorMessage(error)}`);
  }

  if (limits.runMode !== 'live') blockers.push('FPL_RUN_MODE is shadow');
  if (limits.emergencyStop) blockers.push('EMERGENCY_STOP is enabled');
  const permissions = (['transfer', 'lineup', 'chip'] as const).map(kind => ({
    kind,
    permission: getMutationPermission(kind),
  }));
  if (permissions.some(({ permission }) => permission.reason === 'Emergency stop enabled')) {
    blockers.push('Emergency stop environment or file is enabled');
  }
  if (!limits.autoExecuteTransfers && !limits.autoSetLineup && !limits.autoPlayChips) {
    blockers.push('No live mutation class is enabled');
  }
  if (limits.autoPlayChips) blockers.push('Automatic chip execution is not approved for deployment');
  if (!hasRemoteNotificationConfig()) blockers.push('No remote alert channel is configured');
  if (limits.runMode === 'live' && !kapsoConfigured) {
    blockers.push('Kapso WhatsApp plan and action notifications are not configured');
  } else if (limits.runMode === 'shadow' && !kapsoConfigured) {
    warnings.push('Kapso WhatsApp plan and action notifications are not configured');
  }
  if (limits.expectedManagerId === null) blockers.push('FPL_EXPECTED_MANAGER_ID is not configured');
  if (limits.runMode === 'live' && llmConfig.requiredForLive) {
    if (!llmConfig.enabled) blockers.push('The required live LLM decision reviewer is disabled');
    else if (!llmConfig.apiKeyConfigured) blockers.push('The required live LLM decision reviewer has no OPENAI_API_KEY');
  } else if (llmConfig.enabled && !llmConfig.apiKeyConfigured) {
    warnings.push('LLM decision review is enabled but OPENAI_API_KEY is not configured');
  }
  for (const { kind, permission } of permissions) {
    if (!permission.allowed
      && !permission.reason.includes('disabled')
      && permission.reason !== 'FPL_RUN_MODE is shadow'
      && permission.reason !== 'Emergency stop enabled') {
      warnings.push(`${kind}: ${permission.reason}`);
    }
  }

  const auth = await client.authenticate();
  if (auth.authenticated) {
    authenticatedManagerId = auth.managerId;
    try {
      const team = await client.getMyTeam();
      squadPlayers = team.picks.length;
      transferStatus = team.transfers.status;
      if (team.picks.length !== 15) blockers.push(`Authenticated entry has ${team.picks.length} picks instead of 15`);
      if (limits.autoExecuteTransfers && team.picks.some(pick => pick.selling_price === undefined)) {
        blockers.push('At least one authenticated pick has no selling price');
      }
      const activeChips = team.chips.filter(chip => chip.status_for_entry === 'active' || chip.is_pending === true);
      if (activeChips.length > 1) blockers.push('Authenticated entry reports multiple active or pending chips');
      if (activeChips.length === 1) warnings.push(`Active chip: ${activeChips[0]!.name}`);
      if (engine && team.picks.length === 15) {
        const plan = await optimizeTransferPlan(
          team,
          Math.max(0, limits.maxTransfersPerWeek - team.transfers.made),
          6
        );
        transferConfidence = plan.confidence;
        proposedTransfer = plan.transfers.length > 0
          ? plan.transfers.map(transfer => `${transfer.playerOut.web_name} -> ${transfer.playerIn.web_name}`).join(', ')
          : 'hold';
        if (plan.transfers.length > 0 && plan.confidence < limits.minTransferConfidence) {
          const detail = `Transfer proposal confidence ${(plan.confidence * 100).toFixed(0)}% is below ${(limits.minTransferConfidence * 100).toFixed(0)}%`;
          if (limits.autoExecuteTransfers) blockers.push(detail);
          else warnings.push(detail);
        }
        if (plan.transfers.length > 0 && plan.hitCost > limits.maxTransferHitCost) {
          const detail = `Transfer proposal hit cost ${plan.hitCost} exceeds allowed ${limits.maxTransferHitCost}`;
          if (limits.autoExecuteTransfers) blockers.push(detail);
          else warnings.push(detail);
        }
        if (plan.transfers.length > 0 && plan.netGain <= 0) {
          const detail = `Transfer proposal has non-positive net gain ${plan.netGain.toFixed(1)}`;
          if (limits.autoExecuteTransfers) blockers.push(detail);
          else warnings.push(detail);
        }
        if (plan.hitCost > 0 && plan.netGain < limits.minXPGainForHit) {
          const detail = `Transfer proposal net gain ${plan.netGain.toFixed(1)} is below hit threshold ${limits.minXPGainForHit}`;
          if (limits.autoExecuteTransfers) blockers.push(detail);
          else warnings.push(detail);
        }
        const lineup = await selectOptimalLineup(team);
        const currentLineupPoints = await calculateCurrentLineupExpectedPoints(team);
        proposedCaptain = lineup.captain.web_name;
        lineupGain = Math.round((lineup.expectedPoints - currentLineupPoints) * 10) / 10;
        lineupConfidence = lineup.confidence;
        if (lineup.confidence < limits.minLineupConfidence) {
          const detail = `Lineup confidence ${(lineup.confidence * 100).toFixed(0)}% is below ${(limits.minLineupConfidence * 100).toFixed(0)}%`;
          if (limits.autoSetLineup) blockers.push(detail);
          else warnings.push(detail);
        }
        if (lineupGain < limits.minLineupGain) {
          const detail = `Lineup gain ${lineupGain.toFixed(1)} is below ${limits.minLineupGain}`;
          if (limits.autoSetLineup) blockers.push(detail);
          else warnings.push(detail);
        }
      }
    } catch (error) {
      blockers.push(`Authenticated team is unavailable: ${errorMessage(error)}`);
    }
    const unresolved = (await getMutationOperations(auth.managerId)).filter(operation =>
      operation.status === 'planned' || operation.status === 'in_flight' || operation.status === 'unknown'
    );
    if (unresolved.length > 0) {
      blockers.push(`Unresolved mutation operation(s): ${unresolved.map(operation => `${operation.id}:${operation.status}`).join(', ')}`);
    }
  } else {
    blockers.push(`Authentication is unavailable: ${auth.reason.split('\n')[0]}`);
  }

  return {
    checkedAt: new Date().toISOString(),
    observerReady,
    liveReady: observerReady && blockers.length === 0,
    mode: limits.runMode,
    season,
    nextGameweek,
    deadline,
    authenticatedManagerId,
    squadPlayers,
    transferStatus,
    proposedTransfer,
    transferConfidence,
    proposedCaptain,
    lineupGain,
    lineupConfidence,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
  };
}

function printReport(report: DeploymentPreflightReport): void {
  console.log('FPL deployment preflight');
  console.log(`  Observer ready: ${report.observerReady}`);
  console.log(`  Live ready: ${report.liveReady}`);
  console.log(`  Mode: ${report.mode}`);
  console.log(`  Season: ${report.season ?? 'unavailable'}`);
  console.log(`  Next deadline: ${report.nextGameweek ? `GW${report.nextGameweek} ${report.deadline}` : 'unavailable'}`);
  console.log(`  Authenticated manager: ${report.authenticatedManagerId ?? 'none'}`);
  console.log(`  Squad players: ${report.squadPlayers ?? 'unavailable'}`);
  console.log(`  Transfer status: ${report.transferStatus ?? 'unavailable'}`);
  console.log(`  Transfer proposal: ${report.proposedTransfer ?? 'unavailable'}${report.transferConfidence === null ? '' : ` (${(report.transferConfidence * 100).toFixed(0)}% confidence)`}`);
  console.log(`  Captain proposal: ${report.proposedCaptain ?? 'unavailable'}`);
  console.log(`  Lineup gain/confidence: ${report.lineupGain ?? 'unavailable'} / ${report.lineupConfidence === null ? 'unavailable' : `${(report.lineupConfidence * 100).toFixed(0)}%`}`);
  for (const blocker of report.blockers) console.log(`  BLOCKER: ${blocker}`);
  for (const warning of report.warnings) console.log(`  WARNING: ${warning}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const isEntryPoint = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  runDeploymentPreflight()
    .then(report => {
      printReport(report);
      const requireLive = process.argv.includes('--require-live');
      const requireShadow = process.argv.includes('--require-shadow');
      if (!report.observerReady
        || (requireLive && !report.liveReady)
        || (requireShadow && report.mode !== 'shadow')) {
        process.exitCode = 1;
      }
    })
    .catch(error => {
      console.error('[PREFLIGHT] Failed:', errorMessage(error));
      process.exitCode = 1;
    });
}

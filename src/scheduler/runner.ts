// Autonomous Runner - Main entry point for autonomous FPL decision making
import 'dotenv/config';
import { getFPLClient, getFPLClientFromEnv } from '../api/client.js';
import { describeSeasonConfig, getSeasonConfigWarnings } from '../strategy/season.js';
import { getOptimizationEngine, refreshOptimizationEngine } from '../engine/optimizer.js';
import {
  buildDecisionContext,
  gatherIntelligence,
  optimizeTransferPlan,
  selectOptimalLineup,
  evaluateChips,
  getActiveLineupChip,
  hasUnlimitedTransfers,
  calculateCurrentLineupExpectedPoints,
  type DecisionContext 
} from './decisions.js';
import { 
  getSafetyLimits, 
  getRunnerTimingConfig,
  getMutationPermission,
  checkEmergencyStop, 
  validateTransfer, 
  validateLineup,
  validateChip, 
  resetWeeklyTransfers,
  recordTransfer 
} from './limits.js';
import { 
  notify, 
  notifyTransfer, 
  notifyCaptain, 
  notifyChip, 
  notifyAlert, 
  notifySummary 
} from './notify.js';
import { hasRemoteNotificationConfig } from './notify.js';
import { getGameweekSnapshot, logDecision, saveGameweekSnapshot } from '../db/client.js';
import type { GameweekHistory, ChipUsage } from '../api/types.js';
import { captureLearningSnapshot, reconcileFinishedGameweek } from './learning.js';
import { captureMlShadowForecasts } from '../ml/shadow-forecasts.js';
import { createMutationGuard } from './mutation-guard.js';
import { acquireExclusiveFileLock } from './process-lock.js';
import { writeRunnerHealth, type RunnerHealthStatus } from './health.js';
import { getLlmDecisionConfig } from '../llm/config.js';
import { llmReviewAllowsMutation } from '../llm/decision-reviewer.js';
import {
  llmReviewSummary,
  reviewGameweekPlanWithLlm,
  reviewLineupWithLlm,
  reviewTransferPlanWithLlm,
} from './llm-review.js';
import { buildProjectedPlanningTeam, getGameweekPlanDisposition } from './plan-policy.js';
import {
  decideDeadlineExecution,
  effectiveSellingPriceLossAfterFall,
  type DeadlineExecutionDecision,
  type EarlyPriceTrigger,
} from './execution-policy.js';
import { getKapsoWhatsAppConfig } from '../notifications/kapso-config.js';
import {
  flushKapsoWhatsAppUpdates,
  queueKapsoWhatsAppUpdate,
} from '../notifications/kapso.js';

type RunnerPhase = 'monitor' | 'plan' | 'execute' | 'post-deadline';

interface RunnerState {
  phase: RunnerPhase;
  lastPhase: RunnerPhase;
  cycleCount: number;
  lastGWProcessed: number;
}

const TIMING = getRunnerTimingConfig();
const POLL_INTERVAL = TIMING.pollIntervalMs;
const PRE_DEADLINE_HOURS = TIMING.preDeadlineHours;
const DEADLINE_NEWS_WINDOW = TIMING.deadlineNewsWindowMs;
const DEADLINE_NEWS_POLL_INTERVAL = TIMING.deadlineNewsPollIntervalMs;
const FINALIZATION_WINDOW = TIMING.finalizationWindowMs;

let runnerState: RunnerState = {
  phase: 'monitor',
  lastPhase: 'monitor',
  cycleCount: 0,
  lastGWProcessed: 0,
};

let cycleInProgress = false;
let stopping = false;
let timeoutId: NodeJS.Timeout | null = null;
let activeCycle: Promise<void> | null = null;
let releaseRunnerLock: (() => void) | null = null;
let cycleHadError: string | null = null;
const runnerStartedAt = new Date().toISOString();
let lastCycleStartedAt: string | null = null;
let lastCycleCompletedAt: string | null = null;
let consecutiveCycleFailures = 0;
let observedTransferPlan: {
  gameweek: number;
  fingerprint: string;
  observations: number;
} | null = null;

function updateHealth(status: RunnerHealthStatus, error: string | null = null): void {
  writeRunnerHealth(process.env.FPL_HEALTH_PATH?.trim() || 'data/runner-health.json', {
    pid: process.pid,
    mode: getSafetyLimits().runMode,
    status,
    cycleCount: runnerState.cycleCount,
    startedAt: runnerStartedAt,
    updatedAt: new Date().toISOString(),
    lastCycleStartedAt,
    lastCycleCompletedAt,
    lastError: error,
  });
}

function getPhase(hoursToDeadline: number, isPostDeadline: boolean): RunnerPhase {
  if (isPostDeadline) return 'post-deadline';
  if (hoursToDeadline < PRE_DEADLINE_HOURS) return 'execute';
  if (hoursToDeadline < 24) return 'plan';
  return 'monitor';
}

function decideCurrentDeadlineExecution(
  context: DecisionContext,
  planReady: boolean,
  planStable: boolean,
  priceTrigger: EarlyPriceTrigger | null
): DeadlineExecutionDecision {
  const limits = getSafetyLimits();
  return decideDeadlineExecution({
    now: new Date(),
    deadline: context.deadline ?? new Date(Number.NaN),
    finalizationWindowMs: TIMING.finalizationWindowMs,
    hardSafetyMarginMs: limits.deadlineSafetyMinutes * 60_000,
    planReady,
    planStable,
    priceTrigger,
    minimumEarlyPriceConfidence: TIMING.minimumEarlyPriceConfidence,
    minimumExpectedValueLossTenths: TIMING.minimumEarlyPriceValueLossTenths,
    intelligence: {
      feedStatus: context.intelligenceFeed.status,
      lastSuccessfulCheckAt: context.intelligenceFeed.lastSuccessfulCheckAt,
      maximumAgeMs: TIMING.intelligenceMaximumAgeMs,
      hasConflictingNews: context.newsSignals.some(signal => signal.conflicted),
    },
  });
}

function observeTransferPlanStability(
  gameweek: number,
  plan: Awaited<ReturnType<typeof optimizeTransferPlan>>
): boolean {
  const fingerprint = [
    plan.mode,
    ...[...plan.targetPlayerIds].sort((left, right) => left - right),
    ...plan.transfers
      .map(transfer => `${transfer.playerOut.id}->${transfer.playerIn.id}`)
      .sort(),
  ].join(':');
  if (observedTransferPlan?.gameweek === gameweek
    && observedTransferPlan.fingerprint === fingerprint) {
    observedTransferPlan.observations++;
  } else {
    observedTransferPlan = { gameweek, fingerprint, observations: 1 };
  }
  return observedTransferPlan.observations >= 2;
}

function deriveEarlyPriceTrigger(
  plan: Awaited<ReturnType<typeof optimizeTransferPlan>>,
  currentBank: number,
  engine: Awaited<ReturnType<typeof getOptimizationEngine>>
): EarlyPriceTrigger | null {
  if (plan.transfers.length === 0) return null;
  const finalBank = currentBank + plan.transfers.reduce(
    (sum, transfer) => sum + transfer.sellingPrice - transfer.playerIn.now_cost,
    0
  );
  let confidence = 0;
  let expectedValueLossTenths = 0;
  const impactConfidences: number[] = [];
  for (const transfer of plan.transfers) {
    const incoming = engine.predictPriceChange(transfer.playerIn.id);
    if (incoming.source === 'official' && incoming.prediction === 'rise') {
      impactConfidences.push(incoming.confidence);
      expectedValueLossTenths++;
    }
    const outgoing = engine.predictPriceChange(transfer.playerOut.id);
    if (outgoing.source === 'official' && outgoing.prediction === 'fall') {
      const sellingPriceLoss = effectiveSellingPriceLossAfterFall({
        purchasePrice: transfer.purchasePrice,
        currentPrice: transfer.playerOut.now_cost,
        currentSellingPrice: transfer.sellingPrice,
        sellOnFeeRatio: engine.getSeasonConfig().sellOnFeeRatio,
      });
      if (sellingPriceLoss <= 0) continue;
      impactConfidences.push(outgoing.confidence);
      expectedValueLossTenths += sellingPriceLoss;
    }
  }
  confidence = impactConfidences.length > 0 ? Math.min(...impactConfidences) : 0;
  const makesPlanUnaffordable = expectedValueLossTenths > finalBank;
  return confidence > 0
    ? { confidence, makesPlanUnaffordable, expectedValueLossTenths }
    : null;
}

async function initialize(): Promise<boolean> {
  console.log('\n========================================');
  console.log('FPL AUTONOMOUS RUNNER - Starting...');
  console.log('========================================\n');

  const limits = getSafetyLimits();
  if (limits.runMode === 'live' && !hasRemoteNotificationConfig()) {
    throw new Error('Live mode requires a configured remote alert channel');
  }
  if (limits.runMode === 'live'
    && (process.env.ENABLE_TWITTER !== 'true' || !process.env.TWITTER_BEARER_TOKEN?.trim())) {
    throw new Error('Live mode requires a configured verified X/Twitter deadline-news feed');
  }
  const kapsoConfig = getKapsoWhatsAppConfig();
  if (limits.runMode === 'live' && !kapsoConfig.enabled) {
    throw new Error('Live mode requires Kapso WhatsApp plan and action notifications');
  }
  console.log(`[CONFIG] Safety Limits:`);
  console.log(`  - Run Mode: ${limits.runMode}`);
  console.log(`  - Expected Manager: ${limits.expectedManagerId ?? 'not configured'}`);
  console.log(`  - Max Transfers/Week: ${limits.maxTransfersPerWeek}`);
  console.log(`  - Max Unlimited Rebuild Transfers: ${limits.maxUnlimitedTransfers}`);
  console.log(`  - Market Protection (protect/early-season) Weight: ${limits.protectTemplateWeight.toFixed(2)}`);
  console.log(`  - Market Protection (protect/early-season) Core: at least ${limits.minimumTemplateCorePlayers} player(s) at ${limits.templateCoreOwnershipThreshold.toFixed(0)}% ownership`);
  console.log(`  - Market Protection (protect/early-season) Anchor Threshold: ${limits.templateAnchorOwnershipThreshold.toFixed(0)}% ownership`);
  console.log(`  - Min xP Gain for Hit: ${limits.minXPGainForHit}`);
  console.log(`  - Auto-Execute Transfers: ${limits.autoExecuteTransfers}`);
  console.log(`  - Auto-Set Lineup: ${limits.autoSetLineup}`);
  console.log(`  - Auto-Play Chips: ${limits.autoPlayChips}`);
  console.log(`  - Emergency Stop: ${limits.emergencyStop}`);
  console.log(`  - Emergency Stop File: ${limits.emergencyStopFile}`);
  console.log(`  - Maximum Hit Cost: ${limits.maxTransferHitCost}`);
  console.log(`  - Minimum Transfer Confidence: ${(limits.minTransferConfidence * 100).toFixed(0)}%`);
  console.log(`  - Deadline Safety Margin: ${limits.deadlineSafetyMinutes} minutes`);
  console.log(`  - Poll Interval: ${POLL_INTERVAL / 60000} minutes`);
  console.log(`  - Pre-Deadline Hours: ${PRE_DEADLINE_HOURS}h`);
  console.log(`  - Finalization Window: ${FINALIZATION_WINDOW / 60_000} minutes`);
  console.log(`  - Intelligence Maximum Age: ${TIMING.intelligenceMaximumAgeMs / 60_000} minutes`);
  console.log(`  - Minimum Early-Price Confidence: ${(TIMING.minimumEarlyPriceConfidence * 100).toFixed(0)}%`);
  console.log(`  - Minimum Early-Price Loss: ${TIMING.minimumEarlyPriceValueLossTenths} price tick(s)\n`);

  console.log(`[CONFIG] Kapso WhatsApp Observability:`);
  console.log(`  - Enabled: ${kapsoConfig.enabled}`);
  console.log(`  - Mode: ${kapsoConfig.mode ?? 'not configured'}`);
  console.log(`  - Credentials Complete: ${kapsoConfig.enabled}\n`);

  const llmConfig = getLlmDecisionConfig();
  console.log(`[CONFIG] LLM Decision Reviewer:`);
  console.log(`  - Enabled: ${llmConfig.enabled}`);
  console.log(`  - Required For Live: ${llmConfig.requiredForLive}`);
  console.log(`  - Model: ${llmConfig.model ?? 'not configured'}`);
  console.log(`  - API Key Configured: ${llmConfig.apiKeyConfigured}`);
  console.log(`  - Minimum Approval Confidence: ${(llmConfig.minimumConfidence * 100).toFixed(0)}%\n`);
  if (limits.runMode === 'live' && llmConfig.requiredForLive) {
    if (!llmConfig.enabled) throw new Error('Live mode requires FPL_LLM_ENABLED=true');
    if (!llmConfig.apiKeyConfigured) throw new Error('Live mode requires OPENAI_API_KEY for LLM decision review');
  }
  
  if (checkEmergencyStop()) {
    console.log('[RUNNER] Emergency stop is enabled. Runner will monitor but not execute actions.\n');
  }
  
  try {
    const client = getFPLClientFromEnv();
    const auth = await client.authenticate();

    if (auth.authenticated) {
      console.log(`[RUNNER] Authenticated as manager ${auth.managerId}.\n`);
    } else {
      // Without a session the agent can still project, plan, and alert; it simply
      // cannot mutate the team. Exiting here would leave the season unmonitored.
      console.error(`[RUNNER] Not authenticated. Continuing in read-only mode.\n${auth.reason}\n`);
      await notifyAlert('FPL Session Unavailable', auth.reason);
    }

    // Initialize optimizer
    const engine = await getOptimizationEngine();
    console.log('[RUNNER] Optimization engine initialized.');

    const seasonConfig = engine.getSeasonConfig();
    for (const line of describeSeasonConfig(seasonConfig)) console.log(`  ${line}`);
    for (const warning of getSeasonConfigWarnings(seasonConfig)) {
      console.warn(`[RULES] ${warning}`);
    }
    console.log('');

    return true;
  } catch (error) {
    console.error('[RUNNER] Initialization failed:', error);
    return false;
  }
}

// Re-establish the session mid-season when a captured cookie expires.
async function ensureSession(): Promise<boolean> {
  const client = getFPLClient();
  if (client.isAuthenticated() && !client.getLastAuthFailure()) return true;

  const auth = await client.authenticate();
  if (auth.authenticated) {
    console.log('[AUTH] Session re-validated.');
    return true;
  }

  console.error(`[AUTH] Session unavailable: ${auth.reason}`);
  await notifyAlert('FPL Session Expired', auth.reason);
  return false;
}

async function refreshData(): Promise<void> {
  console.log('\n--- Refreshing FPL Data ---');
  
  // Clear both layers so late price, status, and deadline updates are visible.
  getFPLClient().clearCache();
  await refreshOptimizationEngine();
  
  console.log('[DATA] Bootstrap and fixture data refreshed.\n');
}

async function runMonitorPhase(context: DecisionContext): Promise<void> {
  console.log('\n=== MONITOR PHASE (>24h to deadline) ===\n');
  
  if (context.playerStatusChanges.length > 0) {
    console.log(`[INTELLIGENCE] Found ${context.playerStatusChanges.length} player status changes:`);
    for (const change of context.playerStatusChanges) {
      console.log(`  - ${change.player.web_name}: ${change.oldStatus} -> ${change.newStatus}`);
    }
    await notifyAlert(
      'Player Status Changes',
      `${context.playerStatusChanges.length} players changed status this cycle. Check your team!`
    );
  }
  
  if (context.newsAlerts.length > 0) {
    console.log('[INTELLIGENCE] News alerts:');
    for (const alert of context.newsAlerts.slice(0, 5)) {
      console.log(`  - ${alert}`);
    }
  }
  
  // Check external news (Twitter/FPL sites)
  if (context.externalNews && context.externalNews.length > 0) {
    console.log(`[EXTERNAL NEWS] Found ${context.externalNews.length} news items:`);
    for (const news of context.externalNews.slice(0, 5)) {
      console.log(`  - [${news.priority.toUpperCase()}] ${news.source}: ${news.title.substring(0, 60)}...`);
    }
  }
  
  // Check team health
  if (context.teamHealth.alerts.length > 0) {
    console.log('[TEAM] Health alerts:');
    for (const alert of context.teamHealth.alerts) {
      console.log(`  - ${alert}`);
    }
  }
  
  console.log('[MONITOR] No actions needed. Monitoring for changes.\n');
}

async function runPlanPhase(context: DecisionContext): Promise<void> {
  console.log(`\n=== PLAN PHASE (${PRE_DEADLINE_HOURS}-24h to deadline) ===\n`);
  
  const limits = getSafetyLimits();
  const transferPlan = await optimizeTransferPlan(
    context.myTeam!,
    Math.max(0, limits.maxTransfersPerWeek - context.myTeam!.transfers.made),
    6,
    context.rankPolicy
  );
  
  console.log(`[PLAN] Optimized ${transferPlan.horizon}-GW ${transferPlan.mode} in ${context.rankPolicy.mode} mode: ${transferPlan.transfers.length} transfer(s), net gain ${transferPlan.netGain.toFixed(1)} xP, template protection ${transferPlan.templateProtectionGain.toFixed(2)}, rank utility ${transferPlan.rankUtilityGain.toFixed(2)}`);
  if (transferPlan.blockedReason) console.log(`[PLAN] Plan withheld: ${transferPlan.blockedReason}`);
  for (const transfer of transferPlan.transfers) {
    console.log(`  - ${transfer.playerOut.web_name} OUT -> ${transfer.playerIn.web_name} IN`);
  }
  
  // Plan against the same legal lineup and captaincy path used immediately
  // before execution, including the proposed transfers.
  const plannedTeam = buildProjectedPlanningTeam(context.myTeam!, transferPlan);
  const lineup = await selectOptimalLineup(plannedTeam, context.rankPolicy);
  console.log(`[PLAN] Proposed optimized XI captain pending review: ${lineup.captain.web_name} (${lineup.captainExpectedPoints.toFixed(1)} xP)`);
  
  // Evaluate chips
  const chipRecommendations = await evaluateChips(plannedTeam, context.gameweek, lineup);
  console.log(`[PLAN] Proposed chip candidates pending review: ${chipRecommendations.length}`);
  for (const chip of chipRecommendations) {
    console.log(`  - ${chip.chip}: ${chip.reasoning} (Confidence: ${(chip.confidence * 100).toFixed(0)}%)`);
  }

  const llmReview = await reviewGameweekPlanWithLlm({
    context,
    transferPlan,
    captain: {
      id: lineup.captain.id,
      name: lineup.captain.web_name,
      expectedPoints: lineup.captainExpectedPoints,
    },
    chips: chipRecommendations,
  });
  console.log(`[LLM] Gameweek plan review: ${llmReviewSummary(llmReview)}`);
  const disposition = getGameweekPlanDisposition(llmReview, limits.runMode, Boolean(transferPlan.blockedReason));

  const transferSummary = transferPlan.transfers.length > 0
    ? transferPlan.transfers.map(transfer => `${transfer.playerOut.web_name} -> ${transfer.playerIn.web_name}`).join(', ')
    : 'Hold transfers';
  const planFingerprint = [
    context.season,
    context.gameweek,
    transferSummary,
    lineup.captain.id,
    chipRecommendations.map(chip => chip.chip).sort().join(','),
    llmReviewSummary(llmReview),
  ].join('|');
  queueKapsoWhatsAppUpdate({
    season: context.season,
    gameweek: context.gameweek,
    stage: 'plan',
    action: 'gameweek-plan',
    status: disposition.kapsoStatus,
    summary: disposition.held ? `Withheld: ${transferSummary}` : transferSummary,
    details: {
      [disposition.held ? 'Proposed captain' : 'Captain']: lineup.captain.web_name,
      [disposition.held ? 'Proposed vice-captain' : 'Vice-captain']: lineup.viceCaptain.web_name,
      [disposition.held ? 'Proposed starting XI' : 'Starting XI']: lineup.startingXI.map(player => player.web_name),
      [disposition.held ? 'Proposed bench' : 'Bench']: lineup.bench.map(player => player.web_name),
      'Projected net gain': `${transferPlan.netGain.toFixed(1)} xP`,
      'Template protection': transferPlan.templateProtectionGain.toFixed(2),
      'Rank mode': context.rankPolicy.mode,
      'Rank utility': transferPlan.rankUtilityGain.toFixed(2),
      [disposition.held ? 'Proposed chips' : 'Chips']: chipRecommendations.map(chip => chip.chip),
      'LLM review': llmReviewSummary(llmReview),
      Publication: disposition.held ? 'Withheld by LLM review' : 'Published as planned',
      Deadline: context.deadline?.toISOString() ?? 'unavailable',
    },
    runMode: limits.runMode,
    dedupeKey: `plan:${planFingerprint}`,
  });
  
  // Publish the reviewed disposition; a hold is observable but never labelled
  // as an approved recommendation.
  await notify({
    type: 'summary',
    title: disposition.notificationTitle,
    message: `${context.gameweek} | ${context.hoursToDeadline.toFixed(1)}h to deadline`,
    data: {
      'Phase': 'Plan',
      [disposition.held ? 'Proposed Transfers' : 'Transfers']: transferPlan.transfers.length,
      'Projected Net Gain': transferPlan.netGain,
      'Template Protection': transferPlan.templateProtectionGain,
      'Rank Mode': context.rankPolicy.mode,
      'Rank Utility': transferPlan.rankUtilityGain,
      [disposition.held ? 'Proposed Captain' : 'Captain']: lineup.captain.web_name,
      [disposition.held ? 'Proposed Chips' : 'Chips Recommended']: chipRecommendations.length,
      'Publication': disposition.held ? 'Withheld by LLM review' : 'Published as planned',
      'Team Health Alerts': context.teamHealth.alerts.length,
      'LLM Review': llmReviewSummary(llmReview),
    },
    timestamp: new Date(),
  });
  
  console.log(disposition.held
    ? '[PLAN] Proposal withheld after LLM HOLD; no recommendation was published.\n'
    : '[PLAN] Recommendations generated and notified.\n');
}

async function runExecutePhase(context: DecisionContext): Promise<void> {
  console.log(`\n=== EXECUTE PHASE (<${PRE_DEADLINE_HOURS}h to deadline) ===\n`);

  const limits = getSafetyLimits();

  const optimizedPlan = await optimizeTransferPlan(
    context.myTeam!,
    Math.max(0, limits.maxTransfersPerWeek - context.myTeam!.transfers.made),
    6,
    context.rankPolicy
  );
  const transferPlan = optimizedPlan.transfers;
  const totalXPGain = optimizedPlan.expectedGain;
  const hitCost = optimizedPlan.hitCost;
  const engine = await getOptimizationEngine();
  const planStable = observeTransferPlanStability(context.gameweek, optimizedPlan);
  const priceTrigger = deriveEarlyPriceTrigger(optimizedPlan, context.bank, engine);
  const executionDecision = decideCurrentDeadlineExecution(
    context,
    !optimizedPlan.blockedReason,
    planStable,
    priceTrigger
  );

  console.log(
    `[TIMING] ${executionDecision.phase}/${executionDecision.action}: ${executionDecision.reason}; `
    + `${(executionDecision.millisecondsToDeadline / 60_000).toFixed(1)}m to deadline; `
    + `news=${context.intelligenceFeed.status}; stable=${planStable}`
  );
  if (executionDecision.action !== 'commit') {
    console.log('[EXECUTE] Holding changes until a safe qualified commit window.\n');
    return;
  }

  if (transferPlan.length > 0) {
    console.log(`[EXECUTE] Optimized ${optimizedPlan.horizon}-GW ${optimizedPlan.mode} in ${context.rankPolicy.mode} mode: ${transferPlan.length} move(s), net gain ${optimizedPlan.netGain.toFixed(1)} xP, template protection ${optimizedPlan.templateProtectionGain.toFixed(2)}, rank utility ${optimizedPlan.rankUtilityGain.toFixed(2)}`);
    for (const transfer of transferPlan) {
      console.log(`  - ${transfer.playerOut.web_name} -> ${transfer.playerIn.web_name}`);
    }

    const deterministicValidation = validateTransfer(
      totalXPGain,
      hitCost,
      context.freeTransfers,
      transferPlan.length,
      optimizedPlan.confidence,
      hasUnlimitedTransfers(context.myTeam!)
    );
    const llmReview = await reviewTransferPlanWithLlm(context, optimizedPlan);
    const llmAllowed = llmReviewAllowsMutation(llmReview);
    const validation = llmAllowed
      ? deterministicValidation
      : { allowed: false, reason: `LLM review did not approve: ${llmReviewSummary(llmReview)}` };
    
    console.log(`  Validation: ${validation.allowed ? 'APPROVED' : 'BLOCKED'} - ${validation.reason}`);
    console.log(`  LLM review: ${llmReviewSummary(llmReview)}`);
    const transferExecutionDecision = decideCurrentDeadlineExecution(
      context,
      validation.allowed && !optimizedPlan.blockedReason,
      planStable,
      priceTrigger
    );
    console.log(
      `  Commit gate: ${transferExecutionDecision.action.toUpperCase()} - ${transferExecutionDecision.reason}`
    );

    if (validation.allowed && transferExecutionDecision.action === 'commit') {
      const actionKey = `transfer:${context.season}:${context.gameweek}:cycle-${runnerState.cycleCount}`;
      const transferSummary = transferPlan
        .map(transfer => `${transfer.playerOut.web_name} -> ${transfer.playerIn.web_name}`)
        .join(', ');
      queueKapsoWhatsAppUpdate({
        season: context.season,
        gameweek: context.gameweek,
        stage: 'before',
        action: 'transfer',
        status: 'starting',
        summary: transferSummary,
        details: {
          'Net gain': `${optimizedPlan.netGain.toFixed(1)} xP`,
          'Template protection': optimizedPlan.templateProtectionGain.toFixed(2),
          'Hit cost': hitCost,
          Confidence: `${Math.round(optimizedPlan.confidence * 100)}%`,
          'LLM review': llmReviewSummary(llmReview),
        },
        runMode: limits.runMode,
        dedupeKey: `${actionKey}:before`,
        sequenceKey: actionKey,
      });
      try {
        const client = getFPLClient();
        const result = await client.makeTransfers(
          transferPlan.map(transfer => ({
            playerOut: transfer.playerOut.id,
            playerIn: transfer.playerIn.id,
            purchasePrice: transfer.playerIn.now_cost,
            sellingPrice: transfer.sellingPrice,
          })),
          createMutationGuard(context.myTeam!, context.season, context.gameweek, context.deadline)
        );
        
        if (result.success) {
          for (const _transfer of transferPlan) recordTransfer();
          await logDecision({
            season: context.season,
            managerId: context.managerId,
            gameweek: context.gameweek,
            decisionType: 'transfer',
            action: JSON.stringify({
              status: 'executed',
              transfers: transferPlan.map(transfer => ({
                playerOutId: transfer.playerOut.id,
                playerInId: transfer.playerIn.id,
                playerOut: transfer.playerOut.web_name,
                playerIn: transfer.playerIn.web_name,
              })),
            }),
            reasoning: `${optimizedPlan.horizon}-GW full-squad optimization; net gain ${optimizedPlan.netGain.toFixed(1)} xP; template protection ${optimizedPlan.templateProtectionGain.toFixed(2)}; rank utility ${optimizedPlan.rankUtilityGain.toFixed(2)}; LLM ${llmReviewSummary(llmReview)}`,
            expectedPoints: totalXPGain,
            hitsTaken: hitCost / 4,
            createdAt: new Date(),
          });
          for (const transfer of transferPlan) {
            await notifyTransfer(transfer.playerOut, transfer.playerIn, transfer.xpGain, hitCost);
          }
          queueKapsoWhatsAppUpdate({
            season: context.season,
            gameweek: context.gameweek,
            stage: 'after',
            action: 'transfer',
            status: 'confirmed',
            summary: transferSummary,
            details: { Result: result.message },
            runMode: limits.runMode,
            dedupeKey: `${actionKey}:after:confirmed`,
            sequenceKey: actionKey,
          });
          console.log('[EXECUTE] Transfer plan executed successfully!\n');
        } else {
          console.error('[EXECUTE] Transfer failed:', result.message);
          queueKapsoWhatsAppUpdate({
            season: context.season,
            gameweek: context.gameweek,
            stage: 'after',
            action: 'transfer',
            status: result.outcome === 'unknown' ? 'unknown' : 'failed',
            summary: transferSummary,
            details: { Result: result.message },
            runMode: limits.runMode,
            dedupeKey: `${actionKey}:after:${result.outcome === 'unknown' ? 'unknown' : 'failed'}`,
            sequenceKey: actionKey,
          });
          await notifyAlert('Transfer Failed', result.message);
          if (result.outcome === 'unknown') return;
        }
      } catch (error) {
        console.error('[EXECUTE] Transfer failed:', error);
        queueKapsoWhatsAppUpdate({
          season: context.season,
          gameweek: context.gameweek,
          stage: 'after',
          action: 'transfer',
          status: 'failed',
          summary: transferSummary,
          details: { Result: error instanceof Error ? error.message : String(error) },
          runMode: limits.runMode,
          dedupeKey: `${actionKey}:after:exception`,
          sequenceKey: actionKey,
        });
        await notifyAlert('Transfer Failed', `Failed to execute: ${error}`);
      }
    } else {
      // Log the decision even if not executed
      const heldReason = validation.allowed
        ? `Deadline execution policy held: ${transferExecutionDecision.reason}`
        : validation.reason;
      await logDecision({
        season: context.season,
        managerId: context.managerId,
        gameweek: context.gameweek,
        decisionType: 'transfer',
        action: transferPlan.map(transfer => `${transfer.playerOut.web_name} -> ${transfer.playerIn.web_name}`).join(', '),
        reasoning: heldReason,
        expectedPoints: totalXPGain,
        hitsTaken: hitCost / 4,
        createdAt: new Date(),
      });
    }
  } else {
    console.log('[EXECUTE] No transfer candidates found.\n');
  }

  // A qualified economic move may be made early, but lineup, captain and chip
  // choices continue to wait for the final news window.
  if (executionDecision.phase === 'early-price') {
    console.log('[EXECUTE] Early-price phase complete; lineup remains uncommitted.\n');
    return;
  }
  
  const client = getFPLClient();
  const latestTeam = await client.getMyTeam();
  const lineup = await selectOptimalLineup(latestTeam, context.rankPolicy);
  const activeChip = getActiveLineupChip(latestTeam);
  const chipRecommendations = activeChip ? [] : await evaluateChips(latestTeam, context.gameweek, lineup);
  const supportedChip = chipRecommendations.find(chip =>
    (chip.chip === 'bboost' || chip.chip === '3xc')
    && validateChip(chip.chip, chip.recommended, chip.confidence).allowed
  );
  const newChip = supportedChip?.chip as 'bboost' | '3xc' | undefined;
  const submittedChip = activeChip ?? newChip ?? null;

  const currentPicks = new Map(latestTeam.picks.map(pick => [pick.element, pick]));
  const changed = lineup.selection.some(pick => {
    const current = currentPicks.get(pick.element);
    return !current || current.position !== pick.position || current.is_captain !== pick.isCaptain || current.is_vice_captain !== pick.isViceCaptain;
  });
  const currentLineupPoints = await calculateCurrentLineupExpectedPoints(latestTeam);
  const lineupPermission = changed
    ? validateLineup(lineup.expectedPoints - currentLineupPoints, lineup.confidence)
    : { allowed: true, reason: 'Lineup unchanged' };
  const lineupLlmReview = changed || newChip
    ? await reviewLineupWithLlm({
      context,
      lineup,
      currentExpectedPoints: currentLineupPoints,
      chip: newChip ?? null,
      chipExpectedGain: supportedChip?.expectedGain ?? 0,
    })
    : null;
  const lineupLlmAllowed = lineupLlmReview ? llmReviewAllowsMutation(lineupLlmReview) : true;
  if (lineupLlmReview) console.log(`[LLM] Lineup review: ${llmReviewSummary(lineupLlmReview)}`);
  const lineupMutationAllowed = getMutationPermission('lineup').allowed || (!changed && Boolean(newChip));
  const lineupPlanReady = lineupPermission.allowed && lineupLlmAllowed && lineupMutationAllowed;
  const lineupExecutionDecision = decideCurrentDeadlineExecution(
    context,
    lineupPlanReady,
    true,
    null
  );
  if (changed || newChip) {
    console.log(
      `[TIMING] Lineup commit gate: ${lineupExecutionDecision.action.toUpperCase()} - ${lineupExecutionDecision.reason}`
    );
  }
  if (lineupPlanReady && lineupExecutionDecision.action === 'commit') {

    if (changed || newChip) {
      const action = newChip ? 'chip' : 'lineup';
      const actionKey = `${action}:${context.season}:${context.gameweek}:cycle-${runnerState.cycleCount}`;
      const lineupSummary = `Captain ${lineup.captain.web_name}; vice ${lineup.viceCaptain.web_name}${newChip ? `; chip ${newChip}` : ''}`;
      queueKapsoWhatsAppUpdate({
        season: context.season,
        gameweek: context.gameweek,
        stage: 'before',
        action,
        status: 'starting',
        summary: lineupSummary,
        details: {
          'Starting XI': lineup.startingXI.map(player => player.web_name),
          Bench: lineup.bench.map(player => player.web_name),
          'Expected points': lineup.expectedPoints.toFixed(1),
          'LLM review': lineupLlmReview ? llmReviewSummary(lineupLlmReview) : 'not required',
        },
        runMode: limits.runMode,
        dedupeKey: `${actionKey}:before`,
        sequenceKey: actionKey,
      });
      try {
        const result = await client.updateTeam(
          lineup.selection,
          createMutationGuard(latestTeam, context.season, context.gameweek, context.deadline),
          submittedChip
        );
        if (!result.success) {
          queueKapsoWhatsAppUpdate({
            season: context.season,
            gameweek: context.gameweek,
            stage: 'after',
            action,
            status: result.outcome === 'unknown' ? 'unknown' : 'failed',
            summary: lineupSummary,
            details: { Result: result.message },
            runMode: limits.runMode,
            dedupeKey: `${actionKey}:after:${result.outcome === 'unknown' ? 'unknown' : 'failed'}`,
            sequenceKey: actionKey,
          });
          await notifyAlert('Team Update Failed', result.message);
        } else {
        await logDecision({
          season: context.season,
          managerId: context.managerId,
          gameweek: context.gameweek,
          decisionType: newChip ? 'chip' : 'captain',
          action: JSON.stringify({
            captain: lineup.captain.web_name,
            viceCaptain: lineup.viceCaptain.web_name,
            startingXI: lineup.startingXI.map(player => player.web_name),
            bench: lineup.bench.map(player => player.web_name),
            chip: submittedChip,
          }),
          reasoning: `Highest projected legal XI (${lineup.expectedPoints.toFixed(1)} xP); LLM ${lineupLlmReview ? llmReviewSummary(lineupLlmReview) : 'not required'}`,
          expectedPoints: lineup.expectedPoints,
          hitsTaken: 0,
          createdAt: new Date(),
        });
        console.log(`[EXECUTE] Lineup set. Captain ${lineup.captain.web_name}, vice ${lineup.viceCaptain.web_name}.`);
        await notifyCaptain(lineup.captain, lineup.captainExpectedPoints, [lineup.viceCaptain.web_name]);
        if (supportedChip) await notifyChip(supportedChip.chip, context.gameweek, supportedChip.expectedGain, true);
          queueKapsoWhatsAppUpdate({
            season: context.season,
            gameweek: context.gameweek,
            stage: 'after',
            action,
            status: 'confirmed',
            summary: lineupSummary,
            details: { Result: result.message },
            runMode: limits.runMode,
            dedupeKey: `${actionKey}:after:confirmed`,
            sequenceKey: actionKey,
          });
        }
      } catch (error) {
        queueKapsoWhatsAppUpdate({
          season: context.season,
          gameweek: context.gameweek,
          stage: 'after',
          action,
          status: 'failed',
          summary: lineupSummary,
          details: { Result: error instanceof Error ? error.message : String(error) },
          runMode: limits.runMode,
          dedupeKey: `${actionKey}:after:exception`,
          sequenceKey: actionKey,
        });
        throw error;
      }
    } else {
      console.log('[EXECUTE] Existing lineup and captaincy are already optimal.');
    }
  } else {
    const reason = !lineupPermission.allowed
      ? lineupPermission.reason
      : !lineupLlmAllowed
        ? `LLM review did not approve: ${llmReviewSummary(lineupLlmReview!)}`
        : !lineupMutationAllowed
          ? 'Lineup mutation permission is disabled'
          : `Deadline execution policy held: ${lineupExecutionDecision.reason}`;
    console.log(`[EXECUTE] Lineup mutation blocked: ${reason}.`);
  }
}

// Team-independent monitoring used when no session is available. Player news and
// deadlines still get tracked so the season is never running blind.
async function runReadOnlyCycle(): Promise<void> {
  console.log('\n=== READ-ONLY CYCLE (no FPL session) ===\n');

  const engine = await getOptimizationEngine();
  const deadline = engine.getNextDeadline();
  if (deadline) {
    console.log(`[STATUS] Next deadline: GW${deadline.gameweek} in ${deadline.hoursRemaining.toFixed(1)}h`);
  } else {
    console.log('[STATUS] No upcoming deadline found.');
  }

  const latestFinishedGameweek = engine.getGameweeks()
    .filter(gameweek => gameweek.finished)
    .sort((a, b) => b.id - a.id)[0];
  if (latestFinishedGameweek && latestFinishedGameweek.id > runnerState.lastGWProcessed) {
    try {
      await reconcileFinishedGameweek(latestFinishedGameweek.id);
      runnerState.lastGWProcessed = latestFinishedGameweek.id;
    } catch (error) {
      console.error(`[LEARNING] Failed to reconcile GW${latestFinishedGameweek.id} forecasts:`, error);
    }
  }

  const intelligence = await gatherIntelligence(deadline?.gameweek, deadline?.deadline);
  if (intelligence.statusChanges.length > 0) {
    console.log(`[INTELLIGENCE] ${intelligence.statusChanges.length} player status change(s):`);
    for (const change of intelligence.statusChanges.slice(0, 10)) {
      console.log(`  - ${change.player.web_name}: ${change.oldStatus} -> ${change.newStatus}`);
    }
  }
  for (const alert of intelligence.newsAlerts.slice(0, 5)) console.log(`  - ${alert}`);

  if (deadline) {
    const shadowCapture = await captureLearningSnapshot(
      deadline.gameweek,
      deadline.hoursRemaining <= PRE_DEADLINE_HOURS
    );
    if (shadowCapture) await captureMlShadowForecasts(shadowCapture);
  }

  console.log('[READ-ONLY] Team actions are unavailable until a valid FPL session is configured.\n');
}

async function runPostDeadline(context: DecisionContext): Promise<void> {
  console.log('\n=== POST-DEADLINE ===\n');
  
  // Check if we already processed this GW
  if (runnerState.lastGWProcessed === context.gameweek) {
    console.log('[POST] Already processed this gameweek.\n');
    return;
  }

  const client = getFPLClient();
  const managerId = client.getManagerId();
  if (!managerId) {
    console.log('[POST] No manager ID available, skipping snapshot.\n');
    return;
  }
  const season = (await getOptimizationEngine()).getSeasonConfig().season;
  const existingSnapshot = await getGameweekSnapshot(season, managerId, context.gameweek);
  if (existingSnapshot) {
    try {
      await reconcileFinishedGameweek(context.gameweek);
    } catch (error) {
      console.error(`[LEARNING] Failed to reconcile GW${context.gameweek} forecasts:`, error);
      return;
    }
    runnerState.lastGWProcessed = context.gameweek;
    console.log('[POST] Snapshot already exists for this gameweek.\n');
    return;
  }
  
  try {
    const history = await client.getEntryHistory(managerId);
    const currentGWHistory = history.current.find((h: GameweekHistory) => h.event === context.gameweek);
    
    if (currentGWHistory) {
      await saveGameweekSnapshot({
        season,
        managerId,
        gameweek: context.gameweek,
        totalPoints: currentGWHistory.total_points,
        overallRank: currentGWHistory.overall_rank,
        gameweekPoints: currentGWHistory.points,
        gameweekRank: currentGWHistory.rank,
        teamValue: currentGWHistory.value / 10,
        bank: currentGWHistory.bank / 10,
        chipsUsed: JSON.stringify(history.chips.filter((c: ChipUsage) => c.event === context.gameweek).map((c: ChipUsage) => c.name)),
        transfersMade: currentGWHistory.event_transfers,
        transfersCost: currentGWHistory.event_transfers_cost,
        pointsOnBench: currentGWHistory.points_on_bench,
        createdAt: new Date(),
      });

      try {
        await reconcileFinishedGameweek(context.gameweek);
      } catch (error) {
        console.error(`[LEARNING] Failed to reconcile GW${context.gameweek} forecasts:`, error);
        return;
      }
      
      await notifySummary(
        context.gameweek,
        currentGWHistory.points,
        currentGWHistory.overall_rank,
        0
      );
      queueKapsoWhatsAppUpdate({
        season: context.season,
        gameweek: context.gameweek,
        stage: 'after',
        action: 'gameweek-summary',
        status: 'confirmed',
        summary: `${currentGWHistory.points} points; overall rank ${currentGWHistory.overall_rank.toLocaleString()}`,
        details: {
          Transfers: currentGWHistory.event_transfers,
          'Transfer cost': currentGWHistory.event_transfers_cost,
          'Points on bench': currentGWHistory.points_on_bench,
        },
        runMode: getSafetyLimits().runMode,
        dedupeKey: `summary:${context.season}:${context.gameweek}`,
      });
      
      runnerState.lastGWProcessed = context.gameweek;
      console.log(`[POST] GW${context.gameweek} snapshot saved. Points: ${currentGWHistory.points}, Rank: ${currentGWHistory.overall_rank}\n`);
    }
  } catch (error) {
    console.error('[POST] Failed to save snapshot:', error);
  }
}

async function runCycle(): Promise<void> {
  cycleHadError = null;
  runnerState.cycleCount++;
  const cycleStart = new Date();
  console.log(`\n${'='.repeat(50)}`);
  console.log(`CYCLE ${runnerState.cycleCount} - ${cycleStart.toISOString()}`);
  console.log('='.repeat(50));
  
  try {
    // Refresh data
    await refreshData();
    
    // Get decision context
    const authenticated = await ensureSession();
    const context = authenticated ? await buildDecisionContext() : null;

    if (!context) {
      await runReadOnlyCycle();
      return;
    }

    const shadowCapture = await captureLearningSnapshot(
      context.gameweek,
      context.hoursToDeadline <= PRE_DEADLINE_HOURS
    );
    
    const engine = await getOptimizationEngine();
    const latestFinishedGameweek = engine.getGameweeks()
      .filter(gameweek => gameweek.finished)
      .sort((a, b) => b.id - a.id)[0];

    if (latestFinishedGameweek && latestFinishedGameweek.id > runnerState.lastGWProcessed) {
      await runPostDeadline({ ...context, gameweek: latestFinishedGameweek.id });
    }

    // Determine the phase for the next actionable deadline.
    const deadlineInfo = engine.getNextDeadline();
    const hoursToDeadline = deadlineInfo?.hoursRemaining ?? context.hoursToDeadline;
    const newPhase = getPhase(deadlineInfo ? hoursToDeadline : Number.POSITIVE_INFINITY, false);
    
    if (newPhase !== runnerState.phase) {
      console.log(`[PHASE] Transition: ${runnerState.phase} -> ${newPhase}`);
      runnerState.lastPhase = runnerState.phase;
      runnerState.phase = newPhase;
    }
    
    console.log(`[STATUS] GW${context.gameweek} | ${hoursToDeadline.toFixed(1)}h to deadline | Phase: ${newPhase}`);
    console.log(`[TEAM] Free transfers: ${context.freeTransfers}, Bank: £${(context.bank / 10).toFixed(1)}m`);
    
    // Run phase-specific logic
    try {
      switch (newPhase) {
        case 'monitor':
          await runMonitorPhase(context);
          break;
        case 'plan':
          await runPlanPhase(context);
          break;
        case 'execute':
          await runExecutePhase(context);
          break;
        case 'post-deadline':
          await runPostDeadline(context);
          break;
      }
    } finally {
      if (shadowCapture) await captureMlShadowForecasts(shadowCapture);
    }
  } catch (error) {
    console.error('[CYCLE] Error in cycle:', error);
    cycleHadError = error instanceof Error ? error.message : String(error);
    await notifyAlert('Cycle Error', `Error in cycle ${runnerState.cycleCount}: ${error}`);
  }
  
  const cycleEnd = new Date();
  const duration = (cycleEnd.getTime() - cycleStart.getTime()) / 1000;
  console.log(`\n[CYCLE] Completed in ${duration.toFixed(1)}s`);
}

async function safeRunCycle(): Promise<void> {
  if (cycleInProgress) {
    console.log('[CYCLE] Previous cycle still running, skipping this tick.');
    return;
  }

  cycleInProgress = true;
  lastCycleStartedAt = new Date().toISOString();
  updateHealth('running');
  try {
    await runCycle();
    lastCycleCompletedAt = new Date().toISOString();
    if (cycleHadError) {
      consecutiveCycleFailures++;
      updateHealth('error', cycleHadError);
      console.error(
        `[HEALTH] Consecutive failed cycles: ${consecutiveCycleFailures}/${TIMING.maxConsecutiveCycleFailures}`
      );
      if (consecutiveCycleFailures >= TIMING.maxConsecutiveCycleFailures) {
        throw new Error(
          `Worker exceeded ${TIMING.maxConsecutiveCycleFailures} consecutive failed cycles: ${cycleHadError}`
        );
      }
    } else {
      consecutiveCycleFailures = 0;
      updateHealth('idle');
    }
  } catch (error) {
    updateHealth('error', error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    cycleInProgress = false;
  }
}

async function nextPollInterval(): Promise<number> {
  const deadline = (await getOptimizationEngine()).getNextDeadline()?.deadline;
  if (!deadline) return POLL_INTERVAL;
  const remaining = deadline.getTime() - Date.now();
  if (remaining > 0 && remaining <= DEADLINE_NEWS_WINDOW) {
    if (remaining > FINALIZATION_WINDOW) {
      return Math.min(
        DEADLINE_NEWS_POLL_INTERVAL,
        Math.max(1_000, remaining - FINALIZATION_WINDOW)
      );
    }
    return DEADLINE_NEWS_POLL_INTERVAL;
  }
  return POLL_INTERVAL;
}

async function main(): Promise<void> {
  const runOnce = process.argv.includes('--once');
  releaseRunnerLock = acquireExclusiveFileLock(
    process.env.FPL_RUNNER_LOCK_PATH?.trim() || 'data/fpl-runner.lock',
    'FPL runner'
  );
  updateHealth('starting');
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  const initialized = await initialize();
  
  if (!initialized) {
    console.error('[MAIN] Failed to initialize. Exiting.');
    throw new Error('Runner initialization failed');
  }
  
  console.log('[MAIN] Starting polling loop...\n');
  
  const poll = async () => {
    if (stopping) return;
    activeCycle = safeRunCycle();
    try {
      await activeCycle;
    } finally {
      activeCycle = null;
      if (!stopping && !runOnce) {
        const interval = await nextPollInterval().catch(error => {
          console.error('[MAIN] Failed to calculate next poll interval:', error);
          return POLL_INTERVAL;
        });
        timeoutId = setTimeout(() => void poll(), interval);
      }
    }
  };
  await poll();
  if (runOnce) {
    await flushKapsoWhatsAppUpdates();
    releaseRunnerLock?.();
    releaseRunnerLock = null;
    console.log('[MAIN] One-cycle runner check complete.');
  }
}

async function shutdown(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  if (stopping) return;
  stopping = true;
  updateHealth('stopping');
  console.log(`\n[MAIN] Received ${signal}. Waiting for the active cycle to finish...`);
  if (timeoutId) clearTimeout(timeoutId);
  if (activeCycle) await activeCycle;
  const notificationsFlushed = await flushKapsoWhatsAppUpdates();
  if (!notificationsFlushed) console.warn('[KAPSO] Shutdown notification flush timed out; FPL state is unaffected.');
  releaseRunnerLock?.();
  releaseRunnerLock = null;
  console.log('[MAIN] Shutdown complete.');
}

main().catch(async error => {
  console.error('[MAIN] Fatal runner error:', error);
  await flushKapsoWhatsAppUpdates();
  releaseRunnerLock?.();
  releaseRunnerLock = null;
  process.exitCode = 1;
});

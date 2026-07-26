// Autonomous Runner - Main entry point for autonomous FPL decision making
import 'dotenv/config';
import { getFPLClient } from '../api/client.js';
import { getOptimizationEngine, resetOptimizationEngine } from '../engine/optimizer.js';
import { 
  buildDecisionContext, 
  optimizeTransferPlan,
  selectOptimalCaptain, 
  selectOptimalLineup,
  evaluateChips,
  type DecisionContext 
} from './decisions.js';
import { 
  getSafetyLimits, 
  checkEmergencyStop, 
  validateTransfer, 
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
import { getGameweekSnapshot, logDecision, saveGameweekSnapshot } from '../db/client.js';
import type { GameweekHistory, ChipUsage } from '../api/types.js';
import { captureLearningSnapshot, reconcileFinishedGameweek } from './learning.js';

type RunnerPhase = 'monitor' | 'plan' | 'execute' | 'post-deadline';

interface RunnerState {
  phase: RunnerPhase;
  lastPhase: RunnerPhase;
  cycleCount: number;
  lastGWProcessed: number;
}

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MINUTES || '30') * 60 * 1000;
const PRE_DEADLINE_HOURS = parseInt(process.env.PRE_DEADLINE_HOURS || '2');
const DEADLINE_NEWS_WINDOW = parseInt(process.env.DEADLINE_NEWS_WINDOW_MINUTES || '90') * 60 * 1000;
const DEADLINE_NEWS_POLL_INTERVAL = parseInt(process.env.DEADLINE_NEWS_POLL_MINUTES || '5') * 60 * 1000;

let runnerState: RunnerState = {
  phase: 'monitor',
  lastPhase: 'monitor',
  cycleCount: 0,
  lastGWProcessed: 0,
};

let cycleInProgress = false;

function getPhase(hoursToDeadline: number, isPostDeadline: boolean): RunnerPhase {
  if (isPostDeadline) return 'post-deadline';
  if (hoursToDeadline < PRE_DEADLINE_HOURS) return 'execute';
  if (hoursToDeadline < 24) return 'plan';
  return 'monitor';
}

async function initialize(): Promise<boolean> {
  console.log('\n========================================');
  console.log('FPL AUTONOMOUS RUNNER - Starting...');
  console.log('========================================\n');

  const limits = getSafetyLimits();
  console.log(`[CONFIG] Safety Limits:`);
  console.log(`  - Max Transfers/Week: ${limits.maxTransfersPerWeek}`);
  console.log(`  - Min xP Gain for Hit: ${limits.minXPGainForHit}`);
  console.log(`  - Auto-Execute Transfers: ${limits.autoExecuteTransfers}`);
  console.log(`  - Auto-Set Lineup: ${limits.autoSetLineup}`);
  console.log(`  - Auto-Play Chips: ${limits.autoPlayChips}`);
  console.log(`  - Emergency Stop: ${limits.emergencyStop}`);
  console.log(`  - Poll Interval: ${POLL_INTERVAL / 60000} minutes`);
  console.log(`  - Pre-Deadline Hours: ${PRE_DEADLINE_HOURS}h\n`);
  
  if (checkEmergencyStop()) {
    console.log('[RUNNER] Emergency stop is enabled. Runner will monitor but not execute actions.\n');
  }
  
  try {
    const client = getFPLClient(
      process.env.FPL_EMAIL,
      process.env.FPL_PASSWORD,
      process.env.FPL_MANAGER_ID ? parseInt(process.env.FPL_MANAGER_ID) : undefined
    );
    const isAuth = await client.login();
    
    if (!isAuth) {
      console.error('[RUNNER] Failed to authenticate with FPL. Exiting.');
      return false;
    }
    
    console.log('[RUNNER] Authentication successful.\n');
    
    // Initialize optimizer
    await getOptimizationEngine();
    console.log('[RUNNER] Optimization engine initialized.\n');
    
    return true;
  } catch (error) {
    console.error('[RUNNER] Initialization failed:', error);
    return false;
  }
}

async function refreshData(): Promise<void> {
  console.log('\n--- Refreshing FPL Data ---');
  
  // Clear both layers so late price, status, and deadline updates are visible.
  getFPLClient().clearCache();
  resetOptimizationEngine();
  await getOptimizationEngine();
  
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
  console.log('\n=== PLAN PHASE (2-24h to deadline) ===\n');
  
  const limits = getSafetyLimits();
  const transferPlan = await optimizeTransferPlan(
    context.myTeam!,
    Math.max(0, limits.maxTransfersPerWeek - context.myTeam!.transfers.made),
    6
  );
  
  console.log(`[PLAN] Optimized ${transferPlan.horizon}-GW plan: ${transferPlan.transfers.length} transfer(s), net gain ${transferPlan.netGain.toFixed(1)} xP`);
  for (const transfer of transferPlan.transfers) {
    console.log(`  - ${transfer.playerOut.web_name} OUT -> ${transfer.playerIn.web_name} IN`);
  }
  
  // Select captain
  const captainResult = await selectOptimalCaptain(context.myTeam!);
  console.log(`[PLAN] Captain recommendation: ${captainResult.captain.web_name} (${captainResult.xp.toFixed(1)} xP)`);
  
  // Evaluate chips
  const chipRecommendations = await evaluateChips(context.myTeam!, context.gameweek);
  console.log(`[PLAN] Chip recommendations: ${chipRecommendations.length}`);
  for (const chip of chipRecommendations) {
    console.log(`  - ${chip.chip}: ${chip.reasoning} (Confidence: ${(chip.confidence * 100).toFixed(0)}%)`);
  }
  
  // Notify all recommendations
  await notify({
    type: 'summary',
    title: 'GW Planning Complete',
    message: `${context.gameweek} | ${context.hoursToDeadline.toFixed(1)}h to deadline`,
    data: {
      'Phase': 'Plan',
      'Transfers': transferPlan.transfers.length,
      'Projected Net Gain': transferPlan.netGain,
      'Captain': captainResult.captain.web_name,
      'Chips Recommended': chipRecommendations.length,
      'Team Health Alerts': context.teamHealth.alerts.length,
    },
    timestamp: new Date(),
  });
  
  console.log('[PLAN] Recommendations generated and notified.\n');
}

async function runExecutePhase(context: DecisionContext): Promise<void> {
  console.log('\n=== EXECUTE PHASE (<2h to deadline) ===\n');

  const limits = getSafetyLimits();

  const optimizedPlan = await optimizeTransferPlan(
    context.myTeam!,
    Math.max(0, limits.maxTransfersPerWeek - context.myTeam!.transfers.made),
    6
  );
  const transferPlan = optimizedPlan.transfers;
  const totalXPGain = optimizedPlan.expectedGain;
  const hitCost = optimizedPlan.hitCost;

  if (transferPlan.length > 0) {
    console.log(`[EXECUTE] Optimized ${optimizedPlan.horizon}-GW plan: ${transferPlan.length} move(s), net gain ${optimizedPlan.netGain.toFixed(1)} xP`);
    for (const transfer of transferPlan) {
      console.log(`  - ${transfer.playerOut.web_name} -> ${transfer.playerIn.web_name}`);
    }

    const validation = validateTransfer(
      totalXPGain,
      hitCost,
      context.freeTransfers,
      context.myTeam!.transfers.made
    );
    
    console.log(`  Validation: ${validation.allowed ? 'APPROVED' : 'BLOCKED'} - ${validation.reason}`);
    
    if (validation.allowed) {
      try {
        const client = getFPLClient();
        const result = await client.makeTransfers(
          transferPlan.map(transfer => ({
            playerOut: transfer.playerOut.id,
            playerIn: transfer.playerIn.id,
            purchasePrice: transfer.playerIn.now_cost,
            sellingPrice: transfer.sellingPrice,
          })),
          context.gameweek
        );
        
        if (result.success) {
          for (const _transfer of transferPlan) recordTransfer();
          await logDecision({
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
            reasoning: `${optimizedPlan.horizon}-GW full-squad optimization; net gain ${optimizedPlan.netGain.toFixed(1)} xP`,
            expectedPoints: totalXPGain,
            hitsTaken: hitCost / 4,
            createdAt: new Date(),
          });
          for (const transfer of transferPlan) {
            await notifyTransfer(transfer.playerOut, transfer.playerIn, transfer.xpGain, hitCost);
          }
          console.log('[EXECUTE] Transfer plan executed successfully!\n');
        } else {
          console.error('[EXECUTE] Transfer failed:', result.message);
          await notifyAlert('Transfer Failed', result.message);
        }
      } catch (error) {
        console.error('[EXECUTE] Transfer failed:', error);
        await notifyAlert('Transfer Failed', `Failed to execute: ${error}`);
      }
    } else {
      // Log the decision even if not executed
      await logDecision({
        gameweek: context.gameweek,
        decisionType: 'transfer',
        action: transferPlan.map(transfer => `${transfer.playerOut.web_name} -> ${transfer.playerIn.web_name}`).join(', '),
        reasoning: validation.reason,
        expectedPoints: totalXPGain,
        hitsTaken: hitCost / 4,
        createdAt: new Date(),
      });
    }
  } else {
    console.log('[EXECUTE] No transfer candidates found.\n');
  }
  
  const client = getFPLClient();
  const latestTeam = await client.getMyTeam();
  const lineup = await selectOptimalLineup(latestTeam);
  const chipRecommendations = await evaluateChips(latestTeam, context.gameweek);
  const supportedChip = chipRecommendations.find(chip =>
    (chip.chip === 'bboost' || chip.chip === '3xc') &&
    validateChip(chip.chip, chip.recommended, chip.confidence).allowed
  );
  const chip = supportedChip?.chip as 'bboost' | '3xc' | undefined;

  if (limits.autoSetLineup && !checkEmergencyStop()) {
    const currentPicks = new Map(latestTeam.picks.map(pick => [pick.element, pick]));
    const changed = lineup.selection.some(pick => {
      const current = currentPicks.get(pick.element);
      return !current || current.position !== pick.position || current.is_captain !== pick.isCaptain || current.is_vice_captain !== pick.isViceCaptain;
    });

    if (changed || chip) {
      const result = await client.updateTeam(lineup.selection, chip ?? null);
      if (!result.success) {
        await notifyAlert('Team Update Failed', result.message);
      } else {
        await logDecision({
          gameweek: context.gameweek,
          decisionType: chip ? 'chip' : 'captain',
          action: JSON.stringify({
            captain: lineup.captain.web_name,
            viceCaptain: lineup.viceCaptain.web_name,
            startingXI: lineup.startingXI.map(player => player.web_name),
            bench: lineup.bench.map(player => player.web_name),
            chip: chip ?? null,
          }),
          reasoning: `Highest projected legal XI (${lineup.expectedPoints.toFixed(1)} xP)`,
          expectedPoints: lineup.expectedPoints,
          hitsTaken: 0,
          createdAt: new Date(),
        });
        console.log(`[EXECUTE] Lineup set. Captain ${lineup.captain.web_name}, vice ${lineup.viceCaptain.web_name}.`);
        await notifyCaptain(lineup.captain, lineup.captainExpectedPoints, [lineup.viceCaptain.web_name]);
        if (supportedChip) await notifyChip(supportedChip.chip, context.gameweek, supportedChip.expectedGain, true);
      }
    } else {
      console.log('[EXECUTE] Existing lineup and captaincy are already optimal.');
    }
  } else {
    console.log('[EXECUTE] Automatic lineup management is disabled.');
  }
}

async function runPostDeadline(context: DecisionContext): Promise<void> {
  console.log('\n=== POST-DEADLINE ===\n');
  
  // Check if we already processed this GW
  if (runnerState.lastGWProcessed === context.gameweek) {
    console.log('[POST] Already processed this gameweek.\n');
    return;
  }

  const existingSnapshot = await getGameweekSnapshot(context.gameweek);
  if (existingSnapshot) {
    runnerState.lastGWProcessed = context.gameweek;
    console.log('[POST] Snapshot already exists for this gameweek.\n');
    return;
  }
  
  try {
    const client = getFPLClient();
    const managerId = client.getManagerId();
    
    if (!managerId) {
      console.log('[POST] No manager ID available, skipping snapshot.\n');
      return;
    }
    
    const history = await client.getEntryHistory(managerId);
    const currentGWHistory = history.current.find((h: GameweekHistory) => h.event === context.gameweek);
    
    if (currentGWHistory) {
      await saveGameweekSnapshot({
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
      }
      
      await notifySummary(
        context.gameweek,
        currentGWHistory.points,
        currentGWHistory.overall_rank,
        0
      );
      
      runnerState.lastGWProcessed = context.gameweek;
      console.log(`[POST] GW${context.gameweek} snapshot saved. Points: ${currentGWHistory.points}, Rank: ${currentGWHistory.overall_rank}\n`);
    }
  } catch (error) {
    console.error('[POST] Failed to save snapshot:', error);
  }
}

async function runCycle(): Promise<void> {
  runnerState.cycleCount++;
  const cycleStart = new Date();
  console.log(`\n${'='.repeat(50)}`);
  console.log(`CYCLE ${runnerState.cycleCount} - ${cycleStart.toISOString()}`);
  console.log('='.repeat(50));
  
  try {
    // Refresh data
    await refreshData();
    
    // Get decision context
    const context = await buildDecisionContext();
    
    if (!context) {
      console.log('[CYCLE] Could not build decision context. Skipping cycle.\n');
      return;
    }

    await captureLearningSnapshot(context.gameweek, context.hoursToDeadline <= PRE_DEADLINE_HOURS);
    
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
  } catch (error) {
    console.error('[CYCLE] Error in cycle:', error);
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
  try {
    await runCycle();
  } finally {
    cycleInProgress = false;
  }
}

async function nextPollInterval(): Promise<number> {
  const deadline = (await getOptimizationEngine()).getNextDeadline()?.deadline;
  if (!deadline) return POLL_INTERVAL;
  const remaining = deadline.getTime() - Date.now();
  return remaining > 0 && remaining <= DEADLINE_NEWS_WINDOW ? DEADLINE_NEWS_POLL_INTERVAL : POLL_INTERVAL;
}

async function main(): Promise<void> {
  const initialized = await initialize();
  
  if (!initialized) {
    console.error('[MAIN] Failed to initialize. Exiting.');
    process.exit(1);
  }
  
  console.log('[MAIN] Starting polling loop...\n');
  
  let timeoutId: NodeJS.Timeout;
  const poll = async () => {
    await safeRunCycle();
    timeoutId = setTimeout(poll, await nextPollInterval());
  };
  await poll();
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[MAIN] Received SIGINT. Shutting down gracefully...');
    clearTimeout(timeoutId);
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('\n[MAIN] Received SIGTERM. Shutting down gracefully...');
    clearTimeout(timeoutId);
    process.exit(0);
  });
}

main().catch(console.error);

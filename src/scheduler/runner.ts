// Autonomous Runner - Main entry point for autonomous FPL decision making
import 'dotenv/config';
import { getFPLClient } from '../api/client.js';
import { getOptimizationEngine, resetOptimizationEngine } from '../engine/optimizer.js';
import { 
  buildDecisionContext, 
  findBestTransfers, 
  selectOptimalCaptain, 
  evaluateChips,
  gatherIntelligence,
  type DecisionContext 
} from './decisions.js';
import { 
  getSafetyLimits, 
  checkEmergencyStop, 
  validateTransfer, 
  validateChip, 
  resetWeeklyTransfers 
} from './limits.js';
import { 
  notify, 
  notifyTransfer, 
  notifyCaptain, 
  notifyChip, 
  notifyAlert, 
  notifySummary 
} from './notify.js';
import { logDecision, saveGameweekSnapshot } from '../db/client.js';
import type { GameweekHistory, ChipUsage } from '../api/types.js';

type RunnerPhase = 'monitor' | 'plan' | 'execute' | 'post-deadline';

interface RunnerState {
  phase: RunnerPhase;
  lastPhase: RunnerPhase;
  cycleCount: number;
  lastGWProcessed: number;
}

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MINUTES || '30') * 60 * 1000;
const PRE_DEADLINE_HOURS = parseInt(process.env.PRE_DEADLINE_HOURS || '2');

let runnerState: RunnerState = {
  phase: 'monitor',
  lastPhase: 'monitor',
  cycleCount: 0,
  lastGWProcessed: 0,
};

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
  
  // Reset and reinitialize optimizer for fresh data
  resetOptimizationEngine();
  await getOptimizationEngine();
  
  console.log('[DATA] Bootstrap and fixture data refreshed.\n');
}

async function runMonitorPhase(context: DecisionContext): Promise<void> {
  console.log('\n=== MONITOR PHASE (>24h to deadline) ===\n');
  
  // Gather intelligence on status changes
  const intelligence = await gatherIntelligence();
  
  if (intelligence.statusChanges.length > 0) {
    console.log(`[INTELLIGENCE] Found ${intelligence.statusChanges.length} player status changes:`);
    for (const change of intelligence.statusChanges) {
      console.log(`  - ${change.player.web_name}: ${change.oldStatus} -> ${change.newStatus}`);
    }
    await notifyAlert(
      'Player Status Changes',
      `${intelligence.statusChanges.length} players changed status this cycle. Check your team!`
    );
  }
  
  if (intelligence.newsAlerts.length > 0) {
    console.log('[INTELLIGENCE] News alerts:');
    for (const alert of intelligence.newsAlerts.slice(0, 5)) {
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
  
  // Find best transfers
  const transferCandidates = await findBestTransfers(context.myTeam!, 5);
  
  console.log(`[PLAN] Found ${transferCandidates.length} transfer candidates:`);
  for (const candidate of transferCandidates) {
    console.log(`  - ${candidate.playerOut.web_name} OUT -> ${candidate.playerIn.web_name} IN`);
    console.log(`    xP Gain: ${candidate.xpGain}, Net: ${candidate.netGain}, Confidence: ${(candidate.confidence * 100).toFixed(0)}%`);
    console.log(`    Reason: ${candidate.reasoning}`);
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
      'Transfer Candidates': transferCandidates.length,
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
  
  // Find best transfer
  const transferCandidates = await findBestTransfers(context.myTeam!, 3);
  const bestTransfer = transferCandidates[0];
  
  if (bestTransfer) {
    console.log(`[EXECUTE] Best transfer: ${bestTransfer.playerOut.web_name} -> ${bestTransfer.playerIn.web_name}`);
    console.log(`  xP Gain: ${bestTransfer.xpGain}, Hit Cost: ${bestTransfer.hitCost}, Net: ${bestTransfer.netGain}`);
    
    const validation = validateTransfer(
      bestTransfer.xpGain,
      bestTransfer.hitCost,
      context.freeTransfers
    );
    
    console.log(`  Validation: ${validation.allowed ? 'APPROVED' : 'BLOCKED'} - ${validation.reason}`);
    
    if (validation.allowed) {
      try {
        const client = getFPLClient();
        const result = await client.makeTransfer(
          bestTransfer.playerOut.id, 
          bestTransfer.playerIn.id, 
          context.gameweek
        );
        
        if (result.success) {
          await notifyTransfer(
            bestTransfer.playerOut,
            bestTransfer.playerIn,
            bestTransfer.xpGain,
            bestTransfer.hitCost
          );
          console.log('[EXECUTE] Transfer executed successfully!\n');
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
        action: `${bestTransfer.playerOut.web_name} -> ${bestTransfer.playerIn.web_name}`,
        reasoning: validation.reason,
        expectedPoints: bestTransfer.xpGain,
        hitsTaken: bestTransfer.hitCost > 0 ? 1 : 0,
        createdAt: new Date(),
      });
    }
  } else {
    console.log('[EXECUTE] No transfer candidates found.\n');
  }
  
  // Select and set captain
  const captainResult = await selectOptimalCaptain(context.myTeam!);
  console.log(`[EXECUTE] Captain: ${captainResult.captain.web_name} (${captainResult.xp.toFixed(1)} xP)`);
  
  // For captain, we just notify - actual captaincy must be set manually via FPL
  await notifyCaptain(
    captainResult.captain,
    captainResult.xp,
    captainResult.alternatives.map(p => p.web_name)
  );
  
  // Evaluate chips
  const chipRecommendations = await evaluateChips(context.myTeam!, context.gameweek);
  
  for (const chipRec of chipRecommendations) {
    const chipValidation = validateChip(chipRec.chip, chipRec.recommended, chipRec.confidence);
    
    console.log(`[EXECUTE] Chip ${chipRec.chip}: ${chipValidation.allowed ? 'EXECUTING' : 'BLOCKED'} - ${chipValidation.reason}`);
    
    if (chipValidation.allowed) {
      try {
        const client = getFPLClient();
        const chipApiName = chipRec.chip === 'bboost' ? 'bboost' : chipRec.chip === '3xc' ? '3xc' : chipRec.chip;
        const result = await client.playChip(
          chipApiName as 'wildcard' | 'freehit' | 'bboost' | '3xc',
          context.gameweek
        );
        
        if (result.success) {
          await notifyChip(chipRec.chip, context.gameweek, chipRec.expectedGain, true);
          console.log(`[EXECUTE] Chip ${chipRec.chip} played!\n`);
        } else {
          console.error(`[EXECUTE] Chip ${chipRec.chip} failed:`, result.message);
          await notifyAlert('Chip Failed', result.message);
        }
      } catch (error) {
        console.error(`[EXECUTE] Chip ${chipRec.chip} failed:`, error);
        await notifyAlert('Chip Failed', `Failed to play ${chipRec.chip}: ${error}`);
      }
    } else {
      await notifyChip(chipRec.chip, context.gameweek, chipRec.expectedGain, false);
    }
  }
}

async function runPostDeadline(context: DecisionContext): Promise<void> {
  console.log('\n=== POST-DEADLINE ===\n');
  
  // Check if we already processed this GW
  if (runnerState.lastGWProcessed === context.gameweek) {
    console.log('[POST] Already processed this gameweek.\n');
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
        teamValue: currentGWHistory.value,
        bank: currentGWHistory.bank,
        chipsUsed: JSON.stringify(history.chips.filter((c: ChipUsage) => c.event === context.gameweek).map((c: ChipUsage) => c.name)),
        transfersMade: currentGWHistory.event_transfers,
        transfersCost: currentGWHistory.event_transfers_cost,
        pointsOnBench: currentGWHistory.points_on_bench,
        createdAt: new Date(),
      });
      
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
    
    // Determine phase
    const deadlineInfo = (await getOptimizationEngine()).getNextDeadline();
    const hoursToDeadline = deadlineInfo?.hoursRemaining ?? context.hoursToDeadline;
    const isPostDeadline = deadlineInfo === null || hoursToDeadline < 0;
    
    const newPhase = getPhase(hoursToDeadline, isPostDeadline);
    
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

async function main(): Promise<void> {
  const initialized = await initialize();
  
  if (!initialized) {
    console.error('[MAIN] Failed to initialize. Exiting.');
    process.exit(1);
  }
  
  console.log('[MAIN] Starting polling loop...\n');
  
  // Run initial cycle
  await runCycle();
  
  // Set up polling loop
  const intervalId = setInterval(async () => {
    await runCycle();
  }, POLL_INTERVAL);
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[MAIN] Received SIGINT. Shutting down gracefully...');
    clearInterval(intervalId);
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('\n[MAIN] Received SIGTERM. Shutting down gracefully...');
    clearInterval(intervalId);
    process.exit(0);
  });
}

main().catch(console.error);

// Get Performance Tool - Review past decisions from database
import { z } from 'zod';
import { tool } from '@openai/agents';
import { getDecisions, getPerformanceStats, getRecentSnapshots, getDecisionsByType } from '../db/client.js';
import { getOptimizationEngine } from '../engine/optimizer.js';

export const getPerformanceTool = tool({
  name: 'get_performance',
  description: 'Review your FPL decision history and performance. Shows past transfers, chip usage, captain picks, and whether they were successful compared to expectations.',
  parameters: z.object({
    view: z.enum(['summary', 'transfers', 'chips', 'captains', 'all']).default('summary')
      .describe('What to view: summary stats, specific decision types, or all history'),
    gameweekFrom: z.number().default(0).describe('Start gameweek for filtering (0 = no filter)'),
    gameweekTo: z.number().default(0).describe('End gameweek for filtering (0 = no filter)'),
  }),
  execute: async ({ view, gameweekFrom, gameweekTo }) => {
    const engine = await getOptimizationEngine();
    const currentGW = engine.getCurrentGameweek();
    
    const result: Record<string, unknown> = {
      currentGameweek: currentGW,
      view,
    };
    
    if (view === 'summary' || view === 'all') {
      // Get overall performance stats
      const stats = await getPerformanceStats(gameweekFrom, gameweekTo);
      
      result.summary = {
        totalDecisionsTracked: stats.totalDecisions,
        successfulDecisions: stats.successfulDecisions,
        successRate: stats.totalDecisions > 0 
          ? `${((stats.successfulDecisions / stats.totalDecisions) * 100).toFixed(1)}%`
          : 'N/A',
        totalHitsTaken: stats.totalHitsTaken,
        hitsCost: stats.totalHitsTaken * 4,
        averagePointsGain: stats.averagePointsGain.toFixed(1),
        transferROI: stats.transferROI === Infinity 
          ? 'Perfect (no hits taken)'
          : stats.transferROI.toFixed(2),
        captainSuccessRate: `${(stats.captainSuccessRate * 100).toFixed(1)}%`,
        rankChange: stats.rankChange > 0 
          ? `+${stats.rankChange.toLocaleString()} (improved)`
          : stats.rankChange < 0
          ? `${stats.rankChange.toLocaleString()} (dropped)`
          : 'No change',
      };
      
      // Get recent snapshots for trend
      const snapshots = await getRecentSnapshots(10);
      if (snapshots.length > 1) {
        const latest = snapshots[0];
        const oldest = snapshots[snapshots.length - 1];
        
        result.trend = {
          fromGW: oldest.gameweek,
          toGW: latest.gameweek,
          pointsGained: (latest.totalPoints || 0) - (oldest.totalPoints || 0),
          rankChange: (oldest.overallRank || 0) - (latest.overallRank || 0),
          avgPointsPerGW: snapshots.reduce((sum, s) => sum + (s.gameweekPoints || 0), 0) / snapshots.length,
        };
      }
    }
    
    if (view === 'transfers' || view === 'all') {
      const transfers = await getDecisionsByType('transfer');
      
      result.transfers = transfers.map(t => {
        const action = JSON.parse(t.action);
        const success = t.actualPoints !== null && t.expectedPoints !== null 
          ? t.actualPoints > t.expectedPoints 
          : null;
        
        return {
          gameweek: t.gameweek,
          action: `${action.playerOut} → ${action.playerIn}`,
          expectedPoints: t.expectedPoints,
          actualPoints: t.actualPoints,
          outcome: success === null ? 'Pending' : success ? 'Success' : 'Underperformed',
          hitTaken: t.hitsTaken && t.hitsTaken > 0,
          reasoning: t.reasoning,
        };
      });
      
      // Calculate transfer success rate
      const completedTransfers = transfers.filter(t => t.actualPoints !== null);
      const successfulTransfers = completedTransfers.filter(t => 
        t.actualPoints !== null && t.expectedPoints !== null && t.actualPoints > t.expectedPoints
      );
      
      result.transferStats = {
        total: transfers.length,
        completed: completedTransfers.length,
        successful: successfulTransfers.length,
        successRate: completedTransfers.length > 0
          ? `${((successfulTransfers.length / completedTransfers.length) * 100).toFixed(1)}%`
          : 'N/A',
      };
    }
    
    if (view === 'chips' || view === 'all') {
      const chips = await getDecisionsByType('chip');
      
      result.chips = chips.map(c => {
        const action = JSON.parse(c.action);
        return {
          gameweek: c.gameweek,
          chip: action.chip,
          expectedGain: c.expectedPoints,
          actualGain: c.actualPoints,
          outcome: c.actualPoints !== null && c.expectedPoints !== null
            ? c.actualPoints >= c.expectedPoints ? 'Good timing' : 'Could be better'
            : 'Pending',
          reasoning: c.reasoning,
        };
      });
    }
    
    if (view === 'captains' || view === 'all') {
      const captains = await getDecisionsByType('captain');
      
      result.captains = captains.map(c => {
        const action = JSON.parse(c.action);
        return {
          gameweek: c.gameweek,
          captain: action.captain,
          expectedPoints: c.expectedPoints,
          actualPoints: c.actualPoints,
          doubled: c.actualPoints !== null ? (c.actualPoints as number) * 2 : null,
          outcome: c.actualPoints !== null && c.expectedPoints !== null
            ? c.actualPoints >= c.expectedPoints ? 'Hit target' : 'Below target'
            : 'Pending',
        };
      });
    }
    
    // Add insights based on data
    const allDecisions = await getDecisions();
    if (allDecisions.length === 0) {
      result.note = 'No decisions tracked yet. Decisions are logged when you make transfers or play chips through this agent.';
    }
    
    return result;
  },
});

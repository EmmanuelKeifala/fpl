// Gameweek Sync - Automatically sync GW data to database
import { getFPLClient } from '../api/client.js';
import { saveGameweekSnapshot, getGameweekSnapshot } from '../db/client.js';
import { getOptimizationEngine } from '../engine/optimizer.js';
import type { NewGameweekSnapshot } from '../db/schema.js';

/**
 * Sync current gameweek data to database for performance tracking
 */
export async function syncGameweekData(managerId?: number): Promise<{
  synced: boolean;
  gameweek: number;
  message: string;
}> {
  const client = getFPLClient();
  const engine = await getOptimizationEngine();
  const currentGW = engine.getCurrentGameweek();
  
  // Use provided manager ID or get from client
  const mgrId = managerId || client.getManagerId();
  
  if (!mgrId) {
    return {
      synced: false,
      gameweek: currentGW,
      message: 'Manager ID required to sync gameweek data',
    };
  }
  
  try {
    // Check if we already have this GW snapshot
    const existingSnapshot = await getGameweekSnapshot(currentGW);
    
    // Get current data
    const entry = await client.getEntry(mgrId);
    const history = await client.getEntryHistory(mgrId);
    const picks = await client.getEntryPicks(mgrId, currentGW);
    
    // Find current GW in history
    const gwHistory = history.current.find(h => h.event === currentGW);
    
    if (!gwHistory) {
      return {
        synced: false,
        gameweek: currentGW,
        message: `No history data available for GW${currentGW} yet`,
      };
    }
    
    // Find captain and their points
    const captainPick = picks.picks.find(p => p.is_captain);
    const captainPlayer = captainPick ? engine.getPlayer(captainPick.element) : null;
    
    // Get chips used this GW
    const chipsUsed = history.chips
      .filter(c => c.event === currentGW)
      .map(c => c.name);
    
    const snapshot: NewGameweekSnapshot = {
      gameweek: currentGW,
      totalPoints: entry.summary_overall_points,
      overallRank: entry.summary_overall_rank,
      gameweekPoints: gwHistory.points,
      gameweekRank: gwHistory.rank,
      teamValue: gwHistory.value / 10,
      bank: gwHistory.bank / 10,
      chipsUsed: JSON.stringify(chipsUsed),
      transfersMade: gwHistory.event_transfers,
      transfersCost: gwHistory.event_transfers_cost,
      pointsOnBench: gwHistory.points_on_bench,
      captainId: captainPick?.element || null,
      captainPoints: captainPlayer?.event_points || null,
    };
    
    await saveGameweekSnapshot(snapshot);
    
    const isUpdate = existingSnapshot !== undefined;
    
    return {
      synced: true,
      gameweek: currentGW,
      message: isUpdate 
        ? `Updated GW${currentGW} snapshot: ${gwHistory.points} pts, rank ${entry.summary_overall_rank?.toLocaleString()}`
        : `Saved GW${currentGW} snapshot: ${gwHistory.points} pts, rank ${entry.summary_overall_rank?.toLocaleString()}`,
    };
  } catch (error) {
    return {
      synced: false,
      gameweek: currentGW,
      message: `Failed to sync: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Sync all available gameweeks to database
 */
export async function syncAllGameweeks(managerId?: number): Promise<{
  synced: number;
  failed: number;
  message: string;
}> {
  const client = getFPLClient();
  const engine = await getOptimizationEngine();
  const currentGW = engine.getCurrentGameweek();
  
  const mgrId = managerId || client.getManagerId();
  
  if (!mgrId) {
    return {
      synced: 0,
      failed: 0,
      message: 'Manager ID required',
    };
  }
  
  let synced = 0;
  let failed = 0;
  
  try {
    const history = await client.getEntryHistory(mgrId);
    
    for (const gwHistory of history.current) {
      try {
        const picks = await client.getEntryPicks(mgrId, gwHistory.event);
        const captainPick = picks.picks.find(p => p.is_captain);
        
        const chipsUsed = history.chips
          .filter(c => c.event === gwHistory.event)
          .map(c => c.name);
        
        const snapshot: NewGameweekSnapshot = {
          gameweek: gwHistory.event,
          totalPoints: gwHistory.total_points,
          overallRank: gwHistory.overall_rank,
          gameweekPoints: gwHistory.points,
          gameweekRank: gwHistory.rank,
          teamValue: gwHistory.value / 10,
          bank: gwHistory.bank / 10,
          chipsUsed: JSON.stringify(chipsUsed),
          transfersMade: gwHistory.event_transfers,
          transfersCost: gwHistory.event_transfers_cost,
          pointsOnBench: gwHistory.points_on_bench,
          captainId: captainPick?.element || null,
          captainPoints: null, // Would need live data
        };
        
        await saveGameweekSnapshot(snapshot);
        synced++;
      } catch {
        failed++;
      }
    }
    
    return {
      synced,
      failed,
      message: `Synced ${synced} gameweeks${failed > 0 ? `, ${failed} failed` : ''}`,
    };
  } catch (error) {
    return {
      synced,
      failed,
      message: `Sync error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

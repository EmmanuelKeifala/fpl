// Get My Team Tool - View current squad with xP projections
import { z } from 'zod';
import { tool } from '@openai/agents';
import { getFPLClient } from '../api/client.js';
import { getOptimizationEngine } from '../engine/optimizer.js';

export const getMyTeamTool = tool({
  name: 'get_my_team',
  description: 'Get your current FPL squad with player details, expected points (xP), captain, vice-captain, bench order, available chips, and transfer status.',
  parameters: z.object({}),
  execute: async () => {
    const client = getFPLClient();
    const engine = await getOptimizationEngine();
    
    if (!client.isAuthenticated()) {
      // Try to get public team info if manager ID is set
      const managerId = client.getManagerId();
      if (!managerId) {
        return {
          error: 'Not authenticated. Please provide your FPL credentials to view your team.',
        };
      }
      
      // Get picks from public endpoint
      const currentGW = engine.getCurrentGameweek();
      try {
        const picks = await client.getEntryPicks(managerId, currentGW);
        const entry = await client.getEntry(managerId);
        const history = await client.getEntryHistory(managerId);
        
        // Build team data
        const teamData = picks.picks.map(pick => {
          const player = engine.getPlayer(pick.element);
          const team = player ? engine.getTeam(player.team) : undefined;
          const xp = player ? engine.calculateExpectedPoints(player.id, 1) : null;
          
          return {
            position: pick.position,
            name: player?.web_name || 'Unknown',
            team: team?.short_name || 'UNK',
            pos: player ? ['GKP', 'DEF', 'MID', 'FWD'][player.element_type - 1] : 'UNK',
            price: player ? (player.now_cost / 10).toFixed(1) : '0.0',
            form: player?.form || '0.0',
            totalPoints: player?.total_points || 0,
            xpNextGW: xp?.nextGW || 0,
            isCaptain: pick.is_captain,
            isViceCaptain: pick.is_vice_captain,
            isBenched: pick.position > 11,
            multiplier: pick.multiplier,
          };
        });
        
        // Separate starting XI and bench
        const startingXI = teamData.filter(p => !p.isBenched);
        const bench = teamData.filter(p => p.isBenched);
        
        // Get chip usage
        const chipsUsed = history.chips.map(c => ({
          name: c.name,
          gameweek: c.event,
        }));
        
        // Calculate team totals
        const totalXP = startingXI.reduce((sum, p) => {
          const mult = p.isCaptain ? 2 : 1;
          return sum + (p.xpNextGW * mult);
        }, 0);
        
        return {
          manager: {
            name: entry.name,
            teamName: entry.player_first_name + ' ' + entry.player_last_name,
            overallPoints: entry.summary_overall_points,
            overallRank: entry.summary_overall_rank,
            gameweekPoints: entry.summary_event_points,
            gameweekRank: entry.summary_event_rank,
            bank: (history.current[history.current.length - 1]?.bank || 0) / 10,
            teamValue: (history.current[history.current.length - 1]?.value || 0) / 10,
          },
          currentGameweek: currentGW,
          startingXI,
          bench,
          captain: startingXI.find(p => p.isCaptain)?.name || 'None',
          viceCaptain: startingXI.find(p => p.isViceCaptain)?.name || 'None',
          expectedPoints: Math.round(totalXP * 10) / 10,
          chipsUsed,
          transfers: {
            made: picks.entry_history.event_transfers,
            cost: picks.entry_history.event_transfers_cost,
          },
        };
      } catch (error) {
        return {
          error: `Failed to fetch team: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
      }
    }
    
    // Authenticated path - use my-team endpoint
    try {
      const myTeam = await client.getMyTeam();
      const managerId = client.getManagerId()!;
      const entry = await client.getEntry(managerId);
      const history = await client.getEntryHistory(managerId);
      const currentGW = engine.getCurrentGameweek();
      
      // Build team data with xP
      const teamData = myTeam.picks.map(pick => {
        const player = engine.getPlayer(pick.element);
        const team = player ? engine.getTeam(player.team) : undefined;
        const xp = player ? engine.calculateExpectedPoints(player.id, 1) : null;
        
        return {
          position: pick.position,
          name: player?.web_name || 'Unknown',
          team: team?.short_name || 'UNK',
          pos: player ? ['GKP', 'DEF', 'MID', 'FWD'][player.element_type - 1] : 'UNK',
          price: player ? (player.now_cost / 10).toFixed(1) : '0.0',
          form: player?.form || '0.0',
          totalPoints: player?.total_points || 0,
          xpNextGW: xp?.nextGW || 0,
          xpNext5GW: xp?.next5GW || 0,
          isCaptain: pick.is_captain,
          isViceCaptain: pick.is_vice_captain,
          isBenched: pick.position > 11,
          multiplier: pick.multiplier,
        };
      });
      
      const startingXI = teamData.filter(p => !p.isBenched);
      const bench = teamData.filter(p => p.isBenched);
      
      // Available chips
      const availableChips = myTeam.chips
        .filter(c => c.status_for_entry === 'available')
        .map(c => c.name);
      
      const usedChips = myTeam.chips
        .filter(c => c.status_for_entry === 'played')
        .map(c => ({
          name: c.name,
          gameweeks: c.played_by_entry,
        }));
      
      const totalXP = startingXI.reduce((sum, p) => {
        const mult = p.isCaptain ? 2 : 1;
        return sum + (p.xpNextGW * mult);
      }, 0);
      
      return {
        manager: {
          name: entry.name,
          overallPoints: entry.summary_overall_points,
          overallRank: entry.summary_overall_rank?.toLocaleString(),
          gameweekPoints: entry.summary_event_points,
          bank: (myTeam.transfers.bank / 10).toFixed(1),
          teamValue: (myTeam.transfers.value / 10).toFixed(1),
        },
        currentGameweek: currentGW,
        startingXI,
        bench,
        captain: startingXI.find(p => p.isCaptain)?.name || 'None',
        viceCaptain: startingXI.find(p => p.isViceCaptain)?.name || 'None',
        expectedPoints: Math.round(totalXP * 10) / 10,
        transfers: {
          freeTransfers: myTeam.transfers.limit - myTeam.transfers.made,
          madeThisGW: myTeam.transfers.made,
          costThisGW: myTeam.transfers.cost,
        },
        availableChips,
        usedChips,
      };
    } catch (error) {
      // Authenticated endpoint failed - fallback to public endpoint
      const managerId = client.getManagerId();
      if (!managerId) {
        return {
          error: `Failed to fetch team: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
      }
      
      try {
        const currentGW = engine.getCurrentGameweek();
        const picks = await client.getEntryPicks(managerId, currentGW);
        const entry = await client.getEntry(managerId);
        const history = await client.getEntryHistory(managerId);
        
        const teamData = picks.picks.map(pick => {
          const player = engine.getPlayer(pick.element);
          const team = player ? engine.getTeam(player.team) : undefined;
          const xp = player ? engine.calculateExpectedPoints(player.id, 1) : null;
          
          return {
            position: pick.position,
            name: player?.web_name || 'Unknown',
            team: team?.short_name || 'UNK',
            pos: player ? ['GKP', 'DEF', 'MID', 'FWD'][player.element_type - 1] : 'UNK',
            price: player ? (player.now_cost / 10).toFixed(1) : '0.0',
            form: player?.form || '0.0',
            totalPoints: player?.total_points || 0,
            xpNextGW: xp?.nextGW || 0,
            isCaptain: pick.is_captain,
            isViceCaptain: pick.is_vice_captain,
            isBenched: pick.position > 11,
            multiplier: pick.multiplier,
          };
        });
        
        const startingXI = teamData.filter(p => !p.isBenched);
        const bench = teamData.filter(p => p.isBenched);
        
        const chipsUsed = history.chips.map(c => ({
          name: c.name,
          gameweek: c.event,
        }));
        
        const totalXP = startingXI.reduce((sum, p) => {
          const mult = p.isCaptain ? 2 : 1;
          return sum + (p.xpNextGW * mult);
        }, 0);
        
        return {
          manager: {
            name: entry.name,
            teamName: entry.player_first_name + ' ' + entry.player_last_name,
            overallPoints: entry.summary_overall_points,
            overallRank: entry.summary_overall_rank,
            gameweekPoints: entry.summary_event_points,
            gameweekRank: entry.summary_event_rank,
            bank: (history.current[history.current.length - 1]?.bank || 0) / 10,
            teamValue: (history.current[history.current.length - 1]?.value || 0) / 10,
          },
          currentGameweek: currentGW,
          startingXI,
          bench,
          captain: startingXI.find(p => p.isCaptain)?.name || 'None',
          viceCaptain: startingXI.find(p => p.isViceCaptain)?.name || 'None',
          expectedPoints: Math.round(totalXP * 10) / 10,
          chipsUsed,
          transfers: {
            made: picks.entry_history.event_transfers,
            cost: picks.entry_history.event_transfers_cost,
          },
        };
      } catch (fallbackError) {
        return {
          error: `Failed to fetch team: ${fallbackError instanceof Error ? fallbackError.message : 'Unknown error'}`,
        };
      }
    }
  },
});

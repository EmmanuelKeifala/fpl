// Get League Standings Tool
import { z } from 'zod';
import { tool } from '@openai/agents';
import { getFPLClient } from '../api/client.js';

export const getLeagueTool = tool({
  name: 'get_league_standings',
  description: 'Get standings for your mini-leagues. Shows your position, rivals, and points gaps.',
  parameters: z.object({
    leagueId: z.number().default(0).describe('Specific league ID to query. Use 0 to see all your leagues.'),
    showRivals: z.number().default(5).describe('Number of rivals above and below you to show'),
  }),
  execute: async ({ leagueId, showRivals }) => {
    const client = getFPLClient();
    const managerId = client.getManagerId();
    
    if (!managerId) {
      return {
        error: 'Manager ID required. Please provide your FPL manager ID in environment variables.',
      };
    }
    
    try {
      const entry = await client.getEntry(managerId);
      
      // If specific league requested
      if (leagueId) {
        const standings = await client.getClassicLeague(leagueId);
        
        // Find user's position
        const userStanding = standings.standings.results.find(s => s.entry === managerId);
        const userRank = userStanding?.rank || 0;
        
        // Get rivals around user
        const allStandings = standings.standings.results;
        const userIndex = allStandings.findIndex(s => s.entry === managerId);
        
        const startIndex = Math.max(0, userIndex - showRivals);
        const endIndex = Math.min(allStandings.length, userIndex + showRivals + 1);
        const nearbyRivals = allStandings.slice(startIndex, endIndex);
        
        return {
          league: {
            id: standings.league.id,
            name: standings.league.name,
            totalManagers: standings.standings.results.length,
          },
          yourPosition: {
            rank: userStanding?.rank || 'Not found',
            points: userStanding?.total || 0,
            gameweekPoints: userStanding?.event_total || 0,
            teamName: userStanding?.entry_name || entry.name,
          },
          standings: nearbyRivals.map(s => ({
            rank: s.rank,
            movement: s.last_rank > 0 ? s.last_rank - s.rank : 0,
            teamName: s.entry_name,
            managerName: s.player_name,
            totalPoints: s.total,
            gameweekPoints: s.event_total,
            isYou: s.entry === managerId,
            gapToYou: userStanding ? s.total - userStanding.total : 0,
          })),
        };
      }
      
      // List all leagues
      const classicLeagues = entry.leagues.classic
        .filter(l => l.league_type !== 's') // Exclude system leagues
        .slice(0, 10) // Limit to 10 leagues
        .map(l => ({
          id: l.id,
          name: l.name,
          yourRank: l.entry_rank,
          lastRank: l.entry_last_rank,
          movement: l.entry_last_rank > 0 ? l.entry_last_rank - l.entry_rank : 0,
          totalManagers: l.rank_count || 'Unknown',
        }));
      
      const h2hLeagues = entry.leagues.h2h.map(l => ({
        id: l.id,
        name: l.name,
        yourRank: l.entry_rank,
        type: 'Head-to-Head',
      }));
      
      return {
        manager: {
          name: entry.name,
          overallRank: entry.summary_overall_rank?.toLocaleString(),
          totalPoints: entry.summary_overall_points,
        },
        classicLeagues,
        h2hLeagues,
        tip: 'Use the leagueId parameter to see detailed standings for a specific league.',
      };
    } catch (error) {
      return {
        error: `Failed to fetch league data: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
});

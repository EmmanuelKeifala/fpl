// Get Fixtures Tool - FDR analysis, DGWs, BGWs
import { z } from 'zod';
import { tool } from '@openai/agents';
import { getFPLClient } from '../api/client.js';
import { getOptimizationEngine } from '../engine/optimizer.js';

export const getFixturesTool = tool({
  name: 'get_fixtures',
  description: 'Get upcoming fixtures for a team or all teams with fixture difficulty ratings (FDR). Identifies Double Gameweeks (DGW) and Blank Gameweeks (BGW).',
  parameters: z.object({
    teamOrPlayer: z.string().default('').describe('Team name (e.g., "Arsenal") or player name to get their team fixtures. Leave empty for all teams.'),
    gameweeks: z.number().default(5).describe('Number of gameweeks to show (default 5)'),
  }),
  execute: async ({ teamOrPlayer, gameweeks }) => {
    const client = getFPLClient();
    const engine = await getOptimizationEngine();
    const fixtures = await client.getFixtures();
    const currentGW = engine.getCurrentGameweek();
    
    // Find target team if specified
    let targetTeamId: number | undefined;
    if (teamOrPlayer) {
      // Try to find as player first
      const player = engine.findPlayerByName(teamOrPlayer);
      if (player) {
        targetTeamId = player.team;
      } else {
        // Try to find as team
        for (let i = 1; i <= 20; i++) {
          const team = engine.getTeam(i);
          if (team && (
            team.name.toLowerCase().includes(teamOrPlayer.toLowerCase()) ||
            team.short_name.toLowerCase() === teamOrPlayer.toLowerCase()
          )) {
            targetTeamId = team.id;
            break;
          }
        }
      }
      
      if (!targetTeamId) {
        return {
          error: `Could not find team or player "${teamOrPlayer}".`,
          hint: 'Try using the team short name (e.g., "ARS", "MCI") or player name.',
        };
      }
    }
    
    // Get upcoming GWs
    const upcomingGWs = Array.from({ length: gameweeks }, (_, i) => currentGW + i);
    
    // Analyze fixtures per gameweek
    const gwAnalysis = upcomingGWs.map(gw => {
      const gwFixtures = fixtures.filter(f => f.event === gw);
      
      // Count fixtures per team to detect DGW
      const teamFixtureCounts = new Map<number, number>();
      gwFixtures.forEach(f => {
        teamFixtureCounts.set(f.team_h, (teamFixtureCounts.get(f.team_h) || 0) + 1);
        teamFixtureCounts.set(f.team_a, (teamFixtureCounts.get(f.team_a) || 0) + 1);
      });
      
      const dgwTeams = Array.from(teamFixtureCounts.entries())
        .filter(([_, count]) => count >= 2)
        .map(([teamId]) => engine.getTeam(teamId)?.short_name || 'UNK');
      
      // Teams with no fixtures (BGW)
      const allTeamIds = Array.from({ length: 20 }, (_, i) => i + 1);
      const playingTeamIds = new Set([
        ...gwFixtures.map(f => f.team_h),
        ...gwFixtures.map(f => f.team_a),
      ]);
      const bgwTeams = allTeamIds
        .filter(id => !playingTeamIds.has(id))
        .map(id => engine.getTeam(id)?.short_name || 'UNK');
      
      return {
        gameweek: gw,
        fixtureCount: gwFixtures.length,
        isDGW: dgwTeams.length > 0,
        dgwTeams,
        isBGW: bgwTeams.length > 0,
        bgwTeams,
      };
    });
    
    // If target team, get their specific fixtures
    if (targetTeamId) {
      const team = engine.getTeam(targetTeamId);
      const teamFixtures = fixtures
        .filter(f => 
          f.event !== null &&
          f.event >= currentGW &&
          f.event < currentGW + gameweeks &&
          (f.team_h === targetTeamId || f.team_a === targetTeamId)
        )
        .sort((a, b) => (a.event || 0) - (b.event || 0))
        .map(f => {
          const isHome = f.team_h === targetTeamId;
          const opponent = engine.getTeam(isHome ? f.team_a : f.team_h);
          const fdr = isHome ? f.team_a_difficulty : f.team_h_difficulty;
          
          return {
            gameweek: f.event,
            opponent: opponent?.short_name || 'UNK',
            opponentFull: opponent?.name || 'Unknown',
            venue: isHome ? 'Home' : 'Away',
            fdr,
            fdrLabel: ['', 'Very Easy', 'Easy', 'Medium', 'Hard', 'Very Hard'][fdr],
            kickoff: f.kickoff_time,
          };
        });
      
      // Calculate average FDR
      const avgFDR = teamFixtures.length > 0
        ? teamFixtures.reduce((sum, f) => sum + f.fdr, 0) / teamFixtures.length
        : 3;
      
      return {
        team: team?.name || 'Unknown',
        teamShort: team?.short_name || 'UNK',
        currentGameweek: currentGW,
        fixtures: teamFixtures,
        averageFDR: avgFDR.toFixed(2),
        fixtureRating: avgFDR <= 2 ? 'Excellent' : avgFDR <= 2.5 ? 'Good' : avgFDR <= 3 ? 'Average' : avgFDR <= 3.5 ? 'Tough' : 'Very Tough',
        gwAnalysis: gwAnalysis.filter(gw => 
          teamFixtures.some(f => f.gameweek === gw.gameweek)
        ),
      };
    }
    
    // Return all team fixtures summary
    const allTeamFixtures = Array.from({ length: 20 }, (_, i) => {
      const teamId = i + 1;
      const team = engine.getTeam(teamId);
      
      const teamFix = fixtures
        .filter(f => 
          f.event !== null &&
          f.event >= currentGW &&
          f.event < currentGW + gameweeks &&
          (f.team_h === teamId || f.team_a === teamId)
        )
        .sort((a, b) => (a.event || 0) - (b.event || 0));
      
      const fdrValues = teamFix.map(f => {
        const isHome = f.team_h === teamId;
        return isHome ? f.team_a_difficulty : f.team_h_difficulty;
      });
      
      const avgFDR = fdrValues.length > 0
        ? fdrValues.reduce((a, b) => a + b, 0) / fdrValues.length
        : 3;
      
      return {
        team: team?.short_name || 'UNK',
        fixtureCount: teamFix.length,
        averageFDR: avgFDR.toFixed(2),
        fixtures: teamFix.slice(0, 5).map(f => {
          const isHome = f.team_h === teamId;
          const opponent = engine.getTeam(isHome ? f.team_a : f.team_h);
          const fdr = isHome ? f.team_a_difficulty : f.team_h_difficulty;
          return `${opponent?.short_name || '?'}(${isHome ? 'H' : 'A'})[${fdr}]`;
        }).join(', '),
      };
    }).sort((a, b) => parseFloat(a.averageFDR) - parseFloat(b.averageFDR));
    
    return {
      currentGameweek: currentGW,
      gameweeksAnalyzed: gameweeks,
      gwAnalysis,
      teamFixtures: allTeamFixtures,
      bestFixtures: allTeamFixtures.slice(0, 5).map(t => t.team),
      worstFixtures: allTeamFixtures.slice(-5).map(t => t.team),
    };
  },
});

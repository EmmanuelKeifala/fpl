// Get Player Stats Tool - Detailed player analysis with xP
import { z } from 'zod';
import { tool } from '@openai/agents';
import { getFPLClient } from '../api/client.js';
import { getOptimizationEngine } from '../engine/optimizer.js';

export const getPlayerStatsTool = tool({
  name: 'get_player_stats',
  description: 'Get detailed stats for a player including form, upcoming fixtures, ownership, expected points (xP), and historical performance.',
  parameters: z.object({
    playerName: z.string().describe('Player name to search for (e.g., "Salah", "Haaland")'),
  }),
  execute: async ({ playerName }) => {
    const client = getFPLClient();
    const engine = await getOptimizationEngine();
    
    // Find player
    const player = engine.findPlayerByName(playerName);
    if (!player) {
      // Try to find similar players
      const allPlayers = Array.from({ length: 800 }, (_, i) => engine.getPlayer(i + 1))
        .filter(p => p !== undefined);
      
      const suggestions = allPlayers
        .filter(p => 
          p!.web_name.toLowerCase().includes(playerName.toLowerCase().slice(0, 3)) ||
          p!.second_name.toLowerCase().includes(playerName.toLowerCase().slice(0, 3))
        )
        .slice(0, 5)
        .map(p => p!.web_name);
      
      return {
        error: `Player "${playerName}" not found.`,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
      };
    }
    
    const team = engine.getTeam(player.team);
    const xp = engine.calculateExpectedPoints(player.id, 5);
    
    // Get fixtures for this player's team
    const fixtures = await client.getFixtures();
    const currentGW = engine.getCurrentGameweek();
    
    const upcomingFixtures = fixtures
      .filter(f => 
        f.event !== null &&
        f.event >= currentGW &&
        (f.team_h === player.team || f.team_a === player.team)
      )
      .sort((a, b) => (a.event || 0) - (b.event || 0))
      .slice(0, 5)
      .map(f => {
        const isHome = f.team_h === player.team;
        const opponent = engine.getTeam(isHome ? f.team_a : f.team_h);
        const fdr = isHome ? f.team_a_difficulty : f.team_h_difficulty;
        
        return {
          gameweek: f.event,
          opponent: opponent?.short_name || 'UNK',
          venue: isHome ? 'H' : 'A',
          fdr,
          fdrLabel: ['', 'Very Easy', 'Easy', 'Medium', 'Hard', 'Very Hard'][fdr] || 'Unknown',
        };
      });
    
    // Determine position
    const positionNames = ['', 'Goalkeeper', 'Defender', 'Midfielder', 'Forward'];
    const positionShort = ['', 'GKP', 'DEF', 'MID', 'FWD'];
    
    // Calculate value metrics
    const priceInM = player.now_cost / 10;
    const pointsPerMillion = player.total_points / priceInM;
    
    // Status info
    let statusText = 'Available';
    if (player.status === 'i') statusText = 'Injured';
    else if (player.status === 'd') statusText = 'Doubtful';
    else if (player.status === 's') statusText = 'Suspended';
    else if (player.status === 'u') statusText = 'Unavailable';
    
    return {
      player: {
        name: player.web_name,
        fullName: `${player.first_name} ${player.second_name}`,
        team: team?.name || 'Unknown',
        position: positionNames[player.element_type],
        positionShort: positionShort[player.element_type],
        price: `£${priceInM.toFixed(1)}m`,
        priceChange: player.cost_change_event !== 0 
          ? `${player.cost_change_event > 0 ? '+' : ''}£${(player.cost_change_event / 10).toFixed(1)}m this GW`
          : 'No change',
        status: statusText,
        news: player.news || 'No news',
        chanceOfPlaying: player.chance_of_playing_next_round !== null 
          ? `${player.chance_of_playing_next_round}%`
          : 'Unknown',
      },
      season: {
        totalPoints: player.total_points,
        pointsPerGame: player.points_per_game,
        form: player.form,
        ictIndex: player.ict_index,
        minutes: player.minutes,
        starts: player.starts,
        goals: player.goals_scored,
        assists: player.assists,
        cleanSheets: player.clean_sheets,
        bonus: player.bonus,
        yellowCards: player.yellow_cards,
        redCards: player.red_cards,
      },
      ownership: {
        selectedBy: `${player.selected_by_percent}%`,
        transfersInGW: player.transfers_in_event.toLocaleString(),
        transfersOutGW: player.transfers_out_event.toLocaleString(),
        netTransfers: (player.transfers_in_event - player.transfers_out_event).toLocaleString(),
      },
      expected: {
        xG: player.expected_goals,
        xA: player.expected_assists,
        xGI: player.expected_goal_involvements,
        xGC: player.expected_goals_conceded,
      },
      value: {
        pointsPerMillion: pointsPerMillion.toFixed(1),
        valueForm: player.value_form,
        valueSeason: player.value_season,
      },
      setpieces: {
        penalties: player.penalties_order === 1 ? 'Yes (1st choice)' : 
                   player.penalties_order ? `${player.penalties_order}nd choice` : 'No',
        corners: player.corners_and_indirect_freekicks_order === 1 ? 'Yes' : 'No',
        freeKicks: player.direct_freekicks_order === 1 ? 'Yes' : 'No',
      },
      expectedPoints: {
        nextGW: xp.nextGW,
        next5GW: xp.next5GW,
        confidence: `${(xp.confidence * 100).toFixed(0)}%`,
        breakdown: xp.breakdown,
      },
      upcomingFixtures,
    };
  },
});

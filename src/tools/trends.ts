// Get Transfer Trends Tool - Price changes, popular picks
import { z } from 'zod';
import { tool } from '@openai/agents';
import { getOptimizationEngine } from '../engine/optimizer.js';

export const getTrendsTool = tool({
  name: 'get_transfer_trends',
  description: 'Get trending transfers including price risers/fallers, most transferred in/out players, and template picks.',
  parameters: z.object({
    category: z.enum([
      'price_risers',
      'price_fallers', 
      'most_transferred_in',
      'most_transferred_out',
      'template',
      'all'
    ]).describe('Category of trends to fetch'),
    count: z.number().default(10).describe('Number of players to show (default 10)'),
  }),
  execute: async ({ category, count }) => {
    const engine = await getOptimizationEngine();
    const results: Record<string, unknown> = {};
    
    const formatPlayer = (p: ReturnType<typeof engine.getPlayer>) => {
      if (!p) return null;
      const team = engine.getTeam(p.team);
      const xp = engine.calculateExpectedPoints(p.id, 5);
      return {
        name: p.web_name,
        team: team?.short_name || 'UNK',
        position: ['', 'GKP', 'DEF', 'MID', 'FWD'][p.element_type],
        price: `£${(p.now_cost / 10).toFixed(1)}m`,
        form: p.form,
        totalPoints: p.total_points,
        xpNext5GW: xp.next5GW,
        ownership: `${p.selected_by_percent}%`,
      };
    };
    
    if (category === 'price_risers' || category === 'all') {
      const risers = engine.getPriceRisers(count);
      results.priceRisers = risers.map(p => ({
        ...formatPlayer(p),
        priceChange: `+£${(p.cost_change_event / 10).toFixed(1)}m`,
        netTransferGW: (p.transfers_in_event - p.transfers_out_event).toLocaleString(),
      }));
    }
    
    if (category === 'price_fallers' || category === 'all') {
      const fallers = engine.getPriceFallers(count);
      results.priceFallers = fallers.map(p => ({
        ...formatPlayer(p),
        priceChange: `£${(p.cost_change_event / 10).toFixed(1)}m`,
        netTransferGW: (p.transfers_in_event - p.transfers_out_event).toLocaleString(),
      }));
    }
    
    if (category === 'most_transferred_in' || category === 'all') {
      const transfersIn = engine.getTrendingTransfersIn(count);
      results.mostTransferredIn = transfersIn.map(p => ({
        ...formatPlayer(p),
        transfersIn: p.transfers_in_event.toLocaleString(),
      }));
    }
    
    if (category === 'most_transferred_out' || category === 'all') {
      const transfersOut = engine.getTrendingTransfersOut(count);
      results.mostTransferredOut = transfersOut.map(p => ({
        ...formatPlayer(p),
        transfersOut: p.transfers_out_event.toLocaleString(),
        news: p.news || 'No news',
      }));
    }
    
    if (category === 'template' || category === 'all') {
      // Template = most owned players by position
      const topGK = engine.getTopPlayersByPosition(1, 2);
      const topDEF = engine.getTopPlayersByPosition(2, 5);
      const topMID = engine.getTopPlayersByPosition(3, 5);
      const topFWD = engine.getTopPlayersByPosition(4, 3);
      
      results.template = {
        description: 'Most popular template picks by position',
        goalkeepers: topGK.map(p => formatPlayer(p)),
        defenders: topDEF.map(p => formatPlayer(p)),
        midfielders: topMID.map(p => formatPlayer(p)),
        forwards: topFWD.map(p => formatPlayer(p)),
      };
    }
    
    return {
      currentGameweek: engine.getCurrentGameweek(),
      category,
      ...results,
    };
  },
});

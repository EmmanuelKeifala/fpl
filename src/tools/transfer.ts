// Make Transfer Tool - Execute transfers with ROI validation
import { z } from 'zod';
import { tool } from '@openai/agents';
import { getFPLClient } from '../api/client.js';
import { getOptimizationEngine } from '../engine/optimizer.js';
import { logDecision } from '../db/client.js';

export const makeTransferTool = tool({
  name: 'make_transfer',
  description: 'Evaluate and execute a transfer. Shows expected points gain, hit cost analysis, and requires confirmation before executing. Uses game theory to validate the transfer is worthwhile.',
  parameters: z.object({
    playerOut: z.string().describe('Name of player to sell'),
    playerIn: z.string().describe('Name of player to buy'),
    confirm: z.boolean().default(false).describe('Set to true to execute the transfer. First call without confirm to see analysis.'),
  }),
  execute: async ({ playerOut, playerIn, confirm }) => {
    const client = getFPLClient();
    const engine = await getOptimizationEngine();
    
    // Find players
    const outPlayer = engine.findPlayerByName(playerOut);
    const inPlayer = engine.findPlayerByName(playerIn);
    
    if (!outPlayer) {
      return {
        error: `Could not find player "${playerOut}" to sell.`,
        hint: 'Check the spelling or use the player web name.',
      };
    }
    
    if (!inPlayer) {
      return {
        error: `Could not find player "${playerIn}" to buy.`,
        hint: 'Check the spelling or use the player web name.',
      };
    }
    
    // Check same position
    if (outPlayer.element_type !== inPlayer.element_type) {
      return {
        error: 'Players must be in the same position.',
        playerOut: {
          name: outPlayer.web_name,
          position: ['', 'GKP', 'DEF', 'MID', 'FWD'][outPlayer.element_type],
        },
        playerIn: {
          name: inPlayer.web_name,
          position: ['', 'GKP', 'DEF', 'MID', 'FWD'][inPlayer.element_type],
        },
      };
    }
    
    // Get current team info for budget check
    let freeTransfers = 1; // Default assumption
    let bank = 0;
    let sellingPrice = outPlayer.now_cost; // Approximate
    let currentSquadByTeam = new Map<number, number[]>();
    
    if (client.isAuthenticated()) {
      try {
        const myTeam = await client.getMyTeam();
        freeTransfers = myTeam.transfers.limit - myTeam.transfers.made;
        bank = myTeam.transfers.bank;
        
        // Find actual selling price from picks
        const pick = myTeam.picks.find(p => p.element === outPlayer.id);
        if (!pick) {
          return {
            error: `${outPlayer.web_name} is not in your current squad.`,
          };
        }
        sellingPrice = pick.selling_price ?? outPlayer.now_cost;
        
        // Build squad by team for limit check
        myTeam.picks.forEach(p => {
          const player = engine.getPlayer(p.element);
          if (player) {
            const teamPlayers = currentSquadByTeam.get(player.team) || [];
            teamPlayers.push(p.element);
            currentSquadByTeam.set(player.team, teamPlayers);
          }
        });
      } catch (error) {
        // Continue with default values
      }
    }
    
    // Calculate budget
    const buyingPrice = inPlayer.now_cost;
    const budgetAfter = bank + sellingPrice - buyingPrice;
    
    if (budgetAfter < 0) {
      return {
        error: 'Insufficient funds for this transfer.',
        details: {
          sellingPrice: `£${(sellingPrice / 10).toFixed(1)}m`,
          buyingPrice: `£${(buyingPrice / 10).toFixed(1)}m`,
          currentBank: `£${(bank / 10).toFixed(1)}m`,
          shortfall: `£${(Math.abs(budgetAfter) / 10).toFixed(1)}m`,
        },
      };
    }
    
    // Check team limit (max 3 per team)
    if (currentSquadByTeam.size > 0) {
      const inPlayerTeam = inPlayer.team;
      const outPlayerTeam = outPlayer.team;
      const currentTeamCount = currentSquadByTeam.get(inPlayerTeam)?.length || 0;
      
      // If transferring out from same team, the limit is effectively reduced by 1
      const wouldRemoveFromSameTeam = inPlayerTeam === outPlayerTeam;
      const effectiveCount = wouldRemoveFromSameTeam ? currentTeamCount - 1 : currentTeamCount;
      
      if (effectiveCount >= 3) {
        const teamName = engine.getTeam(inPlayerTeam)?.name || 'that team';
        return {
          error: `Cannot have more than 3 players from ${teamName}.`,
          details: {
            currentFromTeam: currentTeamCount,
            playersFromTeam: currentSquadByTeam.get(inPlayerTeam)?.map(id => 
              engine.getPlayer(id)?.web_name || 'Unknown'
            ),
          },
        };
      }
    }
    
    // Evaluate transfer using game theory
    const evaluation = engine.evaluateTransfer(
      outPlayer.id,
      inPlayer.id,
      freeTransfers,
      8 // 8 GW horizon
    );
    
    const analysis = {
      transfer: {
        out: {
          name: outPlayer.web_name,
          team: engine.getTeam(outPlayer.team)?.short_name || 'UNK',
          price: `£${(sellingPrice / 10).toFixed(1)}m`,
          form: outPlayer.form,
          xpNext5GW: engine.calculateExpectedPoints(outPlayer.id, 5).next5GW,
        },
        in: {
          name: inPlayer.web_name,
          team: engine.getTeam(inPlayer.team)?.short_name || 'UNK',
          price: `£${(buyingPrice / 10).toFixed(1)}m`,
          form: inPlayer.form,
          xpNext5GW: engine.calculateExpectedPoints(inPlayer.id, 5).next5GW,
        },
      },
      gameTheory: {
        expectedPointsGain: evaluation.xpGain,
        hitCost: evaluation.hitCost,
        netGain: evaluation.netGain,
        horizon: `${evaluation.horizon} gameweeks`,
        riskLevel: evaluation.riskLevel,
        confidence: `${(evaluation.confidence * 100).toFixed(0)}%`,
        reasoning: evaluation.reasoning,
        recommendation: evaluation.netGain > 0 ? 'APPROVE' : 'CAUTION',
      },
      budget: {
        freeTransfers,
        bankAfter: `£${(budgetAfter / 10).toFixed(1)}m`,
        hitRequired: freeTransfers <= 0,
      },
    };
    
    // If not confirmed, return analysis only
    if (!confirm) {
      return {
        status: 'ANALYSIS_ONLY',
        message: 'Review the analysis below. Call again with confirm=true to execute.',
        ...analysis,
        warning: evaluation.hitCost > 0 && evaluation.netGain < 8
          ? 'This hit may not be worth it. Consider waiting for a free transfer.'
          : undefined,
      };
    }
    
    // Execute transfer
    if (!client.isAuthenticated()) {
      return {
        status: 'AUTH_REQUIRED',
        message: 'Authentication required to execute transfers. Please provide FPL credentials.',
        ...analysis,
      };
    }
    
    const currentGW = engine.getCurrentGameweek();
    const result = await client.makeTransfer(outPlayer.id, inPlayer.id, currentGW, buyingPrice, sellingPrice);
    
    if (result.success) {
      // Log decision to database
      await logDecision({
        gameweek: currentGW,
        decisionType: 'transfer',
        action: JSON.stringify({
          playerOut: outPlayer.web_name,
          playerIn: inPlayer.web_name,
          playerOutId: outPlayer.id,
          playerInId: inPlayer.id,
        }),
        reasoning: evaluation.reasoning,
        expectedPoints: evaluation.xpGain,
        rankBefore: null,
        hitsTaken: evaluation.hitCost > 0 ? 1 : 0,
      });
      
      return {
        status: 'SUCCESS',
        message: `Transfer complete: ${outPlayer.web_name} OUT, ${inPlayer.web_name} IN`,
        ...analysis,
        logged: true,
      };
    } else {
      return {
        status: 'FAILED',
        message: result.message,
        ...analysis,
      };
    }
  },
});

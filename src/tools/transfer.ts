// Make Transfer Tool - Execute transfers with ROI validation
import { z } from 'zod';
import { tool } from '@openai/agents';
import { getFPLClient } from '../api/client.js';
import { getOptimizationEngine } from '../engine/optimizer.js';
import { getFreeTransfers } from '../scheduler/decisions.js';

export const makeTransferTool = tool({
  name: 'make_transfer',
  description: 'Analyze a possible transfer with expected-points, budget, and hit-cost context. This tool never executes a live transfer.',
  parameters: z.object({
    playerOut: z.string().describe('Name of player to sell'),
    playerIn: z.string().describe('Name of player to buy'),
    confirm: z.boolean().default(false).describe('Set true to return a manual-action summary after the analysis.'),
  }),
  execute: async ({ playerOut, playerIn, confirm }) => {
    const client = getFPLClient();
    const engine = await getOptimizationEngine();

    if (!client.isAuthenticated()) {
      return {
        status: 'AUTH_REQUIRED',
        message: 'Authenticated team data is required even for transfer analysis.',
      };
    }
    
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
    let myTeam;
    try {
      myTeam = await client.getMyTeam();
    } catch (error) {
      return { error: `Failed to fetch the authoritative team: ${error instanceof Error ? error.message : String(error)}` };
    }
    const freeTransfers = getFreeTransfers(myTeam);
    const bank = myTeam.transfers.bank;
    const pick = myTeam.picks.find(p => p.element === outPlayer.id);
    if (!pick) return { error: `${outPlayer.web_name} is not in your current squad.` };
    if (pick.selling_price === undefined) return { error: `Selling price is unavailable for ${outPlayer.web_name}.` };
    const sellingPrice = pick.selling_price;
    const currentSquadByTeam = new Map<number, number[]>();
    myTeam.picks.forEach(p => {
      const player = engine.getPlayer(p.element);
      if (player) currentSquadByTeam.set(player.team, [...(currentSquadByTeam.get(player.team) ?? []), p.element]);
    });
    
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
        message: 'Review the analysis below. Call again with confirm=true for a manual-action summary.',
        ...analysis,
        warning: evaluation.hitCost > 0 && evaluation.netGain < 8
          ? 'This hit may not be worth it. Consider waiting for a free transfer.'
          : undefined,
      };
    }
    
    return {
      status: 'MANUAL_REQUIRED',
      message: 'LLM tools are analysis-only. Review this plan and make the transfer manually; autonomous execution is restricted to the deployment worker.',
      ...analysis,
    };
  },
});
